'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id, ...args) {
  if (id === '@aws-sdk/client-dynamodb') {
    class MockDynamoDBClient {
      send() {}
    }
    class BatchGetItemCommand { constructor(input) { this.input = input; } }
    class GetItemCommand { constructor(input) { this.input = input; } }
    class UpdateItemCommand { constructor(input) { this.input = input; } }
    class PutItemCommand { constructor(input) { this.input = input; } }
    class QueryCommand { constructor(input) { this.input = input; } }
    class TransactWriteItemsCommand { constructor(input) { this.input = input; } }
    return {
      BatchGetItemCommand,
      DynamoDBClient: MockDynamoDBClient,
      GetItemCommand,
      PutItemCommand,
      QueryCommand,
      TransactWriteItemsCommand,
      UpdateItemCommand,
    };
  }
  if (id === '@aws-sdk/client-bedrock-runtime') {
    class MockBedrockRuntimeClient {
      send() {}
    }
    class ConverseCommand { constructor(input) { this.input = input; } }
    return {
      BedrockRuntimeClient: MockBedrockRuntimeClient,
      ConverseCommand,
    };
  }
  if (id === '@aws-sdk/client-ses') {
    class MockSESClient {
      send() {}
    }
    class SendEmailCommand { constructor(input) { this.input = input; } }
    return {
      SESClient: MockSESClient,
      SendEmailCommand,
    };
  }
  if (id === '@aws-sdk/client-cognito-identity-provider') {
    class MockCognitoClient {
      send() {}
    }
    class AdminGetUserCommand { constructor(input) { this.input = input; } }
    class AdminDisableUserCommand { constructor(input) { this.input = input; } }
    class AdminEnableUserCommand { constructor(input) { this.input = input; } }
    class ListUsersCommand { constructor(input) { this.input = input; } }
    return {
      CognitoIdentityProviderClient: MockCognitoClient,
      AdminGetUserCommand,
      AdminDisableUserCommand,
      AdminEnableUserCommand,
      ListUsersCommand,
    };
  }
  if (id === '@aws-sdk/client-api-gateway') {
    class MockAPIGatewayClient {
      send() {}
    }
    class CreateUsagePlanKeyCommand { constructor(input) { this.input = input; } }
    class DeleteUsagePlanKeyCommand { constructor(input) { this.input = input; } }
    return {
      APIGatewayClient: MockAPIGatewayClient,
      CreateUsagePlanKeyCommand,
      DeleteUsagePlanKeyCommand,
    };
  }
  return originalRequire.apply(this, [id, ...args]);
};

process.env.TABLE_NAME = 'renderpdf-usage-test';
process.env.BEDROCK_MODEL_ID = 'amazon.nova-micro-v1:0';
process.env.BEDROCK_REGION = 'us-east-1';

const chat = require('./chat');
const analytics = require('./index');

test.beforeEach(() => {
  chat.resetClients();
});

test('buildSystemPrompt includes RenderPDF knowledge modules, decision tags, and visitor context', () => {
  const prompt = chat.buildSystemPrompt({
    visitorContext: {
      plan: 'pro',
      email: 'alex@startup.io',
      url: 'https://renderpdf.vberkoz.com/pricing',
      userId: 'usr_abc123',
    },
  });

  // Decision protocol instructions
  assert.ok(prompt.includes('[DECISION: ANSWER]'));
  assert.ok(prompt.includes('[DECISION: ESCALATE]'));
  assert.ok(prompt.includes('[ESCALATION_REASON: high_value_lead | complex_bug | billing_issue | explicit_request]'));
  assert.ok(prompt.includes('What is the best email address for our lead operator to reach you at?'));

  // Visitor context section
  assert.ok(prompt.includes('alex@startup.io'));
  assert.ok(prompt.includes('Plan: pro'));
  assert.ok(prompt.includes('usr_abc123'));

  // Knowledge base modules
  assert.ok(prompt.includes('/api/v1/render'));
  assert.ok(prompt.includes('headerTemplate'));
  assert.ok(prompt.includes('footerTemplate'));
  assert.ok(prompt.includes('displayHeaderFooter'));
  assert.ok(prompt.includes('Invoice'));
  assert.ok(prompt.includes('Contract'));
  assert.ok(prompt.includes('Starter Tier'));
  assert.ok(prompt.includes('$19/month'));
  assert.ok(prompt.includes('Pro Tier'));
  assert.ok(prompt.includes('$49/month'));
  assert.ok(prompt.includes('Overage Credits'));
  assert.ok(prompt.includes('/batches'));
  assert.ok(prompt.includes('X-RenderPDF-Signature'));
});

