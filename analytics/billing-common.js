'use strict';

const crypto = require('node:crypto');

let DynamoDBClient;
let GetItemCommand;
let QueryCommand;
let UpdateItemCommand;
try {
  ({
    DynamoDBClient,
    GetItemCommand,
    QueryCommand,
    UpdateItemCommand,
  } = require('@aws-sdk/client-dynamodb'));
} catch {
  DynamoDBClient = class MockDynamoDBClient {
    async send() {
      return {};
    }
  };
  GetItemCommand = class GetItemCommand {
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

let APIGatewayClient;
let CreateUsagePlanKeyCommand;
let DeleteUsagePlanKeyCommand;
try {
  ({
    APIGatewayClient,
    CreateUsagePlanKeyCommand,
    DeleteUsagePlanKeyCommand,
  } = require('@aws-sdk/client-api-gateway'));
} catch {
  APIGatewayClient = class MockAPIGatewayClient {
    async send() {
      return {};
    }
  };
  CreateUsagePlanKeyCommand = class CreateUsagePlanKeyCommand {
    constructor(input) {
      this.input = input;
    }
  };
  DeleteUsagePlanKeyCommand = class DeleteUsagePlanKeyCommand {
    constructor(input) {
      this.input = input;
    }
  };
}

const ddb = new DynamoDBClient({});
const apigw = new APIGatewayClient({});

let customDdbClient = null;
let customApigwClient = null;

function setDdbClient(client) {
  customDdbClient = client;
}

function setApigwClient(client) {
  customApigwClient = client;
}

function getDdbClient() {
  return customDdbClient || ddb;
}

function getApigwClient() {
  return customApigwClient || apigw;
}

const ANALYTICS_INDEX = 'AnalyticsDateIndex';
const TABLE_NAME = process.env.TABLE_NAME || 'RenderPdfTable';
const FREE_MONTHLY_QUOTA = positiveInteger(process.env.FREE_MONTHLY_QUOTA, 25);
const PLAN_QUOTAS = {
  free: positiveInteger(process.env.FREE_MONTHLY_QUOTA, 25),
  starter: positiveInteger(process.env.STARTER_MONTHLY_QUOTA, 5000),
  pro: positiveInteger(process.env.PRO_MONTHLY_QUOTA, 20000),
  enterprise: positiveInteger(process.env.ENTERPRISE_MONTHLY_QUOTA, 100000),
};
const PADDLE_API_KEY = process.env.PADDLE_API_KEY || '';
const PADDLE_API_BASE = String(process.env.PADDLE_API_BASE || 'https://api.paddle.com').replace(
  /\/+$/,
  ''
);
const PADDLE_CLIENT_TOKEN = process.env.PADDLE_CLIENT_TOKEN || '';
const PADDLE_ENVIRONMENT = process.env.PADDLE_ENVIRONMENT || 'production';
const PADDLE_PRICES = {
  starter: process.env.PADDLE_STARTER_PRICE_ID || '',
  pro: process.env.PADDLE_PRO_PRICE_ID || '',
  starter_annual: process.env.PADDLE_STARTER_ANNUAL_PRICE_ID || '',
  pro_annual: process.env.PADDLE_PRO_ANNUAL_PRICE_ID || '',
};
const PADDLE_OVERAGE_PRICE_ID = process.env.PADDLE_OVERAGE_PRICE_ID || '';
const OVERAGE_RENDER_CREDITS = positiveInteger(process.env.OVERAGE_RENDER_CREDITS, 1000);
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET || '';
const PADDLE_CHECKOUT_URL = process.env.PADDLE_CHECKOUT_URL || '';
const PADDLE_SUBSCRIPTION_EVENTS = new Set([
  'subscription.created',
  'subscription.updated',
  'subscription.activated',
  'subscription.trialing',
  'subscription.canceled',
  'subscription.past_due',
  'subscription.paused',
  'subscription.resumed',
]);
const QUOTA_UPGRADE_EVENTS = new Set([
  'subscription.created',
  'subscription.updated',
  'subscription.activated',
]);

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

function customerId(request) {
  return String(request.requestContext?.authorizer?.claims?.sub || '').trim();
}

function customerResponse(statusCode, payload) {
  return response(statusCode, payload);
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

async function paddleRequest(path, options = {}) {
  const apiBase = String(process.env.PADDLE_API_BASE || PADDLE_API_BASE || 'https://api.paddle.com').replace(
    /\/+$/,
    ''
  );
  const apiKey = process.env.PADDLE_API_KEY || PADDLE_API_KEY;
  const res = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Paddle-Version': '1',
      Authorization: `Bearer ${apiKey}`,
      ...(options.headers || {}),
    },
  });
  let payload;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    const error = new Error(payload?.error?.detail || `Paddle API returned ${res.status}`);
    error.status = res.status;
    error.code = payload?.error?.code || '';
    throw error;
  }
  return payload;
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

