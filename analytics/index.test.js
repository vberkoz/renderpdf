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
  return originalRequire.apply(this, [id, ...args]);
};

const analytics = require('./index');

test('subscription.created upgrades free user quota to Starter tier (5,000)', async () => {
  const originalSend = analytics.ddb.send;
  const commands = [];

  analytics.ddb.send = async (command) => {
    commands.push(command);
    // getBilling for previous billing
    if (command.constructor.name === 'GetItemCommand') {
      const key = command.input?.Key?.requestId?.S || '';
      if (key.startsWith('BILLING#')) {
        // User was previously on free tier (no billing record)
        return { Item: null };
      }
      if (key.startsWith('USER_QUOTA#')) {
        // User previously exhausted 25 free renders
        return {
          Item: {
            used: { N: '25' },
            limit: { N: '25' },
          },
        };
      }
    }
    return {};
  };

  try {
    const userId = 'user-test-1';
    const subscriptionId = 'sub-test-1';
    const attributes = {
      id: subscriptionId,
      status: 'active',
      custom_data: { user_id: userId, plan: 'starter' },
      items: [{ price: { product: { name: 'RenderPDF Starter' } } }],
    };
    const eventId = 'evt-1';
    const occurredAt = new Date('2026-09-16T12:00:00Z');

    await analytics.saveBillingWebhook(userId, subscriptionId, attributes, eventId, occurredAt, 'subscription.created');

    // Expected commands:
    // 1: GetItem (BILLING#user-test-1)
    // 2: UpdateItem (BILLING#user-test-1)
    // 3: GetItem (USER_QUOTA#user-test-1#2026-09)
    // 4: UpdateItem (USER_QUOTA#user-test-1#2026-09 with limit 5000)
    assert.strictEqual(commands.length, 4);

    const billingUpdate = commands[1];
    assert.strictEqual(billingUpdate.input.Key.requestId.S, 'BILLING#user-test-1');
    assert.strictEqual(billingUpdate.input.ExpressionAttributeValues[':tier'].S, 'starter');

    const quotaUpdate = commands[3];
    assert.strictEqual(quotaUpdate.input.Key.requestId.S, 'USER_QUOTA#user-test-1#2026-09');
    assert.strictEqual(quotaUpdate.input.ExpressionAttributeValues[':limit'].N, '5000');
    assert.strictEqual(quotaUpdate.input.ExpressionAttributeValues[':entity'].S, 'USER_QUOTA');
    assert.strictEqual(quotaUpdate.input.UpdateExpression, 'SET #limit = :limit, entityType = :entity, expiresAt = :expiresAt, #used = if_not_exists(#used, :zero)');
  } finally {
    analytics.ddb.send = originalSend;
  }
});

test('subscription.updated preserves purchased overage credits upon upgrade', async () => {
  const originalSend = analytics.ddb.send;
  const commands = [];

  analytics.ddb.send = async (command) => {
    commands.push(command);
    if (command.constructor.name === 'GetItemCommand') {
      const key = command.input?.Key?.requestId?.S || '';
      if (key.startsWith('BILLING#')) {
        // User was previously on free tier
        return { Item: null };
      }
      if (key.startsWith('USER_QUOTA#')) {
        // User had 25 free renders + 1,000 purchased overage credits = 1,025 limit
        return {
          Item: {
            used: { N: '25' },
            limit: { N: '1025' },
          },
        };
      }
    }
    return {};
  };

  try {
    const userId = 'user-test-2';
    const subscriptionId = 'sub-test-2';
    const attributes = {
      id: subscriptionId,
      status: 'active',
      custom_data: { user_id: userId, plan: 'starter' },
      items: [{ price: { product: { name: 'RenderPDF Starter' } } }],
    };
    const eventId = 'evt-2';
    const occurredAt = new Date('2026-09-16T12:00:00Z');

    await analytics.saveBillingWebhook(userId, subscriptionId, attributes, eventId, occurredAt, 'subscription.updated');

    const quotaUpdate = commands[3];
    assert.strictEqual(quotaUpdate.input.Key.requestId.S, 'USER_QUOTA#user-test-2#2026-09');
    // Starter (5,000) + Overage (1,000) = 6,000
    assert.strictEqual(quotaUpdate.input.ExpressionAttributeValues[':limit'].N, '6000');
  } finally {
    analytics.ddb.send = originalSend;
  }
});

test('subscription.activated upgrades to Pro tier (20,000)', async () => {
  const originalSend = analytics.ddb.send;
  const commands = [];

  analytics.ddb.send = async (command) => {
    commands.push(command);
    if (command.constructor.name === 'GetItemCommand') {
      const key = command.input?.Key?.requestId?.S || '';
      if (key.startsWith('BILLING#')) {
        // User was previously Starter
        return {
          Item: {
            tier: { S: 'starter' },
            status: { S: 'active' },
          },
        };
      }
      if (key.startsWith('USER_QUOTA#')) {
        // User had starter limit (5,000)
        return {
          Item: {
            used: { N: '5000' },
            limit: { N: '5000' },
          },
        };
      }
    }
    return {};
  };

  try {
    const userId = 'user-test-3';
    const subscriptionId = 'sub-test-3';
    const attributes = {
      id: subscriptionId,
      status: 'active',
      custom_data: { user_id: userId, plan: 'pro' },
      items: [{ price: { product: { name: 'RenderPDF Pro' } } }],
    };
    const eventId = 'evt-3';
    const occurredAt = new Date('2026-09-16T12:00:00Z');

    await analytics.saveBillingWebhook(userId, subscriptionId, attributes, eventId, occurredAt, 'subscription.activated');

    const quotaUpdate = commands[3];
    assert.strictEqual(quotaUpdate.input.Key.requestId.S, 'USER_QUOTA#user-test-3#2026-09');
    // Pro (20,000) + 0 overage = 20,000
    assert.strictEqual(quotaUpdate.input.ExpressionAttributeValues[':limit'].N, '20000');
  } finally {
    analytics.ddb.send = originalSend;
  }
});

test('subscription.canceled does not upgrade quota', async () => {
  const originalSend = analytics.ddb.send;
  const commands = [];

  analytics.ddb.send = async (command) => {
    commands.push(command);
    return {};
  };

  try {
    const userId = 'user-test-4';
    const subscriptionId = 'sub-test-4';
    const attributes = {
      id: subscriptionId,
      status: 'canceled',
      custom_data: { user_id: userId, plan: 'pro' },
    };
    const eventId = 'evt-4';
    const occurredAt = new Date('2026-09-16T12:00:00Z');

    await analytics.saveBillingWebhook(userId, subscriptionId, attributes, eventId, occurredAt, 'subscription.canceled');

    // Only GetItem(BILLING) and UpdateItem(BILLING)
    assert.strictEqual(commands.length, 2);
    assert.strictEqual(commands[1].input.Key.requestId.S, 'BILLING#user-test-4');
  } finally {
    analytics.ddb.send = originalSend;
  }
});

test('upgrading Starter with overage to Pro preserves overage credits (21,000)', async () => {
  const originalSend = analytics.ddb.send;
  const commands = [];

  analytics.ddb.send = async (command) => {
    commands.push(command);
    if (command.constructor.name === 'GetItemCommand') {
      const key = command.input?.Key?.requestId?.S || '';
      if (key.startsWith('BILLING#')) {
        return {
          Item: {
            tier: { S: 'starter' },
            status: { S: 'active' },
          },
        };
      }
      if (key.startsWith('USER_QUOTA#')) {
        // Starter base 5,000 + 1,000 overage = 6,000
        return {
          Item: {
            used: { N: '5500' },
            limit: { N: '6000' },
          },
        };
      }
    }
    return {};
  };

  try {
    const userId = 'user-test-5';
    const subscriptionId = 'sub-test-5';
    const attributes = {
      id: subscriptionId,
      status: 'active',
      custom_data: { user_id: userId, plan: 'pro' },
      items: [{ price: { product: { name: 'RenderPDF Pro' } } }],
    };
    const eventId = 'evt-5';
    const occurredAt = new Date('2026-09-16T12:00:00Z');

    await analytics.saveBillingWebhook(userId, subscriptionId, attributes, eventId, occurredAt, 'subscription.updated');

    const quotaUpdate = commands[3];
    assert.strictEqual(quotaUpdate.input.Key.requestId.S, 'USER_QUOTA#user-test-5#2026-09');
    // Pro (20,000) + 1,000 overage = 21,000
    assert.strictEqual(quotaUpdate.input.ExpressionAttributeValues[':limit'].N, '21000');
  } finally {
    analytics.ddb.send = originalSend;
  }
});

test('subscription.created creates quota record when none exists yet', async () => {
  const originalSend = analytics.ddb.send;
  const commands = [];

  analytics.ddb.send = async (command) => {
    commands.push(command);
    if (command.constructor.name === 'GetItemCommand') {
      return { Item: null };
    }
    return {};
  };

  try {
    const userId = 'user-test-6';
    const subscriptionId = 'sub-test-6';
    const attributes = {
      id: subscriptionId,
      status: 'active',
      custom_data: { user_id: userId, plan: 'starter' },
      items: [{ price: { product: { name: 'RenderPDF Starter' } } }],
    };
    const eventId = 'evt-6';
    const occurredAt = new Date('2026-09-16T12:00:00Z');

    await analytics.saveBillingWebhook(userId, subscriptionId, attributes, eventId, occurredAt, 'subscription.created');

    const quotaUpdate = commands[3];
    assert.strictEqual(quotaUpdate.input.Key.requestId.S, 'USER_QUOTA#user-test-6#2026-09');
    assert.strictEqual(quotaUpdate.input.ExpressionAttributeValues[':limit'].N, '5000');
  } finally {
    analytics.ddb.send = originalSend;
  }
});

test('duplicate webhook with older or identical event does not update quota', async () => {
  const originalSend = analytics.ddb.send;
  const commands = [];

  analytics.ddb.send = async (command) => {
    commands.push(command);
    if (command.constructor.name === 'UpdateItemCommand') {
      const error = new Error('ConditionalCheckFailed');
      error.name = 'ConditionalCheckFailedException';
      throw error;
    }
    return {};
  };

  try {
    const userId = 'user-test-7';
    const subscriptionId = 'sub-test-7';
    const attributes = {
      id: subscriptionId,
      status: 'active',
      custom_data: { user_id: userId, plan: 'starter' },
    };
    const eventId = 'evt-7';
    const occurredAt = new Date('2026-09-16T12:00:00Z');

    await assert.rejects(
      async () => {
        await analytics.saveBillingWebhook(userId, subscriptionId, attributes, eventId, occurredAt, 'subscription.created');
      },
      { name: 'ConditionalCheckFailedException' }
    );

    // Only GetItem(BILLING) and the failed UpdateItem(BILLING)
    assert.strictEqual(commands.length, 2);
  } finally {
    analytics.ddb.send = originalSend;
  }
});

test('tierFromAttributes resolves Pro tier from price ID even if custom_data says starter', () => {
  process.env.PADDLE_STARTER_PRICE_ID = 'pri_starter_123';
  process.env.PADDLE_PRO_PRICE_ID = 'pri_pro_456';

  const tier = analytics.tierFromAttributes({
    items: [{ price: { id: 'pri_pro_456' } }],
    custom_data: { plan: 'starter' },
  });
  assert.strictEqual(tier, 'pro');

  const starterTier = analytics.tierFromAttributes({
    items: [{ price: { id: 'pri_starter_123' } }],
    custom_data: { plan: 'pro' },
  });
  assert.strictEqual(starterTier, 'starter');
});

test('tierFromAttributes resolves Pro tier when Starter is items[0] and Pro is items[1]', () => {
  process.env.PADDLE_STARTER_PRICE_ID = 'pri_starter_123';
  process.env.PADDLE_PRO_PRICE_ID = 'pri_pro_456';

  const tier = analytics.tierFromAttributes({
    items: [
      { price: { id: 'pri_starter_123' }, status: 'inactive' },
      { price: { id: 'pri_pro_456' }, status: 'active' },
    ],
    custom_data: { plan: 'starter' },
  });
  assert.strictEqual(tier, 'pro');
});

test('tierFromAttributes resolves Pro tier when Pro is in scheduled_change items', () => {
  process.env.PADDLE_STARTER_PRICE_ID = 'pri_starter_123';
  process.env.PADDLE_PRO_PRICE_ID = 'pri_pro_456';

  const tier = analytics.tierFromAttributes({
    items: [{ price: { id: 'pri_starter_123' }, status: 'active' }],
    scheduled_change: {
      action: 'update',
      items: [{ price: { id: 'pri_pro_456' }, quantity: 1 }],
    },
    custom_data: { plan: 'starter' },
  });
  assert.strictEqual(tier, 'pro');
});