test('handleChatMessage answers technical questions with [DECISION: ANSWER], strips tag from reply, and returns 200', async () => {
  const capturedBedrockCommands = [];
  const capturedDdbCommands = [];

  chat.setBedrockClient({
    send: async (cmd) => {
      capturedBedrockCommands.push(cmd);
      return {
        output: {
          message: {
            content: [
              {
                text: '[DECISION: ANSWER] You can set `options.format` to "A4" and `options.margin` to "18mm" or custom inches like "1in".',
              },
            ],
          },
        },
        usage: { inputTokens: 420, outputTokens: 52 },
      };
    },
  });

  chat.setDdbClient({
    send: async (cmd) => {
      capturedDdbCommands.push(cmd);
      if (cmd.input?.KeyConditionExpression) {
        return { Items: [] }; // No existing history
      }
      return {};
    },
  });

  const event = {
    httpMethod: 'POST',
    path: '/api/v1/chat',
    body: JSON.stringify({
      sessionId: 'cs_test_session_01',
      message: 'How do I configure page margins and paper format?',
      visitorContext: {
        url: 'https://renderpdf.vberkoz.com/#docs',
        plan: 'starter',
      },
    }),
  };

  const response = await chat.handleChatMessage(event);
  assert.equal(response.statusCode, 200);

  const payload = JSON.parse(response.body);
  assert.equal(payload.sessionId, 'cs_test_session_01');
  assert.equal(payload.escalated, false);
  assert.equal(payload.requiresEmail, false);
  assert.equal(payload.decision, '[DECISION: ANSWER]');
  assert.ok(!payload.reply.includes('[DECISION: ANSWER]'));
  assert.ok(payload.reply.includes('options.format'));

  // Verify Bedrock input command
  assert.equal(capturedBedrockCommands.length, 1);
  const bedrockCmd = capturedBedrockCommands[0];
  assert.equal(bedrockCmd.input.modelId, 'amazon.nova-micro-v1:0');
  assert.ok(bedrockCmd.input.system[0].text.includes('RenderPDF Knowledge Base'));
  assert.equal(bedrockCmd.input.messages.length, 1);
  assert.equal(bedrockCmd.input.messages[0].role, 'user');
  assert.equal(bedrockCmd.input.messages[0].content[0].text, 'How do I configure page margins and paper format?');

  // Verify DynamoDB persistence: 1 Query + 3 Puts (Session + User msg + Bot msg)
  const putCommands = capturedDdbCommands.filter((c) => c.constructor.name === 'PutItemCommand' || c.input?.Item);
  assert.equal(putCommands.length, 3);

  // 1. Session item (timestamp 0)
  const sessionPut = putCommands.find((c) => c.input.Item.timestamp?.N === '0');
  assert.ok(sessionPut, 'Session item must be written at timestamp 0');
  assert.equal(sessionPut.input.Item.requestId.S, 'CHAT#cs_test_session_01');
  assert.equal(sessionPut.input.Item.entityType.S, 'CHAT_SESSION');
  assert.equal(sessionPut.input.Item.status.S, 'active');
  assert.equal(sessionPut.input.Item.GSI1PK.S, 'CHAT_STATUS#active');
  assert.ok(sessionPut.input.Item.GSI1SK.S);
  assert.equal(sessionPut.input.Item.plan.S, 'starter');
  assert.equal(sessionPut.input.Item.messageCount.N, '2');

  // 30-day TTL verification
  const nowSec = Math.floor(Date.now() / 1000);
  const ttlSec = Number.parseInt(sessionPut.input.Item.expiresAt.N, 10);
  assert.ok(ttlSec >= nowSec + 29 * 86400, 'TTL must be approximately 30 days in the future');
  assert.ok(ttlSec <= nowSec + 31 * 86400);

  // 2. User message item
  const userPut = putCommands.find((c) => c.input.Item.role?.S === 'user');
  assert.ok(userPut, 'User message must be written');
  assert.equal(userPut.input.Item.requestId.S, 'CHAT#cs_test_session_01');
  assert.equal(userPut.input.Item.sender.S, 'visitor');
  assert.equal(userPut.input.Item.content.S, 'How do I configure page margins and paper format?');
  assert.equal(userPut.input.Item.expiresAt.N, sessionPut.input.Item.expiresAt.N);

  // 3. Assistant message item
  const botPut = putCommands.find((c) => c.input.Item.role?.S === 'assistant');
  assert.ok(botPut, 'Bot message must be written');
  assert.equal(botPut.input.Item.requestId.S, 'CHAT#cs_test_session_01');
  assert.equal(botPut.input.Item.sender.S, 'bot');
  assert.equal(botPut.input.Item.escalated.BOOL, false);
  assert.equal(botPut.input.Item.tokens.M.input.N, '420');
  assert.equal(botPut.input.Item.tokens.M.output.N, '52');
  assert.equal(botPut.input.Item.expiresAt.N, sessionPut.input.Item.expiresAt.N);
});

