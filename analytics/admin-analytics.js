'use strict';

let BatchGetItemCommand;
let DynamoDBClient;
let QueryCommand;

try {
  ({
    BatchGetItemCommand,
    DynamoDBClient,
    QueryCommand,
  } = require('@aws-sdk/client-dynamodb'));
} catch {
  BatchGetItemCommand = class BatchGetItemCommand {
    constructor(input) {
      this.input = input;
    }
  };
  QueryCommand = class QueryCommand {
    constructor(input) {
      this.input = input;
    }
  };
  DynamoDBClient = class MockDynamoDBClient {
    async send() {
      return {};
    }
  };
}

const metrics = require('./admin-analytics-metrics');
const aggregation = require('./admin-analytics-aggregation');

const TABLE_NAME = process.env.TABLE_NAME || 'RenderPdfTable';
const STATS_ALLOWED_EMAIL = String(process.env.STATS_ALLOWED_EMAIL || 'vberkoz@gmail.com')
  .trim()
  .toLowerCase();

const ddb = new DynamoDBClient({});
let customDdbClient = null;

function setDdbClient(client) {
  customDdbClient = client;
}

function getDdbClient() {
  return customDdbClient || ddb;
}

function response(statusCode, payload) {
  return {
    statusCode,
    body: payload == null ? '' : JSON.stringify(payload),
    headers: {
      'Access-Control-Allow-Origin': 'https://renderpdf.vberkoz.com',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Content-Type': 'application/json',
    },
  };
}

