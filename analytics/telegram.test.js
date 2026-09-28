'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id, ...args) {
  if (id === '@aws-sdk/client-dynamodb') {
    class MockDynamoDBClient { send() {} }
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
  if (id === '@aws-sdk/client-ses') {
    class MockSESClient { send() {} }
    class SendEmailCommand { constructor(input) { this.input = input; } }
    return { SESClient: MockSESClient, SendEmailCommand };
  }
  if (id === '@aws-sdk/client-cognito-identity-provider') {
    class MockCognitoClient { send() {} }
    class AdminGetUserCommand { constructor(input) { this.input = input; } }
    return { CognitoIdentityProviderClient: MockCognitoClient, AdminGetUserCommand };
  }
  if (id === '@aws-sdk/client-api-gateway') {
    class MockAPIGatewayClient { send() {} }
    return { APIGatewayClient: MockAPIGatewayClient };
  }
  return originalRequire.apply(this, [id, ...args]);
};

process.env.TABLE_NAME = 'renderpdf-usage-test';
const notifications = require('./notifications');

test.beforeEach(() => {
  notifications.resetTelegramClient();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
});

test('sendTelegramMessage returns missing_credentials when env vars are unset', async () => {
  const result = await notifications.sendTelegramMessage('Test alert');
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'missing_credentials');
});

test('sendTelegramMessage dispatches POST to Telegram Bot API with HTML parse mode', async () => {
  process.env.TELEGRAM_BOT_TOKEN = '123456:ABC-DEF';
  process.env.TELEGRAM_CHAT_ID = '987654321';

  let capturedUrl = null;
  let capturedOptions = null;

  notifications.setTelegramFetch(async (url, opts) => {
    capturedUrl = url;
    capturedOptions = opts;
    return {
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    };
  });

  const res = await notifications.sendTelegramMessage('🚨 <b>Test Alert</b>');
  assert.equal(res.sent, true);
  assert.equal(capturedUrl, 'https://api.telegram.org/bot123456:ABC-DEF/sendMessage');
  assert.equal(capturedOptions.method, 'POST');
  assert.equal(capturedOptions.headers['Content-Type'], 'application/json');

  const body = JSON.parse(capturedOptions.body);
  assert.equal(body.chat_id, '987654321');
  assert.equal(body.text, '🚨 <b>Test Alert</b>');
  assert.equal(body.parse_mode, 'HTML');
});

test('formatChatEscalationTelegramMessage builds clean HTML message with transcript and link', () => {
  const msg = notifications.formatChatEscalationTelegramMessage({
    session: {
      sessionId: 'cs_tg_test_1',
      visitorEmail: 'alex@company.com',
      plan: 'pro',
      escalationReason: 'high_value_lead',
    },
    recentMessages: [
      { role: 'user', content: 'We need 200k renders/month for our enterprise app.' },
      { role: 'assistant', content: 'I have routed your inquiry to Basil.' },
    ],
  });

  assert.ok(msg.includes('RenderPDF Chat Escalated'));
  assert.ok(msg.includes('alex@company.com'));
  assert.ok(msg.includes('pro'));
  assert.ok(msg.includes('high value lead'));
  assert.ok(msg.includes('200k renders/month'));
  assert.ok(msg.includes('https://renderpdf.vberkoz.com/app/admin#chats?id=cs_tg_test_1'));
});

test('sendChatEscalationAlert dispatches to Telegram and SES concurrently', async () => {
  process.env.TELEGRAM_BOT_TOKEN = '123456:ABC-DEF';
  process.env.TELEGRAM_CHAT_ID = '987654321';

  let tgCalled = false;
  notifications.setTelegramFetch(async () => {
    tgCalled = true;
    return {
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 101 } }),
    };
  });

  // Mock SES client
  notifications.setSESClient({
    send: async () => ({ MessageId: 'ses_msg_123' }),
  });

  const res = await notifications.sendChatEscalationAlert({
    session: {
      sessionId: 'cs_tg_dual_dispatch',
      visitorEmail: 'lead@startup.co',
      escalationReason: 'partnership_inquiry',
    },
    recentMessages: [
      { role: 'user', content: 'Interested in partnering with RenderPDF.' },
    ],
  });

  assert.equal(res.sent, true);
  assert.equal(res.telegramSent, true);
  assert.equal(tgCalled, true);
});

test('sendTelegramErrorAlert formats error with context and stack', async () => {
  process.env.TELEGRAM_BOT_TOKEN = '123456:ABC-DEF';
  process.env.TELEGRAM_CHAT_ID = '987654321';

  let sentBody = null;
  notifications.setTelegramFetch(async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({ ok: true }),
    };
  });

  const error = new Error('Database connection timed out');
  await notifications.sendTelegramErrorAlert({
    context: 'POST /api/v1/render',
    error,
    details: { requestId: 'req_xyz' },
  });

  assert.ok(sentBody.text.includes('RenderPDF Error: POST /api/v1/render'));
  assert.ok(sentBody.text.includes('Database connection timed out'));
  assert.ok(sentBody.text.includes('req_xyz'));
});

test('sendTelegramBillingAlert formats billing failure alerts', async () => {
  process.env.TELEGRAM_BOT_TOKEN = '123456:ABC-DEF';
  process.env.TELEGRAM_CHAT_ID = '987654321';

  let sentBody = null;
  notifications.setTelegramFetch(async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({ ok: true }),
    };
  });

  await notifications.sendTelegramBillingAlert({
    userId: 'usr_past_due_42',
    customerEmail: 'billing@client.com',
    eventType: 'subscription.past_due',
    reason: 'Card expired',
  });

  assert.ok(sentBody.text.includes('RenderPDF Billing Alert'));
  assert.ok(sentBody.text.includes('billing@client.com'));
  assert.ok(sentBody.text.includes('subscription.past_due'));
  assert.ok(sentBody.text.includes('Card expired'));
});