test('handleChatMessage detects [DECISION: ESCALATE] for high-value leads and requires email when unknown', async () => {
  const capturedDdbCommands = [];

  chat.setBedrockClient({
    send: async () => ({
      output: {
        message: {
          content: [
            {
              text: '[DECISION: ESCALATE] [ESCALATION_REASON: high_value_lead] For 150k renders/month, our team provisions dedicated concurrency and custom volume pricing. What is the best email address for our lead operator to reach you at?',
            },
          ],
        },
      },
    }),
  });

  chat.setDdbClient({
    send: async (cmd) => {
      capturedDdbCommands.push(cmd);
      if (cmd.input?.KeyConditionExpression) {
        return { Items: [] };
      }
      return {};
    },
  });

  const event = {
    httpMethod: 'POST',
    path: '/api/v1/chat',
    body: JSON.stringify({
      sessionId: 'cs_enterprise_lead',
      message: 'We need 150k PDFs/month and custom SLA terms.',
      visitorContext: {
        url: 'https://renderpdf.vberkoz.com/#pricing',
      },
    }),
  };

  const response = await chat.handleChatMessage(event);
  assert.equal(response.statusCode, 200);

  const payload = JSON.parse(response.body);
  assert.equal(payload.escalated, true);
  assert.equal(payload.requiresEmail, true); // No email was provided in visitorContext
  assert.equal(payload.decision, '[DECISION: ESCALATE]');
  assert.equal(payload.escalationReason, 'high_value_lead');
  assert.ok(!payload.reply.includes('[DECISION: ESCALATE]'));
  assert.ok(!payload.reply.includes('[ESCALATION_REASON:'));

  // Session metadata status should be escalated
  const sessionPut = capturedDdbCommands.find((c) => c.input?.Item?.timestamp?.N === '0');
  assert.equal(sessionPut.input.Item.status.S, 'escalated');
  assert.equal(sessionPut.input.Item.GSI1PK.S, 'CHAT_STATUS#escalated');
  assert.equal(sessionPut.input.Item.unreadByAdmin.BOOL, true);
  assert.equal(sessionPut.input.Item.escalationReason.S, 'high_value_lead');
});

test('handleChatMessage sets requiresEmail: false if email is already present in visitorContext or user message', async () => {
  chat.setBedrockClient({
    send: async () => ({
      output: {
        message: {
          content: [
            {
              text: '[DECISION: ESCALATE] [ESCALATION_REASON: billing_issue] I have escalated this billing discrepancy to our finance team.',
            },
          ],
        },
      },
    }),
  });

  chat.setDdbClient({
    send: async () => ({ Items: [] }),
  });

  // Case 1: visitorContext.email provided
  const event1 = {
    httpMethod: 'POST',
    path: '/api/v1/chat',
    body: JSON.stringify({
      sessionId: 'cs_billing_01',
      message: 'I was double charged on my last invoice.',
      visitorContext: {
        email: 'billing-contact@corp.com',
      },
    }),
  };

  const res1 = await chat.handleChatMessage(event1);
  const payload1 = JSON.parse(res1.body);
  assert.equal(payload1.escalated, true);
  assert.equal(payload1.requiresEmail, false);

  // Case 2: Email contained in message text
  const event2 = {
    httpMethod: 'POST',
    path: '/api/v1/chat',
    body: JSON.stringify({
      sessionId: 'cs_billing_02',
      message: 'Please email me at founder@venture.io regarding enterprise volume.',
    }),
  };

  const res2 = await chat.handleChatMessage(event2);
  const payload2 = JSON.parse(res2.body);
  assert.equal(payload2.escalated, true);
  assert.equal(payload2.requiresEmail, false);
});

test('handleChatMessage includes recent session history in Bedrock converse command', async () => {
  let capturedMessages = null;

  chat.setBedrockClient({
    send: async (cmd) => {
      capturedMessages = cmd.input.messages;
      return {
        output: {
          message: {
            content: [{ text: '[DECISION: ANSWER] Yes, `options.password` uses AES-256 encryption.' }],
          },
        },
      };
    },
  });

  // Return prior session metadata and prior messages from DynamoDB
  chat.setDdbClient({
    send: async (cmd) => {
      if (cmd.input?.KeyConditionExpression) {
        return {
          Items: [
            {
              requestId: { S: 'CHAT#cs_multi_turn' },
              timestamp: { N: '0' },
              entityType: { S: 'CHAT_SESSION' },
              sessionId: { S: 'cs_multi_turn' },
              status: { S: 'active' },
              messageCount: { N: '2' },
              createdAt: { S: '2026-09-28T12:00:00Z' },
            },
            {
              requestId: { S: 'CHAT#cs_multi_turn' },
              timestamp: { N: '1727520000000' },
              entityType: { S: 'CHAT_MESSAGE' },
              role: { S: 'user' },
              content: { S: 'Can I password protect PDFs?' },
            },
            {
              requestId: { S: 'CHAT#cs_multi_turn' },
              timestamp: { N: '1727520001000' },
              entityType: { S: 'CHAT_MESSAGE' },
              role: { S: 'assistant' },
              content: { S: 'Yes! RenderPDF supports AES-256 PDF encryption via options.password.' },
            },
          ],
        };
      }
      return {};
    },
  });

  const event = {
    httpMethod: 'POST',
    path: '/api/v1/chat',
    body: JSON.stringify({
      sessionId: 'cs_multi_turn',
      message: 'What encryption standard is used?',
    }),
  };

  const response = await chat.handleChatMessage(event);
  assert.equal(response.statusCode, 200);

  // Verify conversation history was loaded and structured properly
  assert.ok(capturedMessages);
  assert.equal(capturedMessages.length, 3);
  assert.equal(capturedMessages[0].role, 'user');
  assert.equal(capturedMessages[0].content[0].text, 'Can I password protect PDFs?');
  assert.equal(capturedMessages[1].role, 'assistant');
  assert.equal(capturedMessages[1].content[0].text, 'Yes! RenderPDF supports AES-256 PDF encryption via options.password.');
  assert.equal(capturedMessages[2].role, 'user');
  assert.equal(capturedMessages[2].content[0].text, 'What encryption standard is used?');
});

