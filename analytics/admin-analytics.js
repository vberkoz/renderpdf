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

const ANALYTICS_INDEX = 'AnalyticsDateIndex';
const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
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

function roundOneDecimal(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
}

function roundFloat(value) {
  return Math.floor(value * 100 + 0.5) / 100;
}

function calculateAwsCost(totalRenders = 0, totalDurationMs = 0, totalBytes = 0) {
  const lambdaCost =
    (totalDurationMs / 1000) * (2048 / 1024) * 0.0000166667 + (totalRenders * 0.2) / 1000000;
  const s3Cost = (totalRenders * 0.005) / 1000 + (totalBytes / 1e9) * 0.023;
  return lambdaCost + s3Cost;
}

function calculateGrossMargin(attributedRevenue, awsCost) {
  if (!attributedRevenue || attributedRevenue <= 0) return 0;
  return ((attributedRevenue - awsCost) / attributedRevenue) * 100;
}

function calculateP95(latencyBuckets) {
  if (!latencyBuckets) return 0;
  const buckets = [
    { key: 'under_400ms', min: 100, max: 400, midpoint: 250 },
    { key: '400ms_to_800ms', min: 400, max: 800, midpoint: 600 },
    { key: '800ms_to_1500ms', min: 800, max: 1500, midpoint: 1150 },
    { key: 'over_1500ms', min: 1500, max: 2900, midpoint: 2200 },
  ];

  let total = 0;
  for (const b of buckets) {
    total += Number(latencyBuckets[b.key] || 0);
  }
  if (total === 0) return 0;

  const target = 0.95 * total;
  let cumulative = 0;

  for (const b of buckets) {
    const count = Number(latencyBuckets[b.key] || 0);
    if (count <= 0) continue;
    if (cumulative + count >= target) {
      const rankInBucket = target - cumulative;
      const fraction = rankInBucket / count;
      return Math.round(b.min + fraction * (b.max - b.min));
    }
    cumulative += count;
  }

  return buckets[buckets.length - 1].midpoint;
}

function calculateMedianTtfc(ttfcBuckets) {
  if (!ttfcBuckets) return 0;
  const buckets = [
    { key: 'under_5m', min: 0, max: 5 },
    { key: '5m_to_30m', min: 5, max: 30 },
    { key: '30m_to_2h', min: 30, max: 120 },
    { key: 'over_2h', min: 120, max: 360 },
  ];

  let total = 0;
  for (const b of buckets) {
    total += Number(ttfcBuckets[b.key] || 0);
  }
  if (total === 0) return 0;

  const target = 0.5 * total;
  let cumulative = 0;

  for (const b of buckets) {
    const count = Number(ttfcBuckets[b.key] || 0);
    if (count <= 0) continue;
    if (cumulative + count >= target) {
      const rank = target - cumulative;
      const fraction = rank / count;
      return roundOneDecimal(b.min + fraction * (b.max - b.min));
    }
    cumulative += count;
  }

  return 0;
}

function parseDays(value, fallback = DEFAULT_DAYS) {
  const days = Number.parseInt(value, 10);
  if (!Number.isFinite(days) || days < 1) return fallback;
  return Math.min(days, MAX_DAYS);
}

