'use strict';

const crypto = require('node:crypto');
const {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
} = require('@aws-sdk/client-dynamodb');

const ANALYTICS_INDEX = 'AnalyticsDateIndex';
const ANALYTICS_TTL_DAYS = 90;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const TABLE_NAME = process.env.TABLE_NAME;
const STATS_ALLOWED_EMAIL = String(process.env.STATS_ALLOWED_EMAIL || 'vberkoz@gmail.com').trim().toLowerCase();
const PADDLE_API_KEY = process.env.PADDLE_API_KEY || '';
const PADDLE_API_BASE = String(process.env.PADDLE_API_BASE || 'https://api.paddle.com').replace(/\/+$/, '');
const PADDLE_CLIENT_TOKEN = process.env.PADDLE_CLIENT_TOKEN || '';
const PADDLE_ENVIRONMENT = process.env.PADDLE_ENVIRONMENT || 'production';
const PADDLE_PRICES = {
  starter: process.env.PADDLE_STARTER_PRICE_ID || '',
  pro: process.env.PADDLE_PRO_PRICE_ID || '',
  business: process.env.PADDLE_BUSINESS_PRICE_ID || '',
};
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET || '';
const PADDLE_CHECKOUT_URL = process.env.PADDLE_CHECKOUT_URL || '';
const FREE_MONTHLY_QUOTA = positiveInteger(process.env.FREE_MONTHLY_QUOTA, 25);
const PLAN_QUOTAS = {
  starter: positiveInteger(process.env.STARTER_MONTHLY_QUOTA, 5000),
  pro: positiveInteger(process.env.PRO_MONTHLY_QUOTA, 20000),
  business: positiveInteger(process.env.BUSINESS_MONTHLY_QUOTA, 100000),
};
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
  const path = event.resource || event.path || '';
  if (path.endsWith('/billing/webhook')) return receivePaddleWebhook(event);
  if (path.endsWith('/billing/checkout')) return createCheckout(event);
  if (path.endsWith('/billing/portal')) return openBillingPortal(event);
  if (path.endsWith('/dashboard')) return readCustomerDashboard(event);
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

function customerId(request) {
  return String(request.requestContext?.authorizer?.claims?.sub || '').trim();
}

function customerResponse(statusCode, payload) {
  return response(statusCode, payload);
}

async function readCustomerDashboard(request) {
  const userId = customerId(request);
  if (!userId) return customerResponse(401, { error: 'Sign in is required' });

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const today = dateKey(now);
  const billing = await getBilling(userId);
  const usage = { today: 0, failedToday: 0, logs: [] };

  try {
    for (let day = new Date(monthStart); day <= now; day.setUTCDate(day.getUTCDate() + 1)) {
      const items = await queryDay(`USAGE#${dateKey(day)}`);
      for (const item of items) {
        if (stringValue(item, 'entityType') !== 'PDF_REQUEST' || stringValue(item, 'customerId') !== userId) continue;
        const status = stringValue(item, 'status') || 'success';
        if (dateKey(day) === today) {
          usage.today++;
          if (status !== 'success') usage.failedToday++;
        }
        usage.logs.push({
          requestId: stringValue(item, 'requestId'),
          timestamp: numberValue(item, 'timestamp'),
          status,
          errorType: stringValue(item, 'errorType'),
          apiKeyId: stringValue(item, 'apiKeyId'),
          size: numberValue(item, 'size'),
          durationMs: numberValue(item, 'durationMs'),
        });
      }
    }
  } catch (err) {
    console.error('Could not read customer usage', err);
    return customerResponse(500, { error: 'Could not read usage' });
  }

  const activeSubscription = billing && ['active', 'trialing', 'past_due'].includes(billing.status);
  const quota = activeSubscription ? (PLAN_QUOTAS[billing.tier] || PLAN_QUOTAS.pro) : FREE_MONTHLY_QUOTA;
  let usedThisMonth = 0;
  try { usedThisMonth = await getQuotaUsage(userId, monthStart); } catch (err) {
    console.error('Could not read customer quota', err);
    return customerResponse(500, { error: 'Could not read quota' });
  }
  usage.logs.sort((a, b) => b.timestamp - a.timestamp);
  return customerResponse(200, {
    usage: {
      pdfsToday: usage.today,
      failedToday: usage.failedToday,
      quota,
      usedThisMonth,
      remaining: Math.max(0, quota - usedThisMonth),
      resetsAt: nextMonthStart(now).toISOString(),
    },
    billing: billing ? publicBilling(billing) : { status: 'free', plan: 'Free' },
    logs: usage.logs.slice(0, 25),
  });
}

