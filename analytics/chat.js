'use strict';

const crypto = require('node:crypto');
const {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
} = require('@aws-sdk/client-dynamodb');
const {
  sendChatEscalationAlert,
  sendTelegramErrorAlert,
} = require('./notifications');
const {
  KNOWLEDGE_CANONICAL_RENDER,
  KNOWLEDGE_STARTER_TEMPLATES,
  KNOWLEDGE_QUOTAS_AND_PRICING,
  KNOWLEDGE_BATCHES_AND_WEBHOOKS,
  RENDERPDF_KNOWLEDGE_BASE,
  buildSystemPrompt,
} = require('./chat-kb');
const {
  isAuthorizedAdmin,
  createChatAdminHandlers,
} = require('./chat-admin');

let BedrockRuntimeClient;
let ConverseCommand;
try {
  ({ BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime'));
} catch {
  BedrockRuntimeClient = class MockBedrockClient {
    async send() {
      return {};
    }
  };
  ConverseCommand = class MockConverseCommand {
    constructor(input) {
      this.input = input;
    }
  };
}

const TABLE_NAME = process.env.TABLE_NAME || process.env.DYNAMODB_TABLE || '';
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || 'amazon.nova-micro-v1:0';
const BEDROCK_REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1';
const CHAT_TTL_SECONDS = 30 * 86400; // 30-day TTL

const OUT_OF_SCOPE_REGEX =
  /\b(partner(?:ship|s)?|partner\s*program|reseller|affiliate|sponsor(?:ship)?|invest(?:or|ment|ing)?|acquisition|custom\s*contract|sales\s*rep)\b/i;
const HALLUCINATION_REGEX =
  /\b(reach out to our sales|contact our sales|sales team at|email our sales|renderpdf\.com|partner program|partner section)\b/i;

let customBedrockClient = null;
let customDdbClient = null;

function setBedrockClient(client) {
  customBedrockClient = client;
}

function setDdbClient(client) {
  customDdbClient = client;
}

function resetClients() {
  customBedrockClient = null;
  customDdbClient = null;
}

function getBedrockClient() {
  if (customBedrockClient) return customBedrockClient;
  return new BedrockRuntimeClient({ region: BEDROCK_REGION });
}

function getDdbClient() {
  if (customDdbClient) return customDdbClient;
  return new DynamoDBClient({});
}

// ─── RESPONSE PARSING & FORMATTING ────────────────────────────────────────────

function parseModelResponse(text) {
  let cleaned = String(text || '');

  // Strip Bedrock internal safety/identity system prompt leaks
  cleaned = cleaned
    .replace(/You do not identify as[\s\S]*?(?:Identity policy\.?|$)/gi, '')
    .replace(/Generate a polite, respectful, and safe response[\s\S]*?$/gi, '')
    .replace(/I am an AI system built by a team of inventors at Amazon[\s\S]*?(?:\.|$)/gi, '')
    .trim();

  const isEscalate = /\[DECISION:\s*ESCALATE\]/i.test(cleaned);
  const reasonMatch = cleaned.match(/\[ESCALATION_REASON:\s*([a-zA-Z0-9_]+)\]/i);
  const escalationReason = reasonMatch
    ? reasonMatch[1].toLowerCase()
    : isEscalate
      ? 'explicit_request'
      : null;

  let cleanReply = cleaned
    .replace(/\[DECISION:\s*[^\]]+\]/gi, '')
    .replace(/\[ESCALATION_REASON:\s*[^\]]+\]/gi, '')
    .trim();

  // Normalize any hallucinated bare renderpdf.com domains to canonical renderpdf.vberkoz.com
  cleanReply = cleanReply.replace(
    /https?:\/\/(?:www\.)?renderpdf\.com(?!\.vberkoz)/gi,
    'https://renderpdf.vberkoz.com'
  );

  return {
    decision: isEscalate ? '[DECISION: ESCALATE]' : '[DECISION: ANSWER]',
    escalated: isEscalate,
    escalationReason,
    reply: cleanReply || cleaned.trim(),
    rawReply: text,
  };
}

function extractEmailFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : null;
}

function chatResponse(statusCode, payload, mode = 'public') {
  return {
    statusCode,
    body: payload == null ? '' : JSON.stringify(payload),
    headers: {
      'Access-Control-Allow-Origin': mode === 'admin' ? 'https://renderpdf.vberkoz.com' : '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, max-age=0',
    },
  };
}

// ─── DYNAMODB PERSISTENCE ─────────────────────────────────────────────────────

