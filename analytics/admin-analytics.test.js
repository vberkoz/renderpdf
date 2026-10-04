'use strict';

const test = require('node:test');
const assert = require('node:assert');
const adminAnalytics = require('./admin-analytics');

test('isAuthorizedAdmin correctly authorizes Admins group and STATS_ALLOWED_EMAIL', () => {
  // Empty or invalid
  assert.strictEqual(adminAnalytics.isAuthorizedAdmin(null), false);
  assert.strictEqual(adminAnalytics.isAuthorizedAdmin({}), false);
  assert.strictEqual(adminAnalytics.isAuthorizedAdmin({ requestContext: {} }), false);

  // Non-admin
  assert.strictEqual(
    adminAnalytics.isAuthorizedAdmin({
      requestContext: {
        authorizer: {
          claims: {
            'cognito:groups': ['Users'],
            email: 'user@example.com',
          },
        },
      },
    }),
    false
  );

  // Admins group array
  assert.strictEqual(
    adminAnalytics.isAuthorizedAdmin({
      requestContext: {
        authorizer: {
          claims: {
            'cognito:groups': ['Users', 'Admins'],
            email: 'user@example.com',
          },
        },
      },
    }),
    true
  );

  // Admins group string
  assert.strictEqual(
    adminAnalytics.isAuthorizedAdmin({
      requestContext: {
        authorizer: {
          claims: {
            'cognito:groups': '["Admins"]',
            email: 'user@example.com',
          },
        },
      },
    }),
    true
  );

  // Allowed email
  assert.strictEqual(
    adminAnalytics.isAuthorizedAdmin({
      requestContext: {
        authorizer: {
          claims: {
            email: 'vberkoz@gmail.com',
          },
        },
      },
    }),
    true
  );
});

test('calculateAwsCost computes lambda and s3 costs accurately', () => {
  assert.strictEqual(adminAnalytics.calculateAwsCost(), 0);
  const cost = adminAnalytics.calculateAwsCost(1000, 500000, 10000000);
  assert.ok(cost > 0);
  assert.strictEqual(typeof cost, 'number');
});

test('calculateGrossMargin calculates percentage and handles non-positive revenue', () => {
  assert.strictEqual(adminAnalytics.calculateGrossMargin(0, 10), 0);
  assert.strictEqual(adminAnalytics.calculateGrossMargin(-10, 5), 0);
  assert.strictEqual(adminAnalytics.calculateGrossMargin(100, 20), 80);
});

test('calculateP95 handles empty and populated latency buckets', () => {
  assert.strictEqual(adminAnalytics.calculateP95(null), 0);
  assert.strictEqual(adminAnalytics.calculateP95({}), 0);
  const p95 = adminAnalytics.calculateP95({
    under_400ms: 95,
    '400ms_to_800ms': 5,
    '800ms_to_1500ms': 0,
    over_1500ms: 0,
  });
  assert.ok(p95 >= 100 && p95 <= 400);
});

test('calculateMedianTtfc handles empty and populated ttfc buckets', () => {
  assert.strictEqual(adminAnalytics.calculateMedianTtfc(null), 0);
  assert.strictEqual(adminAnalytics.calculateMedianTtfc({}), 0);
  const median = adminAnalytics.calculateMedianTtfc({
    under_5m: 10,
    '5m_to_30m': 10,
    '30m_to_2h': 0,
    over_2h: 0,
  });
  assert.ok(median > 0);
});

test('roundOneDecimal rounds numbers to 1 decimal place', () => {
  assert.strictEqual(adminAnalytics.roundOneDecimal(NaN), 0);
  assert.strictEqual(adminAnalytics.roundOneDecimal(Infinity), 0);
  assert.strictEqual(adminAnalytics.roundOneDecimal(12.345), 12.3);
  assert.strictEqual(adminAnalytics.roundOneDecimal(12.38), 12.4);
});

test('parseDays parses days within allowed bounds', () => {
  assert.strictEqual(adminAnalytics.parseDays(undefined), 7);
  assert.strictEqual(adminAnalytics.parseDays('0'), 7);
  assert.strictEqual(adminAnalytics.parseDays('-5'), 7);
  assert.strictEqual(adminAnalytics.parseDays('abc', 14), 14);
  assert.strictEqual(adminAnalytics.parseDays('30'), 30);
  assert.strictEqual(adminAnalytics.parseDays('365'), 90);
});

test('topRanks sorts Map entries by count descending then name ascending', () => {
  const map = new Map([
    ['US', 10],
    ['DE', 25],
    ['FR', 25],
    ['UK', 5],
  ]);
  const ranked = adminAnalytics.topRanks(map, 3);
  assert.strictEqual(ranked.length, 3);
  assert.strictEqual(ranked[0].name, 'DE');
  assert.strictEqual(ranked[0].count, 25);
  assert.strictEqual(ranked[1].name, 'FR');
  assert.strictEqual(ranked[1].count, 25);
  assert.strictEqual(ranked[2].name, 'US');
  assert.strictEqual(ranked[2].count, 10);
});

test('unwrap unwraps DynamoDB item attributes recursively', () => {
  assert.strictEqual(adminAnalytics.unwrap(null), null);
  assert.strictEqual(adminAnalytics.unwrap('plain'), 'plain');
  assert.strictEqual(adminAnalytics.unwrap(42), 42);

  const rawItem = {
    str: { S: 'hello' },
    num: { N: '123' },
    invalidNum: { N: 'abc' },
    bool: { BOOL: true },
    nullVal: { NULL: true },
    list: { L: [{ S: 'item1' }, { N: '2' }] },
    map: { M: { inner: { S: 'val' } } },
  };

  const unwrapped = adminAnalytics.unwrap(rawItem);
  assert.deepStrictEqual(unwrapped, {
    str: 'hello',
    num: 123,
    invalidNum: 0,
    bool: true,
    nullVal: null,
    list: ['item1', 2],
    map: { inner: 'val' },
  });
});

test('readAdminAnalytics returns 403 for unauthorized requests', async () => {
  const res = await adminAnalytics.readAdminAnalytics({});
  assert.strictEqual(res.statusCode, 403);
});

test('readAnalytics delegates directly to readAdminAnalytics', async () => {
  const res = await adminAnalytics.readAnalytics({});
  assert.strictEqual(res.statusCode, 403);
});

test('readAdminAnalytics executes with custom ddb client', async () => {
  const mockDdb = {
    send: async () => {
      return { Responses: { RenderPdfTable: [] } };
    },
  };
  adminAnalytics.setDdbClient(mockDdb);
  try {
    const res = await adminAnalytics.readAdminAnalytics({
      queryStringParameters: { days: '7' },
      requestContext: {
        authorizer: { claims: { 'cognito:groups': ['Admins'] } },
      },
    });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.summary);
    assert.ok(body.funnel);
    assert.ok(body.rendering);
    assert.strictEqual(body.dailyRollups.length, 7);
  } finally {
    adminAnalytics.setDdbClient(null);
  }
});
