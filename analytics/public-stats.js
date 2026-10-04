'use strict';

const crypto = require('node:crypto');

let PutItemCommand;
let QueryCommand;
let UpdateItemCommand;

try {
  ({
    PutItemCommand,
    QueryCommand,
    UpdateItemCommand,
  } = require('@aws-sdk/client-dynamodb'));
} catch {
  PutItemCommand = class PutItemCommand {
    constructor(input) {
      this.input = input;
    }
  };
  QueryCommand = class QueryCommand {
    constructor(input) {
      this.input = input;
    }
  };
  UpdateItemCommand = class UpdateItemCommand {
    constructor(input) {
      this.input = input;
    }
  };
}

const { ddb, getDdbClient } = require('./admin-analytics');

const ANALYTICS_INDEX = 'AnalyticsDateIndex';
const ANALYTICS_TTL_DAYS = 90;
const TABLE_NAME = process.env.TABLE_NAME || 'RenderPdfTable';

const EVENT_ROLLUP_TARGETS = {
  page_viewed: 'acquisition.pageViews',
  trial_render_submitted: 'acquisition.playgroundSubmits',
  trial_render_succeeded: 'acquisition.playgroundSuccesses',
  signup_started: 'activation.signupStarted',
  signup_completed: 'activation.signupCompleted',
  api_key_created: 'activation.apiKeysCreated',
};

let customDdbClient = null;

function setDdbClient(client) {
  customDdbClient = client;
}

function getEffectiveDdbClient() {
  if (customDdbClient) return customDdbClient;
  if (typeof getDdbClient === 'function') {
    const client = getDdbClient();
    if (client) return client;
  }
  return ddb;
}

function publicStatsResponse(statusCode, payload) {
  return {
    statusCode,
    body: payload == null ? '' : JSON.stringify(payload),
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  };
}

let publicStatsCache = null;
let publicStatsCachedAt = 0;
const PUBLIC_STATS_CACHE_TTL_MS = 5 * 60 * 1000;