test('handleChatMessage returns 400 for empty message or malformed JSON', async () => {
  const resEmpty = await chat.handleChatMessage({
    httpMethod: 'POST',
    body: JSON.stringify({ message: '   ' }),
  });
  assert.equal(resEmpty.statusCode, 400);

  const resMalformed = await chat.handleChatMessage({
    httpMethod: 'POST',
    body: '{not valid json',
  });
  assert.equal(resMalformed.statusCode, 400);
});

test('handleChatMessage returns 204 for OPTIONS preflight request with CORS headers', async () => {
  const resOptions = await chat.handleChatMessage({
    httpMethod: 'OPTIONS',
    path: '/api/v1/chat',
  });
  assert.equal(resOptions.statusCode, 204);
  assert.equal(resOptions.headers['Access-Control-Allow-Origin'], '*');
  assert.ok(resOptions.headers['Access-Control-Allow-Methods'].includes('POST'));
});

test('analytics.handler routes /api/v1/chat directly and via route override query param', async () => {
  chat.setBedrockClient({
    send: async () => ({
      output: {
        message: {
          content: [{ text: '[DECISION: ANSWER] RenderPDF supports A4, Letter, and Legal.' }],
        },
      },
    }),
  });
  chat.setDdbClient({
    send: async () => ({ Items: [] }),
  });

  // Direct path
  const resDirect = await analytics.handler({
    httpMethod: 'POST',
    path: '/api/v1/chat',
    body: JSON.stringify({ message: 'What page sizes are supported?' }),
  });
  assert.equal(resDirect.statusCode, 200);
  const dataDirect = JSON.parse(resDirect.body);
  assert.equal(dataDirect.escalated, false);
  assert.ok(dataDirect.reply.includes('A4'));

  // Route query param override (e.g. from static dashboard)
  const resOverride = await analytics.handler({
    httpMethod: 'POST',
    path: '/',
    queryStringParameters: { route: '/api/v1/chat' },
    body: JSON.stringify({ message: 'What page sizes are supported?' }),
  });
  assert.equal(resOverride.statusCode, 200);

  // OPTIONS via route override
  const resOptionsOverride = await analytics.handler({
    httpMethod: 'OPTIONS',
    path: '/',
    queryStringParameters: { route: '/api/v1/chat' },
  });
  assert.equal(resOptionsOverride.statusCode, 204);
});

// ─── TASK 2 TESTS: ESCALATION SES ALERTS & ADMIN CHAT APIS ───────────────────

const notifications = require('./notifications');

const adminContext = {
  requestContext: {
    authorizer: {
      claims: {
        email: 'vberkoz@gmail.com',
        'cognito:groups': ['Admins'],
        sub: 'admin_usr_01',
      },
    },
  },
};

const nonAdminContext = {
  requestContext: {
    authorizer: {
      claims: {
        email: 'user@example.com',
        sub: 'regular_usr_02',
      },
    },
  },
};

