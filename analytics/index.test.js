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
    assert.strictEqual(body.summary.mrrUsd, 3456.0);
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

  const expectedLambda = (5000000 / 1000) * 2 * 0.0000166667 + (10000 * 0.2) / 1000000;
  const expectedS3 = (10000 * 0.005) / 1000 + (1000000000 / 1e9) * 0.023;
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