function unmarshalSession(item) {
  if (!item) return null;
  return {
    sessionId: item.sessionId?.S || '',
    status: item.status?.S || 'active',
    escalationReason: item.escalationReason?.S || null,
    source: item.source?.S || 'landing',
    visitorEmail: item.visitorEmail?.S || null,
    customerId: item.customerId?.S || null,
    plan: item.plan?.S || 'anonymous',
    unreadByAdmin: item.unreadByAdmin?.BOOL ?? false,
    summary: item.summary?.S || null,
    createdAt: item.createdAt?.S || null,
    updatedAt: item.updatedAt?.S || null,
    escalatedAt: item.escalatedAt?.S || null,
    expiresAt: item.expiresAt?.N ? Number.parseInt(item.expiresAt.N, 10) : null,
    messageCount: item.messageCount?.N ? Number.parseInt(item.messageCount.N, 10) : 0,
  };
}

function unmarshalMessage(item) {
  if (!item) return null;
  return {
    messageId: item.messageId?.S || '',
    role: item.role?.S || 'user',
    sender: item.sender?.S || 'visitor',
    content: item.content?.S || '',
    timestamp: item.timestamp?.N ? Number.parseInt(item.timestamp.N, 10) : 0,
    escalated: item.escalated?.BOOL ?? false,
    tokens: item.tokens?.M
      ? {
          input: Number.parseInt(item.tokens.M.input?.N || '0', 10),
          output: Number.parseInt(item.tokens.M.output?.N || '0', 10),
        }
      : null,
  };
}

async function fetchSessionHistory(sessionId) {
  const currentTableName = process.env.TABLE_NAME || process.env.DYNAMODB_TABLE || TABLE_NAME;
  if (!sessionId || !currentTableName) return { session: null, messages: [] };
  const ddb = getDdbClient();

  try {
    const res = await ddb.send(
      new QueryCommand({
        TableName: currentTableName,
        KeyConditionExpression: 'requestId = :rid',
        ExpressionAttributeValues: {
          ':rid': { S: `CHAT#${sessionId}` },
        },
        ScanIndexForward: true,
      })
    );

    const items = res?.Items || [];
    let session = null;
    const messages = [];

    for (const item of items) {
      if (item.timestamp?.N === '0') {
        session = unmarshalSession(item);
      } else {
        messages.push(unmarshalMessage(item));
      }
    }

    return { session, messages };
  } catch (err) {
    console.error('Failed to query chat session history', err);
    return { session: null, messages: [] };
  }
}

function formatConversationForBedrock(historyMessages, currentMessage) {
  const formatted = [];
  const recentHistory = (historyMessages || []).slice(-10);

  for (const msg of recentHistory) {
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const text = String(msg.content || '').trim();
    if (!text) continue;

    if (formatted.length > 0 && formatted[formatted.length - 1].role === role) {
      formatted[formatted.length - 1].content[0].text += '\n\n' + text;
    } else {
      formatted.push({ role, content: [{ text }] });
    }
  }

  // Bedrock ConverseCommand requires starting with a user message
  while (formatted.length > 0 && formatted[0].role !== 'user') {
    formatted.shift();
  }

  if (formatted.length > 0 && formatted[formatted.length - 1].role === 'user') {
    formatted[formatted.length - 1].content[0].text += '\n\n' + currentMessage.trim();
  } else {
    formatted.push({ role: 'user', content: [{ text: currentMessage.trim() }] });
  }

  return formatted;
}