test('escalation trigger fires sendSESEmail with correct recipient, subject, and transcript', async () => {
  const capturedEmails = [];
  notifications.setSESClient({
    send: async (cmd) => {
      capturedEmails.push(cmd);
      return { MessageId: 'ses_msg_123' };
    },
  });

  chat.setBedrockClient({
    send: async () => ({
      output: {
        message: {
          content: [
            {
              text: '[DECISION: ESCALATE] [ESCALATION_REASON: high_value_lead] For 250k renders/month, our lead engineer will configure dedicated capacity. What is the best email address for our lead operator to reach you at?',
            },
          ],
        },
      },
      usage: { inputTokens: 500, outputTokens: 60 },
    }),
  });

  chat.setDdbClient({
    send: async (cmd) => {
      if (cmd.input?.KeyConditionExpression) {
        return {
          Items: [
            {
              requestId: { S: 'CHAT#cs_ses_alert_01' },
              timestamp: { N: '1727533000000' },
              entityType: { S: 'CHAT_MESSAGE' },
              role: { S: 'user' },
              sender: { S: 'visitor' },
              content: { S: 'Hi, we are generating 250,000 invoices every month.' },
            },
          ],
        };
      }
      return {};
    },
  });

  const event = {
    httpMethod: 'POST',
    path: '/api/v1/chat',
    body: JSON.stringify({
      sessionId: 'cs_ses_alert_01',
      message: 'Can we get custom pricing and SLA?',
      visitorContext: {
        email: 'lead@enterprisefintech.com',
        plan: 'starter',
        url: 'https://renderpdf.vberkoz.com/pricing',
      },
    }),
  };

  const response = await chat.handleChatMessage(event);
  assert.equal(response.statusCode, 200);

  // Verify SES SendEmailCommand was dispatched
  assert.equal(capturedEmails.length, 1);
  const emailCmd = capturedEmails[0];
  const destAddresses = emailCmd.input.Destination.ToAddresses;
  assert.deepEqual(destAddresses, ['vberkoz@gmail.com']);

  const subject = emailCmd.input.Message.Subject.Data;
  assert.ok(subject.includes('[RenderPDF Chat Escalation]'));
  assert.ok(subject.includes('lead@enterprisefintech.com'));
  assert.ok(subject.includes('high value lead'));

  const html = emailCmd.input.Message.Body.Html.Data;
  assert.ok(html.includes('cs_ses_alert_01'));
  assert.ok(html.includes('lead@enterprisefintech.com'));
  assert.ok(html.includes('starter'));
  assert.ok(html.includes('high_value_lead'));
  assert.ok(html.includes('Can we get custom pricing and SLA?'));
  assert.ok(html.includes('https://renderpdf.vberkoz.com/app/admin#chats?id=cs_ses_alert_01'));
});

test('admin endpoints return 403 Forbidden for non-admin callers', async () => {
  // 1. GET /api/v1/admin/chats
  const resList = await chat.listAdminChats({
    ...nonAdminContext,
    httpMethod: 'GET',
    path: '/api/v1/admin/chats',
  });
  assert.equal(resList.statusCode, 403);

  // 2. GET /api/v1/admin/chats/{sessionId}
  const resTranscript = await chat.getAdminChatTranscript({
    ...nonAdminContext,
    httpMethod: 'GET',
    path: '/api/v1/admin/chats/cs_test',
  }, 'cs_test');
  assert.equal(resTranscript.statusCode, 403);

  // 3. POST /api/v1/admin/chats/{sessionId}/reply
  const resReply = await chat.postAdminChatReply({
    ...nonAdminContext,
    httpMethod: 'POST',
    path: '/api/v1/admin/chats/cs_test/reply',
    body: JSON.stringify({ message: 'Hello' }),
  }, 'cs_test');
  assert.equal(resReply.statusCode, 403);

  // 4. POST /api/v1/admin/chats/{sessionId}/status
  const resStatus = await chat.updateAdminChatStatus({
    ...nonAdminContext,
    httpMethod: 'POST',
    path: '/api/v1/admin/chats/cs_test/status',
    body: JSON.stringify({ status: 'resolved' }),
  }, 'cs_test');
  assert.equal(resStatus.statusCode, 403);
});

test('listAdminChats queries GSI1 and returns escalated chats ordered by activity', async () => {
  const capturedDdbQueries = [];
  chat.setDdbClient({
    send: async (cmd) => {
      capturedDdbQueries.push(cmd);
      if (cmd.input?.IndexName === 'AnalyticsDateIndex') {
        return {
          Items: [
            {
              sessionId: { S: 'cs_escalated_01' },
              timestamp: { N: '0' },
              status: { S: 'escalated' },
              escalationReason: { S: 'high_value_lead' },
              visitorEmail: { S: 'cto@fintechscale.com' },
              plan: { S: 'starter' },
              source: { S: 'landing' },
              summary: { S: 'We need 150k PDFs/month' },
              unreadByAdmin: { BOOL: true },
              messageCount: { N: '4' },
              updatedAt: { S: '2026-09-28T14:32:15Z' },
              createdAt: { S: '2026-09-28T14:30:00Z' },
            },
            {
              sessionId: { S: 'cs_escalated_02' },
              timestamp: { N: '0' },
              status: { S: 'escalated' },
              escalationReason: { S: 'complex_bug' },
              visitorEmail: { S: 'dev@saas.co' },
              plan: { S: 'pro' },
              source: { S: 'dashboard' },
              summary: { S: 'Chromium font rendering glitch on A4' },
              unreadByAdmin: { BOOL: true },
              messageCount: { N: '6' },
              updatedAt: { S: '2026-09-28T15:10:00Z' },
              createdAt: { S: '2026-09-28T15:00:00Z' },
            },
          ],
        };
      }
      return {};
    },
  });

  const event = {
    ...adminContext,
    httpMethod: 'GET',
    path: '/api/v1/admin/chats',
    queryStringParameters: { status: 'escalated', limit: '20' },
  };

  const response = await chat.listAdminChats(event);
  assert.equal(response.statusCode, 200);

  const payload = JSON.parse(response.body);
  assert.ok(Array.isArray(payload.chats));
  assert.equal(payload.chats.length, 2);

  // Verifying reverse chronological ordering by updatedAt (15:10 before 14:32)
  assert.equal(payload.chats[0].sessionId, 'cs_escalated_02');
  assert.equal(payload.chats[0].status, 'escalated');
  assert.equal(payload.chats[0].escalationReason, 'complex_bug');
  assert.equal(payload.chats[0].visitorEmail, 'dev@saas.co');
  assert.equal(payload.chats[0].unreadByAdmin, true);

  assert.equal(payload.chats[1].sessionId, 'cs_escalated_01');
  assert.equal(payload.chats[1].status, 'escalated');

  // Verify GSI1 query parameters
  const query = capturedDdbQueries.find((c) => c.input?.IndexName === 'AnalyticsDateIndex');
  assert.ok(query);
  assert.equal(query.input.ExpressionAttributeValues[':pk'].S, 'CHAT_STATUS#escalated');
  assert.equal(query.input.ScanIndexForward, false);
});