async function createCheckout(request) {
  const userId = customerId(request);
  if (!userId) return customerResponse(401, { error: 'Sign in is required' });
  let checkout;
  try { checkout = JSON.parse(request.body || '{}'); } catch { return customerResponse(400, { error: 'Invalid checkout request' }); }
  const tier = String(checkout.plan || 'pro').toLowerCase();
  const priceID = PADDLE_PRICES[tier];
  if (!PADDLE_API_KEY || !PADDLE_CLIENT_TOKEN || !priceID || !PADDLE_CHECKOUT_URL) {
    return customerResponse(503, { error: 'Billing is not configured yet' });
  }
  try {
    const result = await paddleRequest('/transactions', {
      method: 'POST',
      body: JSON.stringify({
        items: [{ price_id: priceID, quantity: 1 }],
        collection_mode: 'automatic',
        custom_data: { user_id: userId, plan: tier },
        checkout: { url: PADDLE_CHECKOUT_URL },
      }),
    });
    const transactionId = result?.data?.id;
    if (!transactionId) throw new Error('Paddle did not return a transaction ID');
    return customerResponse(200, { transactionId, clientToken: PADDLE_CLIENT_TOKEN, environment: PADDLE_ENVIRONMENT });
  } catch (err) {
    console.error('Could not create Paddle checkout', err);
    return customerResponse(502, { error: 'Could not start checkout' });
  }
}

async function openBillingPortal(request) {
  const userId = customerId(request);
  if (!userId) return customerResponse(401, { error: 'Sign in is required' });
  const billing = await getBilling(userId);
  if (!billing?.paddleCustomerId) return customerResponse(404, { error: 'No subscription is linked to this account' });
  if (!PADDLE_API_KEY) return customerResponse(503, { error: 'Billing is not configured yet' });
  try {
    const result = await paddleRequest(`/customers/${encodeURIComponent(billing.paddleCustomerId)}/portal-sessions`, {
      method: 'POST',
      body: JSON.stringify({ subscription_ids: billing.subscriptionId ? [billing.subscriptionId] : [] }),
    });
    const url = result?.data?.urls?.general?.overview;
    if (!url) throw new Error('Paddle did not return a customer portal URL');
    return customerResponse(200, { url });
  } catch (err) {
    console.error('Could not load Paddle customer portal', err);
    return customerResponse(502, { error: 'Could not open the billing portal' });
  }
}

async function receivePaddleWebhook(request) {
  if (!PADDLE_WEBHOOK_SECRET) {
    console.error('Paddle webhook rejected: secret is not configured');
    return response(503, { error: 'Billing webhook is not configured' });
  }
  const rawBody = request.body || '';
  const signatureParts = signaturePartsFrom(header(request.headers, 'paddle-signature'));
  if (!signatureParts.timestamp || !signatureParts.hash || Math.abs(Math.floor(Date.now() / 1000) - Number(signatureParts.timestamp)) > 300) {
    console.warn('Paddle webhook rejected: signature header is missing or stale');
    return response(401, { error: 'Invalid webhook signature' });
  }
  const expected = crypto.createHmac('sha256', PADDLE_WEBHOOK_SECRET).update(`${signatureParts.timestamp}:${rawBody}`).digest('hex');
  if (!safeEqual(signatureParts.hash, expected)) {
    console.warn('Paddle webhook rejected: signature mismatch');
    return response(401, { error: 'Invalid webhook signature' });
  }
  let payload;
  try { payload = JSON.parse(rawBody); } catch { return response(400, { error: 'Invalid JSON body' }); }
  const attributes = payload?.data || {};
  const userId = String(attributes?.custom_data?.user_id || '').trim();
  const subscriptionId = String(attributes?.id || '').trim();
  if (!userId || !subscriptionId) {
    console.log(`Paddle webhook ignored: ${payload?.event_type || 'unknown'} does not contain RenderPDF subscription custom data`);
    return response(200, { received: true });
  }
  try {
    await ddb.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: billingItem(userId, subscriptionId, attributes),
    }));
  } catch (err) {
    console.error('Could not save billing webhook', err);
    return response(500, { error: 'Could not save billing state' });
  }
  console.log(`Paddle subscription synced: ${payload?.event_type || 'unknown'} (${attributes.status || 'unknown'})`);
  return response(200, { received: true });
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

