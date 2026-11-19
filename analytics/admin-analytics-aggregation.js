'use strict';

const { calculateP95, latencyBucket } = require('./admin-analytics-metrics');

const ANALYTICS_INDEX = 'AnalyticsDateIndex';
const TABLE_NAME = process.env.TABLE_NAME || 'RenderPdfTable';

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

async function queryDay(partition, client, QueryCommand) {
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

async function aggregateDayData(dateStr, existingRollup = null, client, QueryCommand) {
  let usageItems = [];
  let analyticsItems = [];

  try {
    [usageItems, analyticsItems] = await Promise.all([
      queryDay(`USAGE#${dateStr}`, client, QueryCommand).catch(() => []),
      queryDay(`ANALYTICS#${dateStr}`, client, QueryCommand).catch(() => []),
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

module.exports = {
  stringValue,
  numberValue,
  queryDay,
  aggregateDayData,
};