async function persistChatTurn({
  sessionId,
  userMessage,
  cleanReply,
  rawReply,
  escalated,
  escalationReason,
  visitorContext,
  existingSession,
  previousMessages,
  usage,
}) {
  const currentTableName = process.env.TABLE_NAME || process.env.DYNAMODB_TABLE || TABLE_NAME;
  if (!currentTableName) return;
  const ddb = getDdbClient();
  const now = new Date();
  const nowEpochMs = now.getTime();
  const nowIso = now.toISOString();
  const expiresAt = Math.floor(nowEpochMs / 1000) + CHAT_TTL_SECONDS;

  const visitorEmail =
    visitorContext.email ||
    extractEmailFromText(userMessage) ||
    existingSession?.visitorEmail ||
    null;
  const customerId = visitorContext.userId || existingSession?.customerId || null;
  const plan = visitorContext.plan || existingSession?.plan || 'anonymous';
  const source =
    visitorContext.source ||
    (visitorContext.url ? 'landing' : existingSession?.source || 'landing');

  const status = escalated
    ? 'escalated'
    : existingSession?.status === 'escalated'
      ? 'escalated'
      : 'active';
  const finalEscalationReason = escalationReason || existingSession?.escalationReason || null;
  const messageCount = (previousMessages?.length || 0) + 2;

  // 1. Session Metadata Item (SK = 0)
  const sessionItem = {
    requestId: { S: `CHAT#${sessionId}` },
    timestamp: { N: '0' },
    entityType: { S: 'CHAT_SESSION' },
    sessionId: { S: sessionId },
    status: { S: status },
    GSI1PK: { S: `CHAT_STATUS#${status}` },
    GSI1SK: { S: nowIso },
    source: { S: source },
    plan: { S: plan },
    unreadByAdmin: { BOOL: status === 'escalated' },
    createdAt: { S: existingSession?.createdAt || nowIso },
    updatedAt: { S: nowIso },
    expiresAt: { N: String(expiresAt) },
    messageCount: { N: String(messageCount) },
    summary: { S: userMessage.slice(0, 300) },
  };

  if (visitorEmail) sessionItem.visitorEmail = { S: visitorEmail };
  if (customerId) sessionItem.customerId = { S: customerId };
  if (finalEscalationReason) sessionItem.escalationReason = { S: finalEscalationReason };
  if (status === 'escalated')
    sessionItem.escalatedAt = { S: existingSession?.escalatedAt || nowIso };

  // 2. User Message Item (SK = userTimestamp)
  const userMsgId = 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const userMsgItem = {
    requestId: { S: `CHAT#${sessionId}` },
    timestamp: { N: String(nowEpochMs) },
    entityType: { S: 'CHAT_MESSAGE' },
    messageId: { S: userMsgId },
    role: { S: 'user' },
    sender: { S: 'visitor' },
    content: { S: userMessage },
    expiresAt: { N: String(expiresAt) },
  };

  // 3. Bot Assistant Message Item (SK = botTimestamp)
  const botMsgId = 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const botMsgItem = {
    requestId: { S: `CHAT#${sessionId}` },
    timestamp: { N: String(nowEpochMs + 1) },
    entityType: { S: 'CHAT_MESSAGE' },
    messageId: { S: botMsgId },
    role: { S: 'assistant' },
    sender: { S: 'bot' },
    content: { S: cleanReply },
    escalated: { BOOL: escalated },
    expiresAt: { N: String(expiresAt) },
  };

  if (usage?.inputTokens != null || usage?.outputTokens != null) {
    botMsgItem.tokens = {
      M: {
        input: { N: String(usage.inputTokens || 0) },
        output: { N: String(usage.outputTokens || 0) },
      },
    };
  }

  // Persist items
  await Promise.all([
    ddb.send(new PutItemCommand({ TableName: currentTableName, Item: sessionItem })),
    ddb.send(new PutItemCommand({ TableName: currentTableName, Item: userMsgItem })),
    ddb.send(new PutItemCommand({ TableName: currentTableName, Item: botMsgItem })),
  ]);

  return {
    sessionId,
    visitorEmail,
    status,
    messageCount,
  };
}

// ─── MAIN CHAT HANDLER ────────────────────────────────────────────────────────

