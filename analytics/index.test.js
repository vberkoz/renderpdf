const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id, ...args) {
  if (id === '@aws-sdk/client-dynamodb') {
    class MockDynamoDBClient {
      send() {}
    }
    class GetItemCommand { constructor(input) { this.input = input; } }
    class UpdateItemCommand { constructor(input) { this.input = input; } }
    class PutItemCommand { constructor(input) { this.input = input; } }
    class QueryCommand { constructor(input) { this.input = input; } }
    class TransactWriteItemsCommand { constructor(input) { this.input = input; } }
    return {
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