test('getAdminChatTranscript returns transcript and updates unreadByAdmin to false', async () => {
  const capturedDdbCommands = [];
  chat.setDdbClient({
    send: async (cmd) => {
      capturedDdbCommands.push(cmd);
      if (cmd.input?.KeyConditionExpression) {
        return {
          Items: [
            {
              requestId: { S: 'CHAT#cs_dossier_01' },
              timestamp: { N: '0' },
              entityType: { S: 'CHAT_SESSION' },
              sessionId: { S: 'cs_dossier_01' },
              status: { S: 'escalated' },
              escalationReason: { S: 'high_value_lead' },
              visitorEmail: { S: 'lead@enterprise.com' },
              customerId: { S: 'usr_c1f7b76e' },
              plan: { S: 'starter' },
              source: { S: 'landing' },
              unreadByAdmin: { BOOL: true },
            },
            {
              requestId: { S: 'CHAT#cs_dossier_01' },
              timestamp: { N: '1727533800000' },
              entityType: { S: 'CHAT_MESSAGE' },
              messageId: { S: 'msg_01' },
              role: { S: 'user' },
              sender: { S: 'visitor' },
              content: { S: 'Hi, what are your volume discounts for 200k documents a month?' },
            },
            {
              requestId: { S: 'CHAT#cs_dossier_01' },
              timestamp: { N: '1727533801200' },
              entityType: { S: 'CHAT_MESSAGE' },
              messageId: { S: 'msg_02' },
              role: { S: 'assistant' },
              sender: { S: 'bot' },
              content: { S: 'RenderPDF easily supports high volumes...' },
            },
          ],
        };
      }
      return {};
    },
  });

  const event = {
    ...adminContext,
    httpMethod: 'GET',
    path: '/api/v1/admin/chats/cs_dossier_01',
    pathParameters: { sessionId: 'cs_dossier_01' },
  };

  const response = await chat.getAdminChatTranscript(event);
  assert.equal(response.statusCode, 200);

  const payload = JSON.parse(response.body);
  assert.equal(payload.sessionId, 'cs_dossier_01');
  assert.equal(payload.visitorEmail, 'lead@enterprise.com');
  assert.equal(payload.unreadByAdmin, false);
  assert.equal(payload.messages.length, 2);
  assert.equal(payload.messages[0].sender, 'visitor');
  assert.equal(payload.messages[1].sender, 'bot');

  // Verify unreadByAdmin update command was executed
  const updateCmd = capturedDdbCommands.find((c) => c.input?.UpdateExpression?.includes('unreadByAdmin'));
  assert.ok(updateCmd, 'Should issue update to clear unreadByAdmin');
  assert.equal(updateCmd.input.ExpressionAttributeValues[':f'].BOOL, false);
});