function topRanks(values, limit) {
  return [...values.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function stringValue(item, key) {
  return item?.[key]?.S || (typeof item?.[key] === 'string' ? item[key] : '');
}

function numberValue(item, key) {
  if (item?.[key]?.N != null) {
    const value = Number.parseInt(item[key].N, 10);
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof item?.[key] === 'number') return item[key];
  if (typeof item?.[key] === 'string') {
    const parsed = Number.parseInt(item[key], 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function latencyBucket(durationMs) {
  if (durationMs < 400) return 'under_400ms';
  if (durationMs < 800) return '400ms_to_800ms';
  if (durationMs < 1500) return '800ms_to_1500ms';
  return 'over_1500ms';
}

async function queryDay(partition) {
  const client = getDdbClient();
  const tableName = process.env.TABLE_NAME || TABLE_NAME;
  const items = [];
  let ExclusiveStartKey;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: ANALYTICS_INDEX,
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': { S: partition } },
        ExclusiveStartKey,
      })
    );
    items.push(...(result.Items || []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey && Object.keys(ExclusiveStartKey).length > 0);
  return items;
}

async function aggregateDayData(dateStr, existingRollup = null) {
  let usageItems = [];
  let analyticsItems = [];

  try {
    [usageItems, analyticsItems] = await Promise.all([
      queryDay(`USAGE#${dateStr}`).catch(() => []),
      queryDay(`ANALYTICS#${dateStr}`).catch(() => []),
    ]);
  } catch (err) {
    console.error(`Could not query day data for ${dateStr}:`, err);
  }

  if (usageItems.length === 0 && analyticsItems.length === 0) {
    return existingRollup || null;
  }

  let totalRenders = 0;
  let successes = 0;
  let errors = 0;
  let totalDurationMs = 0;
  let totalBytes = 0;
  let playgroundSubmits = 0;
  let playgroundSuccesses = 0;
  const byPlan = { trial: 0, free: 0, starter: 0, pro: 0 };
  const latencyBuckets = {
    under_400ms: 0,
    '400ms_to_800ms': 0,
    '800ms_to_1500ms': 0,
    over_1500ms: 0,
  };

  for (const item of usageItems) {
    const entityType = stringValue(item, 'entityType');
    if (entityType === 'PDF_REQUEST' || !entityType) {
      totalRenders++;
      const status = stringValue(item, 'status') || 'success';
      if (status === 'success') {
        successes++;
      } else {
        errors++;
      }

      const plan = stringValue(item, 'plan') || 'free';
      byPlan[plan] = (byPlan[plan] || 0) + 1;
      if (plan === 'trial') {
        playgroundSubmits++;
        if (status === 'success') playgroundSuccesses++;
      }

      const duration = numberValue(item, 'renderDurationMs') || numberValue(item, 'durationMs');
      if (duration > 0) {
        totalDurationMs += duration;
        const bucket = latencyBucket(duration);
        latencyBuckets[bucket] = (latencyBuckets[bucket] || 0) + 1;
      }

      const size = numberValue(item, 'size');
      if (size > 0) totalBytes += size;
    }
  }

  let pageViews = 0;
  let signupsCompleted = 0;
  let apiKeysCreated = 0;

  for (const item of analyticsItems) {
    const eventName = stringValue(item, 'eventName');
    if (eventName === 'page_viewed') pageViews++;
    if (eventName === 'trial_render_submitted') playgroundSubmits++;
    if (eventName === 'trial_render_succeeded') playgroundSuccesses++;
    if (eventName === 'signup_completed' || eventName === 'signup') signupsCompleted++;
    if (eventName === 'api_key_created') apiKeysCreated++;
  }

  const p95 = calculateP95(latencyBuckets);

  const prevAcq = existingRollup?.acquisition || {};
  const prevAct = existingRollup?.activation || {};
  const prevRend = existingRollup?.rendering || {};

  const merged = {
    date: dateStr,
    acquisition: {
      pageViews: Math.max(pageViews, Number(prevAcq.pageViews || 0)),
      playgroundSubmits: Math.max(playgroundSubmits, Number(prevAcq.playgroundSubmits || 0)),
      playgroundSuccesses: Math.max(playgroundSuccesses, Number(prevAcq.playgroundSuccesses || 0)),
    },
    activation: {
      signupsCompleted: Math.max(
        signupsCompleted,
        Number(prevAct.signupCompleted ?? prevAct.signupsCompleted ?? 0)
      ),
      apiKeysCreated: Math.max(apiKeysCreated, Number(prevAct.apiKeysCreated || 0)),
      firstApiCalls: Math.max(
        Number(prevAct.firstApiCalls || 0),
        apiKeysCreated > 0 && totalRenders > 0 ? 1 : 0
      ),
      ttfcBuckets: prevAct.ttfcBuckets || {
        under_5m: 0,
        '5m_to_30m': 0,
        '30m_to_2h': 0,
        over_2h: 0,
      },
    },
    rendering: {
      totalRenders: Math.max(totalRenders, Number(prevRend.totalRenders || 0)),
      successes: Math.max(successes, Number(prevRend.successes || 0)),
      errors: Math.max(errors, Number(prevRend.errors || 0)),
      totalDurationMs: Math.max(totalDurationMs, Number(prevRend.totalDurationMs || 0)),
      totalBytes: Math.max(totalBytes, Number(prevRend.totalBytes || 0)),
      byPlan,
      latencyBuckets: {
        under_400ms: Math.max(
          latencyBuckets.under_400ms,
          Number(prevRend.latencyBuckets?.under_400ms || 0)
        ),
        '400ms_to_800ms': Math.max(
          latencyBuckets['400ms_to_800ms'],
          Number(prevRend.latencyBuckets?.['400ms_to_800ms'] || 0)
        ),
        '800ms_to_1500ms': Math.max(
          latencyBuckets['800ms_to_1500ms'],
          Number(prevRend.latencyBuckets?.['800ms_to_1500ms'] || 0)
        ),
        over_1500ms: Math.max(
          latencyBuckets.over_1500ms,
          Number(prevRend.latencyBuckets?.over_1500ms || 0)
        ),
      },
      p95Ms: p95 || prevRend.p95Ms || 0,
    },
  };

  if (existingRollup?.monetization) merged.monetization = existingRollup.monetization;
  if (existingRollup?.revenueUsd) merged.revenueUsd = existingRollup.revenueUsd;
  if (existingRollup?.summary) merged.summary = existingRollup.summary;

  return merged;
}

async function readAdminAnalytics(request) {
  if (!isAuthorizedAdmin(request)) {
    return response(403, { error: 'Forbidden' });
  }

  const days = parseDays(request?.queryStringParameters?.days, 30);
  const now = new Date();
  const keys = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    keys.push({ requestId: { S: `ROLLUP#${dateKey(d)}` }, timestamp: { N: '0' } });
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
    dates.push(dateKey(d));
  }

  const todayStr = dateKey(now);
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
        : calculateAwsCost(dayRenders, dayDurationMs, dayBytes);
    const dayMargin =
      item.marginPercent != null
        ? Number(item.marginPercent)
        : calculateGrossMargin(dayRevenue, dayAwsCost);
    const dayP95 =
      item.p95Ms != null
        ? Number(item.p95Ms)
        : rendering.p95Ms != null
          ? Number(rendering.p95Ms)
          : calculateP95(rendering.latencyBuckets);

    totalAttributedRevenue += dayRevenue;
    totalAwsCost += dayAwsCost;

    dailyRollups.push({
      date: dateStr,
      renders: dayRenders,
      errors: dayErrors,
      revenueUsd: roundFloat(dayRevenue),
      estimatedAwsCostUsd: roundFloat(dayAwsCost),
      marginPercent: roundOneDecimal(dayMargin),
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
    totalAttributedRevenue > 0 ? calculateGrossMargin(totalAttributedRevenue, totalAwsCost) : 0;

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
    mrrUsd: roundFloat(
      Number(
        latestItem?.summary?.mrrUsd ??
          latestItem?.mrrUsd ??
          latestItem?.monetization?.mrrUsd ??
          totalAttributedRevenue
      )
    ),
    grossMarginPercent: roundOneDecimal(overallGrossMargin),
    costPerThousandPdfsUsd: roundFloat(costPerThousand),
  };

  const funnel = {
    pageViews: totalPageViews,
    playgroundSubmits: totalPlaygroundSubmits,
    playgroundActivationRate:
      totalPageViews > 0 ? roundOneDecimal((totalPlaygroundSubmits / totalPageViews) * 100) : 0,
    signupsCompleted: totalSignupsCompleted,
    trialToSignupRate:
      totalPlaygroundSubmits > 0
        ? roundOneDecimal((totalSignupsCompleted / totalPlaygroundSubmits) * 100)
        : 0,
    apiKeysCreated: totalApiKeysCreated,
    signupToKeyRate:
      totalSignupsCompleted > 0
        ? roundOneDecimal((totalApiKeysCreated / totalSignupsCompleted) * 100)
        : 0,
    firstApiCalls: totalFirstApiCalls,
    ttfcMedianMinutes: calculateMedianTtfc(combinedTtfcBuckets),
  };

  const successRate = totalRenders > 0 ? roundFloat((totalSuccesses / totalRenders) * 100) : 100.0;

  const avgRenderMs = totalRenders > 0 ? Math.round(totalDurationMs / totalRenders) : 0;

  const rendering = {
    totalRenders,
    successRate,
    averageRenderMs: avgRenderMs,
    p95RenderMs: calculateP95(combinedLatencyBuckets),
    latencyHistogram: combinedLatencyBuckets,
  };

  return response(200, {
    summary,
    funnel,
    rendering,
    dailyRollups,
  });
}

async function readAnalytics(request) {
  return readAdminAnalytics(request);
}

module.exports = {
  calculateAwsCost,
  calculateGrossMargin,
  calculateP95,
  calculateMedianTtfc,
  aggregateDayData,
  readAdminAnalytics,
  readAnalytics,
  isAuthorizedAdmin,
  unwrap,
  roundOneDecimal,
  parseDays,
  topRanks,
  // Helper / utility exports:
  queryDay,
  latencyBucket,
  dateKey,
  stringValue,
  numberValue,
  roundFloat,
  response,
  ddb,
  setDdbClient,
  getDdbClient,
};