async function handleChatMessage(event) {
  if (event?.httpMethod === 'OPTIONS') {
    return chatResponse(204);
  }

  let body = {};
  if (event && typeof event.body === 'string') {
    try {
      body = JSON.parse(event.body);
    } catch {
      return chatResponse(400, { error: 'Invalid JSON in request body' });
    }
  } else if (event && typeof event.body === 'object' && event.body !== null) {
    body = event.body;
  } else if (event && typeof event === 'object' && event.message) {
    body = event;
  }

  const message = body.message && typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return chatResponse(400, { error: 'Message is required' });
  }

  const sessionId =
    (body.sessionId && String(body.sessionId).trim()) ||
    'cs_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const visitorContext =
    body.visitorContext && typeof body.visitorContext === 'object' ? body.visitorContext : {};

  // 1. Fetch recent history from DynamoDB
  const { session: existingSession, messages: historyMessages } =
    await fetchSessionHistory(sessionId);

  // 2. Prepare Bedrock Converse payload
  const systemPrompt = buildSystemPrompt({ visitorContext });
  const conversationMessages = formatConversationForBedrock(historyMessages, message);

  // 3. Invoke Bedrock Nova Micro
  const bedrockClient = getBedrockClient();
  let rawOutputText = '';
  let usage = {};

  try {
    const converseCmd = new ConverseCommand({
      modelId: BEDROCK_MODEL_ID,
      system: [{ text: systemPrompt }],
      messages: conversationMessages,
      inferenceConfig: {
        maxTokens: 1024,
        temperature: 0.3,
      },
    });

    const bedrockRes = await bedrockClient.send(converseCmd);
    rawOutputText = bedrockRes?.output?.message?.content?.[0]?.text || '';
    usage = bedrockRes?.usage || {};
  } catch (err) {
    console.error('Bedrock invocation failed', err);
    await sendTelegramErrorAlert({
      context: 'Bedrock Nova Micro Failure',
      error: err,
      details: { sessionId, message: message.slice(0, 150) },
    }).catch(() => {});
    rawOutputText =
      '[DECISION: ESCALATE] [ESCALATION_REASON: complex_bug] I am having trouble processing your request right now. I have notified our engineering team. What is the best email address for our lead operator to reach you at?';
  }

  // 4. Parse model response & decision tags
  const parsed = parseModelResponse(rawOutputText);

  // Deterministic guardrails: detect out-of-scope business inquiries or hallucinated sales advice
  const isOutOfScope = OUT_OF_SCOPE_REGEX.test(message);
  const isHallucinatedSales = HALLUCINATION_REGEX.test(parsed.reply);
  const effectiveEmail =
    visitorContext.email || extractEmailFromText(message) || existingSession?.visitorEmail || null;

  if (!parsed.escalated && (isOutOfScope || isHallucinatedSales)) {
    parsed.escalated = true;
    parsed.decision = '[DECISION: ESCALATE]';
    parsed.escalationReason = 'high_value_lead';
    if (effectiveEmail) {
      parsed.reply = `I've routed your inquiry directly to our founder and lead engineer (Basil) for personal follow-up. We'll be in touch at ${effectiveEmail} shortly.`;
    } else {
      parsed.reply = `I've routed your inquiry directly to our founder and lead engineer (Basil). What is the best email address for our lead operator to reach you at?`;
    }
  }

  const requiresEmail = parsed.escalated && !effectiveEmail;

  // 5. Persist session metadata and messages in DynamoDB
  try {
    await persistChatTurn({
      sessionId,
      userMessage: message,
      cleanReply: parsed.reply,
      rawReply: parsed.rawReply,
      escalated: parsed.escalated,
      escalationReason: parsed.escalationReason,
      visitorContext,
      existingSession,
      previousMessages: historyMessages,
      usage,
    });
  } catch (err) {
    console.error('Failed to persist chat session to DynamoDB', err);
  }

  // 6. If escalated, dispatch instant operator alert via SES
  if (parsed.escalated) {
    const sessionForAlert = {
      sessionId,
      status: 'escalated',
      escalationReason: parsed.escalationReason || 'explicit_request',
      visitorEmail: effectiveEmail || null,
      customerId: visitorContext.userId || existingSession?.customerId || null,
      plan: visitorContext.plan || existingSession?.plan || 'anonymous',
      source:
        visitorContext.source ||
        (visitorContext.url ? 'landing' : existingSession?.source || 'landing'),
      sourceIp: event?.requestContext?.identity?.sourceIp || null,
    };
    const recentMessages = [
      ...(historyMessages || []).slice(-5),
      { role: 'user', sender: 'visitor', content: message },
      { role: 'assistant', sender: 'bot', content: parsed.reply },
    ];
    try {
      await sendChatEscalationAlert({ session: sessionForAlert, recentMessages });
    } catch (err) {
      console.error('Failed to dispatch chat escalation alert email', err);
    }
  }

  // 7. Return response
  return chatResponse(200, {
    sessionId,
    reply: parsed.reply,
    escalated: parsed.escalated,
    requiresEmail,
    decision: parsed.decision,
    escalationReason: parsed.escalationReason,
  });
}

// ─── ADMIN CHAT MANAGEMENT HANDLERS ───────────────────────────────────────────

const adminHandlers = createChatAdminHandlers({
  getTableName: () => process.env.TABLE_NAME || process.env.DYNAMODB_TABLE || TABLE_NAME,
  getDdbClient,
  unmarshalSession,
  unmarshalMessage,
  chatResponse,
  CHAT_TTL_SECONDS,
});

module.exports = {
  handleChatMessage,
  buildSystemPrompt,
  parseModelResponse,
  formatConversationForBedrock,
  extractEmailFromText,
  chatResponse,
  isAuthorizedAdmin,
  listAdminChats: adminHandlers.listAdminChats,
  getAdminChatTranscript: adminHandlers.getAdminChatTranscript,
  postAdminChatReply: adminHandlers.postAdminChatReply,
  updateAdminChatStatus: adminHandlers.updateAdminChatStatus,
  setBedrockClient,
  setDdbClient,
  resetClients,
  RENDERPDF_KNOWLEDGE_BASE,
  KNOWLEDGE_CANONICAL_RENDER,
  KNOWLEDGE_STARTER_TEMPLATES,
  KNOWLEDGE_QUOTAS_AND_PRICING,
  KNOWLEDGE_BATCHES_AND_WEBHOOKS,
  BEDROCK_MODEL_ID,
  CHAT_TTL_SECONDS,
};