async function queryDay(partition) {
  const tableName = process.env.TABLE_NAME || TABLE_NAME;
  const items = [];
  let ExclusiveStartKey;
  do {
    const result = await getDdbClient().send(
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

function monthlyQuotaForBilling(billing) {
  if (!billing || !billing.tier || billing.tier === 'free') return FREE_MONTHLY_QUOTA;
  return ['active', 'trialing', 'past_due'].includes(billing.status)
    ? PLAN_QUOTAS[billing.tier] || PLAN_QUOTAS.pro
    : FREE_MONTHLY_QUOTA;
}

function planNameForTier(tier, interval = 'month') {
  if (tier === 'free') return 'RenderPDF Free';
  if (tier === 'starter') {
    return interval === 'year' ? 'RenderPDF Starter (Annual)' : 'RenderPDF Starter';
  }
  if (tier === 'enterprise') {
    return 'RenderPDF Enterprise';
  }
  return interval === 'year' ? 'RenderPDF Professional (Annual)' : 'RenderPDF Professional';
}

async function getBilling(userId) {
  const tableName = process.env.TABLE_NAME || TABLE_NAME;
  try {
    const result = await getDdbClient().send(
      new GetItemCommand({
        TableName: tableName,
        Key: { requestId: { S: `BILLING#${userId}` }, timestamp: { N: '0' } },
        ConsistentRead: true,
      })
    );
    if (!result.Item) return null;
    return {
      subscriptionId: stringValue(result.Item, 'subscriptionId'),
      paddleCustomerId: stringValue(result.Item, 'paddleCustomerId'),
      tier: stringValue(result.Item, 'tier'),
      status: stringValue(result.Item, 'status'),
      plan: stringValue(result.Item, 'plan'),
      provider: stringValue(result.Item, 'provider'),
      manualOverride:
        result.Item.manualOverride?.BOOL != null
          ? result.Item.manualOverride.BOOL
          : result.Item.manualOverride?.S === 'true' || Boolean(unwrap(result.Item.manualOverride)),
      renewsAt: stringValue(result.Item, 'renewsAt'),
      endsAt: stringValue(result.Item, 'endsAt'),
      scheduledAction: stringValue(result.Item, 'scheduledAction'),
      scheduledAt: stringValue(result.Item, 'scheduledAt'),
      updatePaymentMethod: stringValue(result.Item, 'updatePaymentMethod'),
      customerEmail: stringValue(result.Item, 'customerEmail'),
      pastDueAlertSentAt: stringValue(result.Item, 'pastDueAlertSentAt'),
    };
  } catch (err) {
    console.error('Could not read billing state', err);
    throw err;
  }
}

async function getQuotaRecord(userId, monthStart) {
  const tableName = process.env.TABLE_NAME || TABLE_NAME;
  const result = await getDdbClient().send(
    new GetItemCommand({
      TableName: tableName,
      Key: {
        requestId: { S: `USER_QUOTA#${userId}#${dateKey(monthStart).slice(0, 7)}` },
        timestamp: { N: '0' },
      },
      ConsistentRead: true,
    })
  );
  return { used: numberValue(result.Item, 'used'), limit: numberValue(result.Item, 'limit') };
}

async function syncUserUsagePlans(userId, tier) {
  const freePlanId = process.env.FREE_USAGE_PLAN_ID || '';
  const starterPlanId = process.env.STARTER_USAGE_PLAN_ID || '';
  const proPlanId = process.env.PRO_USAGE_PLAN_ID || '';
  const apiKeysTable = process.env.API_KEYS_TABLE || '';

  if (!freePlanId && !starterPlanId && !proPlanId) return;
  if (!apiKeysTable || !userId) return;

  const targetPlanId =
    tier === 'pro' || tier === 'enterprise'
      ? proPlanId || freePlanId
      : tier === 'starter'
        ? starterPlanId || freePlanId
        : freePlanId;

  if (!targetPlanId) return;

  try {
    const keysResult = await getDdbClient().send(
      new QueryCommand({
        TableName: apiKeysTable,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': { S: `USER#${userId}` },
          ':sk': { S: 'APIKEY#' },
        },
      })
    );

    const items = keysResult.Items || [];
    const allPlanIds = [freePlanId, starterPlanId, proPlanId].filter(Boolean);

    for (const item of items) {
      if (!item.isActive?.BOOL || !item.apiGatewayKeyId?.S) continue;
      const keyId = item.apiGatewayKeyId.S;

      for (const oldPlanId of allPlanIds) {
        if (oldPlanId === targetPlanId) continue;
        try {
          await getApigwClient().send(
            new DeleteUsagePlanKeyCommand({
              UsagePlanId: oldPlanId,
              KeyId: keyId,
            })
          );
        } catch (_) {
          // Ignore if key was not in this plan
        }
      }

      try {
        await getApigwClient().send(
          new CreateUsagePlanKeyCommand({
            UsagePlanId: targetPlanId,
            KeyId: keyId,
            KeyType: 'API_KEY',
          })
        );
      } catch (err) {
        if (err.name !== 'ConflictException') {
          console.warn(`Could not attach key ${keyId} to usage plan ${targetPlanId}:`, err);
        }
      }
    }
  } catch (err) {
    console.warn(`Could not sync usage plans for user ${userId}:`, err);
  }
}

module.exports = {
  TABLE_NAME,
  PADDLE_API_KEY,
  PADDLE_API_BASE,
  PADDLE_CLIENT_TOKEN,
  PADDLE_ENVIRONMENT,
  PADDLE_PRICES,
  PADDLE_OVERAGE_PRICE_ID,
  OVERAGE_RENDER_CREDITS,
  PADDLE_WEBHOOK_SECRET,
  PADDLE_CHECKOUT_URL,
  PADDLE_SUBSCRIPTION_EVENTS,
  QUOTA_UPGRADE_EVENTS,
  FREE_MONTHLY_QUOTA,
  PLAN_QUOTAS,
  ddb,
  apigw,
  setDdbClient,
  setApigwClient,
  getDdbClient,
  getApigwClient,
  unwrap,
  queryDay,
  monthlyQuotaForBilling,
  planNameForTier,
  getBilling,
  getQuotaRecord,
  syncUserUsagePlans,
  response,
  customerId,
  customerResponse,
  positiveInteger,
  nextMonthStart,
  dateKey,
  stringValue,
  numberValue,
  header,
  safeEqual,
  signaturePartsFrom,
  paddleRequest,
};