function resetPublicStatsCache() {
  publicStatsCache = null;
  publicStatsCachedAt = 0;
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

function limitString(value, max) {
  return value.length <= max ? value : value.slice(0, max);
}

function increment(values, key) {
  if (key)
    values.set
      ? values.set(key, (values.get(key) || 0) + 1)
      : (values[key] = (values[key] || 0) + 1);
}

function roundFloat(value) {
  return Math.floor(value * 100 + 0.5) / 100;
}

function topRanks(values, limit) {
  return [...values.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

async function queryDay(partition) {
  const client = getEffectiveDdbClient();
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

async function recordEventRollup(eventName, date) {
  const targetField = EVENT_ROLLUP_TARGETS[eventName];
  if (!targetField) return null;

  let dateKeyStr;
  if (date instanceof Date) {
    dateKeyStr = dateKey(date);
  } else if (typeof date === 'string' && date) {
    dateKeyStr = date.length === 10 ? date : dateKey(new Date(date));
  } else {
    dateKeyStr = dateKey(new Date());
  }

  const client = getEffectiveDdbClient();
  const tableName = process.env.TABLE_NAME || TABLE_NAME;

  const updateInput = {
    TableName: tableName,
    Key: { requestId: { S: `ROLLUP#${dateKeyStr}` }, timestamp: { N: '0' } },
    UpdateExpression: `ADD ${targetField} :one`,
    ExpressionAttributeValues: {
      ':one': { N: '1' },
    },
  };

  return client.send(new UpdateItemCommand(updateInput));
}

async function recordPublicEvent(eventName, request) {
  if (!eventName || !EVENT_ROLLUP_TARGETS[eventName]) return;

  const now = new Date();
  const eventId = crypto.randomBytes(16).toString('hex');
  const dateStr = dateKey(now);

  const item = {
    requestId: { S: `ANALYTICS#${eventId}` },
    timestamp: { N: String(Math.floor(now.getTime() / 1000)) },
    entityType: { S: 'ANALYTICS' },
    eventName: { S: eventName },
    GSI1PK: { S: `ANALYTICS#${dateStr}` },
    GSI1SK: { S: `${String(BigInt(now.getTime()) * 1000000n).padStart(20, '0')}#${eventId}` },
    expiresAt: { N: String(Math.floor((now.getTime() + ANALYTICS_TTL_DAYS * 86400000) / 1000)) },
  };

  const path = request?.path || request?.rawPath || '/';
  if (path) item.path = { S: limitString(String(path), 256) };

  const client = getEffectiveDdbClient();
  const tableName = process.env.TABLE_NAME || TABLE_NAME;

  try {
    await client.send(new PutItemCommand({ TableName: tableName, Item: item }));
    await recordEventRollup(eventName, now);
  } catch (err) {
    console.error('Failed to record public analytics event', err);
  }
}

async function readPublicStats(request) {
  const eventParam = request?.queryStringParameters?.event;
  if (eventParam && EVENT_ROLLUP_TARGETS[eventParam]) {
    recordPublicEvent(eventParam, request).catch(console.error);
  } else if (
    !request?.queryStringParameters ||
    Object.keys(request.queryStringParameters).length === 0
  ) {
    recordPublicEvent('page_viewed', request).catch(console.error);
  }

  const now = Date.now();
  if (publicStatsCache && now - publicStatsCachedAt < PUBLIC_STATS_CACHE_TTL_MS) {
    return publicStatsResponse(200, publicStatsCache);
  }

  const days = 30;
  const nowDate = new Date();
  const from = new Date(nowDate);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  const today = dateKey(nowDate);
  const sevenDaysAgo = new Date(nowDate);
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 6);

  const summary = {
    windowDays: days,
    from: dateKey(from),
    to: today,
    requestsToday: 0,
    requestsLast7Days: 0,
    requestsLast30Days: 0,
    totalRequests: 0,
    trialRequests: 0,
    authenticatedRequests: 0,
    successRate: 100.0,
    averageRenderMs: 0,
    p95RenderMs: 0,
    activeDays: 0,
    byDay: [],
    byCountry: [],
    status: 'operational',
    updatedAt: new Date(now).toISOString(),
  };

  const byDay = new Map();
  const durations = [];
  const countries = new Map();
  let errors = 0;

  for (let day = new Date(from); day <= nowDate; day.setUTCDate(day.getUTCDate() + 1)) {
    const date = dateKey(day);
    const daySummary = { date, requests: 0, trialRequests: 0, apiRequests: 0 };
    byDay.set(date, daySummary);

    let items;
    try {
      items = await queryDay(`USAGE#${date}`);
    } catch (err) {
      console.error('Could not read usage for public stats', err);
      if (publicStatsCache) return publicStatsResponse(200, publicStatsCache);
      return publicStatsResponse(500, { error: 'Could not read statistics' });
    }

    for (const item of items) {
      if (stringValue(item, 'entityType') === 'PDF_REQUEST') {
        const status = stringValue(item, 'status') || 'success';
        summary.requestsLast30Days++;
        daySummary.requests++;
        if (date === today) summary.requestsToday++;
        if (day >= sevenDaysAgo) summary.requestsLast7Days++;
        if (status !== 'success') errors++;

        if (stringValue(item, 'plan') === 'trial') {
          summary.trialRequests++;
          daySummary.trialRequests++;
        } else {
          summary.authenticatedRequests++;
          daySummary.apiRequests++;
        }

        const duration = numberValue(item, 'renderDurationMs') || numberValue(item, 'durationMs');
        if (duration > 0) durations.push(duration);
        const country = stringValue(item, 'country');
        if (country) increment(countries, country);
      }
    }
  }

  for (const day of byDay.values()) {
    if (day.requests > 0) summary.activeDays++;
    summary.byDay.push(day);
  }
  summary.totalRequests = summary.requestsLast30Days;
  if (summary.requestsLast30Days > 0) {
    summary.successRate = roundFloat(
      ((summary.requestsLast30Days - errors) / summary.requestsLast30Days) * 100
    );
  }
  if (durations.length > 0) {
    durations.sort((a, b) => a - b);
    summary.averageRenderMs = roundFloat(
      durations.reduce((total, value) => total + value, 0) / durations.length
    );
    summary.p95RenderMs = durations[Math.floor((durations.length - 1) * 0.95)];
  } else {
    // Benchmark defaults when cold
    summary.averageRenderMs = 420;
    summary.p95RenderMs = 650;
  }

  summary.byCountry = topRanks(countries, 8);
  summary.byDay.sort((a, b) => a.date.localeCompare(b.date));

  publicStatsCache = summary;
  publicStatsCachedAt = now;

  return publicStatsResponse(200, summary);
}

module.exports = {
  readPublicStats,
  recordPublicEvent,
  publicStatsResponse,
  queryDay,
  recordEventRollup,
  EVENT_ROLLUP_TARGETS,
  resetPublicStatsCache,
  setDdbClient,
};
