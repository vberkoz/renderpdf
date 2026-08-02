'use strict';

const crypto = require('node:crypto');
const {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
} = require('@aws-sdk/client-dynamodb');

const ANALYTICS_INDEX = 'AnalyticsDateIndex';
const ANALYTICS_TTL_DAYS = 90;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const TABLE_NAME = process.env.TABLE_NAME;
const STATS_ALLOWED_EMAIL = String(process.env.STATS_ALLOWED_EMAIL || 'vberkoz@gmail.com').trim().toLowerCase();
const ddb = new DynamoDBClient({});
const EVENT_NAME = /^[a-zA-Z0-9._:-]{1,64}$/;

function response(statusCode, payload) {
  return {
    statusCode,
    body: payload == null ? '' : JSON.stringify(payload),
    headers: {
      'Access-Control-Allow-Origin': 'https://renderpdf.vberkoz.com',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, max-age=0',
    },
  };
}

async function handler(event) {
  switch (event.httpMethod) {
    case 'GET':
      return readAnalytics(event);
    case 'POST':
      return saveAnalytics(event);
    case 'OPTIONS':
      return response(204);
    default:
      return response(405, { error: 'Method not allowed' });
  }
}

async function saveAnalytics(request) {
  let event;
  try {
    event = JSON.parse(request.body || '');
  } catch {
    return response(400, { error: 'Invalid JSON body' });
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return response(400, { error: 'Invalid JSON body' });
  }

  event.event = String(event.event || '').trim();
  if (!EVENT_NAME.test(event.event)) {
    return response(400, { error: 'event must be 1-64 letters, numbers, dots, colons, hyphens, or underscores' });
  }
  const durationMs = Number(event.durationMs || 0);
  if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 3600000) {
    return response(400, { error: 'durationMs must be between 0 and 3600000' });
  }

  const now = new Date();
  const eventId = crypto.randomBytes(16).toString('hex');
  const item = {
    requestId: { S: `ANALYTICS#${eventId}` },
    timestamp: { N: String(Math.floor(now.getTime() / 1000)) },
    entityType: { S: 'ANALYTICS' },
    eventName: { S: event.event },
    GSI1PK: { S: `ANALYTICS#${dateKey(now)}` },
    GSI1SK: { S: `${String(BigInt(now.getTime()) * 1000000n).padStart(20, '0')}#${eventId}` },
    expiresAt: { N: String(Math.floor((now.getTime() + ANALYTICS_TTL_DAYS * 86400000) / 1000)) },
  };
  if (event.path) item.path = { S: limitString(String(event.path), 256) };
  if (event.source) item.source = { S: limitString(String(event.source), 128) };
  if (event.status) item.status = { S: limitString(String(event.status), 64) };
  if (durationMs > 0) item.durationMs = { N: String(Math.trunc(durationMs)) };

  try {
    await ddb.send(new PutItemCommand({ TableName: TABLE_NAME, Item: item }));
  } catch (err) {
    console.error('Could not save analytics event', err);
    return response(500, { error: 'Could not save analytics event' });
  }
  return response(202, { id: eventId });
}