test('postAdminChatReply appends operator message to DynamoDB and sends email when sendEmail is true', async () => {
  const capturedDdbCommands = [];
  const capturedEmails = [];

  notifications.setSESClient({
    send: async (cmd) => {
      capturedEmails.push(cmd);
      return { MessageId: 'ses_reply_msg_999' };
    },
  });

  chat.setDdbClient({
    send: async (cmd) => {
      capturedDdbCommands.push(cmd);
      if (cmd.input?.Key?.timestamp?.N === '0' && cmd.constructor.name === 'GetItemCommand') {
        return {
          Item: {
            requestId: { S: 'CHAT#cs_reply_test' },
            timestamp: { N: '0' },
            entityType: { S: 'CHAT_SESSION' },
            sessionId: { S: 'cs_reply_test' },
            status: { S: 'escalated' },
            visitorEmail: { S: 'customer@clientapp.com' },
            plan: { S: 'pro' },
            messageCount: { N: '4' },
          },
        };
      }
      return {};
    },
  });

  const event = {
    ...adminContext,
    httpMethod: 'POST',
    path: '/api/v1/admin/chats/cs_reply_test/reply',
    pathParameters: { sessionId: 'cs_reply_test' },
    body: JSON.stringify({
      message: 'Hi! This is Basil from RenderPDF. We can offer you custom pricing at $350/mo for 200k documents.',
      sendEmail: true,
    }),
  };

  const response = await chat.postAdminChatReply(event);
  assert.equal(response.statusCode, 200);

  const payload = JSON.parse(response.body);
  assert.equal(payload.success, true);
  assert.ok(payload.messageId.startsWith('msg_'));
  assert.equal(payload.emailDispatched, true);

  // 1. Verify operator message was written to DynamoDB
  const putMsg = capturedDdbCommands.find((c) => c.input?.Item?.role?.S === 'operator');
  assert.ok(putMsg);
  assert.equal(putMsg.input.Item.requestId.S, 'CHAT#cs_reply_test');
  assert.equal(putMsg.input.Item.sender.S, 'operator');
  assert.ok(putMsg.input.Item.content.S.includes('custom pricing'));

  // 2. Verify session metadata updatedAt and messageCount were updated
  const updateSession = capturedDdbCommands.find((c) => c.input?.UpdateExpression?.includes('messageCount'));
  assert.ok(updateSession);

  // 3. Verify SES email was dispatched to customer
  assert.equal(capturedEmails.length, 1);
  assert.deepEqual(capturedEmails[0].input.Destination.ToAddresses, ['customer@clientapp.com']);
  assert.ok(capturedEmails[0].input.Message.Body.Html.Data.includes('custom pricing'));
});

test('updateAdminChatStatus updates status and GSI1PK in DynamoDB', async () => {
  const capturedDdbCommands = [];
  chat.setDdbClient({
    send: async (cmd) => {
      capturedDdbCommands.push(cmd);
      return {};
    },
  });

  const event = {
    ...adminContext,
    httpMethod: 'POST',
    path: '/api/v1/admin/chats/cs_status_test/status',
    pathParameters: { sessionId: 'cs_status_test' },
    body: JSON.stringify({ status: 'resolved' }),
  };

  const response = await chat.updateAdminChatStatus(event);
  assert.equal(response.statusCode, 200);

  const payload = JSON.parse(response.body);
  assert.equal(payload.success, true);
  assert.equal(payload.status, 'resolved');

  // Verify DynamoDB UpdateItemCommand
  const updateCmd = capturedDdbCommands.find((c) => c.input?.UpdateExpression?.includes('#st = :st'));
  assert.ok(updateCmd);
  assert.equal(updateCmd.input.ExpressionAttributeValues[':st'].S, 'resolved');
  assert.equal(updateCmd.input.ExpressionAttributeValues[':gpk'].S, 'CHAT_STATUS#resolved');
  assert.equal(updateCmd.input.ExpressionAttributeValues[':f'].BOOL, false); // unreadByAdmin reset on resolve
});

test('analytics.handler routes all /api/v1/admin/chats endpoints and query param route overrides', async () => {
  chat.setDdbClient({
    send: async (cmd) => {
      if (cmd.input?.IndexName === 'AnalyticsDateIndex') {
        return { Items: [] };
      }
      if (cmd.input?.KeyConditionExpression) {
        return {
          Items: [
            {
              requestId: { S: 'CHAT#cs_route_test' },
              timestamp: { N: '0' },
              sessionId: { S: 'cs_route_test' },
              status: { S: 'active' },
            },
          ],
        };
      }
      if (cmd.input?.Key?.timestamp?.N === '0') {
        return {
          Item: {
            requestId: { S: 'CHAT#cs_route_test' },
            timestamp: { N: '0' },
            sessionId: { S: 'cs_route_test' },
            visitorEmail: { S: 'user@route.test' },
          },
        };
      }
      return {};
    },
  });

  // 1. Direct GET /api/v1/admin/chats
  const resList = await analytics.handler({
    ...adminContext,
    httpMethod: 'GET',
    path: '/api/v1/admin/chats',
  });
  assert.equal(resList.statusCode, 200);

  // 2. Direct GET /api/v1/admin/chats/{sessionId}
  const resGet = await analytics.handler({
    ...adminContext,
    httpMethod: 'GET',
    path: '/api/v1/admin/chats/cs_route_test',
    pathParameters: { sessionId: 'cs_route_test' },
  });
  assert.equal(resGet.statusCode, 200);

  // 3. Route override POST ?route=/admin/chats/{sessionId}/reply
  const resReply = await analytics.handler({
    ...adminContext,
    httpMethod: 'POST',
    path: '/',
    queryStringParameters: { route: '/admin/chats/cs_route_test/reply' },
    body: JSON.stringify({ message: 'Reply via route override' }),
  });
  assert.equal(resReply.statusCode, 200);

  // 4. Route override POST ?route=/admin/chats/{sessionId}/status
  const resStatus = await analytics.handler({
    ...adminContext,
    httpMethod: 'POST',
    path: '/',
    queryStringParameters: { route: '/admin/chats/cs_route_test/status' },
    body: JSON.stringify({ status: 'active' }),
  });
  assert.equal(resStatus.statusCode, 200);

  // 5. OPTIONS preflight
  const resOptions = await analytics.handler({
    httpMethod: 'OPTIONS',
    path: '/api/v1/admin/chats',
  });
  assert.equal(resOptions.statusCode, 204);
});