async function getBilling(userId) {
  try {
    const result = await ddb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { requestId: { S: `BILLING#${userId}` }, timestamp: { N: '0' } },
      ConsistentRead: true,
    }));
    if (!result.Item) return null;
    return {
      subscriptionId: stringValue(result.Item, 'subscriptionId'),
      paddleCustomerId: stringValue(result.Item, 'paddleCustomerId'),
      tier: stringValue(result.Item, 'tier'),
      status: stringValue(result.Item, 'status'),
      plan: stringValue(result.Item, 'plan'),
      renewsAt: stringValue(result.Item, 'renewsAt'),
      endsAt: stringValue(result.Item, 'endsAt'),
      updatePaymentMethod: stringValue(result.Item, 'updatePaymentMethod'),
    };
  } catch (err) {
    console.error('Could not read billing state', err);
    throw err;
  }
}

async function getQuotaUsage(userId, monthStart) {
  const result = await ddb.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: { requestId: { S: `USER_QUOTA#${userId}#${dateKey(monthStart).slice(0, 7)}` }, timestamp: { N: '0' } },
    ConsistentRead: true,
  }));
  return numberValue(result.Item, 'used');
}

function billingItem(userId, subscriptionId, attributes) {
  const value = (input) => ({ S: String(input || '') });
  const billingPeriod = attributes.current_billing_period || {};
  const firstItem = Array.isArray(attributes.items) ? attributes.items[0] : null;
  return {
    requestId: value(`BILLING#${userId}`),
    timestamp: { N: '0' },
    entityType: value('BILLING'),
    customerId: value(userId),
    subscriptionId: value(subscriptionId),
    paddleCustomerId: value(attributes.customer_id),
    tier: value(attributes.custom_data?.plan || 'pro'),
    status: value(attributes.status || 'unknown'),
    plan: value(firstItem?.price?.product?.name || 'RenderPDF Pro'),
    renewsAt: value(attributes.next_billed_at || billingPeriod.ends_at),
    endsAt: value(attributes.canceled_at),
    updatedAt: { N: String(Math.floor(Date.now() / 1000)) },
  };
}

function publicBilling(billing) {
  return {
    status: billing.status || 'unknown',
    plan: billing.plan || 'RenderPDF Pro',
    tier: billing.tier || 'pro',
    renewsAt: billing.renewsAt || null,
    endsAt: billing.endsAt || null,
  };
}

async function paddleRequest(path, options = {}) {
  const response = await fetch(`${PADDLE_API_BASE}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${PADDLE_API_KEY}`,
      ...(options.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`Paddle API returned ${response.status}`);
  return response.json();
}

function header(headers, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === target) return String(value || '');
  }
  return '';
}

function safeEqual(left, right) {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signaturePartsFrom(value) {
  const parts = {};
  for (const pair of String(value || '').split(';')) {
    const [key, item] = pair.trim().split('=', 2);
    if (key === 'ts') parts.timestamp = item;
    if (key === 'h1' && !parts.hash) parts.hash = item;
  }
  return parts;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nextMonthStart(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
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
