'use strict';

require('./test-aws-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const analytics = require('./index');

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
    const createCmd = apigwCommands.find((c) => c.constructor.name === 'CreateUsagePlanKeyCommand');
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

test('handler returns 404/405 for retired chat and admin routes while preserving dashboard, billing, public-stats, and analytics', async () => {
  const origDdbSend = analytics.ddb.send;
  analytics.ddb.send = async () => ({ Items: [], Item: null });

  try {
    const retiredChat = await analytics.handler({
      resource: '/api/v1/chat',
      httpMethod: 'POST',
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.strictEqual(retiredChat.statusCode, 404);

    const retiredAdminAnalytics = await analytics.handler({
      resource: '/api/v1/admin/analytics',
      httpMethod: 'GET',
      requestContext: { authorizer: { claims: { 'cognito:groups': ['Admins'] } } },
    });
    assert.strictEqual(retiredAdminAnalytics.statusCode, 404);

    const retiredAdminUsers = await analytics.handler({
      resource: '/api/v1/admin/users',
      httpMethod: 'GET',
      requestContext: { authorizer: { claims: { 'cognito:groups': ['Admins'] } } },
    });
    assert.strictEqual(retiredAdminUsers.statusCode, 404);

    const retiredAdminPlan = await analytics.handler({
      resource: '/api/v1/admin/users/u-1/plan',
      httpMethod: 'POST',
      requestContext: { authorizer: { claims: { 'cognito:groups': ['Admins'] } } },
    });
    assert.strictEqual(retiredAdminPlan.statusCode, 404);

    const retiredAnalyticsGet = await analytics.handler({
      resource: '/api/v1/analytics',
      httpMethod: 'GET',
    });
    assert.strictEqual(retiredAnalyticsGet.statusCode, 405);

    const analyticsPost = await analytics.handler({
      resource: '/api/v1/analytics',
      httpMethod: 'POST',
      body: JSON.stringify({ event: 'page_viewed' }),
    });
    assert.strictEqual(analyticsPost.statusCode, 202);

    const publicStatsRes = await analytics.handler({
      resource: '/api/v1/public-stats',
      httpMethod: 'GET',
    });
    assert.strictEqual(publicStatsRes.statusCode, 200);
    assert.strictEqual(JSON.parse(publicStatsRes.body).status, 'operational');

    const dashboardRes = await analytics.handler({
      resource: '/api/v1/dashboard',
      httpMethod: 'GET',
      requestContext: { authorizer: { claims: { sub: 'cust_123' } } },
    });
    assert.strictEqual(dashboardRes.statusCode, 200);
    assert.strictEqual(JSON.parse(dashboardRes.body).billing.status, 'free');

    const checkoutRes = await analytics.handler({
      resource: '/api/v1/billing/checkout',
      httpMethod: 'POST',
      requestContext: { authorizer: { claims: { sub: 'cust_123' } } },
      body: JSON.stringify({ plan: 'invalid_tier' }),
    });
    assert.strictEqual(checkoutRes.statusCode, 422);
  } finally {
    analytics.ddb.send = origDdbSend;
  }
});