test('tierFromAttributes resolves Pro tier when item name contains Pro', () => {
  process.env.PADDLE_STARTER_PRICE_ID = 'pri_starter_123';
  process.env.PADDLE_PRO_PRICE_ID = 'pri_pro_456';

  const tier = analytics.tierFromAttributes({
    items: [
      { price: { product: { name: 'RenderPDF Pro' } } },
    ],
  });
  assert.strictEqual(tier, 'pro');
});

test('tierFromAttributes resolves Pro tier when recurring_transaction_details has Pro price', () => {
  process.env.PADDLE_STARTER_PRICE_ID = 'pri_starter_123';
  process.env.PADDLE_PRO_PRICE_ID = 'pri_pro_456';

  const tier = analytics.tierFromAttributes({
    items: [{ price: { id: 'pri_starter_123' } }],
    recurring_transaction_details: {
      line_items: [{ price_id: 'pri_pro_456' }],
    },
  });
  assert.strictEqual(tier, 'pro');
});

test('readCustomerDashboard uses max of quotaRecord.limit and baseQuota (Pro 20,000 > 5,000)', async () => {
  const originalSend = analytics.ddb.send;
  const originalFetch = global.fetch;

  analytics.ddb.send = async (command) => {
    if (command.constructor.name === 'GetItemCommand') {
      const key = command.input?.Key?.requestId?.S || '';
      if (key.startsWith('BILLING#')) {
        return {
          Item: {
            tier: { S: 'pro' },
            status: { S: 'active' },
            subscriptionId: { S: 'sub_active' },
          },
        };
      }
      if (key.startsWith('USER_QUOTA#')) {
        // Obsolete limit of 5,000 from old Starter subscription
        return {
          Item: {
            used: { N: '50' },
            limit: { N: '5000' },
          },
        };
      }
    }
    if (command.constructor.name === 'QueryCommand') {
      return { Items: [] };
    }
    return {};
  };

  // Paddle returns active Pro subscription
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      data: {
        id: 'sub_active',
        status: 'active',
        items: [{ price: { id: process.env.PADDLE_PRO_PRICE_ID || '' } }],
        custom_data: { plan: 'pro' },
      },
    }),
  });

  try {
    const res = await analytics.handler({
      resource: '/api/v1/dashboard',
      httpMethod: 'GET',
      requestContext: {
        authorizer: {
          claims: { sub: 'user-pro-check' },
        },
      },
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.usage.quota, 20000);
    assert.strictEqual(body.usage.remaining, 19950);
    assert.strictEqual(body.billing.tier, 'pro');
  } finally {
    analytics.ddb.send = originalSend;
    global.fetch = originalFetch;
  }
});

test('direct sync does not use condition expression that could reject synchronous syncs', async () => {
  const originalSend = analytics.ddb.send;
  const commands = [];

  analytics.ddb.send = async (command) => {
    commands.push(command);
    return {};
  };

  try {
    const userId = 'user-direct-sync';
    const subscriptionId = 'sub-direct-sync';
    const attributes = {
      id: subscriptionId,
      status: 'active',
      items: [{ price: { id: process.env.PADDLE_PRO_PRICE_ID || '' } }],
    };
    const eventId = `sync-${Date.now()}`;
    const occurredAt = new Date();

    await analytics.saveBillingWebhook(userId, subscriptionId, attributes, eventId, occurredAt, 'subscription.updated');

    const billingUpdate = commands[1];
    assert.strictEqual(billingUpdate.input.ConditionExpression, undefined);
  } finally {
    analytics.ddb.send = originalSend;
  }
});