function isAuthorizedAdmin(request) {
  const claims = request?.requestContext?.authorizer?.claims;
  if (!claims) return false;

  const groups = claims['cognito:groups'];
  if (Array.isArray(groups) && groups.includes('Admins')) return true;
  if (typeof groups === 'string') {
    const list = groups
      .replace(/[\[\]"']/g, '')
      .split(',')
      .map((s) => s.trim());
    if (list.includes('Admins')) return true;
  }

  const email = String(claims.email || '')
    .trim()
    .toLowerCase();
  const allowedEmail = String(process.env.STATS_ALLOWED_EMAIL || STATS_ALLOWED_EMAIL || '')
    .trim()
    .toLowerCase();
  if (email && allowedEmail && email === allowedEmail) return true;

  return false;
}

function unwrap(val) {
  if (val == null) return null;
  if (typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(unwrap);

  const keys = Object.keys(val);
  if (keys.length === 1) {
    const k = keys[0];
    if (k === 'S') return val.S;
    if (k === 'N') {
      const num = Number(val.N);
      return Number.isFinite(num) ? num : 0;
    }
    if (k === 'BOOL') return Boolean(val.BOOL);
    if (k === 'NULL') return null;
    if (k === 'M') return unwrap(val.M);
    if (k === 'L') return val.L.map(unwrap);
  }

  const res = {};
  for (const [k, v] of Object.entries(val)) {
    res[k] = unwrap(v);
  }
  return res;
}

function queryDay(partition) {
  return aggregation.queryDay(partition, getDdbClient(), QueryCommand);
}

function aggregateDayData(dateStr, existingRollup = null) {
  return aggregation.aggregateDayData(dateStr, existingRollup, getDdbClient(), QueryCommand);
}

async function readAdminAnalytics(request) {
  if (!isAuthorizedAdmin(request)) {
    return response(403, { error: 'Forbidden' });
  }

  const days = metrics.parseDays(request?.queryStringParameters?.days, 30);
  const now = new Date();
  const keys = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    keys.push({ requestId: { S: `ROLLUP#${metrics.dateKey(d)}` }, timestamp: { N: '0' } });
  }

  const tableName = process.env.TABLE_NAME || TABLE_NAME || 'RenderPdfTable';
  let batchRes;
  try {
    batchRes = await getDdbClient().send(
      new BatchGetItemCommand({
        RequestItems: { [tableName]: { Keys: keys } },
      })
    );
  } catch (err) {
    console.error('Could not read admin analytics', err);
    return response(500, { error: 'Could not read analytics' });
  }

  const rawItems =
    batchRes?.Responses?.[tableName] ||
    (TABLE_NAME && batchRes?.Responses?.[TABLE_NAME]) ||
    (batchRes?.Responses && Object.values(batchRes.Responses)[0]) ||
    [];

  const itemsMap = new Map();
  for (const rawItem of rawItems) {
    const unwrapped = unwrap(rawItem);
    const dateStr =
      unwrapped.date ||
      (unwrapped.requestId ? String(unwrapped.requestId).replace(/^ROLLUP#/, '') : '');
    if (dateStr) {
      itemsMap.set(dateStr, unwrapped);
    }
  }

  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(metrics.dateKey(d));
  }

  const todayStr = metrics.dateKey(now);
  const datesToAggregate = dates.filter((d) => !itemsMap.has(d) || d === todayStr);
  if (datesToAggregate.length > 0) {
    const aggregatedResults = await Promise.all(
      datesToAggregate.map((d) => aggregateDayData(d, itemsMap.get(d)))
    );

    for (let i = 0; i < datesToAggregate.length; i++) {
      const d = datesToAggregate[i];
      const aggregated = aggregatedResults[i];
      if (aggregated) {
        itemsMap.set(d, aggregated);
      }
    }
  }

  const dailyRollups = [];
  let totalPageViews = 0;
  let totalPlaygroundSubmits = 0;
  let totalSignupsCompleted = 0;
  let totalApiKeysCreated = 0;
  let totalFirstApiCalls = 0;
  let totalRenders = 0;
  let totalSuccesses = 0;
  let totalErrors = 0;
  let totalDurationMs = 0;
  let totalBytes = 0;
  let totalAttributedRevenue = 0;
  let totalAwsCost = 0;

  const combinedLatencyBuckets = {
    under_400ms: 0,
    '400ms_to_800ms': 0,
    '800ms_to_1500ms': 0,
    over_1500ms: 0,
  };

  const combinedTtfcBuckets = {
    under_5m: 0,
    '5m_to_30m': 0,
    '30m_to_2h': 0,
    over_2h: 0,
  };

  for (const dateStr of dates) {
    const item = itemsMap.get(dateStr) || {};
    const acquisition = item.acquisition || {};
    const activation = item.activation || {};
    const monetization = item.monetization || {};
    const rendering = item.rendering || {};

    totalPageViews += Number(acquisition.pageViews || 0);
    totalPlaygroundSubmits += Number(acquisition.playgroundSubmits || 0);
    const signups = Number(activation.signupCompleted ?? activation.signupsCompleted ?? 0);
    totalSignupsCompleted += signups;
    totalApiKeysCreated += Number(activation.apiKeysCreated || 0);
    totalFirstApiCalls += Number(activation.firstApiCalls || 0);

    const ttfc = activation.ttfcBuckets || {};
    combinedTtfcBuckets.under_5m += Number(ttfc.under_5m || 0);
    combinedTtfcBuckets['5m_to_30m'] += Number(ttfc['5m_to_30m'] || 0);
    combinedTtfcBuckets['30m_to_2h'] += Number(ttfc['30m_to_2h'] || 0);
    combinedTtfcBuckets.over_2h += Number(ttfc.over_2h || 0);

    const dayRenders = Number(rendering.totalRenders || 0);
    const dayErrors = Number(rendering.errors || 0);
    const daySuccesses =
      rendering.successes != null
        ? Number(rendering.successes)
        : Math.max(0, dayRenders - dayErrors);
    const dayDurationMs = Number(rendering.totalDurationMs || 0);
    const dayBytes = Number(rendering.totalBytes || 0);

    totalRenders += dayRenders;
    totalErrors += dayErrors;
    totalSuccesses += daySuccesses;
    totalDurationMs += dayDurationMs;
    totalBytes += dayBytes;

    const latBuckets = rendering.latencyBuckets || {};
    combinedLatencyBuckets.under_400ms += Number(latBuckets.under_400ms || 0);
    combinedLatencyBuckets['400ms_to_800ms'] += Number(latBuckets['400ms_to_800ms'] || 0);
    combinedLatencyBuckets['800ms_to_1500ms'] += Number(latBuckets['800ms_to_1500ms'] || 0);
    combinedLatencyBuckets.over_1500ms += Number(latBuckets.over_1500ms || 0);

    const dayRevenue = Number(
      item.revenueUsd ??
        monetization.revenueUsd ??
        monetization.overageRevenueUsd ??
        item.attributedRevenue ??
        0
    );
    const dayAwsCost =
      item.estimatedAwsCostUsd != null
        ? Number(item.estimatedAwsCostUsd)
        : metrics.calculateAwsCost(dayRenders, dayDurationMs, dayBytes);
    const dayMargin =
      item.marginPercent != null
        ? Number(item.marginPercent)
        : metrics.calculateGrossMargin(dayRevenue, dayAwsCost);
    const dayP95 =
      item.p95Ms != null
        ? Number(item.p95Ms)
        : rendering.p95Ms != null
          ? Number(rendering.p95Ms)
          : metrics.calculateP95(rendering.latencyBuckets);

    totalAttributedRevenue += dayRevenue;
    totalAwsCost += dayAwsCost;

    dailyRollups.push({
      date: dateStr,
      renders: dayRenders,
      errors: dayErrors,
      revenueUsd: metrics.roundFloat(dayRevenue),
      estimatedAwsCostUsd: metrics.roundFloat(dayAwsCost),
      marginPercent: metrics.roundOneDecimal(dayMargin),
      p95Ms: dayP95,
    });
  }

  let latestItem = null;
  for (let i = dates.length - 1; i >= 0; i--) {
    const item = itemsMap.get(dates[i]);
    if (item && Object.keys(item).length > 0) {
      latestItem = item;
      break;
    }
  }

  const overallGrossMargin =
    totalAttributedRevenue > 0
      ? metrics.calculateGrossMargin(totalAttributedRevenue, totalAwsCost)
      : 0;

  const costPerThousand = totalRenders > 0 ? (totalAwsCost / totalRenders) * 1000 : 0;

  const summary = {
    totalUsers: Number(
      latestItem?.summary?.totalUsers ??
        latestItem?.totalUsers ??
        latestItem?.monetization?.totalUsers ??
        totalSignupsCompleted
    ),
    activeSubscriptions: Number(
      latestItem?.summary?.activeSubscriptions ??
        latestItem?.activeSubscriptions ??
        latestItem?.monetization?.activeSubscriptions ??
        (latestItem?.monetization?.checkoutsCompleted || 0)
    ),
    mrrUsd: metrics.roundFloat(
      Number(
        latestItem?.summary?.mrrUsd ??
          latestItem?.mrrUsd ??
          latestItem?.monetization?.mrrUsd ??
          totalAttributedRevenue
      )
    ),
    grossMarginPercent: metrics.roundOneDecimal(overallGrossMargin),
    costPerThousandPdfsUsd: metrics.roundFloat(costPerThousand),
  };

  const funnel = {
    pageViews: totalPageViews,
    playgroundSubmits: totalPlaygroundSubmits,
    playgroundActivationRate:
      totalPageViews > 0
        ? metrics.roundOneDecimal((totalPlaygroundSubmits / totalPageViews) * 100)
        : 0,
    signupsCompleted: totalSignupsCompleted,
    trialToSignupRate:
      totalPlaygroundSubmits > 0
        ? metrics.roundOneDecimal((totalSignupsCompleted / totalPlaygroundSubmits) * 100)
        : 0,
    apiKeysCreated: totalApiKeysCreated,
    signupToKeyRate:
      totalSignupsCompleted > 0
        ? metrics.roundOneDecimal((totalApiKeysCreated / totalSignupsCompleted) * 100)
        : 0,
    firstApiCalls: totalFirstApiCalls,
    ttfcMedianMinutes: metrics.calculateMedianTtfc(combinedTtfcBuckets),
  };

  const successRate =
    totalRenders > 0
      ? metrics.roundFloat((totalSuccesses / totalRenders) * 100)
      : 100.0;

  const avgRenderMs = totalRenders > 0 ? Math.round(totalDurationMs / totalRenders) : 0;

  const rendering = {
    totalRenders,
    successRate,
    averageRenderMs: avgRenderMs,
    p95RenderMs: metrics.calculateP95(combinedLatencyBuckets),
    latencyHistogram: combinedLatencyBuckets,
  };

  const todayRollup = dailyRollups.find((r) => r.date === todayStr);
  const requestsToday = todayRollup ? todayRollup.renders : 0;
  const recent7 = dailyRollups.slice(-7);
  const requestsLast7Days = recent7.reduce((acc, r) => acc + (r.renders || 0), 0);

  return response(200, {
    summary,
    funnel,
    rendering,
    dailyRollups,
    windowDays: days,
    requestsToday,
    requestsLast7Days,
    requestsLast30Days: totalRenders,
    totalRequests: totalRenders,
    trialRequests: totalPlaygroundSubmits,
    authenticatedRequests: Math.max(0, totalRenders - totalPlaygroundSubmits),
    successRate,
    averageRenderMs: avgRenderMs,
    p95RenderMs: rendering.p95RenderMs,
    errors: totalErrors,
    timeouts: 0,
    trialToSignupRate: funnel.trialToSignupRate,
    byDay: dailyRollups.map((r) => ({
      date: r.date,
      requests: r.renders,
      trialRequests: 0,
      apiRequests: r.renders,
    })),
  });
}

async function readAnalytics(request) {
  return readAdminAnalytics(request);
}

module.exports = {
  calculateAwsCost: metrics.calculateAwsCost,
  calculateGrossMargin: metrics.calculateGrossMargin,
  calculateP95: metrics.calculateP95,
  calculateMedianTtfc: metrics.calculateMedianTtfc,
  roundOneDecimal: metrics.roundOneDecimal,
  roundFloat: metrics.roundFloat,
  parseDays: metrics.parseDays,
  topRanks: metrics.topRanks,
  dateKey: metrics.dateKey,
  latencyBucket: metrics.latencyBucket,
  DEFAULT_DAYS: metrics.DEFAULT_DAYS,
  MAX_DAYS: metrics.MAX_DAYS,

  stringValue: aggregation.stringValue,
  numberValue: aggregation.numberValue,
  queryDay,
  aggregateDayData,

  readAdminAnalytics,
  readAnalytics,
  isAuthorizedAdmin,
  unwrap,
  response,
  ddb,
  setDdbClient,
  getDdbClient,
};