test('parseModelResponse strips Bedrock identity leaks and normalizes renderpdf.com domains', () => {
  const leakedResponse = `You do not identify as chatgpt, gemini, llama, titan or claude. You should reply to identity related questions with identifying yourself as an AI system built by a team of inventors at Amazon. Identity policy.
[DECISION: ANSWER] Check out https://www.renderpdf.com/docs for details. Generate a polite, respectful, and safe response.`;

  const parsed = chat.parseModelResponse(leakedResponse);
  assert.equal(parsed.decision, '[DECISION: ANSWER]');
  assert.equal(parsed.escalated, false);
  assert.ok(!parsed.reply.includes('inventors at Amazon'));
  assert.ok(!parsed.reply.includes('Identity policy'));
  assert.ok(!parsed.reply.includes('Generate a polite'));
  assert.ok(!parsed.reply.includes('www.renderpdf.com'));
  assert.ok(parsed.reply.includes('https://renderpdf.vberkoz.com/docs'));
});

test('handleChatMessage deterministically intercepts partnership inquiries and escalates to Basil', async () => {
  const capturedBedrockCommands = [];
  const capturedDdbCommands = [];

  // Simulate Bedrock hallucinating a partner program without escalation
  chat.setBedrockClient({
    send: async (cmd) => {
      capturedBedrockCommands.push(cmd);
      return {
        output: {
          message: {
            content: [
              {
                text: '[DECISION: ANSWER] To become a RenderPDF partner, visit https://www.renderpdf.com and reach out to our sales team.',
              },
            ],
          },
        },
      };
    },
  });

  chat.setDdbClient({
    send: async (cmd) => {
      capturedDdbCommands.push(cmd);
      return {};
    },
  });

  const event = {
    httpMethod: 'POST',
    path: '/api/v1/chat',
    body: JSON.stringify({
      sessionId: 'cs_partner_test',
      message: 'How do I become a RenderPDF partner and discuss partnership opportunities?',
      visitorContext: {},
    }),
  };

  const response = await chat.handleChatMessage(event);
  assert.equal(response.statusCode, 200);

  const payload = JSON.parse(response.body);
  assert.equal(payload.sessionId, 'cs_partner_test');
  assert.equal(payload.escalated, true, 'Partnership question must be escalated');
  assert.equal(payload.decision, '[DECISION: ESCALATE]');
  assert.equal(payload.requiresEmail, true);
  assert.ok(payload.reply.includes('founder and lead engineer (Basil)'));
  assert.ok(payload.reply.includes('What is the best email address for our lead operator to reach you at?'));

  // Ensure hallucinated sales instructions were NOT shown to user
  assert.ok(!payload.reply.includes('reach out to our sales team'));
  assert.ok(!payload.reply.includes('www.renderpdf.com'));

  // Verify DynamoDB persisted as escalated
  const sessionPut = capturedDdbCommands.find((c) => c.input?.Item?.timestamp?.N === '0');
  assert.ok(sessionPut);
  assert.equal(sessionPut.input.Item.status.S, 'escalated');
  assert.equal(sessionPut.input.Item.escalationReason.S, 'high_value_lead');
});

test('handleChatMessage with known email confirms routing to Basil without re-asking email', async () => {
  chat.setBedrockClient({
    send: async () => ({
      output: {
        message: {
          content: [
            {
              text: '[DECISION: ANSWER] Contact our sales team for enterprise reseller agreements.',
            },
          ],
        },
      },
    }),
  });

  chat.setDdbClient({
    send: async () => ({}),
  });

  const event = {
    httpMethod: 'POST',
    path: '/api/v1/chat',
    body: JSON.stringify({
      sessionId: 'cs_reseller_test',
      message: 'Do you offer a reseller program for agencies?',
      visitorContext: {
        email: 'partner@agency.com',
      },
    }),
  };

  const response = await chat.handleChatMessage(event);
  assert.equal(response.statusCode, 200);

  const payload = JSON.parse(response.body);
  assert.equal(payload.escalated, true);
  assert.equal(payload.requiresEmail, false);
  assert.ok(payload.reply.includes('partner@agency.com'));
  assert.ok(payload.reply.includes('Basil'));
});


