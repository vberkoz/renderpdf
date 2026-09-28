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
    return {
      CognitoIdentityProviderClient: MockCognitoClient,
      AdminGetUserCommand,
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