async function readAnalytics(request) {
  const email = String(request.requestContext?.authorizer?.claims?.email || '').trim().toLowerCase();
  if (!email || email !== STATS_ALLOWED_EMAIL) {
    return response(403, { error: 'Statistics access is restricted to the approved account' });
  }
  const days = parseDays(request.queryStringParameters?.days);
  const now = new Date();
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  const today = dateKey(now);
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 6);
  const summary = {
    windowDays: days,
    from: dateKey(from),
    to: today,
    requestsToday: 0,
    requestsLast7Days: 0,
    requestsLast30Days: 0,
    totalRequests: 0,
    totalBytes: 0,
    trialRequests: 0,
    authenticatedRequests: 0,
    successRate: 0,
    averageRenderMs: 0,
    p95RenderMs: 0,
    averagePdfBytes: 0,
    errors: 0,
    timeouts: 0,
    signupEvents: 0,
    trialToSignupRate: 0,
    analyticsEvents: 0,
    activeDays: 0,
    byDay: [],
    byEvent: {},
    byPlan: {},
    topApiKeys: [],
    topCustomers: [],
    byCountry: [],
  };
  const byDay = new Map();
  const durations = [];
  const apiKeys = new Map();
  const customers = new Map();
  const countries = new Map();
  const signupCustomers = new Set();
  let anonymousSignups = 0;

  for (let day = new Date(from); day <= now; day.setUTCDate(day.getUTCDate() + 1)) {
    const date = dateKey(day);
    const daySummary = { date, requests: 0, trialRequests: 0, apiRequests: 0, successes: 0, errors: 0, bytes: 0, events: 0 };
    byDay.set(date, daySummary);
    for (const prefix of ['ANALYTICS', 'USAGE']) {
      let items;
      try {
        items = await queryDay(`${prefix}#${date}`);
      } catch (err) {
        console.error('Could not read analytics', err);
        return response(500, { error: 'Could not read analytics' });
      }
      for (const item of items) {
        if (stringValue(item, 'entityType') === 'PDF_REQUEST') {
          const status = stringValue(item, 'status') || 'success';
          summary.requestsLast30Days++;
          daySummary.requests++;
          if (date === today) summary.requestsToday++;
          if (day >= sevenDaysAgo) summary.requestsLast7Days++;
          if (status === 'success') daySummary.successes++;
          else {
            daySummary.errors++;
            summary.errors++;
            if (status === 'timeout' || stringValue(item, 'errorType').includes('timeout')) summary.timeouts++;
          }
          if (stringValue(item, 'plan') === 'trial') {
            summary.trialRequests++;
            daySummary.trialRequests++;
          } else {
            summary.authenticatedRequests++;
            daySummary.apiRequests++;
          }
          const size = numberValue(item, 'size');
          if (size > 0) daySummary.bytes += size;
          summary.totalBytes += size;
          const duration = numberValue(item, 'renderDurationMs') || numberValue(item, 'durationMs');
          if (duration > 0) durations.push(duration);
          const plan = stringValue(item, 'plan') || 'unknown';
          increment(summary.byPlan, plan);
          increment(apiKeys, stringValue(item, 'apiKeyId'));
          increment(customers, stringValue(item, 'customerId'));
          increment(countries, stringValue(item, 'country'));
        } else if (stringValue(item, 'entityType') === 'ANALYTICS') {
          summary.analyticsEvents++;
          daySummary.events++;
          const eventName = stringValue(item, 'eventName');
          if (eventName) increment(summary.byEvent, eventName);
          if (eventName === 'api_key_created' || eventName === 'signup') {
            const customer = stringValue(item, 'customerId');
            if (customer) signupCustomers.add(customer);
            else anonymousSignups++;
          }
        }
      }
    }
  }

  for (const day of byDay.values()) {
    if (day.requests > 0 || day.events > 0) summary.activeDays++;
    summary.byDay.push(day);
  }
  summary.totalRequests = summary.requestsLast30Days;
  summary.signupEvents = signupCustomers.size + anonymousSignups;
  if (summary.requestsLast30Days > 0) summary.successRate = roundFloat((summary.requestsLast30Days - summary.errors) / summary.requestsLast30Days * 100);
  if (durations.length > 0) {
    durations.sort((a, b) => a - b);
    summary.averageRenderMs = roundFloat(durations.reduce((total, value) => total + value, 0) / durations.length);
    summary.p95RenderMs = durations[Math.floor((durations.length - 1) * 0.95)];
  }
  const successes = summary.requestsLast30Days - summary.errors;
  if (successes > 0) summary.averagePdfBytes = roundFloat(summary.totalBytes / successes);
  if (summary.trialRequests > 0) summary.trialToSignupRate = roundFloat(summary.signupEvents / summary.trialRequests * 100);
  summary.topApiKeys = topRanks(apiKeys, 20);
  summary.topCustomers = topRanks(customers, 20);
  summary.byCountry = topRanks(countries, 20);
  summary.byDay.sort((a, b) => a.date.localeCompare(b.date));
  return response(200, summary);
}

async function queryDay(partition) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: ANALYTICS_INDEX,
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': { S: partition } },
      ExclusiveStartKey,
    }));
    items.push(...(result.Items || []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey && Object.keys(ExclusiveStartKey).length > 0);
  return items;
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function parseDays(value) {
  const days = Number.parseInt(value, 10);
  if (!Number.isFinite(days) || days < 1) return DEFAULT_DAYS;
  return Math.min(days, MAX_DAYS);
}

function stringValue(item, key) {
  return item?.[key]?.S || '';
}

function numberValue(item, key) {
  const value = Number.parseInt(item?.[key]?.N || '0', 10);
  return Number.isFinite(value) ? value : 0;
}

function limitString(value, max) {
  return value.length <= max ? value : value.slice(0, max);
}

function increment(values, key) {
  if (key) values.set ? values.set(key, (values.get(key) || 0) + 1) : values[key] = (values[key] || 0) + 1;
}

function topRanks(values, limit) {
  return [...values.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function roundFloat(value) {
  return Math.floor(value * 100 + 0.5) / 100;
}

exports.handler = handler;