test('changePlan succeeds and clears scheduled change if present', async () => {
  const originalSend = analytics.ddb.send;
  const originalFetch = global.fetch;
  let sentPatchBody = null;

  analytics.ddb.send = async (command) => {
    if (command.constructor.name === 'GetItemCommand') {
      return {
        Item: {
          subscriptionId: { S: 'sub_has_schedule' },
          status: { S: 'active' },
          tier: { S: 'starter' },
          scheduledAction: { S: 'update' },
          scheduledAt: { S: '2026-10-06T00:00:00Z' },
        },
      };
    }
    return {};
  };

  global.fetch = async (url, options) => {
    if (options?.method === 'PATCH') {
      sentPatchBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          data: {
            id: 'sub_has_schedule',
            status: 'active',
            items: [{ price: { id: process.env.PADDLE_PRO_PRICE_ID || '' } }],
          },
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  process.env.PADDLE_API_KEY = 'test_key';
  try {
    const res = await analytics.changePlan({
      requestContext: { authorizer: { claims: { sub: 'user_plan_change' } } },
      body: JSON.stringify({ plan: 'pro' }),
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.plan, 'pro');
    assert.strictEqual(body.changed, true);
    assert.strictEqual(sentPatchBody.scheduled_change, null);
  } finally {
    analytics.ddb.send = originalSend;
    global.fetch = originalFetch;
  }
});

test('subscription.created with starter_annual upgrades quota to Starter tier (5,000)', async () => {
  const originalSend = analytics.ddb.send;
  const commands = [];

  analytics.ddb.send = async (command) => {
    commands.push(command);
    if (command.constructor.name === 'GetItemCommand') {
      const key = command.input?.Key?.requestId?.S || '';
      if (key.startsWith('BILLING#')) return { Item: null };
      if (key.startsWith('USER_QUOTA#')) return { Item: { used: { N: '25' }, limit: { N: '25' } } };
    }
    return {};
  };

  try {
    const userId = 'user-test-annual-1';
    const subscriptionId = 'sub-test-annual-1';
    const attributes = {
      id: subscriptionId,
      status: 'active',
      custom_data: { user_id: userId, plan: 'starter_annual' },
      items: [{ price: { product: { name: 'RenderPDF Starter Annual' } } }],
    };
    const eventId = 'evt-annual-1';
    const occurredAt = new Date('2026-09-16T12:00:00Z');

    await analytics.saveBillingWebhook(userId, subscriptionId, attributes, eventId, occurredAt, 'subscription.created');

    assert.strictEqual(commands.length, 4);

    const billingUpdate = commands[1];
    assert.strictEqual(billingUpdate.input.Key.requestId.S, 'BILLING#user-test-annual-1');
    assert.strictEqual(billingUpdate.input.ExpressionAttributeValues[':tier'].S, 'starter');
    assert.strictEqual(billingUpdate.input.ExpressionAttributeValues[':interval'].S, 'year');
    assert.strictEqual(billingUpdate.input.ExpressionAttributeValues[':plan'].S, 'RenderPDF Starter (Annual)');

    const quotaUpdate = commands[3];
    assert.strictEqual(quotaUpdate.input.Key.requestId.S, 'USER_QUOTA#user-test-annual-1#2026-09');
    assert.strictEqual(quotaUpdate.input.ExpressionAttributeValues[':limit'].N, '5000');
  } finally {
    analytics.ddb.send = originalSend;
  }
});

test('subscription.created with pro_annual upgrades quota to Pro tier (20,000)', async () => {
  const originalSend = analytics.ddb.send;
  const commands = [];

  analytics.ddb.send = async (command) => {
    commands.push(command);
    if (command.constructor.name === 'GetItemCommand') {
      const key = command.input?.Key?.requestId?.S || '';
      if (key.startsWith('BILLING#')) return { Item: null };
      if (key.startsWith('USER_QUOTA#')) return { Item: { used: { N: '0' }, limit: { N: '25' } } };
    }
    return {};
  };

  try {
    const userId = 'user-test-annual-2';
    const subscriptionId = 'sub-test-annual-2';
    const attributes = {
      id: subscriptionId,
      status: 'active',
      custom_data: { user_id: userId, plan: 'pro_annual' },
      items: [{ price: { product: { name: 'RenderPDF Professional Annual' } } }],
    };
    const eventId = 'evt-annual-2';
    const occurredAt = new Date('2026-09-16T12:00:00Z');

    await analytics.saveBillingWebhook(userId, subscriptionId, attributes, eventId, occurredAt, 'subscription.created');

    assert.strictEqual(commands.length, 4);

    const billingUpdate = commands[1];
    assert.strictEqual(billingUpdate.input.ExpressionAttributeValues[':tier'].S, 'pro');
    assert.strictEqual(billingUpdate.input.ExpressionAttributeValues[':interval'].S, 'year');
    assert.strictEqual(billingUpdate.input.ExpressionAttributeValues[':plan'].S, 'RenderPDF Professional (Annual)');

    const quotaUpdate = commands[3];
    assert.strictEqual(quotaUpdate.input.ExpressionAttributeValues[':limit'].N, '20000');
  } finally {
    analytics.ddb.send = originalSend;
  }
});

test('tierFromAttributes and intervalFromAttributes resolve annual pricing and intervals', () => {
  process.env.PADDLE_STARTER_PRICE_ID = 'pri_starter_123';
  process.env.PADDLE_STARTER_ANNUAL_PRICE_ID = 'pri_starter_yr_123';
  process.env.PADDLE_PRO_PRICE_ID = 'pri_pro_456';
  process.env.PADDLE_PRO_ANNUAL_PRICE_ID = 'pri_pro_yr_456';

  const subStarterAnnual = {
    items: [{ price: { id: 'pri_starter_yr_123' } }],
  };
  assert.strictEqual(analytics.tierFromAttributes(subStarterAnnual), 'starter');
  assert.strictEqual(analytics.intervalFromAttributes(subStarterAnnual), 'year');

  const subProAnnual = {
    items: [{ price: { id: 'pri_pro_yr_456' } }],
  };
  assert.strictEqual(analytics.tierFromAttributes(subProAnnual), 'pro');
  assert.strictEqual(analytics.intervalFromAttributes(subProAnnual), 'year');

  const subMonthly = {
    items: [{ price: { id: 'pri_starter_123' } }],
  };
  assert.strictEqual(analytics.tierFromAttributes(subMonthly), 'starter');
  assert.strictEqual(analytics.intervalFromAttributes(subMonthly), 'month');
});

test('receiveOverageWebhook credits 1,000 PDFs for price pri_01m2fzxsmngvj4a5186zydh2ej', async () => {
  process.env.PADDLE_OVERAGE_PRICE_ID = 'pri_01m2fzxsmngvj4a5186zydh2ej';
  const originalSend = analytics.ddb.send;
  const commands = [];

  analytics.ddb.send = async (command) => {
    commands.push(command);
    if (command.constructor.name === 'GetItemCommand') {
      const key = command.input?.Key?.requestId?.S || '';
      if (key.startsWith('BILLING#')) {
        // User on Starter tier (5,000 quota)
        return { Item: { tier: { S: 'starter' }, status: { S: 'active' } } };
      }
    }
    return {};
  };

  try {
    const payload = {
      event_id: 'evt_overage_test_1',
      occurred_at: '2026-09-19T10:00:00Z',
      data: {
        id: 'txn_overage_123',
        custom_data: { user_id: 'user_overage_test', entitlement: 'overage' },
        items: [
          {
            price: { id: 'pri_01m2fzxsmngvj4a5186zydh2ej' },
            quantity: 1,
          },
        ],
      },
    };

    const res = await analytics.receiveOverageWebhook(payload);
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.received, true);

    assert.strictEqual(commands.length, 2);

    const transact = commands[1];
    assert.strictEqual(transact.constructor.name, 'TransactWriteItemsCommand');
    const items = transact.input.TransactItems;
    assert.strictEqual(items.length, 2);

    // Put OVERAGE record
    const putItem = items[0].Put.Item;
    assert.strictEqual(putItem.requestId.S, 'OVERAGE#txn_overage_123');
    assert.strictEqual(putItem.customerId.S, 'user_overage_test');
    assert.strictEqual(putItem.paddleTransactionId.S, 'txn_overage_123');
    assert.strictEqual(putItem.credits.N, '1000');

    // Update USER_QUOTA
    const quotaUpdate = items[1].Update;
    assert.strictEqual(quotaUpdate.Key.requestId.S, 'USER_QUOTA#user_overage_test#2026-09');
    assert.strictEqual(quotaUpdate.ExpressionAttributeValues[':baseQuota'].N, '5000');
    assert.strictEqual(quotaUpdate.ExpressionAttributeValues[':credits'].N, '1000');
  } finally {
    analytics.ddb.send = originalSend;
  }
});

test('receiveOverageWebhook ignores transaction with mismatched price ID', async () => {
  process.env.PADDLE_OVERAGE_PRICE_ID = 'pri_01m2fzxsmngvj4a5186zydh2ej';
  const payload = {
    event_id: 'evt_overage_test_mismatch',
    occurred_at: '2026-09-19T10:00:00Z',
    data: {
      id: 'txn_wrong_price',
      custom_data: { user_id: 'user_overage_test', entitlement: 'overage' },
      items: [
        {
          price: { id: 'pri_some_other_price' },
          quantity: 1,
        },
      ],
    },
  };

  const res = await analytics.receiveOverageWebhook(payload);
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.ignored, true);
});

test('createCheckout with plan overage succeeds at any time without requiring quota exhaustion', async () => {
  const originalFetch = global.fetch;
  let postedBody = null;

  global.fetch = async (url, options) => {
    if (options?.method === 'POST') {
      postedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          data: {
            id: 'txn_overage_test_checkout',
          },
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  process.env.PADDLE_API_KEY = 'test_key';
  process.env.PADDLE_CLIENT_TOKEN = 'test_client_token';
  process.env.PADDLE_OVERAGE_PRICE_ID = 'pri_01m2fzxsmngvj4a5186zydh2ej';
  process.env.PADDLE_CHECKOUT_URL = 'https://renderpdf.vberkoz.com/app/?view=billing';

  try {
    const res = await analytics.createCheckout({
      requestContext: { authorizer: { claims: { sub: 'user_checkout_test' } } },
      body: JSON.stringify({ plan: 'overage' }),
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.transactionId, 'txn_overage_test_checkout');
    assert.strictEqual(body.clientToken, 'test_client_token');

    assert.strictEqual(postedBody.items[0].price_id, 'pri_01m2fzxsmngvj4a5186zydh2ej');
    assert.strictEqual(postedBody.custom_data.user_id, 'user_checkout_test');
    assert.strictEqual(postedBody.custom_data.user_email, '');
    assert.strictEqual(postedBody.custom_data.entitlement, 'overage');
  } finally {
    global.fetch = originalFetch;
  }
});

test('buildPaymentFailedEmail formats email with prompt and quick link to update payment method', () => {
  const notifications = require('./notifications');
  const { subject, html, text } = notifications.buildPaymentFailedEmail('billing@example.com');

  assert.ok(subject.includes('Payment failed'));
  const prompt = 'Please update your payment method promptly to prevent your API access from being suspended.';
  assert.ok(text.includes(prompt));
  assert.ok(html.includes('update your payment method promptly'));
  assert.ok(text.includes('https://renderpdf.vberkoz.com/app/#billing'));
  assert.ok(html.includes('https://renderpdf.vberkoz.com/app/#billing'));
});

test('subscription.past_due triggers payment failed alert email via SES', async () => {
  const notifications = require('./notifications');
  const sentEmails = [];
  notifications.setSESClient({
    send: async (command) => {
      sentEmails.push(command.input);
      return { MessageId: 'ses_msg_123' };
    },
  });

  const commands = [];
  const origSend = analytics.ddb.send;
  analytics.ddb.send = async (command) => {
    commands.push(command);
    if (command.constructor.name === 'GetItemCommand') {
      const key = command.input.Key.requestId.S;
      if (key === 'BILLING#user_past_due_1') {
        return {
          Item: {
            status: { S: 'active' },
            tier: { S: 'pro' },
            customerEmail: { S: 'user1@example.com' },
          },
        };
      }
      return { Item: null };
    }
    return {};
  };

  try {
    await analytics.saveBillingWebhook(
      'user_past_due_1',
      'sub_123',
      {
        status: 'past_due',
        custom_data: { user_id: 'user_past_due_1', user_email: 'user1@example.com' },
      },
      'evt_past_due_1',
      new Date('2026-09-20T10:00:00Z'),
      'subscription.past_due'
    );

    assert.strictEqual(sentEmails.length, 1);
    assert.strictEqual(sentEmails[0].Destination.ToAddresses[0], 'user1@example.com');
    assert.ok(sentEmails[0].Message.Subject.Data.includes('Payment failed'));

    // Verify pastDueAlertSentAt was updated in DynamoDB
    const alertUpdate = commands.find(
      (c) => c.constructor.name === 'UpdateItemCommand' && c.input.UpdateExpression === 'SET pastDueAlertSentAt = :now'
    );
    assert.ok(alertUpdate, 'expected pastDueAlertSentAt update command');
    assert.strictEqual(alertUpdate.input.Key.requestId.S, 'BILLING#user_past_due_1');
  } finally {
    analytics.ddb.send = origSend;
  }
});

test('duplicate subscription.past_due webhook does not resend payment failed alert', async () => {
  const notifications = require('./notifications');
  const sentEmails = [];
  notifications.setSESClient({
    send: async (command) => {
      sentEmails.push(command.input);
      return { MessageId: 'ses_msg_123' };
    },
  });

  const origSend = analytics.ddb.send;
  analytics.ddb.send = async (command) => {
    if (command.constructor.name === 'GetItemCommand') {
      const key = command.input.Key.requestId.S;
      if (key === 'BILLING#user_past_due_dup') {
        return {
          Item: {
            status: { S: 'past_due' },
            tier: { S: 'pro' },
            customerEmail: { S: 'user_dup@example.com' },
            pastDueAlertSentAt: { S: '1700000000' },
          },
        };
      }
      return { Item: null };
    }
    return {};
  };

  try {
    await analytics.saveBillingWebhook(
      'user_past_due_dup',
      'sub_123',
      {
        status: 'past_due',
        custom_data: { user_id: 'user_past_due_dup', user_email: 'user_dup@example.com' },
      },
      'evt_past_due_dup',
      new Date('2026-09-20T10:00:00Z'),
      'subscription.past_due'
    );

    assert.strictEqual(sentEmails.length, 0, 'duplicate past due webhook should not resend alert');
  } finally {
    analytics.ddb.send = origSend;
  }
});

test('transaction.payment_failed triggers payment failed alert email', async () => {
  const notifications = require('./notifications');
  const sentEmails = [];
  notifications.setSESClient({
    send: async (command) => {
      sentEmails.push(command.input);
      return { MessageId: 'ses_msg_123' };
    },
  });

  const origSend = analytics.ddb.send;
  analytics.ddb.send = async (command) => {
    if (command.constructor.name === 'GetItemCommand') {
      const key = command.input.Key.requestId.S;
      if (key === 'BILLING#user_txn_failed') {
        return {
          Item: {
            status: { S: 'active' },
            customerEmail: { S: 'fail@example.com' },
          },
        };
      }
      return { Item: null };
    }
    return {};
  };

  try {
    const res = await analytics.receivePaymentFailedWebhook({
      event_type: 'transaction.payment_failed',
      data: {
        id: 'txn_fail_123',
        custom_data: { user_id: 'user_txn_failed', user_email: 'fail@example.com' },
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(sentEmails.length, 1);
    assert.strictEqual(sentEmails[0].Destination.ToAddresses[0], 'fail@example.com');
  } finally {
    analytics.ddb.send = origSend;
  }
});

test('syncUserUsagePlans migrates active keys between usage plans', async () => {
  const origDdbSend = analytics.ddb.send;
  const origApigwSend = analytics.apigw.send;
  const apigwCommands = [];

  process.env.API_KEYS_TABLE = 'ApiKeysTable';
  process.env.FREE_USAGE_PLAN_ID = 'free-plan-id';
  process.env.STARTER_USAGE_PLAN_ID = 'starter-plan-id';
  process.env.PRO_USAGE_PLAN_ID = 'pro-plan-id';

  analytics.ddb.send = async (cmd) => {
    if (cmd.constructor.name === 'QueryCommand') {
      return {
        Items: [
          {
            PK: { S: 'USER#user_plan_test' },
            SK: { S: 'APIKEY#key_1' },
            isActive: { BOOL: true },
            apiGatewayKeyId: { S: 'agw_key_1' },
          },
          {
            PK: { S: 'USER#user_plan_test' },
            SK: { S: 'APIKEY#key_inactive' },
            isActive: { BOOL: false },
            apiGatewayKeyId: { S: 'agw_key_2' },
          },
        ],
      };
    }
    return {};
  };

  analytics.apigw.send = async (cmd) => {
    apigwCommands.push(cmd);
    return {};
  };

  try {
    await analytics.syncUserUsagePlans('user_plan_test', 'pro');
    assert.ok(apigwCommands.length > 0);
    const createCmd = apigwCommands.find(c => c.constructor.name === 'CreateUsagePlanKeyCommand');
    assert.ok(createCmd);
    assert.strictEqual(createCmd.input.UsagePlanId, 'pro-plan-id');
    assert.strictEqual(createCmd.input.KeyId, 'agw_key_1');
  } finally {
    analytics.ddb.send = origDdbSend;
    analytics.apigw.send = origApigwSend;
  }
});

test('latencyBucket classifies render durations into expected buckets', () => {
  assert.strictEqual(analytics.latencyBucket(0), 'under_400ms');
  assert.strictEqual(analytics.latencyBucket(350), 'under_400ms');
  assert.strictEqual(analytics.latencyBucket(399), 'under_400ms');
  assert.strictEqual(analytics.latencyBucket(400), '400ms_to_800ms');
  assert.strictEqual(analytics.latencyBucket(799), '400ms_to_800ms');
  assert.strictEqual(analytics.latencyBucket(800), '800ms_to_1500ms');
  assert.strictEqual(analytics.latencyBucket(1499), '800ms_to_1500ms');
  assert.strictEqual(analytics.latencyBucket(1500), 'over_1500ms');
  assert.strictEqual(analytics.latencyBucket(5000), 'over_1500ms');
});

test('recordRenderRollup sends expected atomic ADD parameters and targets under_400ms for success', async () => {
  const origDdbSend = analytics.ddb.send;
  const commands = [];
  analytics.ddb.send = async (cmd) => {
    commands.push(cmd);
    return {};
  };

  try {
    await analytics.recordRenderRollup('success', 350, 50000, 'pro');

    assert.strictEqual(commands.length, 1);
    const cmd = commands[0];
    assert.strictEqual(cmd.constructor.name, 'UpdateItemCommand');
    assert.ok(cmd.input.Key.requestId.S.startsWith('ROLLUP#'));
    assert.strictEqual(cmd.input.Key.timestamp.N, '0');
    assert.ok(cmd.input.UpdateExpression.includes('ADD rendering.totalRenders :one'));
    assert.strictEqual(cmd.input.ExpressionAttributeNames['#rendSuccess'], 'rendering.successes');
    assert.strictEqual(cmd.input.ExpressionAttributeNames['#rendError'], 'dummy_error');
    assert.strictEqual(cmd.input.ExpressionAttributeNames['#plan'], 'pro');
    assert.strictEqual(cmd.input.ExpressionAttributeNames['#latBucket'], 'under_400ms');
    assert.strictEqual(cmd.input.ExpressionAttributeValues[':one'].N, '1');
    assert.strictEqual(cmd.input.ExpressionAttributeValues[':size'].N, '50000');
    assert.strictEqual(cmd.input.ExpressionAttributeValues[':duration'].N, '350');
    assert.strictEqual(cmd.input.ExpressionAttributeValues[':succIncr'].N, '1');
    assert.strictEqual(cmd.input.ExpressionAttributeValues[':errIncr'].N, '0');
  } finally {
    analytics.ddb.send = origDdbSend;
  }
});

test('recordRenderRollup increments rendering.errors on error outcome with dateKey', async () => {
  const origDdbSend = analytics.ddb.send;
  const commands = [];
  analytics.ddb.send = async (cmd) => {
    commands.push(cmd);
    return {};
  };

  try {
    await analytics.recordRenderRollup('error', 950, 0, 'starter', '2026-09-27');

    assert.strictEqual(commands.length, 1);
    const cmd = commands[0];
    assert.strictEqual(cmd.constructor.name, 'UpdateItemCommand');
    assert.strictEqual(cmd.input.Key.requestId.S, 'ROLLUP#2026-09-27');
    assert.strictEqual(cmd.input.Key.timestamp.N, '0');
    assert.strictEqual(cmd.input.ExpressionAttributeNames['#rendSuccess'], 'dummy_success');
    assert.strictEqual(cmd.input.ExpressionAttributeNames['#rendError'], 'rendering.errors');
    assert.strictEqual(cmd.input.ExpressionAttributeNames['#plan'], 'starter');
    assert.strictEqual(cmd.input.ExpressionAttributeNames['#latBucket'], '800ms_to_1500ms');
    assert.strictEqual(cmd.input.ExpressionAttributeValues[':succIncr'].N, '0');
    assert.strictEqual(cmd.input.ExpressionAttributeValues[':errIncr'].N, '1');
    assert.strictEqual(cmd.input.ExpressionAttributeValues[':size'].N, '0');
    assert.strictEqual(cmd.input.ExpressionAttributeValues[':duration'].N, '950');
  } finally {
    analytics.ddb.send = origDdbSend;
  }
});

test('recordRenderRollup handles optional parameters and defaults', async () => {
  const origDdbSend = analytics.ddb.send;
  const commands = [];
  analytics.ddb.send = async (cmd) => {
    commands.push(cmd);
    return {};
  };

  try {
    await analytics.recordRenderRollup('failed');

    assert.strictEqual(commands.length, 1);
    const cmd = commands[0];
    assert.strictEqual(cmd.input.ExpressionAttributeNames['#plan'], 'unknown');
    assert.strictEqual(cmd.input.ExpressionAttributeNames['#latBucket'], 'under_400ms');
    assert.strictEqual(cmd.input.ExpressionAttributeNames['#rendSuccess'], 'dummy_success');
    assert.strictEqual(cmd.input.ExpressionAttributeNames['#rendError'], 'rendering.errors');
    assert.strictEqual(cmd.input.ExpressionAttributeValues[':size'].N, '0');
    assert.strictEqual(cmd.input.ExpressionAttributeValues[':duration'].N, '0');
    assert.strictEqual(cmd.input.ExpressionAttributeValues[':succIncr'].N, '0');
    assert.strictEqual(cmd.input.ExpressionAttributeValues[':errIncr'].N, '1');
  } finally {
    analytics.ddb.send = origDdbSend;
  }
});

test('saveAnalytics increments corresponding acquisition and activation rollups for known events', async () => {
  const origDdbSend = analytics.ddb.send;

  const eventMap = {
    page_viewed: 'acquisition.pageViews',
    trial_render_submitted: 'acquisition.playgroundSubmits',
    trial_render_succeeded: 'acquisition.playgroundSuccesses',
    signup_started: 'activation.signupStarted',
    signup_completed: 'activation.signupCompleted',
    api_key_created: 'activation.apiKeysCreated',
  };

  try {
    for (const [eventName, expectedTarget] of Object.entries(eventMap)) {
      const commands = [];
      analytics.ddb.send = async (cmd) => {
        commands.push(cmd);
        return {};
      };

      const res = await analytics.saveAnalytics({
        body: JSON.stringify({ event: eventName }),
      });

      assert.strictEqual(res.statusCode, 202);
      assert.strictEqual(commands.length, 2);

      const putCmd = commands[0];
      assert.strictEqual(putCmd.constructor.name, 'PutItemCommand');
      assert.strictEqual(putCmd.input.Item.eventName.S, eventName);

      const rollupCmd = commands[1];
      assert.strictEqual(rollupCmd.constructor.name, 'UpdateItemCommand');
      assert.ok(rollupCmd.input.Key.requestId.S.startsWith('ROLLUP#'));
      assert.strictEqual(rollupCmd.input.Key.timestamp.N, '0');
      assert.strictEqual(rollupCmd.input.UpdateExpression, `ADD ${expectedTarget} :one`);
      assert.strictEqual(rollupCmd.input.ExpressionAttributeValues[':one'].N, '1');
    }
  } finally {
    analytics.ddb.send = origDdbSend;
  }
});

test('saveAnalytics does not trigger rollup update for untracked event names', async () => {
  const origDdbSend = analytics.ddb.send;
  const commands = [];
  analytics.ddb.send = async (cmd) => {
    commands.push(cmd);
    return {};
  };

  try {
    const res = await analytics.saveAnalytics({
      body: JSON.stringify({ event: 'untracked_button_click' }),
    });

    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(commands.length, 1);
    assert.strictEqual(commands[0].constructor.name, 'PutItemCommand');
  } finally {
    analytics.ddb.send = origDdbSend;
  }
});

test('readAdminAnalytics returns 403 Forbidden for non-admin callers', async () => {
  // Missing authorizer claims
  const res1 = await analytics.readAdminAnalytics({});
  assert.strictEqual(res1.statusCode, 403);
  assert.deepStrictEqual(JSON.parse(res1.body), { error: 'Forbidden' });

  // Non-admin group and unauthorized email
  const res2 = await analytics.readAdminAnalytics({
    requestContext: {
      authorizer: {
        claims: {
          'cognito:groups': ['Users'],
          email: 'regular_user@example.com',
        },
      },
    },
  });
  assert.strictEqual(res2.statusCode, 403);

  // String group that is not Admins
  const res3 = await analytics.readAdminAnalytics({
    requestContext: {
      authorizer: {
        claims: {
          'cognito:groups': 'Viewers',
          email: 'unauth@domain.com',
        },
      },
    },
  });
  assert.strictEqual(res3.statusCode, 403);
});

test('readAdminAnalytics allows admin caller via cognito:groups or STATS_ALLOWED_EMAIL', async () => {
  const origDdbSend = analytics.ddb.send;
  const commands = [];
  analytics.ddb.send = async (cmd) => {
    commands.push(cmd);
    return { Responses: { [process.env.TABLE_NAME || 'RenderPdfTable']: [] } };
  };

  try {
    // Via cognito:groups array
    const res1 = await analytics.readAdminAnalytics({
      requestContext: {
        authorizer: {
          claims: {
            'cognito:groups': ['Admins', 'Developers'],
            email: 'admin1@example.com',
          },
        },
      },
    });
    assert.strictEqual(res1.statusCode, 200);

    // Via cognito:groups string
    const res2 = await analytics.readAdminAnalytics({
      requestContext: {
        authorizer: {
          claims: {
            'cognito:groups': 'Admins',
            email: 'admin2@example.com',
          },
        },
      },
    });
    assert.strictEqual(res2.statusCode, 200);

    // Via STATS_ALLOWED_EMAIL
    const res3 = await analytics.readAdminAnalytics({
      requestContext: {
        authorizer: {
          claims: {
            email: 'vberkoz@gmail.com',
          },
        },
      },
    });
    assert.strictEqual(res3.statusCode, 200);
  } finally {
    analytics.ddb.send = origDdbSend;
  }
});

test('readAdminAnalytics queries batch keys for requested days (default 30, custom 7)', async () => {
  const origDdbSend = analytics.ddb.send;
  const commands = [];
  analytics.ddb.send = async (cmd) => {
    commands.push(cmd);
    return { Responses: {} };
  };

  try {
    // Default 30 days
    await analytics.readAdminAnalytics({
      requestContext: {
        authorizer: { claims: { 'cognito:groups': ['Admins'] } },
      },
    });
    const batchCmds1 = commands.filter((cmd) => cmd.constructor.name === 'BatchGetItemCommand');
    assert.strictEqual(batchCmds1.length, 1);
    const cmd1 = batchCmds1[0];
    const tableKeys1 = Object.values(cmd1.input.RequestItems)[0].Keys;
    assert.strictEqual(tableKeys1.length, 30);
    assert.ok(tableKeys1[0].requestId.S.startsWith('ROLLUP#'));
    assert.strictEqual(tableKeys1[0].timestamp.N, '0');

    // Custom 7 days
    commands.length = 0;
    await analytics.readAdminAnalytics({
      queryStringParameters: { days: '7' },
      requestContext: {
        authorizer: { claims: { 'cognito:groups': ['Admins'] } },
      },
    });
    const batchCmds2 = commands.filter((cmd) => cmd.constructor.name === 'BatchGetItemCommand');
    assert.strictEqual(batchCmds2.length, 1);
    const tableKeys2 = Object.values(batchCmds2[0].input.RequestItems)[0].Keys;
    assert.strictEqual(tableKeys2.length, 7);
  } finally {
    analytics.ddb.send = origDdbSend;
  }
});

test('readAdminAnalytics parses funnels, unit economics, latency, and daily rollups accurately', async () => {
  const origDdbSend = analytics.ddb.send;

  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const dateStr1 = analytics.dateKey(yesterday);
  const dateStr2 = analytics.dateKey(now);

  const sampleRollup1 = {
    requestId: { S: `ROLLUP#${dateStr1}` },
    timestamp: { N: '0' },
    entityType: { S: 'DAILY_ROLLUP' },
    acquisition: {
      M: {
        pageViews: { N: '1000' },
        playgroundSubmits: { N: '200' },
      },
    },
    activation: {
      M: {
        signupCompleted: { N: '20' },
        apiKeysCreated: { N: '15' },
        firstApiCalls: { N: '10' },
        ttfcBuckets: {
          M: {
            under_5m: { N: '6' },
            '5m_to_30m': { N: '3' },
            '30m_to_2h': { N: '1' },
            over_2h: { N: '0' },
          },
        },
      },
    },
    monetization: {
      M: {
        checkoutsCompleted: { N: '2' },
        revenueUsd: { N: '50.00' },
      },
    },
    rendering: {
      M: {
        totalRenders: { N: '5000' },
        successes: { N: '4990' },
        errors: { N: '10' },
        totalDurationMs: { N: '2500000' },
        totalBytes: { N: '500000000' },
        latencyBuckets: {
          M: {
            under_400ms: { N: '4500' },
            '400ms_to_800ms': { N: '400' },
            '800ms_to_1500ms': { N: '90' },
            over_1500ms: { N: '10' },
          },
        },
      },
    },
  };

  const sampleRollup2 = {
    requestId: { S: `ROLLUP#${dateStr2}` },
    timestamp: { N: '0' },
    entityType: { S: 'DAILY_ROLLUP' },
    summary: {
      M: {
        totalUsers: { N: '1420' },
        activeSubscriptions: { N: '84' },
        mrrUsd: { N: '3456.00' },
      },
    },
    acquisition: {
      M: {
        pageViews: { N: '1500' },
        playgroundSubmits: { N: '300' },
      },
    },
    activation: {
      M: {
        signupCompleted: { N: '30' },
        apiKeysCreated: { N: '25' },
        firstApiCalls: { N: '20' },
        ttfcBuckets: {
          M: {
            under_5m: { N: '14' },
            '5m_to_30m': { N: '5' },
            '30m_to_2h': { N: '1' },
            over_2h: { N: '0' },
          },
        },
      },
    },
    monetization: {
      M: {
        checkoutsCompleted: { N: '3' },
        revenueUsd: { N: '75.00' },
      },
    },
    rendering: {
      M: {
        totalRenders: { N: '6000' },
        successes: { N: '5995' },
        errors: { N: '5' },
        totalDurationMs: { N: '3000000' },
        totalBytes: { N: '600000000' },
        latencyBuckets: {
          M: {
            under_400ms: { N: '5300' },
            '400ms_to_800ms': { N: '500' },
            '800ms_to_1500ms': { N: '150' },
            over_1500ms: { N: '50' },
          },
        },
      },
    },
  };

  analytics.ddb.send = async () => {
    return {
      Responses: {
        RenderPdfTable: [sampleRollup1, sampleRollup2],
      },
    };
  };

  try {
    const res = await analytics.readAdminAnalytics({
      queryStringParameters: { days: '2' },
      requestContext: {
        authorizer: { claims: { 'cognito:groups': ['Admins'] } },
      },
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);

    // Summary assertions
    assert.strictEqual(body.summary.totalUsers, 1420);
    assert.strictEqual(body.summary.activeSubscriptions, 84);
    assert.strictEqual(body.summary.mrrUsd, 3456.00);
    assert.ok(body.summary.grossMarginPercent > 90);
    assert.ok(body.summary.costPerThousandPdfsUsd > 0);

    // Funnel assertions
    assert.strictEqual(body.funnel.pageViews, 2500);
    assert.strictEqual(body.funnel.playgroundSubmits, 500);
    assert.strictEqual(body.funnel.playgroundActivationRate, 20); // (500 / 2500) * 100 = 20%
    assert.strictEqual(body.funnel.signupsCompleted, 50);
    assert.strictEqual(body.funnel.trialToSignupRate, 10); // (50 / 500) * 100 = 10%
    assert.strictEqual(body.funnel.apiKeysCreated, 40);
    assert.strictEqual(body.funnel.signupToKeyRate, 80); // (40 / 50) * 100 = 80%
    assert.strictEqual(body.funnel.firstApiCalls, 30);
    assert.ok(body.funnel.ttfcMedianMinutes > 0 && body.funnel.ttfcMedianMinutes < 10);

    // Rendering assertions
    assert.strictEqual(body.rendering.totalRenders, 11000);
    assert.strictEqual(body.rendering.latencyHistogram.under_400ms, 9800);
    assert.strictEqual(body.rendering.latencyHistogram['400ms_to_800ms'], 900);
    assert.strictEqual(body.rendering.latencyHistogram['800ms_to_1500ms'], 240);
    assert.strictEqual(body.rendering.latencyHistogram.over_1500ms, 60);
    assert.ok(body.rendering.successRate > 99.8);
    assert.ok(body.rendering.p95RenderMs > 0);

    // Daily rollups assertions
    assert.strictEqual(body.dailyRollups.length, 2);
    const day1 = body.dailyRollups.find((d) => d.date === dateStr1);
    assert.ok(day1);
    assert.strictEqual(day1.renders, 5000);
    assert.strictEqual(day1.errors, 10);
    assert.strictEqual(day1.revenueUsd, 50);
    assert.ok(day1.estimatedAwsCostUsd > 0);
    assert.ok(day1.marginPercent > 90);
  } finally {
    analytics.ddb.send = origDdbSend;
  }
});

test('calculateP95 correctly reflects skewed duration distributions', () => {
  // Case 1: 96% under 400ms
  const p95Fast = analytics.calculateP95({
    under_400ms: 96,
    '400ms_to_800ms': 4,
    '800ms_to_1500ms': 0,
    over_1500ms: 0,
  });
  assert.ok(p95Fast <= 400, `Expected p95 <= 400, got ${p95Fast}`);
  assert.ok(p95Fast >= 100, `Expected p95 >= 100, got ${p95Fast}`);

  // Case 2: 90% under 400ms, 10% in 400ms_to_800ms (P95 falls into 400ms_to_800ms)
  const p95Mid = analytics.calculateP95({
    under_400ms: 90,
    '400ms_to_800ms': 10,
    '800ms_to_1500ms': 0,
    over_1500ms: 0,
  });
  assert.ok(p95Mid >= 400 && p95Mid <= 800, `Expected 400 <= p95 <= 800, got ${p95Mid}`);

  // Case 3: 90% in 400-800ms, 10% in 800-1500ms (P95 falls into 800ms_to_1500ms)
  const p95High = analytics.calculateP95({
    under_400ms: 0,
    '400ms_to_800ms': 90,
    '800ms_to_1500ms': 10,
    over_1500ms: 0,
  });
  assert.ok(p95High >= 800 && p95High <= 1500, `Expected 800 <= p95 <= 1500, got ${p95High}`);

  // Case 4: Heavy tail over 1500ms
  const p95Slow = analytics.calculateP95({
    under_400ms: 50,
    '400ms_to_800ms': 20,
    '800ms_to_1500ms': 10,
    over_1500ms: 20,
  });
  assert.ok(p95Slow >= 1500, `Expected p95 >= 1500, got ${p95Slow}`);

  // Edge case: Empty histogram
  assert.strictEqual(analytics.calculateP95({}), 0);
  assert.strictEqual(analytics.calculateP95(null), 0);
});

test('financial math helpers calculate AWS cost and gross margin correctly', () => {
  // Lambda Cost: (totalDurationMs / 1000) * (2048 / 1024) * 0.0000166667 + (totalRenders * 0.20 / 1000000)
  // S3 Cost: (totalRenders * 0.005 / 1000) + ((totalBytes / 1e9) * 0.023)
  const renders = 10000;
  const durationMs = 5000000;
  const bytes = 1000000000; // 1 GB
  const cost = analytics.calculateAwsCost(renders, durationMs, bytes);

  const expectedLambda = (5000000 / 1000) * 2 * 0.0000166667 + (10000 * 0.20 / 1000000);
  const expectedS3 = (10000 * 0.005 / 1000) + ((1000000000 / 1e9) * 0.023);
  const expectedTotal = expectedLambda + expectedS3;
  assert.ok(Math.abs(cost - expectedTotal) < 0.00001);

  // Gross Margin: ((attributedRevenue - awsCost) / attributedRevenue) * 100
  const margin = analytics.calculateGrossMargin(100, cost);
  const expectedMargin = ((100 - cost) / 100) * 100;
  assert.ok(Math.abs(margin - expectedMargin) < 0.0001);

  // 0 revenue returns 0% margin
  assert.strictEqual(analytics.calculateGrossMargin(0, cost), 0);
  assert.strictEqual(analytics.calculateGrossMargin(-10, cost), 0);
});

test('handler correctly routes GET and OPTIONS /api/v1/admin/analytics', async () => {
  const origDdbSend = analytics.ddb.send;
  analytics.ddb.send = async () => ({ Responses: {} });

  try {
    // OPTIONS
    const optRes = await analytics.handler({
      resource: '/api/v1/admin/analytics',
      httpMethod: 'OPTIONS',
    });
    assert.strictEqual(optRes.statusCode, 204);

    // POST returns 405 Method Not Allowed
    const postRes = await analytics.handler({
      resource: '/api/v1/admin/analytics',
      httpMethod: 'POST',
    });
    assert.strictEqual(postRes.statusCode, 405);

    // GET with admin claims routes to readAdminAnalytics
    const getRes = await analytics.handler({
      resource: '/api/v1/admin/analytics',
      httpMethod: 'GET',
      requestContext: {
        authorizer: { claims: { 'cognito:groups': ['Admins'] } },
      },
    });
    assert.strictEqual(getRes.statusCode, 200);
  } finally {
    analytics.ddb.send = origDdbSend;
  }
});

test('readAdminAnalytics automatically aggregates raw USAGE and ANALYTICS items when ROLLUP is missing', async () => {
  const origDdbSend = analytics.ddb.send;
  const now = new Date();
  const todayStr = analytics.dateKey(now);

  analytics.ddb.send = async (cmd) => {
    if (cmd.constructor.name === 'BatchGetItemCommand') {
      return { Responses: {} };
    }
    if (cmd.constructor.name === 'QueryCommand') {
      const pk = cmd.input.ExpressionAttributeValues[':pk'].S;
      if (pk === `USAGE#${todayStr}`) {
        return {
          Items: [
            {
              entityType: { S: 'PDF_REQUEST' },
              status: { S: 'success' },
              plan: { S: 'trial' },
              durationMs: { N: '500' },
              renderDurationMs: { N: '480' },
              size: { N: '50000' },
            },
          ],
        };
      }
      if (pk === `ANALYTICS#${todayStr}`) {
        return {
          Items: [
            {
              entityType: { S: 'ANALYTICS' },
              eventName: { S: 'page_viewed' },
            },
          ],
        };
      }
    }
    return { Items: [] };
  };

  try {
    const res = await analytics.readAdminAnalytics({
      queryStringParameters: { days: '1' },
      requestContext: {
        authorizer: { claims: { 'cognito:groups': ['Admins'] } },
      },
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.rendering.totalRenders, 1);
    assert.strictEqual(body.rendering.successRate, 100);
    assert.strictEqual(body.funnel.pageViews, 1);
    assert.strictEqual(body.funnel.playgroundSubmits, 1);
    assert.strictEqual(body.dailyRollups.length, 1);
    assert.strictEqual(body.dailyRollups[0].renders, 1);
  } finally {
    analytics.ddb.send = origDdbSend;
  }
});

test('admin users endpoints return 403 Forbidden for non-admin callers', async () => {
  const nonAdminEvent = {
    resource: '/api/v1/admin/users',
    path: '/api/v1/admin/users',
    httpMethod: 'GET',
    requestContext: {
      authorizer: { claims: { email: 'regular@user.com' } },
    },
  };
  const dossierEvent = {
    resource: '/api/v1/admin/users/{userId}',
    path: '/api/v1/admin/users/c1f7b76e-3c2e-4b21-8273-df3e18a992bc',
    pathParameters: { userId: 'c1f7b76e-3c2e-4b21-8273-df3e18a992bc' },
    httpMethod: 'GET',
    requestContext: {
      authorizer: { claims: { email: 'regular@user.com' } },
    },
  };

  const res1 = await analytics.handler(nonAdminEvent);
  assert.strictEqual(res1.statusCode, 403);

  const res2 = await analytics.handler(dossierEvent);
  assert.strictEqual(res2.statusCode, 403);

  const res3 = await analytics.searchAdminUsers({ requestContext: {} });
  assert.strictEqual(res3.statusCode, 403);

  const res4 = await analytics.readAdminUserDossier({ requestContext: {} }, 'u1');
  assert.strictEqual(res4.statusCode, 403);
});

test('searchAdminUsers by email prefix matches users and joins billing, quota, and active keys', async () => {
  const origCognitoSend = analytics.cognito.send;
  const origDdbSend = analytics.ddb.send;
  const cognitoCommands = [];
  const ddbCommands = [];

  const userId = 'c1f7b76e-3c2e-4b21-8273-df3e18a992bc';
  const email = 'customer@acme.com';

  analytics.cognito.send = async (cmd) => {
    cognitoCommands.push(cmd);
    if (cmd.constructor.name === 'ListUsersCommand') {
      assert.strictEqual(cmd.input.Filter, 'email ^= "customer@acme.com"');
      return {
        Users: [
          {
            Username: userId,
            Attributes: [
              { Name: 'sub', Value: userId },
              { Name: 'email', Value: email },
            ],
            UserCreateDate: new Date('2026-04-12T14:22:00Z'),
          },
        ],
        PaginationToken: 'next-page-tok-123',
      };
    }
    return {};
  };

  analytics.ddb.send = async (cmd) => {
    ddbCommands.push(cmd);
    if (cmd.constructor.name === 'BatchGetItemCommand') {
      const tableName = Object.keys(cmd.input.RequestItems)[0];
      return {
        Responses: {
          [tableName]: [
            {
              requestId: { S: `BILLING#${userId}` },
              tier: { S: 'starter' },
              status: { S: 'active' },
              provider: { S: 'paddle' },
              manualOverride: { BOOL: false },
            },
            {
              requestId: { S: `USER_QUOTA#${userId}#2026-09` },
              used: { N: '412' },
              limit: { N: '5000' },
            },
          ],
        },
      };
    }
    if (cmd.constructor.name === 'QueryCommand') {
      // API_KEYS_TABLE query
      return {
        Items: [
          { keyId: { S: 'key_1' }, isActive: { BOOL: true } },
          { keyId: { S: 'key_2' }, isActive: { BOOL: true } },
          { keyId: { S: 'key_3' }, isActive: { BOOL: false } },
        ],
      };
    }
    return {};
  };

  try {
    const event = {
      resource: '/api/v1/admin/users',
      path: '/api/v1/admin/users',
      httpMethod: 'GET',
      queryStringParameters: { q: 'customer@acme.com', tier: 'all', status: 'all' },
      requestContext: {
        authorizer: { claims: { 'cognito:groups': ['Admins'] } },
      },
    };

    const res = await analytics.handler(event);
    assert.strictEqual(res.statusCode, 200);

    const body = JSON.parse(res.body);
    assert.strictEqual(body.nextCursor, 'next-page-tok-123');
    assert.strictEqual(body.users.length, 1);

    const u = body.users[0];
    assert.strictEqual(u.id, userId);
    assert.strictEqual(u.email, email);
    assert.strictEqual(u.tier, 'starter');
    assert.strictEqual(u.status, 'active');
    assert.strictEqual(u.provider, 'paddle');
    assert.strictEqual(u.manualOverride, false);
    assert.strictEqual(u.quotaUsed, 412);
    assert.strictEqual(u.quotaLimit, 5000);
    assert.strictEqual(u.activeKeys, 2);
    assert.strictEqual(u.createdAt, '2026-04-12T14:22:00.000Z');
  } finally {
    analytics.cognito.send = origCognitoSend;
    analytics.ddb.send = origDdbSend;
  }
});

test('searchAdminUsers by UUID queries Cognito AdminGetUser directly', async () => {
  const origCognitoSend = analytics.cognito.send;
  const origDdbSend = analytics.ddb.send;
  const uuid = 'c1f7b76e-3c2e-4b21-8273-df3e18a992bc';

  let adminGetUserCalled = false;

  analytics.cognito.send = async (cmd) => {
    if (cmd.constructor.name === 'AdminGetUserCommand') {
      adminGetUserCalled = true;
      assert.strictEqual(cmd.input.Username, uuid);
      return {
        Username: uuid,
        UserAttributes: [
          { Name: 'sub', Value: uuid },
          { Name: 'email', Value: 'direct_uuid@example.com' },
        ],
        UserCreateDate: new Date('2026-01-15T00:00:00Z'),
      };
    }
    return {};
  };

  analytics.ddb.send = async (cmd) => {
    if (cmd.constructor.name === 'BatchGetItemCommand') {
      const tableName = Object.keys(cmd.input.RequestItems)[0];
      return { Responses: { [tableName]: [] } };
    }
    if (cmd.constructor.name === 'QueryCommand') {
      return { Items: [] };
    }
    return {};
  };

  try {
    const res = await analytics.searchAdminUsers({
      queryStringParameters: { q: uuid },
      requestContext: {
        authorizer: { claims: { email: 'vberkoz@gmail.com' } },
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(adminGetUserCalled, true);

    const body = JSON.parse(res.body);
    assert.strictEqual(body.users.length, 1);
    assert.strictEqual(body.users[0].id, uuid);
    assert.strictEqual(body.users[0].email, 'direct_uuid@example.com');
    assert.strictEqual(body.users[0].tier, 'free');
    assert.strictEqual(body.users[0].quotaLimit, 25);
    assert.strictEqual(body.nextCursor, null);
  } finally {
    analytics.cognito.send = origCognitoSend;
    analytics.ddb.send = origDdbSend;
  }
});

test('readAdminUserDossier joins all 5 data sources combined', async () => {
  const origCognitoSend = analytics.cognito.send;
  const origDdbSend = analytics.ddb.send;
  const userId = 'c1f7b76e-3c2e-4b21-8273-df3e18a992bc';

  analytics.cognito.send = async (cmd) => {
    if (cmd.constructor.name === 'AdminGetUserCommand') {
      assert.strictEqual(cmd.input.Username, userId);
      return {
        Username: userId,
        UserAttributes: [
          { Name: 'sub', Value: userId },
          { Name: 'email', Value: 'customer@acme.com' },
          { Name: 'email_verified', Value: 'true' },
        ],
        Enabled: true,
        UserCreateDate: new Date('2026-04-12T14:22:00Z'),
      };
    }
    return {};
  };

  analytics.ddb.send = async (cmd) => {
    if (cmd.constructor.name === 'GetItemCommand') {
      const key = cmd.input.Key.requestId.S;
      if (key === `BILLING#${userId}`) {
        return {
          Item: {
            tier: { S: 'starter' },
            status: { S: 'active' },
            plan: { S: 'RenderPDF Starter' },
            provider: { S: 'paddle' },
            manualOverride: { BOOL: false },
            subscriptionId: { S: 'sub_01h6t8z' },
            renewsAt: { S: '2026-10-12T14:22:00Z' },
          },
        };
      }
      if (key.startsWith(`USER_QUOTA#${userId}`)) {
        return {
          Item: {
            used: { N: '412' },
            limit: { N: '5000' },
          },
        };
      }
    }
    if (cmd.constructor.name === 'QueryCommand') {
      // Check if querying API keys or Recent Requests
      if (cmd.input.TableName === process.env.API_KEYS_TABLE || cmd.input.KeyConditionExpression?.includes('APIKEY#')) {
        return {
          Items: [
            {
              keyId: { S: 'key_9f82d1c' },
              name: { S: 'Production Backend' },
              isActive: { BOOL: true },
              createdAt: { N: '1712931720' },
              lastUsed: { N: '1727289120' },
            },
          ],
        };
      }
      // USAGE requests (via CustomerIdDateIndex or customer partition)
      return {
        Items: [
          {
            requestId: { S: 'req_8471b0' },
            timestamp: { N: '1727289120' },
            status: { S: 'success' },
            errorType: { S: '' },
            durationMs: { N: '482' },
            size: { N: '184920' },
          },
        ],
      };
    }
    return {};
  };

  try {
    const event = {
      resource: '/api/v1/admin/users/{userId}',
      path: `/api/v1/admin/users/${userId}`,
      pathParameters: { userId },
      httpMethod: 'GET',
      requestContext: {
        authorizer: { claims: { 'cognito:groups': 'Admins' } },
      },
    };

    const res = await analytics.handler(event);
    assert.strictEqual(res.statusCode, 200);

    const body = JSON.parse(res.body);

    // 1. User
    assert.deepStrictEqual(body.user, {
      id: userId,
      email: 'customer@acme.com',
      emailVerified: true,
      enabled: true,
      createdAt: '2026-04-12T14:22:00.000Z',
    });

    // 2. Billing
    assert.deepStrictEqual(body.billing, {
      tier: 'starter',
      status: 'active',
      plan: 'RenderPDF Starter',
      provider: 'paddle',
      manualOverride: false,
      subscriptionId: 'sub_01h6t8z',
      renewsAt: '2026-10-12T14:22:00Z',
    });

    // 3. Quota
    assert.strictEqual(body.quota.used, 412);
    assert.strictEqual(body.quota.limit, 5000);
    assert.strictEqual(body.quota.remaining, 4588);

    // 4. API Keys
    assert.strictEqual(body.apiKeys.length, 1);
    assert.deepStrictEqual(body.apiKeys[0], {
      keyId: 'key_9f82d1c',
      name: 'Production Backend',
      isActive: true,
      createdAt: 1712931720,
      lastUsed: 1727289120,
    });

    // 5. Recent Requests
    assert.strictEqual(body.recentRequests.length, 1);
    assert.deepStrictEqual(body.recentRequests[0], {
      requestId: 'req_8471b0',
      timestamp: 1727289120,
      status: 'success',
      errorType: '',
      durationMs: 482,
      size: 184920,
    });
  } finally {
    analytics.cognito.send = origCognitoSend;
    analytics.ddb.send = origDdbSend;
  }
});

test('searchAdminUsers filters by tier and status in-memory', async () => {
  const origCognitoSend = analytics.cognito.send;
  const origDdbSend = analytics.ddb.send;

  analytics.cognito.send = async () => {
    return {
      Users: [
        {
          Username: 'user-starter',
          Attributes: [{ Name: 'sub', Value: 'user-starter' }, { Name: 'email', Value: 'starter@example.com' }],
        },
        {
          Username: 'user-pro',
          Attributes: [{ Name: 'sub', Value: 'user-pro' }, { Name: 'email', Value: 'pro@example.com' }],
        },
      ],
    };
  };

  analytics.ddb.send = async (cmd) => {
    if (cmd.constructor.name === 'BatchGetItemCommand') {
      const tableName = Object.keys(cmd.input.RequestItems)[0];
      return {
        Responses: {
          [tableName]: [
            { requestId: { S: 'BILLING#user-starter' }, tier: { S: 'starter' }, status: { S: 'active' } },
            { requestId: { S: 'BILLING#user-pro' }, tier: { S: 'pro' }, status: { S: 'past_due' } },
          ],
        },
      };
    }
    return { Items: [] };
  };

  try {
    const resStarter = await analytics.searchAdminUsers({
      queryStringParameters: { tier: 'starter' },
      requestContext: { authorizer: { claims: { 'cognito:groups': ['Admins'] } } },
    });
    const bodyStarter = JSON.parse(resStarter.body);
    assert.strictEqual(bodyStarter.users.length, 1);
    assert.strictEqual(bodyStarter.users[0].id, 'user-starter');

    const resPastDue = await analytics.searchAdminUsers({
      queryStringParameters: { status: 'past_due' },
      requestContext: { authorizer: { claims: { 'cognito:groups': ['Admins'] } } },
    });
    const bodyPastDue = JSON.parse(resPastDue.body);
    assert.strictEqual(bodyPastDue.users.length, 1);
    assert.strictEqual(bodyPastDue.users[0].id, 'user-pro');
  } finally {
    analytics.cognito.send = origCognitoSend;
    analytics.ddb.send = origDdbSend;
  }
});

test('readAdminUserDossier returns 404 when user not found in Cognito', async () => {
  const origCognitoSend = analytics.cognito.send;

  analytics.cognito.send = async () => {
    const err = new Error('User does not exist');
    err.name = 'UserNotFoundException';
    throw err;
  };

  try {
    const res = await analytics.readAdminUserDossier(
      { requestContext: { authorizer: { claims: { 'cognito:groups': ['Admins'] } } } },
      'non-existent-user'
    );
    assert.strictEqual(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'User not found');
  } finally {
    analytics.cognito.send = origCognitoSend;
  }
});

test('handler correctly handles OPTIONS and 405 for /admin/users', async () => {
  const optRes1 = await analytics.handler({
    resource: '/api/v1/admin/users',
    httpMethod: 'OPTIONS',
  });
  assert.strictEqual(optRes1.statusCode, 204);

  const optRes2 = await analytics.handler({
    resource: '/api/v1/admin/users/{userId}',
    pathParameters: { userId: '123' },
    httpMethod: 'OPTIONS',
  });
  assert.strictEqual(optRes2.statusCode, 204);

  const postRes = await analytics.handler({
    resource: '/api/v1/admin/users',
    httpMethod: 'POST',
    requestContext: { authorizer: { claims: { 'cognito:groups': ['Admins'] } } },
  });
  assert.strictEqual(postRes.statusCode, 405);
});

test('handler correctly routes admin/users via route query parameter override', async () => {
  const optRes = await analytics.handler({
    resource: '/api/v1/analytics',
    queryStringParameters: { route: 'admin/users' },
    httpMethod: 'OPTIONS',
  });
  assert.strictEqual(optRes.statusCode, 204);

  const optResUser = await analytics.handler({
    resource: '/api/v1/analytics',
    queryStringParameters: { route: 'admin/users/user-123' },
    httpMethod: 'OPTIONS',
  });
  assert.strictEqual(optResUser.statusCode, 204);
});

test('readAdminUserDossier resolves Google federated user by sub UUID', async () => {
  const origCognitoSend = analytics.cognito.send;
  const origDdbSend = analytics.ddb.send;
  const targetSub = '8408c4f8-f0a1-704d-092d-6d17fb091fa8';
  const federatedUsername = 'Google_107286376204740932967';

  analytics.cognito.send = async (cmd) => {
    if (cmd.constructor.name === 'ListUsersCommand') {
      if (cmd.input?.Filter === `sub = "${targetSub}"`) {
        return {
          Users: [
            {
              Username: federatedUsername,
              Attributes: [
                { Name: 'sub', Value: targetSub },
                { Name: 'email', Value: 'basilsergius@gmail.com' },
                { Name: 'email_verified', Value: 'false' },
              ],
              Enabled: true,
              UserCreateDate: new Date('2026-09-18T05:52:12Z'),
            },
          ],
        };
      }
    }
    const err = new Error('User not found');
    err.name = 'UserNotFoundException';
    throw err;
  };

  analytics.ddb.send = async (cmd) => {
    if (cmd.constructor.name === 'GetItemCommand') {
      const key = cmd.input.Key.requestId.S;
      if (key === `BILLING#${targetSub}`) {
        return {
          Item: {
            tier: { S: 'free' },
            status: { S: 'active' },
            plan: { S: 'Free' },
            provider: { S: 'none' },
          },
        };
      }
      if (key.startsWith(`USER_QUOTA#${targetSub}`)) {
        return { Item: { used: { N: '5' }, limit: { N: '25' } } };
      }
    }
    return {};
  };

  try {
    const res = await analytics.readAdminUserDossier(
      { requestContext: { authorizer: { claims: { 'cognito:groups': ['Admins'] } } } },
      targetSub
    );
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.user.id, targetSub);
    assert.strictEqual(body.user.email, 'basilsergius@gmail.com');
    assert.strictEqual(body.billing.tier, 'free');
    assert.strictEqual(body.quota.used, 5);
  } finally {
    analytics.cognito.send = origCognitoSend;
    analytics.ddb.send = origDdbSend;
  }
});

test('saveBillingWebhook ignores downgrade/cancel when manualOverride is true (Task 3.1)', async () => {
  const origDdbSend = analytics.ddb.send;
  const updates = [];

  analytics.ddb.send = async (cmd) => {
    if (cmd.constructor.name === 'GetItemCommand') {
      const key = cmd.input.Key.requestId.S;
      if (key === 'BILLING#user_vip') {
        return {
          Item: {
            tier: { S: 'pro' },
            status: { S: 'active' },
            manualOverride: { BOOL: true },
          },
        };
      }
    }
    if (cmd.constructor.name === 'UpdateItemCommand') {
      updates.push(cmd);
      return {};
    }
    return {};
  };

  try {
    // 1. Canceled webhook should be ignored for VIP account
    await analytics.saveBillingWebhook(
      'user_vip',
      'sub_vip',
      { status: 'canceled' },
      'evt_cancel_1',
      new Date(),
      'subscription.canceled'
    );
    assert.strictEqual(updates.length, 0, 'No UpdateItemCommand sent when manualOverride is active');

    // 2. Past due webhook should also be ignored
    await analytics.saveBillingWebhook(
      'user_vip',
      'sub_vip',
      { status: 'past_due' },
      'evt_pastdue_1',
      new Date(),
      'subscription.past_due'
    );
    assert.strictEqual(updates.length, 0, 'No UpdateItemCommand sent on past_due for VIP account');

    // 3. Paused webhook should also be ignored
    await analytics.saveBillingWebhook(
      'user_vip',
      'sub_vip',
      { status: 'paused' },
      'evt_paused_1',
      new Date(),
      'subscription.paused'
    );
    assert.strictEqual(updates.length, 0, 'No UpdateItemCommand sent on paused for VIP account');

    // 4. Status = 'canceled' in attributes should be ignored even if eventType is generic
    await analytics.saveBillingWebhook(
      'user_vip',
      'sub_vip',
      { status: 'canceled' },
      'evt_cancel_generic',
      new Date(),
      'subscription.updated'
    );
    assert.strictEqual(updates.length, 0, 'No UpdateItemCommand sent when attributes.status is canceled');

    // 5. Legitimate paid upgrade clears manualOverride and adopts new paid tier
    await analytics.saveBillingWebhook(
      'user_vip',
      'sub_vip_paid',
      {
        status: 'active',
        customer_id: 'ctm_paid_1',
        items: [{ price: { id: 'pri_pro_monthly' } }],
        custom_data: { tier: 'pro' },
      },
      'evt_paid_upgrade',
      new Date(),
      'subscription.updated'
    );
    const billingUpdate = updates.find((cmd) => cmd.input?.Key?.requestId?.S === 'BILLING#user_vip');
    assert.ok(billingUpdate, 'BILLING# update was sent for paid upgrade');
    assert.strictEqual(billingUpdate.input.ExpressionAttributeValues[':manualOverride'].BOOL, false);
  } finally {
    analytics.ddb.send = origDdbSend;
  }
});

test('saveBillingWebhook permits downgrade for standard user without manualOverride', async () => {
  const origDdbSend = analytics.ddb.send;
  const updates = [];

  analytics.ddb.send = async (cmd) => {
    if (cmd.constructor.name === 'GetItemCommand') {
      const key = cmd.input.Key.requestId.S;
      if (key === 'BILLING#user_standard') {
        return {
          Item: {
            tier: { S: 'pro' },
            status: { S: 'active' },
            manualOverride: { BOOL: false },
          },
        };
      }
    }
    if (cmd.constructor.name === 'UpdateItemCommand') {
      updates.push(cmd);
      return {};
    }
    return {};
  };

  try {
    await analytics.saveBillingWebhook(
      'user_standard',
      'sub_std',
      { status: 'canceled' },
      'evt_cancel_2',
      new Date(),
      'subscription.canceled'
    );
    assert.ok(updates.length > 0, 'UpdateItemCommand was sent to record cancellation for standard user');
  } finally {
    analytics.ddb.send = origDdbSend;
  }
});

test('handleAdminUserPlanOverride enforces auth, validates input, updates quota and audit trail (Task 3.2)', async () => {
  const origDdbSend = analytics.ddb.send;
  const origApigwSend = analytics.apigw.send;
  const origApiKeysTable = process.env.API_KEYS_TABLE;
  const origProUsagePlanId = process.env.PRO_USAGE_PLAN_ID;
  process.env.API_KEYS_TABLE = 'ApiKeysTable';
  process.env.PRO_USAGE_PLAN_ID = 'pro-plan-id';

  const ddbCommands = [];
  const apigwCommands = [];

  analytics.ddb.send = async (cmd) => {
    ddbCommands.push(cmd);
    if (cmd.constructor.name === 'GetItemCommand') {
      return {
        Item: {
          tier: { S: 'free' },
          status: { S: 'active' },
        },
      };
    }
    if (cmd.constructor.name === 'QueryCommand') {
      // Mock active API key for syncUserUsagePlans
      return {
        Items: [
          {
            PK: { S: 'USER#target_user_1' },
            SK: { S: 'APIKEY#key_1' },
            isActive: { BOOL: true },
            apiGatewayKeyId: { S: 'ag_key_123' },
          },
        ],
      };
    }
    return {};
  };

  analytics.apigw.send = async (cmd) => {
    apigwCommands.push(cmd);
    return {};
  };

  try {
    // 1. Non-admin receives 403
    const forbiddenRes = await analytics.handleAdminUserPlanOverride(
      { requestContext: { authorizer: { claims: { 'cognito:groups': ['Users'] } } } },
      'target_user_1'
    );
    assert.strictEqual(forbiddenRes.statusCode, 403);

    // 2. Missing reason returns 400
    const missingReasonRes = await analytics.handleAdminUserPlanOverride(
      {
        requestContext: { authorizer: { claims: { 'cognito:groups': ['Admins'], email: 'operator@renderpdf.com' } } },
        body: JSON.stringify({ tier: 'pro', reason: '' }),
      },
      'target_user_1'
    );
    assert.strictEqual(missingReasonRes.statusCode, 400);

    // 3. Valid admin plan change to Pro
    const successRes = await analytics.handleAdminUserPlanOverride(
      {
        requestContext: { authorizer: { claims: { 'cognito:groups': ['Admins'], email: 'operator@renderpdf.com' } } },
        body: JSON.stringify({
          tier: 'pro',
          manualOverride: true,
          reason: 'VIP contract Q4',
          customMonthlyQuota: 25000,
        }),
      },
      'target_user_1'
    );
    assert.strictEqual(successRes.statusCode, 200);
    const body = JSON.parse(successRes.body);
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.tier, 'pro');
    assert.strictEqual(body.manualOverride, true);
    assert.strictEqual(body.quotaLimit, 25000);

    // Verify BILLING# update
    const billingUpdate = ddbCommands.find((c) => c.constructor.name === 'UpdateItemCommand' && c.input.Key.requestId.S === 'BILLING#target_user_1');
    assert.ok(billingUpdate, 'BILLING# update sent');
    assert.strictEqual(billingUpdate.input.ExpressionAttributeValues[':tier'].S, 'pro');
    assert.strictEqual(billingUpdate.input.ExpressionAttributeValues[':manualOverride'].BOOL, true);
    assert.strictEqual(billingUpdate.input.ExpressionAttributeValues[':admin'].S, 'operator@renderpdf.com');

    // Verify USER_QUOTA# update
    const quotaUpdate = ddbCommands.find((c) => c.constructor.name === 'UpdateItemCommand' && c.input.Key.requestId.S.startsWith('USER_QUOTA#target_user_1'));
    assert.ok(quotaUpdate, 'USER_QUOTA# update sent');
    assert.strictEqual(quotaUpdate.input.ExpressionAttributeValues[':limit'].N, '25000');

    // Verify syncUserUsagePlans attached key to Pro usage plan in API Gateway
    const createKeyCmd = apigwCommands.find((c) => c.constructor.name === 'CreateUsagePlanKeyCommand');
    assert.ok(createKeyCmd, 'syncUserUsagePlans attached key to ProUsagePlan');
    assert.strictEqual(createKeyCmd.input.UsagePlanId, 'pro-plan-id');
    assert.strictEqual(createKeyCmd.input.KeyId, 'ag_key_123');

    // Verify ADMIN_AUDIT# put
    const auditPut = ddbCommands.find((c) => c.constructor.name === 'PutItemCommand' && c.input.Item.requestId.S.startsWith('ADMIN_AUDIT#'));
    assert.ok(auditPut, 'ADMIN_AUDIT record written');
    assert.strictEqual(auditPut.input.Item.action.S, 'PLAN_OVERRIDE');
    assert.strictEqual(auditPut.input.Item.adminEmail.S, 'operator@renderpdf.com');
    assert.strictEqual(auditPut.input.Item.targetUserId.S, 'target_user_1');
    assert.strictEqual(auditPut.input.Item.reason.S, 'VIP contract Q4');
  } finally {
    analytics.ddb.send = origDdbSend;
    analytics.apigw.send = origApigwSend;
    process.env.API_KEYS_TABLE = origApiKeysTable;
    process.env.PRO_USAGE_PLAN_ID = origProUsagePlanId;
  }
});

test('handleAdminUserQuotaAdjust applies add_credits, set_limit, reset_usage and records audit', async () => {
  const origDdbSend = analytics.ddb.send;
  const ddbCommands = [];

  analytics.ddb.send = async (cmd) => {
    ddbCommands.push(cmd);
    if (cmd.constructor.name === 'GetItemCommand') {
      const key = cmd.input.Key.requestId.S;
      if (key.startsWith('USER_QUOTA#')) {
        return { Item: { used: { N: '200' }, limit: { N: '5000' } } };
      }
    }
    return {};
  };

  try {
    // 1. Non-admin receives 403
    const forbiddenRes = await analytics.handleAdminUserQuotaAdjust(
      { requestContext: { authorizer: { claims: { 'cognito:groups': ['Users'] } } } },
      'target_user_2'
    );
    assert.strictEqual(forbiddenRes.statusCode, 403);

    // 2. add_credits increases limit
    const addRes = await analytics.handleAdminUserQuotaAdjust(
      {
        requestContext: { authorizer: { claims: { 'cognito:groups': ['Admins'], email: 'admin@renderpdf.com' } } },
        body: JSON.stringify({
          action: 'add_credits',
          amount: 1000,
          reason: 'Goodwill grant for webhook retry issue',
        }),
      },
      'target_user_2'
    );
    assert.strictEqual(addRes.statusCode, 200);
    const addBody = JSON.parse(addRes.body);
    assert.strictEqual(addBody.success, true);
    assert.strictEqual(addBody.limit, 6000);
    assert.strictEqual(addBody.used, 200);
    assert.strictEqual(addBody.remaining, 5800);

    // 3. set_limit sets exact limit
    const setRes = await analytics.handleAdminUserQuotaAdjust(
      {
        requestContext: { authorizer: { claims: { 'cognito:groups': ['Admins'], email: 'admin@renderpdf.com' } } },
        body: JSON.stringify({
          action: 'set_limit',
          amount: 15000,
          reason: 'Custom trial limit',
        }),
      },
      'target_user_2'
    );
    assert.strictEqual(setRes.statusCode, 200);
    const setBody = JSON.parse(setRes.body);
    assert.strictEqual(setBody.limit, 15000);

    // 4. reset_usage clears used count
    const resetRes = await analytics.handleAdminUserQuotaAdjust(
      {
        requestContext: { authorizer: { claims: { 'cognito:groups': ['Admins'], email: 'admin@renderpdf.com' } } },
        body: JSON.stringify({
          action: 'reset_usage',
          reason: 'Operator testing usage reset',
        }),
      },
      'target_user_2'
    );
    assert.strictEqual(resetRes.statusCode, 200);
    const resetBody = JSON.parse(resetRes.body);
    assert.strictEqual(resetBody.used, 0);

    // Verify audit logs were written for all actions
    const auditLogs = ddbCommands.filter((c) => c.constructor.name === 'PutItemCommand' && c.input.Item.requestId.S.startsWith('ADMIN_AUDIT#'));
    assert.strictEqual(auditLogs.length, 3, 'Audit log written for each quota adjustment');
  } finally {
    analytics.ddb.send = origDdbSend;
  }
});

test('handler correctly routes POST /api/v1/admin/users/{userId}/plan and quota directly and via route override', async () => {
  const origDdbSend = analytics.ddb.send;
  analytics.ddb.send = async (cmd) => {
    if (cmd.constructor.name === 'GetItemCommand') {
      return { Item: { tier: { S: 'free' }, limit: { N: '25' }, used: { N: '0' } } };
    }
    return {};
  };

  try {
    // 1. Direct POST /admin/users/{userId}/plan
    const planRes = await analytics.handler({
      resource: '/api/v1/admin/users/{userId}/plan',
      path: '/api/v1/admin/users/user_abc/plan',
      pathParameters: { userId: 'user_abc' },
      httpMethod: 'POST',
      requestContext: { authorizer: { claims: { 'cognito:groups': ['Admins'], email: 'admin@renderpdf.com' } } },
      body: JSON.stringify({ tier: 'starter', reason: 'Upgraded by support' }),
    });
    assert.strictEqual(planRes.statusCode, 200);

    // 2. Query override route=admin/users/user_abc/quota
    const quotaRes = await analytics.handler({
      resource: '/api/v1/analytics',
      path: '/api/v1/analytics',
      queryStringParameters: { route: 'admin/users/user_abc/quota' },
      httpMethod: 'POST',
      requestContext: { authorizer: { claims: { 'cognito:groups': ['Admins'], email: 'admin@renderpdf.com' } } },
      body: JSON.stringify({ action: 'add_credits', amount: 500, reason: 'Support bonus' }),
    });
    assert.strictEqual(quotaRes.statusCode, 200);

    // 3. OPTIONS for plan and quota sub-resources return 204
    const optPlan = await analytics.handler({
      resource: '/api/v1/admin/users/{userId}/plan',
      httpMethod: 'OPTIONS',
    });
    assert.strictEqual(optPlan.statusCode, 204);

    const optQuota = await analytics.handler({
      resource: '/api/v1/admin/users/{userId}/quota',
      httpMethod: 'OPTIONS',
    });
    assert.strictEqual(optQuota.statusCode, 204);
  } finally {
    analytics.ddb.send = origDdbSend;
  }
});

test('recordAdminAudit writes immutable audit trail record with 365-day TTL (Task 4.1)', async () => {
  const origDdbSend = analytics.ddb.send;
  const ddbCommands = [];
  analytics.ddb.send = async (cmd) => {
    ddbCommands.push(cmd);
    return {};
  };

  try {
    const beforeSeconds = Math.floor(Date.now() / 1000);
    const todayKey = new Date().toISOString().slice(0, 10);

    await analytics.recordAdminAudit({
      adminEmail: 'secops@renderpdf.com',
      targetUserId: 'user_audit_test_123',
      action: 'PLAN_OVERRIDE',
      reason: 'Manual tier upgrade for enterprise pilot',
      details: { previousTier: 'starter', newTier: 'enterprise' },
    });

    const afterSeconds = Math.floor(Date.now() / 1000);

    assert.strictEqual(ddbCommands.length, 1);
    const putCmd = ddbCommands[0];
    assert.strictEqual(putCmd.constructor.name, 'PutItemCommand');
    assert.strictEqual(putCmd.input.TableName, process.env.TABLE_NAME);

    const item = putCmd.input.Item;
    // Partition Key: ADMIN_AUDIT#YYYY-MM-DD
    assert.strictEqual(item.requestId.S, `ADMIN_AUDIT#${todayKey}`);

    // Sort Key: unix seconds
    const itemTimestamp = Number(item.timestamp.N);
    assert.ok(itemTimestamp >= beforeSeconds && itemTimestamp <= afterSeconds, 'Timestamp is current unix seconds');

    // Entity type
    assert.strictEqual(item.entityType.S, 'ADMIN_AUDIT');

    // Audit ID
    assert.ok(item.auditId.S && item.auditId.S.length > 0, 'AuditId is populated');

    // Attributes
    assert.strictEqual(item.adminEmail.S, 'secops@renderpdf.com');
    assert.strictEqual(item.targetUserId.S, 'user_audit_test_123');
    assert.strictEqual(item.action.S, 'PLAN_OVERRIDE');
    assert.strictEqual(item.reason.S, 'Manual tier upgrade for enterprise pilot');
    assert.deepStrictEqual(JSON.parse(item.details.S), { previousTier: 'starter', newTier: 'enterprise' });

    // 365-day TTL: expiresAt = timestamp + 365 * 86400
    const expiresAt = Number(item.expiresAt.N);
    const expectedExpires = itemTimestamp + (365 * 86400);
    assert.strictEqual(expiresAt, expectedExpires, 'Expires exactly 365 days after creation');

    // Test with missing/default optional fields
    ddbCommands.length = 0;
    await analytics.recordAdminAudit({
      action: 'KEY_REVOKE',
    });

    assert.strictEqual(ddbCommands.length, 1);
    const defaultItem = ddbCommands[0].input.Item;
    assert.strictEqual(defaultItem.adminEmail.S, 'unknown');
    assert.strictEqual(defaultItem.targetUserId.S, '');
    assert.strictEqual(defaultItem.action.S, 'KEY_REVOKE');
    assert.strictEqual(defaultItem.reason.S, '');
    assert.strictEqual(defaultItem.details.S, '{}');
  } finally {
    analytics.ddb.send = origDdbSend;
  }
});


test('handleAdminUserStatus - disabling user calls AdminDisableUserCommand and deactivates keys (Task 4.2)', async () => {
  const origDdbSend = analytics.ddb.send;
  const origCognitoSend = analytics.cognito.send;
  const ddbCommands = [];
  const cognitoCommands = [];

  analytics.ddb.send = async (cmd) => {
    ddbCommands.push(cmd);
    if (cmd.constructor.name === 'QueryCommand') {
      return { Items: [{ PK: { S: 'USER#u1' }, SK: { S: 'APIKEY#k1' } }] };
    }
    return {};
  };
  analytics.cognito.send = async (cmd) => {
    cognitoCommands.push(cmd);
    return {};
  };

  const prevTable = process.env.API_KEYS_TABLE;
  const prevPool = process.env.USER_POOL_ID;
  try {
    process.env.API_KEYS_TABLE = 'keys-table';
    process.env.USER_POOL_ID = 'us-east-1_pool';

    const adminRequest = {
      httpMethod: 'POST',
      path: '/api/v1/admin/users/u1/status',
      requestContext: { authorizer: { claims: { email: 'admin@test.com', 'cognito:groups': 'Admins' } } },
      body: JSON.stringify({ action: 'disable', reason: 'Fraudulent activity' }),
    };

    const res = await analytics.handleAdminUserStatus(adminRequest, 'u1');
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.action, 'disable');

    // Cognito AdminDisableUserCommand was called
    assert.strictEqual(cognitoCommands.length, 1);
    assert.strictEqual(cognitoCommands[0].constructor.name, 'AdminDisableUserCommand');
    assert.strictEqual(cognitoCommands[0].input.Username, 'u1');
    assert.strictEqual(cognitoCommands[0].input.UserPoolId, 'us-east-1_pool');

    // API key deactivated via UpdateItemCommand
    const updateCmd = ddbCommands.find((c) => c.constructor.name === 'UpdateItemCommand');
    assert.ok(updateCmd, 'UpdateItemCommand should be sent to deactivate key');
    assert.strictEqual(updateCmd.input.Key.SK.S, 'APIKEY#k1');

    // Audit written via PutItemCommand
    const auditCmd = ddbCommands.find((c) => c.constructor.name === 'PutItemCommand');
    assert.ok(auditCmd, 'PutItemCommand should be sent for audit record');
    assert.strictEqual(auditCmd.input.Item.action.S, 'USER_SUSPEND');
  } finally {
    analytics.ddb.send = origDdbSend;
    analytics.cognito.send = origCognitoSend;
    if (prevTable === undefined) delete process.env.API_KEYS_TABLE; else process.env.API_KEYS_TABLE = prevTable;
    if (prevPool === undefined) delete process.env.USER_POOL_ID; else process.env.USER_POOL_ID = prevPool;
  }
});

test('handleAdminKeyRevoke - marks key inactive in DynamoDB and records audit (Task 4.2)', async () => {
  const origDdbSend = analytics.ddb.send;
  const origApigwSend = analytics.apigw.send;
  const ddbCommands = [];
  const apigwCommands = [];

  analytics.ddb.send = async (cmd) => {
    ddbCommands.push(cmd);
    if (cmd.constructor.name === 'QueryCommand') {
      return { Items: [{ PK: { S: 'USER#u1' }, SK: { S: 'APIKEY#k1' }, apiGatewayKeyId: { S: 'gw-key-id' } }] };
    }
    return {};
  };
  analytics.apigw.send = async (cmd) => {
    apigwCommands.push(cmd);
    return {};
  };

  const prevTable = process.env.API_KEYS_TABLE;
  const prevPro = process.env.PRO_USAGE_PLAN_ID;
  try {
    process.env.API_KEYS_TABLE = 'keys-table';
    process.env.PRO_USAGE_PLAN_ID = 'pro-plan';

    const adminRequest = {
      httpMethod: 'POST',
      path: '/api/v1/admin/users/u1/keys/k1/revoke',
      requestContext: { authorizer: { claims: { email: 'admin@test.com', 'cognito:groups': 'Admins' } } },
      body: JSON.stringify({ reason: 'API key compromised' }),
    };

    const res = await analytics.handleAdminKeyRevoke(adminRequest, 'u1', 'k1');
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.keyId, 'k1');

    // UpdateItemCommand marks key inactive
    const updateCmd = ddbCommands.find((c) => c.constructor.name === 'UpdateItemCommand');
    assert.ok(updateCmd, 'UpdateItemCommand should mark key isActive = false');
    assert.strictEqual(updateCmd.input.Key.SK.S, 'APIKEY#k1');
    assert.deepStrictEqual(updateCmd.input.ExpressionAttributeValues[':false'], { BOOL: false });

    // DeleteUsagePlanKeyCommand removes key from API Gateway
    assert.ok(apigwCommands.length > 0, 'DeleteUsagePlanKeyCommand should be called');
    assert.strictEqual(apigwCommands[0].constructor.name, 'DeleteUsagePlanKeyCommand');
    assert.strictEqual(apigwCommands[0].input.KeyId, 'gw-key-id');

    // Audit written
    const auditCmd = ddbCommands.find((c) => c.constructor.name === 'PutItemCommand');
    assert.ok(auditCmd, 'PutItemCommand should record audit');
    assert.strictEqual(auditCmd.input.Item.action.S, 'KEY_REVOKE');
    assert.strictEqual(auditCmd.input.Item.reason.S, 'API key compromised');
  } finally {
    analytics.ddb.send = origDdbSend;
    analytics.apigw.send = origApigwSend;
    if (prevTable === undefined) delete process.env.API_KEYS_TABLE; else process.env.API_KEYS_TABLE = prevTable;
    if (prevPro === undefined) delete process.env.PRO_USAGE_PLAN_ID; else process.env.PRO_USAGE_PLAN_ID = prevPro;
  }
});

test('listAdminAuditLogs - queries audit partitions and returns sorted logs; non-admin gets 403 (Task 4.2)', async () => {
  const origDdbSend = analytics.ddb.send;
  const ddbCommands = [];

  const fakeNow = Date.now();
  const todayKey = new Date(fakeNow).toISOString().slice(0, 10);

  analytics.ddb.send = async (cmd) => {
    ddbCommands.push(cmd);
    if (cmd.constructor.name === 'QueryCommand') {
      return {
        Items: [
          {
            requestId: { S: `ADMIN_AUDIT#${todayKey}` },
            timestamp: { N: String(fakeNow - 1000) },
            auditId: { S: 'audit-1' },
            adminEmail: { S: 'admin@test.com' },
            targetUserId: { S: 'u1' },
            action: { S: 'USER_SUSPEND' },
            reason: { S: 'Fraud' },
            details: { S: '{"cognitoAction":"disable"}' },
          },
          {
            requestId: { S: `ADMIN_AUDIT#${todayKey}` },
            timestamp: { N: String(fakeNow - 2000) },
            auditId: { S: 'audit-2' },
            adminEmail: { S: 'admin@test.com' },
            targetUserId: { S: 'u2' },
            action: { S: 'KEY_REVOKE' },
            reason: { S: 'Compromised' },
            details: { S: '{}' },
          },
        ],
      };
    }
    return {};
  };

  try {
    // Non-admin caller receives 403
    const anonRes = await analytics.listAdminAuditLogs({ httpMethod: 'GET' });
    assert.strictEqual(anonRes.statusCode, 403);

    const adminRequest = {
      httpMethod: 'GET',
      requestContext: { authorizer: { claims: { email: 'admin@test.com', 'cognito:groups': 'Admins' } } },
      queryStringParameters: { days: '1', limit: '10' },
    };
    const res = await analytics.listAdminAuditLogs(adminRequest);
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.logs), 'logs should be an array');
    assert.strictEqual(body.logs.length, 2);
    // Sorted descending by timestamp
    assert.ok(body.logs[0].timestamp >= body.logs[1].timestamp, 'logs should be sorted descending');
    assert.strictEqual(body.logs[0].action, 'USER_SUSPEND');
    assert.deepStrictEqual(body.logs[0].details, { cognitoAction: 'disable' });

    // QueryCommand sent with ADMIN_AUDIT#<date> partition
    const queryCmd = ddbCommands.find((c) => c.constructor.name === 'QueryCommand');
    assert.ok(queryCmd, 'QueryCommand should be sent');
    assert.ok(queryCmd.input.ExpressionAttributeValues[':pk'].S.startsWith('ADMIN_AUDIT#'), 'partition key should start with ADMIN_AUDIT#');
  } finally {
    analytics.ddb.send = origDdbSend;
  }
});







