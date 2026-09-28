'use strict';

const crypto = require('node:crypto');
const {
  BatchGetItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} = require('@aws-sdk/client-dynamodb');
const {
  CognitoIdentityProviderClient,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  ListUsersCommand,
  AdminGetUserCommand,
} = require('@aws-sdk/client-cognito-identity-provider');
const {
  APIGatewayClient,
  CreateUsagePlanKeyCommand,
  DeleteUsagePlanKeyCommand,
} = require('@aws-sdk/client-api-gateway');
const { sendPaymentFailedAlert, sendTelegramErrorAlert } = require('./notifications');
const {
  handleChatMessage,
  buildSystemPrompt,
  listAdminChats,
  getAdminChatTranscript,
  postAdminChatReply,
  updateAdminChatStatus,
} = require('./chat');

const ANALYTICS_INDEX = 'AnalyticsDateIndex';
const ANALYTICS_TTL_DAYS = 90;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const TABLE_NAME = process.env.TABLE_NAME;
const API_KEYS_TABLE = process.env.API_KEYS_TABLE || '';
const USER_POOL_ID = process.env.USER_POOL_ID || '';
const FREE_USAGE_PLAN_ID = process.env.FREE_USAGE_PLAN_ID || '';
const STARTER_USAGE_PLAN_ID = process.env.STARTER_USAGE_PLAN_ID || '';
const PRO_USAGE_PLAN_ID = process.env.PRO_USAGE_PLAN_ID || '';
const STATS_ALLOWED_EMAIL = String(process.env.STATS_ALLOWED_EMAIL || 'vberkoz@gmail.com').trim().toLowerCase();
const PADDLE_API_KEY = process.env.PADDLE_API_KEY || '';
const PADDLE_API_BASE = String(process.env.PADDLE_API_BASE || 'https://api.paddle.com').replace(/\/+$/, '');
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
const FREE_MONTHLY_QUOTA = positiveInteger(process.env.FREE_MONTHLY_QUOTA, 25);
const PLAN_QUOTAS = {
  free: positiveInteger(process.env.FREE_MONTHLY_QUOTA, 25),
  starter: positiveInteger(process.env.STARTER_MONTHLY_QUOTA, 5000),
  pro: positiveInteger(process.env.PRO_MONTHLY_QUOTA, 20000),
  enterprise: positiveInteger(process.env.ENTERPRISE_MONTHLY_QUOTA, 100000),
};
const ddb = new DynamoDBClient({});
const apigw = new APIGatewayClient({});
const cognito = new CognitoIdentityProviderClient({});
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
  try {
    return await routeRequest(event);
  } catch (err) {
    console.error('Unhandled error in analytics handler:', err);
    await sendTelegramErrorAlert({
      context: `${event?.httpMethod || 'HTTP'} ${event?.resource || event?.path || '/'}`,
      error: err,
      details: {
        sourceIp: event?.requestContext?.identity?.sourceIp,
        userId: event?.requestContext?.authorizer?.claims?.sub,
        route: event?.queryStringParameters?.route,
      },
    }).catch(() => {});
    return response(500, { error: 'Internal server error' });
  }
}

async function routeRequest(event) {
  const path = event.resource || event.path || '';
  let routeOverride = event.queryStringParameters?.route || event.queryStringParameters?.view || '';
  if (routeOverride && typeof routeOverride === 'string' && routeOverride.includes('%')) {
    try {
      routeOverride = decodeURIComponent(routeOverride);
    } catch {
      // keep original
    }
  }
  const effectivePath = routeOverride
    ? (routeOverride.startsWith('/') ? routeOverride : `/${routeOverride}`)
    : path;

  if (path.endsWith('/billing/webhook')) return receivePaddleWebhook(event);
  if (path.endsWith('/billing/checkout')) return createCheckout(event);
  if (path.endsWith('/billing/change-plan')) return changePlan(event);
  if (path.endsWith('/billing/portal')) return openBillingPortal(event);
  if (path.endsWith('/dashboard')) return readCustomerDashboard(event);
  if (path.endsWith('/public-stats') || path.endsWith('/stats/public') || path.endsWith('/stats/summary')) {
    if (event.httpMethod === 'OPTIONS') return publicStatsResponse(204);
    return readPublicStats(event);
  }
  if (effectivePath.endsWith('/chat') || effectivePath === '/api/v1/chat') {
    if (event.httpMethod === 'OPTIONS' || event.httpMethod === 'POST') return handleChatMessage(event);
    return response(405, { error: 'Method not allowed' });
  }
  if (effectivePath.endsWith('/admin/analytics') || effectivePath.includes('/admin/analytics')) {
    if (event.httpMethod === 'OPTIONS') return response(204);
    if (event.httpMethod === 'GET') return readAdminAnalytics(event);
    return response(405, { error: 'Method not allowed' });
  }
  if (effectivePath.includes('/admin/users') || effectivePath.includes('/api/v1/users') || effectivePath.endsWith('/users') || effectivePath.startsWith('/users/')) {
    if (event.httpMethod === 'OPTIONS') return response(204);

    const planMatch = effectivePath.match(/\/(?:admin\/)?users\/([^/?#]+)\/plan$/) || (event.path || '').match(/\/(?:admin\/)?users\/([^/?#]+)\/plan$/);
    if (planMatch || event.resource?.endsWith('/plan')) {
      const userId = (event.pathParameters?.userId && event.pathParameters?.userId !== '{userId}') ? event.pathParameters.userId : (planMatch ? planMatch[1] : null);
      if (event.httpMethod === 'POST') return handleAdminUserPlanOverride(event, userId);
      return response(405, { error: 'Method not allowed' });
    }

    const quotaMatch = effectivePath.match(/\/(?:admin\/)?users\/([^/?#]+)\/quota$/) || (event.path || '').match(/\/(?:admin\/)?users\/([^/?#]+)\/quota$/);
    if (quotaMatch || event.resource?.endsWith('/quota')) {
      const userId = (event.pathParameters?.userId && event.pathParameters?.userId !== '{userId}') ? event.pathParameters.userId : (quotaMatch ? quotaMatch[1] : null);
      if (event.httpMethod === 'POST') return handleAdminUserQuotaAdjust(event, userId);
      return response(405, { error: 'Method not allowed' });
    }

    const statusMatch = effectivePath.match(/\/(?:admin\/)?users\/([^/?#]+)\/status$/) || (event.path || '').match(/\/(?:admin\/)?users\/([^/?#]+)\/status$/);
    if (statusMatch || event.resource?.endsWith('/status')) {
      const userId = (event.pathParameters?.userId && event.pathParameters?.userId !== '{userId}') ? event.pathParameters.userId : (statusMatch ? statusMatch[1] : null);
      if (event.httpMethod === 'POST') return handleAdminUserStatus(event, userId);
      return response(405, { error: 'Method not allowed' });
    }

    const revokeMatch = effectivePath.match(/\/(?:admin\/)?users\/([^/?#]+)\/keys\/([^/?#]+)\/revoke$/) || (event.path || '').match(/\/(?:admin\/)?users\/([^/?#]+)\/keys\/([^/?#]+)\/revoke$/);
    if (revokeMatch || event.resource?.endsWith('/revoke')) {
      const userId = (event.pathParameters?.userId && event.pathParameters?.userId !== '{userId}') ? event.pathParameters.userId : (revokeMatch ? revokeMatch[1] : null);
      const keyId = (event.pathParameters?.keyId && event.pathParameters?.keyId !== '{keyId}') ? event.pathParameters.keyId : (revokeMatch ? revokeMatch[2] : null);
      if (event.httpMethod === 'POST') return handleAdminKeyRevoke(event, userId, keyId);
      return response(405, { error: 'Method not allowed' });
    }

    const userIdParam = event.pathParameters?.userId || event.queryStringParameters?.userId;
    const match = effectivePath.match(/\/(?:admin\/)?users\/([^/?#]+)$/) || (event.path || '').match(/\/(?:admin\/)?users\/([^/?#]+)$/);
    const userId = (userIdParam && userIdParam !== '{userId}') ? userIdParam : (match ? match[1] : null);
    if (userId && userId !== 'users') {
      if (event.httpMethod === 'GET') return readAdminUserDossier(event, userId);
      return response(405, { error: 'Method not allowed' });
    }
    if (event.httpMethod === 'GET') return searchAdminUsers(event);
    return response(405, { error: 'Method not allowed' });
  }
  if (effectivePath.includes('/admin/audit-logs') || effectivePath.endsWith('/audit-logs')) {
    if (event.httpMethod === 'OPTIONS') return response(204);
    if (event.httpMethod === 'GET') return listAdminAuditLogs(event);
    return response(405, { error: 'Method not allowed' });
  }
  if (effectivePath.includes('/admin/chats') || effectivePath.endsWith('/chats') || effectivePath.startsWith('/chats/')) {
    if (event.httpMethod === 'OPTIONS') return response(204);

    const replyMatch = effectivePath.match(/\/(?:admin\/)?chats\/([^/?#]+)\/reply$/) || (event.path || '').match(/\/(?:admin\/)?chats\/([^/?#]+)\/reply$/);
    if (replyMatch || event.resource?.endsWith('/reply')) {
      const sessionId = (event.pathParameters?.sessionId && event.pathParameters?.sessionId !== '{sessionId}') ? event.pathParameters.sessionId : (replyMatch ? replyMatch[1] : null);
      if (event.httpMethod === 'POST') return postAdminChatReply(event, sessionId);
      return response(405, { error: 'Method not allowed' });
    }

    const statusMatch = effectivePath.match(/\/(?:admin\/)?chats\/([^/?#]+)\/status$/) || (event.path || '').match(/\/(?:admin\/)?chats\/([^/?#]+)\/status$/);
    if (statusMatch || (event.resource?.includes('/chats/') && event.resource?.endsWith('/status'))) {
      const sessionId = (event.pathParameters?.sessionId && event.pathParameters?.sessionId !== '{sessionId}') ? event.pathParameters.sessionId : (statusMatch ? statusMatch[1] : null);
      if (event.httpMethod === 'POST') return updateAdminChatStatus(event, sessionId);
      return response(405, { error: 'Method not allowed' });
    }

    const sessionIdParam = event.pathParameters?.sessionId || event.queryStringParameters?.sessionId;
    const match = effectivePath.match(/\/(?:admin\/)?chats\/([^/?#]+)$/) || (event.path || '').match(/\/(?:admin\/)?chats\/([^/?#]+)$/);
    const sessionId = (sessionIdParam && sessionIdParam !== '{sessionId}') ? sessionIdParam : (match ? match[1] : null);
    if (sessionId && sessionId !== 'chats') {
      if (event.httpMethod === 'GET') return getAdminChatTranscript(event, sessionId);
      return response(405, { error: 'Method not allowed' });
    }

    if (event.httpMethod === 'GET') return listAdminChats(event);
    return response(405, { error: 'Method not allowed' });
  }

  switch (event.httpMethod) {
    case 'GET':
      return readAdminAnalytics(event);
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

function tierFromAttributes(attributes) {
  const proPrice = PADDLE_PRICES.pro || process.env.PADDLE_PRO_PRICE_ID || '';
  const proAnnualPrice = PADDLE_PRICES.pro_annual || process.env.PADDLE_PRO_ANNUAL_PRICE_ID || '';
  const starterPrice = PADDLE_PRICES.starter || process.env.PADDLE_STARTER_PRICE_ID || '';
  const starterAnnualPrice = PADDLE_PRICES.starter_annual || process.env.PADDLE_STARTER_ANNUAL_PRICE_ID || '';

  const extractItemDetails = (item) => {
    if (!item) return { ids: [], name: '' };
    const ids = [
      item.price?.id,
      item.price_id,
      item.id,
      item.price?.product_id,
    ].filter(Boolean).map(String);
    const name = [
      item.price?.product?.name,
      item.price?.name,
      item.price?.description,
      item.description,
    ].filter(Boolean).join(' ').toLowerCase();
    return { ids, name };
  };

  const collectItems = () => {
    const items = [];
    const add = (item) => {
      if (item && typeof item === 'object') items.push(item);
    };

    if (Array.isArray(attributes?.items)) {
      for (const item of attributes.items) add(item);
    }
    if (Array.isArray(attributes?.scheduled_change?.items)) {
      for (const item of attributes.scheduled_change.items) add(item);
    }
    if (Array.isArray(attributes?.recurring_transaction_details?.line_items)) {
      for (const item of attributes.recurring_transaction_details.line_items) {
        add(item);
        if (item.item) add(item.item);
      }
    }
    if (Array.isArray(attributes?.next_transaction?.details?.line_items)) {
      for (const item of attributes.next_transaction.details.line_items) {
        add(item);
        if (item.item) add(item.item);
      }
    }
    return items;
  };

  const allItems = collectItems();

  // 1. Pro price ID match (monthly or annual, active items, scheduled items, or transaction previews)
  const proIds = [proPrice, proAnnualPrice].filter(Boolean);
  if (proIds.length > 0) {
    for (const item of allItems) {
      if (extractItemDetails(item).ids.some((id) => proIds.includes(id))) return 'pro';
    }
  }

  // 2. Pro name match (e.g. "RenderPDF Pro", "RenderPDF Professional")
  for (const item of allItems) {
    const { name } = extractItemDetails(item);
    if (name.includes('pro') || name.includes('professional')) return 'pro';
  }

  // 3. Starter price ID match (monthly or annual)
  const starterIds = [starterPrice, starterAnnualPrice].filter(Boolean);
  if (starterIds.length > 0) {
    for (const item of allItems) {
      if (extractItemDetails(item).ids.some((id) => starterIds.includes(id))) return 'starter';
    }
  }

  // 4. Starter name match
  for (const item of allItems) {
    const { name } = extractItemDetails(item);
    if (name.includes('starter')) return 'starter';
  }

  // 5. Fallback to custom_data.plan
  const customPlan = String(attributes?.custom_data?.plan || '').trim().toLowerCase();
  if (customPlan === 'starter' || customPlan === 'starter_annual') return 'starter';
  if (customPlan === 'pro' || customPlan === 'pro_annual') return 'pro';

  return 'pro';
}

function intervalFromAttributes(attributes) {
  const proAnnualPrice = PADDLE_PRICES.pro_annual || process.env.PADDLE_PRO_ANNUAL_PRICE_ID || '';
  const starterAnnualPrice = PADDLE_PRICES.starter_annual || process.env.PADDLE_STARTER_ANNUAL_PRICE_ID || '';
  const annualIds = [proAnnualPrice, starterAnnualPrice].filter(Boolean);

  if (attributes?.billing_cycle?.interval === 'year') return 'year';

  const items = Array.isArray(attributes?.items) ? attributes.items : [];
  for (const item of items) {
    const ids = [item.price?.id, item.price_id, item.id].filter(Boolean).map(String);
    if (annualIds.some((id) => ids.includes(id))) return 'year';
    const name = [item.price?.product?.name, item.price?.name, item.description].filter(Boolean).join(' ').toLowerCase();
    if (name.includes('annual') || name.includes('yearly')) return 'year';
    if (item.price?.billing_cycle?.interval === 'year') return 'year';
  }

  const customPlan = String(attributes?.custom_data?.plan || '').trim().toLowerCase();
  if (customPlan.includes('annual') || customPlan.includes('year')) return 'year';

  return 'month';
}

async function syncSubscriptionWithPaddle(userId, billing) {
  if (!billing?.subscriptionId || !PADDLE_API_KEY) return billing;
  try {
    const result = await paddleRequest(
      `/subscriptions/${encodeURIComponent(billing.subscriptionId)}?include=next_transaction,recurring_transaction_details`
    );
    const sub = result?.data;
    if (!sub) return billing;
    const tier = tierFromAttributes(sub);
    const status = String(sub.status || billing.status || 'active').toLowerCase();
    if (
      tier !== billing.tier ||
      status !== billing.status ||
      (billing.plan && !billing.plan.toLowerCase().includes(tier))
    ) {
      const occurredAt = new Date();
      const eventId = `sync-${Date.now()}`;
      await saveBillingWebhook(
        userId,
        billing.subscriptionId,
        {
          ...sub,
          status,
          custom_data: { user_id: userId, plan: tier, ...(sub.custom_data || {}) },
        },
        eventId,
        occurredAt,
        'subscription.updated'
      );
      return await getBilling(userId);
    }
  } catch (err) {
    console.warn('Could not sync subscription with Paddle', err);
  }
  return billing;
}

async function readCustomerDashboard(request) {
  const userId = customerId(request);
  if (!userId) return customerResponse(401, { error: 'Sign in is required' });

  let billing = await getBilling(userId);
  if (billing?.subscriptionId) {
    billing = await syncSubscriptionWithPaddle(userId, billing);
  }

  const userEmail = String(request.requestContext?.authorizer?.claims?.email || '').trim();
  if (userEmail && billing && !billing.customerEmail) {
    try {
      await ddb.send(new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: { requestId: { S: `BILLING#${userId}` }, timestamp: { N: '0' } },
        UpdateExpression: 'SET customerEmail = :email',
        ExpressionAttributeValues: { ':email': { S: userEmail } },
      }));
      billing.customerEmail = userEmail;
    } catch {}
  }

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const today = dateKey(now);
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

  const baseQuota = monthlyQuotaForBilling(billing);
  let quotaRecord;
  try { quotaRecord = await getQuotaRecord(userId, monthStart); } catch (err) {
    console.error('Could not read customer quota', err);
    return customerResponse(500, { error: 'Could not read quota' });
  }
  const usedThisMonth = quotaRecord.used;
  const quota = Math.max(quotaRecord.limit || 0, baseQuota);

  if (quotaRecord.limit < baseQuota && ['active', 'trialing', 'past_due'].includes(billing?.status)) {
    try {
      const prevTier = quotaRecord.limit >= PLAN_QUOTAS.starter ? 'starter' : 'free';
      await updateQuotaOnSubscriptionChange(userId, now, {
        custom_data: { plan: billing?.tier },
        status: billing?.status,
        items: [{ price: { id: PADDLE_PRICES[billing?.tier] } }],
      }, { tier: prevTier, status: 'active' });
    } catch (healErr) {
      console.warn('Could not self-heal quota record in readCustomerDashboard', healErr);
    }
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
  const isOverage = tier === 'overage';
  if (!isOverage && !Object.hasOwn(PADDLE_PRICES, tier)) return customerResponse(422, { error: 'Choose a valid plan' });
  const apiKey = process.env.PADDLE_API_KEY || PADDLE_API_KEY;
  const clientToken = process.env.PADDLE_CLIENT_TOKEN || PADDLE_CLIENT_TOKEN;
  const checkoutUrl = process.env.PADDLE_CHECKOUT_URL || PADDLE_CHECKOUT_URL;
  const environment = process.env.PADDLE_ENVIRONMENT || PADDLE_ENVIRONMENT;
  const priceID = isOverage ? (process.env.PADDLE_OVERAGE_PRICE_ID || PADDLE_OVERAGE_PRICE_ID) : PADDLE_PRICES[tier];
  if (!apiKey || !clientToken || !priceID || !checkoutUrl) {
    return customerResponse(503, { error: 'Billing is not configured yet' });
  }
  const userEmail = String(request.requestContext?.authorizer?.claims?.email || '').trim();
  try {
    const result = await paddleRequest('/transactions', {
      method: 'POST',
      body: JSON.stringify({
        items: [{ price_id: priceID, quantity: 1 }],
        collection_mode: 'automatic',
        custom_data: isOverage
          ? { user_id: userId, user_email: userEmail, entitlement: 'overage' }
          : { user_id: userId, user_email: userEmail, plan: tier },
        checkout: { url: checkoutUrl },
      }),
    });
    const transactionId = result?.data?.id;
    if (!transactionId) throw new Error('Paddle did not return a transaction ID');
    return customerResponse(200, { transactionId, clientToken, environment });
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

async function changePlan(request) {
  const userId = customerId(request);
  if (!userId) return customerResponse(401, { error: 'Sign in is required' });
  let input;
  try { input = JSON.parse(request.body || '{}'); } catch { return customerResponse(400, { error: 'Invalid plan change request' }); }
  const requestedPlan = String(input.plan || '').toLowerCase();
  const priceID = PADDLE_PRICES[requestedPlan] || process.env[
    requestedPlan === 'starter' ? 'PADDLE_STARTER_PRICE_ID' :
    requestedPlan === 'starter_annual' ? 'PADDLE_STARTER_ANNUAL_PRICE_ID' :
    requestedPlan === 'pro_annual' ? 'PADDLE_PRO_ANNUAL_PRICE_ID' :
    'PADDLE_PRO_PRICE_ID'
  ] || '';
  if (!priceID) return customerResponse(422, { error: 'Choose a valid plan' });
  if (!PADDLE_API_KEY && !process.env.PADDLE_API_KEY) return customerResponse(503, { error: 'Billing is not configured yet' });

  const billing = await getBilling(userId);
  if (!billing?.subscriptionId || !['active', 'trialing'].includes(billing.status)) {
    return customerResponse(409, { error: 'No active subscription is available to change' });
  }
  const currentTier = billing.tier;
  const currentInterval = billing.interval || (billing.plan && billing.plan.toLowerCase().includes('annual') ? 'year' : 'month');
  const targetTier = requestedPlan.startsWith('starter') ? 'starter' : 'pro';
  const targetInterval = (requestedPlan.includes('annual') || requestedPlan.includes('year')) ? 'year' : 'month';
  if (currentTier === targetTier && currentInterval === targetInterval) {
    return customerResponse(409, { error: 'You are already on this plan' });
  }

  try {
    const patchBody = {
      items: [{ price_id: priceID, quantity: 1 }],
      custom_data: { user_id: userId, plan: requestedPlan },
      proration_billing_mode: 'prorated_immediately',
    };
    if (billing.scheduledAction) {
      patchBody.scheduled_change = null;
    }
    const result = await paddleRequest(`/subscriptions/${encodeURIComponent(billing.subscriptionId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patchBody),
    });

    const updatedSub = result?.data || {};
    const occurredAt = new Date();
    const eventId = `plan-change-${Date.now()}`;
    const subAttributes = {
      ...updatedSub,
      status: updatedSub.status || 'active',
      custom_data: { user_id: userId, plan: requestedPlan, ...(updatedSub.custom_data || {}) },
      items: [{ price: { id: priceID } }, ...(Array.isArray(updatedSub.items) ? updatedSub.items.slice(1) : [])],
    };
    try {
      await saveBillingWebhook(userId, billing.subscriptionId, subAttributes, eventId, occurredAt, 'subscription.updated');
    } catch (saveErr) {
      console.warn('Could not immediately sync billing after changePlan', saveErr);
    }

    return customerResponse(200, { requested: true, plan: requestedPlan, changed: true });
  } catch (err) {
    console.error('Could not change Paddle subscription plan', err);
    if (err?.status === 403) {
      return customerResponse(503, { error: 'Paddle billing key needs Subscription write permission to change plans' });
    }
    return customerResponse(502, { error: 'Could not change the subscription plan' });
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
  const eventType = String(payload?.event_type || '').trim();
  if (eventType === 'transaction.completed') {
    return receiveOverageWebhook(payload);
  }
  if (eventType === 'transaction.payment_failed') {
    return receivePaymentFailedWebhook(payload);
  }
  if (!PADDLE_SUBSCRIPTION_EVENTS.has(eventType)) {
    console.log(`Paddle webhook ignored: unsupported event type ${eventType || 'unknown'}`);
    return response(200, { received: true, ignored: true });
  }
  const eventId = String(payload?.event_id || '').trim();
  const occurredAt = paddleEventTime(payload?.occurred_at);
  if (!eventId || !occurredAt) {
    console.warn(`Paddle webhook ignored: ${eventType} is missing a valid event ID or occurred_at timestamp`);
    return response(200, { received: true, ignored: true });
  }
  const attributes = payload?.data || {};
  const userId = String(attributes?.custom_data?.user_id || '').trim();
  const subscriptionId = String(attributes?.id || '').trim();
  if (!userId || !subscriptionId) {
    console.log(`Paddle webhook ignored: ${eventType} does not contain RenderPDF subscription custom data`);
    return response(200, { received: true, ignored: true });
  }
  try {
    await saveBillingWebhook(userId, subscriptionId, attributes, eventId, occurredAt, eventType);
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      console.log(`Paddle webhook ignored: duplicate or out-of-order ${eventType} (${eventId})`);
      return response(200, { received: true, ignored: true });
    }
    console.error('Could not save billing webhook', err);
    return response(500, { error: 'Could not save billing state' });
  }
  console.log(`Paddle subscription synced: ${eventType} (${attributes.status || 'unknown'})`);
  return response(200, { received: true });
}

async function receiveOverageWebhook(payload) {
  const eventId = String(payload?.event_id || '').trim();
  const occurredAt = paddleEventTime(payload?.occurred_at);
  const transaction = payload?.data || {};
  const userId = String(transaction?.custom_data?.user_id || '').trim();
  const transactionId = String(transaction?.id || '').trim();
  const overagePriceId = process.env.PADDLE_OVERAGE_PRICE_ID || PADDLE_OVERAGE_PRICE_ID || '';
  const itemPriceId = String(transaction.items?.[0]?.price?.id || transaction.items?.[0]?.price_id || '');
  const isOverage = transaction?.custom_data?.entitlement === 'overage' &&
    Array.isArray(transaction.items) && transaction.items.length === 1 &&
    itemPriceId === overagePriceId &&
    Number(transaction.items[0]?.quantity) === 1;
  if (!eventId || !occurredAt || !userId || !transactionId || !isOverage) {
    console.log('Paddle transaction.completed ignored: not a valid RenderPDF overage purchase');
    return response(200, { received: true, ignored: true });
  }
  try {
    await creditOverage(userId, transactionId, eventId, occurredAt);
  } catch (err) {
    if (err?.name === 'TransactionCanceledException' || err?.name === 'ConditionalCheckFailedException') {
      console.log(`Paddle overage webhook ignored: duplicate transaction ${transactionId}`);
      return response(200, { received: true, ignored: true });
    }
    console.error('Could not apply overage credit', err);
    return response(500, { error: 'Could not apply overage credit' });
  }
  console.log(`Paddle overage credit applied: ${transactionId} (+${OVERAGE_RENDER_CREDITS})`);
  return response(200, { received: true });
}

async function receivePaymentFailedWebhook(payload) {
  const transaction = payload?.data || {};
  const userId = String(transaction?.custom_data?.user_id || '').trim();
  const customerEmail = String(transaction?.custom_data?.user_email || transaction?.customer?.email || '').trim();
  if (userId) {
    const previousBilling = await getBilling(userId);
    if (!previousBilling?.pastDueAlertSentAt) {
      try {
        await sendPaymentFailedAlert(ddb, TABLE_NAME, userId, customerEmail);
        await ddb.send(new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: { requestId: { S: `BILLING#${userId}` }, timestamp: { N: '0' } },
          UpdateExpression: 'SET pastDueAlertSentAt = :now, #status = if_not_exists(#status, :pastDue)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':now': { N: String(Math.floor(Date.now() / 1000)) },
            ':pastDue': { S: 'past_due' },
          },
        }));
      } catch (alertErr) {
        console.error('Could not send payment failed alert from transaction webhook', alertErr);
      }
    }
  }
  return response(200, { received: true });
}

function latencyBucket(durationMs) {
  const d = Number(durationMs) || 0;
  if (d < 400) return 'under_400ms';
  if (d < 800) return '400ms_to_800ms';
  if (d < 1500) return '800ms_to_1500ms';
  return 'over_1500ms';
}

async function recordRenderRollup(status, durationMs, pdfBytes, plan, date) {
  let dateKeyStr;
  if (date instanceof Date) {
    dateKeyStr = dateKey(date);
  } else if (typeof date === 'string' && date) {
    dateKeyStr = date.length === 10 ? date : dateKey(new Date(date));
  } else {
    dateKeyStr = dateKey(new Date());
  }

  const updateInput = {
    TableName: TABLE_NAME,
    Key: { requestId: { S: `ROLLUP#${dateKeyStr}` }, timestamp: { N: '0' } },
    UpdateExpression: `
      ADD rendering.totalRenders :one,
          rendering.totalBytes :size,
          rendering.totalDurationMs :duration,
          #rendSuccess :succIncr,
          #rendError :errIncr,
          rendering.byPlan.#plan :one,
          rendering.latencyBuckets.#latBucket :one
    `,
    ExpressionAttributeNames: {
      '#rendSuccess': status === 'success' ? 'rendering.successes' : 'dummy_success',
      '#rendError': status !== 'success' ? 'rendering.errors' : 'dummy_error',
      '#plan': plan || 'unknown',
      '#latBucket': latencyBucket(durationMs),
    },
    ExpressionAttributeValues: {
      ':one': { N: '1' },
      ':size': { N: String(pdfBytes || 0) },
      ':duration': { N: String(durationMs || 0) },
      ':succIncr': { N: status === 'success' ? '1' : '0' },
      ':errIncr': { N: status !== 'success' ? '1' : '0' },
    },
  };

  return ddb.send(new UpdateItemCommand(updateInput));
}

const EVENT_ROLLUP_TARGETS = {
  page_viewed: 'acquisition.pageViews',
  trial_render_submitted: 'acquisition.playgroundSubmits',
  trial_render_succeeded: 'acquisition.playgroundSuccesses',
  signup_started: 'activation.signupStarted',
  signup_completed: 'activation.signupCompleted',
  api_key_created: 'activation.apiKeysCreated',
};

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

  const updateInput = {
    TableName: TABLE_NAME,
    Key: { requestId: { S: `ROLLUP#${dateKeyStr}` }, timestamp: { N: '0' } },
    UpdateExpression: `ADD ${targetField} :one`,
    ExpressionAttributeValues: {
      ':one': { N: '1' },
    },
  };

  return ddb.send(new UpdateItemCommand(updateInput));
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
    if (EVENT_ROLLUP_TARGETS[event.event]) {
      await recordEventRollup(event.event, now);
    }
  } catch (err) {
    console.error('Could not save analytics event', err);
    return response(500, { error: 'Could not save analytics event' });
  }
  return response(202, { id: eventId });
}

function isAuthorizedAdmin(request) {
  const claims = request?.requestContext?.authorizer?.claims;
  if (!claims) return false;

  const groups = claims['cognito:groups'];
  if (Array.isArray(groups) && groups.includes('Admins')) return true;
  if (typeof groups === 'string') {
    const list = groups.replace(/[\[\]"']/g, '').split(',').map((s) => s.trim());
    if (list.includes('Admins')) return true;
  }

  const email = String(claims.email || '').trim().toLowerCase();
  const allowedEmail = String(process.env.STATS_ALLOWED_EMAIL || STATS_ALLOWED_EMAIL || '').trim().toLowerCase();
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

function calculateAwsCost(totalRenders = 0, totalDurationMs = 0, totalBytes = 0) {
  const lambdaCost = (totalDurationMs / 1000) * (2048 / 1024) * 0.0000166667 + (totalRenders * 0.20 / 1000000);
  const s3Cost = (totalRenders * 0.005 / 1000) + ((totalBytes / 1e9) * 0.023);
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
      signupsCompleted: Math.max(signupsCompleted, Number(prevAct.signupCompleted ?? prevAct.signupsCompleted ?? 0)),
      apiKeysCreated: Math.max(apiKeysCreated, Number(prevAct.apiKeysCreated || 0)),
      firstApiCalls: Math.max(Number(prevAct.firstApiCalls || 0), (apiKeysCreated > 0 && totalRenders > 0) ? 1 : 0),
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
        under_400ms: Math.max(latencyBuckets.under_400ms, Number(prevRend.latencyBuckets?.under_400ms || 0)),
        '400ms_to_800ms': Math.max(latencyBuckets['400ms_to_800ms'], Number(prevRend.latencyBuckets?.['400ms_to_800ms'] || 0)),
        '800ms_to_1500ms': Math.max(latencyBuckets['800ms_to_1500ms'], Number(prevRend.latencyBuckets?.['800ms_to_1500ms'] || 0)),
        over_1500ms: Math.max(latencyBuckets.over_1500ms, Number(prevRend.latencyBuckets?.over_1500ms || 0)),
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
    batchRes = await ddb.send(new BatchGetItemCommand({
      RequestItems: { [tableName]: { Keys: keys } },
    }));
  } catch (err) {
    console.error('Could not read admin analytics', err);
    return response(500, { error: 'Could not read analytics' });
  }

  const rawItems = batchRes?.Responses?.[tableName]
    || (TABLE_NAME && batchRes?.Responses?.[TABLE_NAME])
    || (batchRes?.Responses && Object.values(batchRes.Responses)[0])
    || [];

  const itemsMap = new Map();
  for (const rawItem of rawItems) {
    const unwrapped = unwrap(rawItem);
    const dateStr = unwrapped.date || (unwrapped.requestId ? String(unwrapped.requestId).replace(/^ROLLUP#/, '') : '');
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
    const daySuccesses = rendering.successes != null ? Number(rendering.successes) : Math.max(0, dayRenders - dayErrors);
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

    const dayRevenue = Number(item.revenueUsd ?? monetization.revenueUsd ?? monetization.overageRevenueUsd ?? item.attributedRevenue ?? 0);
    const dayAwsCost = item.estimatedAwsCostUsd != null
      ? Number(item.estimatedAwsCostUsd)
      : calculateAwsCost(dayRenders, dayDurationMs, dayBytes);
    const dayMargin = item.marginPercent != null
      ? Number(item.marginPercent)
      : calculateGrossMargin(dayRevenue, dayAwsCost);
    const dayP95 = item.p95Ms != null
      ? Number(item.p95Ms)
      : (rendering.p95Ms != null ? Number(rendering.p95Ms) : calculateP95(rendering.latencyBuckets));

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

  const overallGrossMargin = totalAttributedRevenue > 0
    ? calculateGrossMargin(totalAttributedRevenue, totalAwsCost)
    : 0;

  const costPerThousand = totalRenders > 0
    ? (totalAwsCost / totalRenders) * 1000
    : 0;

  const summary = {
    totalUsers: Number(latestItem?.summary?.totalUsers ?? latestItem?.totalUsers ?? latestItem?.monetization?.totalUsers ?? totalSignupsCompleted),
    activeSubscriptions: Number(latestItem?.summary?.activeSubscriptions ?? latestItem?.activeSubscriptions ?? latestItem?.monetization?.activeSubscriptions ?? (latestItem?.monetization?.checkoutsCompleted || 0)),
    mrrUsd: roundFloat(Number(latestItem?.summary?.mrrUsd ?? latestItem?.mrrUsd ?? latestItem?.monetization?.mrrUsd ?? totalAttributedRevenue)),
    grossMarginPercent: roundOneDecimal(overallGrossMargin),
    costPerThousandPdfsUsd: roundFloat(costPerThousand),
  };

  const funnel = {
    pageViews: totalPageViews,
    playgroundSubmits: totalPlaygroundSubmits,
    playgroundActivationRate: totalPageViews > 0
      ? roundOneDecimal((totalPlaygroundSubmits / totalPageViews) * 100)
      : 0,
    signupsCompleted: totalSignupsCompleted,
    trialToSignupRate: totalPlaygroundSubmits > 0
      ? roundOneDecimal((totalSignupsCompleted / totalPlaygroundSubmits) * 100)
      : 0,
    apiKeysCreated: totalApiKeysCreated,
    signupToKeyRate: totalSignupsCompleted > 0
      ? roundOneDecimal((totalApiKeysCreated / totalSignupsCompleted) * 100)
      : 0,
    firstApiCalls: totalFirstApiCalls,
    ttfcMedianMinutes: calculateMedianTtfc(combinedTtfcBuckets),
  };

  const successRate = totalRenders > 0
    ? roundFloat((totalSuccesses / totalRenders) * 100)
    : 100.0;

  const avgRenderMs = totalRenders > 0
    ? Math.round(totalDurationMs / totalRenders)
    : 0;

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

function getCognitoAttr(user, attrName) {
  if (!user) return '';
  const attrs = user.Attributes || user.UserAttributes || [];
  if (Array.isArray(attrs)) {
    const found = attrs.find((a) => a.Name === attrName || a.name === attrName);
    if (found) return found.Value != null ? found.Value : (found.value != null ? found.value : '');
  }
  if (user[attrName] != null) return String(user[attrName]);
  return '';
}

function formatCognitoDate(d) {
  if (!d) return '';
  if (d instanceof Date) return d.toISOString();
  if (typeof d === 'number') {
    return new Date(d > 1e11 ? d : d * 1000).toISOString();
  }
  if (typeof d === 'string') {
    try {
      const parsed = new Date(d);
      return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : d;
    } catch (_) {
      return d;
    }
  }
  return '';
}

async function findCognitoUser(userPoolId, identifier) {
  if (!identifier) return null;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);

  // 1. If it's a UUID, search by sub attribute first
  if (isUuid) {
    try {
      const listRes = await cognito.send(new ListUsersCommand({
        UserPoolId: userPoolId,
        Filter: `sub = "${identifier}"`,
        Limit: 1,
      }));
      if (listRes?.Users && listRes.Users.length > 0) {
        return listRes.Users[0];
      }
    } catch (err) {
      console.warn(`Cognito ListUsers by sub failed for ${identifier}:`, err);
    }
  }

  // 2. Try AdminGetUser (matches Username exactly)
  try {
    const userRes = await cognito.send(new AdminGetUserCommand({
      UserPoolId: userPoolId,
      Username: identifier,
    }));
    if (userRes) return userRes;
  } catch (err) {
    if (err.name !== 'UserNotFoundException') {
      console.warn(`Cognito AdminGetUser failed for ${identifier}:`, err);
    }
  }

  // 3. Try ListUsers by email
  if (identifier.includes('@')) {
    try {
      const listRes = await cognito.send(new ListUsersCommand({
        UserPoolId: userPoolId,
        Filter: `email = "${identifier}"`,
        Limit: 1,
      }));
      if (listRes?.Users && listRes.Users.length > 0) {
        return listRes.Users[0];
      }
    } catch (err) {
      console.warn(`Cognito ListUsers by email failed for ${identifier}:`, err);
    }
  }

  // 4. Fallback: if not UUID or email, try sub filter anyway
  if (!isUuid) {
    try {
      const listRes = await cognito.send(new ListUsersCommand({
        UserPoolId: userPoolId,
        Filter: `sub = "${identifier}"`,
        Limit: 1,
      }));
      if (listRes?.Users && listRes.Users.length > 0) {
        return listRes.Users[0];
      }
    } catch (_) {}
  }

  return null;
}

function mapRecentRequest(rawItem) {
  const item = unwrap(rawItem) || {};
  return {
    requestId: String(item.requestId || ''),
    timestamp: Number(item.timestamp) || 0,
    status: String(item.status || 'success'),
    errorType: String(item.errorType || ''),
    durationMs: Number(item.durationMs ?? item.renderDurationMs) || 0,
    size: Number(item.size) || 0,
  };
}

async function getRecentRequestsForUser(userId) {
  const tableName = process.env.TABLE_NAME || TABLE_NAME || 'RenderPdfTable';

  // 1. Try querying CustomerIdDateIndex
  try {
    const res = await ddb.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'CustomerIdDateIndex',
      KeyConditionExpression: 'customerId = :cid',
      ExpressionAttributeValues: { ':cid': { S: userId } },
      ScanIndexForward: false,
      Limit: 25,
    }));
    if (res?.Items && res.Items.length > 0) {
      return res.Items.map(mapRecentRequest);
    }
  } catch (_) {
    // If index query fails or does not exist, continue to fallback
  }

  // 2. Try customer partition CUSTOMER#<userId>
  try {
    const res = await ddb.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'requestId = :pk',
      ExpressionAttributeValues: { ':pk': { S: `CUSTOMER#${userId}` } },
      ScanIndexForward: false,
      Limit: 25,
    }));
    if (res?.Items && res.Items.length > 0) {
      return res.Items.map(mapRecentRequest);
    }
  } catch (_) {}

  // 3. Fallback: scan recent days using queryDay
  const logs = [];
  const now = new Date();
  for (let i = 0; i < 30 && logs.length < 25; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    try {
      const items = await queryDay(`USAGE#${dateKey(d)}`);
      for (const item of items) {
        if (stringValue(item, 'entityType') === 'PDF_REQUEST' && stringValue(item, 'customerId') === userId) {
          logs.push(mapRecentRequest(item));
        }
      }
    } catch (_) {}
  }
  logs.sort((a, b) => b.timestamp - a.timestamp);
  return logs.slice(0, 25);
}

async function searchAdminUsers(request) {
  if (!isAuthorizedAdmin(request)) {
    return response(403, { error: 'Forbidden' });
  }

  const userPoolId = process.env.USER_POOL_ID || USER_POOL_ID || 'renderpdf-users-v2';
  const queryParams = request?.queryStringParameters || {};
  const q = String(queryParams.q || '').trim();
  const tierParam = String(queryParams.tier || '').trim();
  const statusParam = String(queryParams.status || '').trim();
  const limitParam = positiveInteger(queryParams.limit, 25);
  const limit = Math.min(Math.max(1, limitParam), 100);
  const cursor = queryParams.cursor ? String(queryParams.cursor).trim() : null;

  let cognitoUsers = [];
  let nextCursor = null;

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q);

  if (isUuid) {
    const singleUser = await findCognitoUser(userPoolId, q);
    if (singleUser) {
      cognitoUsers = [singleUser];
    }
  } else {
    const listParams = {
      UserPoolId: userPoolId,
      Limit: limit,
    };
    if (cursor) {
      listParams.PaginationToken = cursor;
    }
    if (q) {
      listParams.Filter = `email ^= "${q}"`;
    }
    try {
      const listRes = await cognito.send(new ListUsersCommand(listParams));
      cognitoUsers = listRes?.Users || [];
      nextCursor = listRes?.PaginationToken || null;
    } catch (err) {
      console.error('Cognito ListUsers error:', err);
      return response(500, { error: 'Could not list users' });
    }
  }

  if (cognitoUsers.length === 0) {
    return response(200, { users: [], nextCursor: null });
  }

  const now = new Date();
  const currentMonth = dateKey(now).slice(0, 7);
  const tableName = process.env.TABLE_NAME || TABLE_NAME || 'RenderPdfTable';
  const apiKeysTable = process.env.API_KEYS_TABLE || API_KEYS_TABLE;

  const keys = [];
  for (const u of cognitoUsers) {
    const uid = getCognitoAttr(u, 'sub') || u.Username;
    if (uid) {
      keys.push({ requestId: { S: `BILLING#${uid}` }, timestamp: { N: '0' } });
      keys.push({ requestId: { S: `USER_QUOTA#${uid}#${currentMonth}` }, timestamp: { N: '0' } });
    }
  }

  const billingMap = new Map();
  const quotaMap = new Map();

  if (keys.length > 0) {
    try {
      for (let i = 0; i < keys.length; i += 100) {
        const chunk = keys.slice(i, i + 100);
        const batchRes = await ddb.send(new BatchGetItemCommand({
          RequestItems: { [tableName]: { Keys: chunk } },
        }));
        const rawItems = batchRes?.Responses?.[tableName]
          || (TABLE_NAME && batchRes?.Responses?.[TABLE_NAME])
          || (batchRes?.Responses && Object.values(batchRes.Responses)[0])
          || [];
        for (const raw of rawItems) {
          const item = unwrap(raw) || {};
          const reqId = String(item.requestId || '');
          if (reqId.startsWith('BILLING#')) {
            const uid = reqId.slice('BILLING#'.length);
            billingMap.set(uid, item);
          } else if (reqId.startsWith('USER_QUOTA#')) {
            const parts = reqId.split('#');
            const uid = parts[1];
            quotaMap.set(uid, item);
          }
        }
      }
    } catch (err) {
      console.error('BatchGetItem error in searchAdminUsers:', err);
    }
  }

  const activeKeysMap = new Map();
  if (apiKeysTable) {
    await Promise.all(cognitoUsers.map(async (u) => {
      const uid = getCognitoAttr(u, 'sub') || u.Username;
      if (!uid) return;
      try {
        const keysRes = await ddb.send(new QueryCommand({
          TableName: apiKeysTable,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: {
            ':pk': { S: `USER#${uid}` },
            ':sk': { S: 'APIKEY#' },
          },
        }));
        const count = (keysRes.Items || []).filter((k) => {
          const item = unwrap(k);
          return item.isActive !== false;
        }).length;
        activeKeysMap.set(uid, count);
      } catch (_) {
        activeKeysMap.set(uid, 0);
      }
    }));
  }

  const assembledUsers = cognitoUsers.map((u) => {
    const uid = getCognitoAttr(u, 'sub') || u.Username;
    const billing = billingMap.get(uid) || {};
    const quota = quotaMap.get(uid) || {};

    const tier = billing.tier || 'free';
    const status = billing.status || 'active';
    const manualOverride = Boolean(billing.manualOverride === true || billing.manualOverride === 'true');
    const provider = billing.provider || (billing.subscriptionId ? 'paddle' : (manualOverride ? 'manual' : 'paddle'));
    const quotaUsed = Number(quota.used) || 0;
    const baseQuota = monthlyQuotaForBilling({ tier, status });
    const quotaLimit = Number(quota.limit) || baseQuota;
    const activeKeys = activeKeysMap.get(uid) || 0;

    return {
      id: uid,
      email: getCognitoAttr(u, 'email'),
      tier,
      status,
      provider,
      manualOverride,
      quotaUsed,
      quotaLimit,
      quotaMonth: currentMonth,
      activeKeys,
      createdAt: formatCognitoDate(u.UserCreateDate),
    };
  });

  let filteredUsers = assembledUsers;
  if (tierParam && tierParam.toLowerCase() !== 'all') {
    filteredUsers = filteredUsers.filter((u) => u.tier.toLowerCase() === tierParam.toLowerCase());
  }
  if (statusParam && statusParam.toLowerCase() !== 'all') {
    filteredUsers = filteredUsers.filter((u) => u.status.toLowerCase() === statusParam.toLowerCase());
  }

  return response(200, {
    users: filteredUsers,
    nextCursor,
  });
}

async function readAdminUserDossier(request, explicitUserId = null) {
  if (!isAuthorizedAdmin(request)) {
    return response(403, { error: 'Forbidden' });
  }

  const userIdParam = explicitUserId || request?.pathParameters?.userId || request?.queryStringParameters?.userId;
  const routeParam = request?.queryStringParameters?.route || request?.queryStringParameters?.view || '';
  const match = (routeParam ? (routeParam.startsWith('/') ? routeParam : `/${routeParam}`) : (request?.path || request?.resource || '')).match(/\/(?:admin\/)?users\/([^/?#]+)$/);
  const userId = (userIdParam && userIdParam !== '{userId}') ? userIdParam : (match ? match[1] : null);

  if (!userId || userId === 'users') {
    return response(400, { error: 'userId is required' });
  }

  const userPoolId = process.env.USER_POOL_ID || USER_POOL_ID || 'renderpdf-users-v2';

  // 1. Cognito user lookup (supports sub UUID, username, and email)
  let userRes;
  try {
    userRes = await findCognitoUser(userPoolId, userId);
  } catch (err) {
    console.error(`Cognito lookup error for ${userId}:`, err);
    return response(500, { error: 'Could not retrieve user' });
  }

  if (!userRes) {
    return response(404, { error: 'User not found' });
  }

  const subId = getCognitoAttr(userRes, 'sub');
  const canonicalUserId = subId || userRes.Username || userId;

  const user = {
    id: canonicalUserId,
    email: getCognitoAttr(userRes, 'email'),
    emailVerified: getCognitoAttr(userRes, 'email_verified') === 'true',
    enabled: userRes.Enabled !== false,
    createdAt: formatCognitoDate(userRes.UserCreateDate),
  };

  // 2. Billing state
  let billingRecord = null;
  try {
    billingRecord = await getBilling(canonicalUserId);
  } catch (err) {
    console.warn(`Could not read billing state for ${canonicalUserId}:`, err);
  }

  const tier = billingRecord?.tier || 'free';
  const status = billingRecord?.status || 'active';
  const manualOverride = Boolean(billingRecord?.manualOverride === true || billingRecord?.manualOverride === 'true');
  const provider = billingRecord?.provider || (billingRecord?.subscriptionId ? 'paddle' : (manualOverride ? 'manual' : (tier === 'free' ? 'none' : 'paddle')));
  const plan = billingRecord?.plan || (tier === 'free' ? 'Free' : planNameForTier(tier));

  const billing = {
    tier,
    status,
    plan,
    provider,
    manualOverride,
    subscriptionId: billingRecord?.subscriptionId || null,
    renewsAt: billingRecord?.renewsAt || null,
  };

  // 3. Quota state
  const now = new Date();
  const currentMonth = dateKey(now).slice(0, 7);
  let quotaRecord = { used: 0, limit: 0 };
  try {
    quotaRecord = await getQuotaRecord(canonicalUserId, now);
  } catch (err) {
    console.warn(`Could not read quota record for ${canonicalUserId}:`, err);
  }

  const baseQuota = monthlyQuotaForBilling(billingRecord);
  const quotaLimit = Math.max(quotaRecord.limit || 0, baseQuota);
  const quotaUsed = quotaRecord.used || 0;

  const quota = {
    month: currentMonth,
    used: quotaUsed,
    limit: quotaLimit,
    remaining: Math.max(0, quotaLimit - quotaUsed),
  };

  // 4. Active API Keys
  const apiKeysTable = process.env.API_KEYS_TABLE || API_KEYS_TABLE;
  let apiKeys = [];
  if (apiKeysTable) {
    try {
      const keysRes = await ddb.send(new QueryCommand({
        TableName: apiKeysTable,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': { S: `USER#${canonicalUserId}` },
          ':sk': { S: 'APIKEY#' },
        },
      }));
      apiKeys = (keysRes.Items || []).map((raw) => {
        const item = unwrap(raw) || {};
        return {
          keyId: String(item.keyId || ''),
          name: String(item.name || ''),
          isActive: item.isActive !== false,
          createdAt: Number(item.createdAt) || 0,
          lastUsed: item.lastUsed != null ? Number(item.lastUsed) : null,
        };
      });
    } catch (err) {
      console.warn(`Could not query API keys for user ${canonicalUserId}:`, err);
    }
  }

  // 5. Recent Request Telemetry
  let recentRequests = [];
  try {
    recentRequests = await getRecentRequestsForUser(canonicalUserId);
  } catch (err) {
    console.warn(`Could not query recent requests for user ${canonicalUserId}:`, err);
  }

  return response(200, {
    user,
    billing,
    quota,
    apiKeys,
    recentRequests,
  });
}

function getAdminEmail(request) {
  const claims = request?.requestContext?.authorizer?.claims;
  return claims?.email || claims?.username || claims?.sub || 'admin';
}

function parseJsonBody(request) {
  if (!request?.body) return {};
  if (typeof request.body === 'object') return request.body;
  try {
    return JSON.parse(request.body);
  } catch {
    return null;
  }
}

async function recordAdminAudit({ adminEmail, targetUserId, action, reason, details }) {
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  const auditId = crypto.randomUUID ? crypto.randomUUID() : `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const expiresAt = Math.floor(now.getTime() / 1000) + (365 * 86400);

  await ddb.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      requestId: { S: `ADMIN_AUDIT#${dateKey}` },
      timestamp: { N: String(Math.floor(now.getTime() / 1000)) },
      entityType: { S: 'ADMIN_AUDIT' },
      auditId: { S: auditId },
      adminEmail: { S: adminEmail || 'unknown' },
      targetUserId: { S: targetUserId || '' },
      action: { S: action },
      reason: { S: reason || '' },
      details: { S: JSON.stringify(details || {}) },
      expiresAt: { N: String(expiresAt) },
    },
  }));
}

async function handleAdminUserPlanOverride(request, explicitUserId = null) {
  if (!isAuthorizedAdmin(request)) {
    return response(403, { error: 'Forbidden' });
  }

  const userIdParam = explicitUserId || request?.pathParameters?.userId || request?.queryStringParameters?.userId;
  const routeParam = request?.queryStringParameters?.route || request?.queryStringParameters?.view || '';
  const match = (routeParam ? (routeParam.startsWith('/') ? routeParam : `/${routeParam}`) : (request?.path || request?.resource || '')).match(/\/(?:admin\/)?users\/([^/?#]+)\/plan$/);
  const userId = (userIdParam && userIdParam !== '{userId}') ? userIdParam : (match ? match[1] : null);

  if (!userId || userId === 'users') {
    return response(400, { error: 'userId is required' });
  }

  const body = parseJsonBody(request);
  if (!body) {
    return response(400, { error: 'Invalid JSON body' });
  }

  const tier = String(body.tier || '').toLowerCase().trim();
  const validTiers = ['free', 'starter', 'pro', 'enterprise'];
  if (!validTiers.includes(tier)) {
    return response(400, { error: `Invalid tier. Allowed tiers: ${validTiers.join(', ')}` });
  }

  const reason = String(body.reason || '').trim();
  if (!reason) {
    return response(400, { error: 'Reason is required for audit trail' });
  }

  const manualOverride = body.manualOverride !== undefined ? Boolean(body.manualOverride) : true;
  const customMonthlyQuota = body.customMonthlyQuota != null && body.customMonthlyQuota !== '' ? parseInt(body.customMonthlyQuota, 10) : null;
  const quotaLimit = (customMonthlyQuota != null && !isNaN(customMonthlyQuota) && customMonthlyQuota > 0)
    ? customMonthlyQuota
    : (PLAN_QUOTAS[tier] || PLAN_QUOTAS.pro);

  const adminEmail = getAdminEmail(request);
  const now = new Date();
  const occurredAtIso = now.toISOString();

  let previousBilling = null;
  try {
    previousBilling = await getBilling(userId);
  } catch (err) {
    console.warn(`Could not read previous billing for ${userId}:`, err);
  }

  // 1. Update BILLING#<userId>
  const planName = planNameForTier(tier, 'month');
  await ddb.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: { requestId: { S: `BILLING#${userId}` }, timestamp: { N: '0' } },
    UpdateExpression: 'SET entityType = :entity, customerId = :customerId, #tier = :tier, #status = :status, #plan = :plan, manualOverride = :manualOverride, overrideReason = :reason, overrideSetBy = :admin, overrideSetAt = :setAt, updatedAt = :updatedAt',
    ExpressionAttributeNames: {
      '#tier': 'tier',
      '#status': 'status',
      '#plan': 'plan',
    },
    ExpressionAttributeValues: {
      ':entity': { S: 'BILLING' },
      ':customerId': { S: userId },
      ':tier': { S: tier },
      ':status': { S: 'active' },
      ':plan': { S: planName },
      ':manualOverride': { BOOL: manualOverride },
      ':reason': { S: reason },
      ':admin': { S: adminEmail },
      ':setAt': { S: occurredAtIso },
      ':updatedAt': { N: String(Math.floor(now.getTime() / 1000)) },
    },
  }));

  // 2. Update USER_QUOTA#<userId>#YYYY-MM
  const month = dateKey(now).slice(0, 7);
  const quotaKey = `USER_QUOTA#${userId}#${month}`;
  const expiresAt = Math.floor(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1)).getTime() / 1000);
  await ddb.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: { requestId: { S: quotaKey }, timestamp: { N: '0' } },
    UpdateExpression: 'SET #limit = :limit, entityType = :entity, expiresAt = :expiresAt, #used = if_not_exists(#used, :zero)',
    ExpressionAttributeNames: { '#limit': 'limit', '#used': 'used' },
    ExpressionAttributeValues: {
      ':limit': { N: String(quotaLimit) },
      ':entity': { S: 'USER_QUOTA' },
      ':expiresAt': { N: String(expiresAt) },
      ':zero': { N: '0' },
    },
  }));

  // 3. Sync API Gateway Usage Plans
  try {
    await syncUserUsagePlans(userId, tier);
  } catch (syncErr) {
    console.warn(`Could not sync usage plans for user ${userId}:`, syncErr);
  }

  // 4. Audit Log
  await recordAdminAudit({
    adminEmail,
    targetUserId: userId,
    action: 'PLAN_OVERRIDE',
    reason,
    details: {
      previousTier: previousBilling?.tier || 'free',
      newTier: tier,
      manualOverride,
      customMonthlyQuota: customMonthlyQuota || null,
      quotaLimit,
    },
  });

  return response(200, {
    success: true,
    userId,
    tier,
    manualOverride,
    quotaLimit,
  });
}

async function handleAdminUserQuotaAdjust(request, explicitUserId = null) {
  if (!isAuthorizedAdmin(request)) {
    return response(403, { error: 'Forbidden' });
  }

  const userIdParam = explicitUserId || request?.pathParameters?.userId || request?.queryStringParameters?.userId;
  const routeParam = request?.queryStringParameters?.route || request?.queryStringParameters?.view || '';
  const match = (routeParam ? (routeParam.startsWith('/') ? routeParam : `/${routeParam}`) : (request?.path || request?.resource || '')).match(/\/(?:admin\/)?users\/([^/?#]+)\/quota$/);
  const userId = (userIdParam && userIdParam !== '{userId}') ? userIdParam : (match ? match[1] : null);

  if (!userId || userId === 'users') {
    return response(400, { error: 'userId is required' });
  }

  const body = parseJsonBody(request);
  if (!body) {
    return response(400, { error: 'Invalid JSON body' });
  }

  const action = String(body.action || '').toLowerCase().trim();
  const validActions = ['add_credits', 'set_limit', 'reset_usage'];
  if (!validActions.includes(action)) {
    return response(400, { error: `Invalid action. Allowed actions: ${validActions.join(', ')}` });
  }

  const reason = String(body.reason || '').trim();
  if (!reason) {
    return response(400, { error: 'Reason is required for audit trail' });
  }

  const now = new Date();
  const month = dateKey(now).slice(0, 7);
  let quotaRecord = { used: 0, limit: 0 };
  try {
    quotaRecord = await getQuotaRecord(userId, now);
  } catch (err) {
    console.warn(`Could not read quota record for ${userId}:`, err);
  }

  let currentLimit = quotaRecord.limit || 0;
  const currentUsed = quotaRecord.used || 0;
  if (currentLimit === 0) {
    let billing = null;
    try {
      billing = await getBilling(userId);
    } catch (_) {}
    currentLimit = monthlyQuotaForBilling(billing);
  }

  let newLimit = currentLimit;
  let newUsed = currentUsed;

  if (action === 'add_credits') {
    const amount = parseInt(body.amount, 10);
    if (isNaN(amount) || amount <= 0) {
      return response(400, { error: 'amount must be a positive integer' });
    }
    newLimit = currentLimit + amount;
  } else if (action === 'set_limit') {
    const amount = parseInt(body.amount, 10);
    if (isNaN(amount) || amount < 0) {
      return response(400, { error: 'amount must be a non-negative integer' });
    }
    newLimit = amount;
  } else if (action === 'reset_usage') {
    newUsed = 0;
  }

  const quotaKey = `USER_QUOTA#${userId}#${month}`;
  const expiresAt = Math.floor(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1)).getTime() / 1000);

  await ddb.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: { requestId: { S: quotaKey }, timestamp: { N: '0' } },
    UpdateExpression: 'SET #limit = :limit, #used = :used, entityType = :entity, expiresAt = :expiresAt',
    ExpressionAttributeNames: { '#limit': 'limit', '#used': 'used' },
    ExpressionAttributeValues: {
      ':limit': { N: String(newLimit) },
      ':used': { N: String(newUsed) },
      ':entity': { S: 'USER_QUOTA' },
      ':expiresAt': { N: String(expiresAt) },
    },
  }));

  const adminEmail = getAdminEmail(request);
  await recordAdminAudit({
    adminEmail,
    targetUserId: userId,
    action: 'QUOTA_ADJUST',
    reason,
    details: {
      action,
      amount: body.amount != null ? body.amount : null,
      previousUsed: currentUsed,
      previousLimit: currentLimit,
      newUsed,
      newLimit,
      month,
    },
  });

  return response(200, {
    success: true,
    userId,
    month,
    used: newUsed,
    limit: newLimit,
    remaining: Math.max(0, newLimit - newUsed),
  });
}

let publicStatsCache = null;
let publicStatsCachedAt = 0;
const PUBLIC_STATS_CACHE_TTL_MS = 5 * 60 * 1000;

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

  try {
    await ddb.send(new PutItemCommand({ TableName: TABLE_NAME, Item: item }));
    await recordEventRollup(eventName, now);
  } catch (err) {
    console.error('Failed to record public analytics event', err);
  }
}

async function readPublicStats(request) {
  const eventParam = request?.queryStringParameters?.event;
  if (eventParam && EVENT_ROLLUP_TARGETS[eventParam]) {
    recordPublicEvent(eventParam, request).catch(console.error);
  } else if (!request?.queryStringParameters || Object.keys(request.queryStringParameters).length === 0) {
    recordPublicEvent('page_viewed', request).catch(console.error);
  }

  const now = Date.now();
  if (publicStatsCache && (now - publicStatsCachedAt < PUBLIC_STATS_CACHE_TTL_MS)) {
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
      return response(500, { error: 'Could not read statistics' });
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
    summary.successRate = roundFloat(((summary.requestsLast30Days - errors) / summary.requestsLast30Days) * 100);
  }
  if (durations.length > 0) {
    durations.sort((a, b) => a - b);
    summary.averageRenderMs = roundFloat(durations.reduce((total, value) => total + value, 0) / durations.length);
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
      provider: stringValue(result.Item, 'provider'),
      manualOverride: result.Item.manualOverride?.BOOL != null
        ? result.Item.manualOverride.BOOL
        : (result.Item.manualOverride?.S === 'true' || Boolean(unwrap(result.Item.manualOverride))),
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
  const result = await ddb.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: { requestId: { S: `USER_QUOTA#${userId}#${dateKey(monthStart).slice(0, 7)}` }, timestamp: { N: '0' } },
    ConsistentRead: true,
  }));
  return { used: numberValue(result.Item, 'used'), limit: numberValue(result.Item, 'limit') };
}

function monthlyQuotaForBilling(billing) {
  if (!billing || !billing.tier || billing.tier === 'free') return FREE_MONTHLY_QUOTA;
  return ['active', 'trialing', 'past_due'].includes(billing.status)
    ? (PLAN_QUOTAS[billing.tier] || PLAN_QUOTAS.pro)
    : FREE_MONTHLY_QUOTA;
}

async function creditOverage(userId, transactionId, eventId, occurredAt) {
  const month = dateKey(occurredAt).slice(0, 7);
  const quotaKey = `USER_QUOTA#${userId}#${month}`;
  const billing = await getBilling(userId);
  const baseQuota = monthlyQuotaForBilling(billing);
  const expiresAt = Math.floor(new Date(Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth() + 2, 1)).getTime() / 1000);
  await ddb.send(new TransactWriteItemsCommand({
    TransactItems: [
      {
        Put: {
          TableName: TABLE_NAME,
          Item: {
            requestId: { S: `OVERAGE#${transactionId}` },
            timestamp: { N: '0' },
            entityType: { S: 'OVERAGE_PURCHASE' },
            customerId: { S: userId },
            paddleTransactionId: { S: transactionId },
            paddleEventId: { S: eventId },
            credits: { N: String(OVERAGE_RENDER_CREDITS) },
            expiresAt: { N: String(expiresAt) },
          },
          ConditionExpression: 'attribute_not_exists(requestId)',
        },
      },
      {
        Update: {
          TableName: TABLE_NAME,
          Key: { requestId: { S: quotaKey }, timestamp: { N: '0' } },
          UpdateExpression: 'SET #limit = if_not_exists(#limit, :baseQuota) + :credits, entityType = :entity, expiresAt = :expiresAt',
          ExpressionAttributeNames: { '#limit': 'limit' },
          ExpressionAttributeValues: {
            ':baseQuota': { N: String(baseQuota) },
            ':credits': { N: String(OVERAGE_RENDER_CREDITS) },
            ':entity': { S: 'USER_QUOTA' },
            ':expiresAt': { N: String(expiresAt) },
          },
        },
      },
    ],
  }));
}

async function saveBillingWebhook(userId, subscriptionId, attributes, eventId, occurredAt, eventType = '') {
  const previousBilling = await getBilling(userId);
  if (previousBilling?.manualOverride === true) {
    const isDowngradeOrCancel =
      ['subscription.canceled', 'subscription.paused', 'subscription.past_due'].includes(eventType) ||
      attributes?.status === 'canceled' ||
      attributes?.status === 'past_due';

    if (isDowngradeOrCancel) {
      console.log(`Paddle webhook ignored: manualOverride is active for user ${userId} (${eventType})`);
      return; // Preserve the admin's manual plan
    }
  }

  const fields = billingFields(userId, subscriptionId, attributes, eventId, occurredAt);
  const names = {};
  const values = {};
  const updates = [];
  for (const [name, value] of Object.entries(fields)) {
    const token = `#${name}`;
    const valueToken = `:${name}`;
    names[token] = name;
    values[valueToken] = value;
    updates.push(`${token} = ${valueToken}`);
  }
  if (previousBilling?.manualOverride === true) {
    names['#manualOverride'] = 'manualOverride';
    values[':manualOverride'] = { BOOL: false };
    updates.push('#manualOverride = :manualOverride');
  }
  names['#eventTime'] = 'paddleEventOccurredAtMs';
  names['#eventId'] = 'paddleEventId';
  values[':eventTime'] = fields.paddleEventOccurredAtMs;
  values[':eventId'] = fields.paddleEventId;
  const isDirectAction = eventId.startsWith('sync-') || eventId.startsWith('plan-change-');
  const updateInput = {
    TableName: TABLE_NAME,
    Key: { requestId: { S: `BILLING#${userId}` }, timestamp: { N: '0' } },
    UpdateExpression: `SET ${updates.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
  if (!isDirectAction) {
    // A webhook can be retried or arrive after a newer state transition. Only
    // strictly newer Paddle events may replace the entitlement record.
    updateInput.ConditionExpression = '(attribute_not_exists(#eventTime) OR #eventTime < :eventTime) AND (attribute_not_exists(#eventId) OR #eventId <> :eventId)';
  }
  await ddb.send(new UpdateItemCommand(updateInput));
  const isPastDue = attributes?.status === 'past_due' || eventType === 'subscription.past_due';
  if (isPastDue && (previousBilling?.status !== 'past_due' || !previousBilling?.pastDueAlertSentAt)) {
    const customerEmail = String(attributes?.custom_data?.user_email || attributes?.customer?.email || previousBilling?.customerEmail || '').trim();
    try {
      await sendPaymentFailedAlert(ddb, TABLE_NAME, userId, customerEmail);
      await ddb.send(new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: { requestId: { S: `BILLING#${userId}` }, timestamp: { N: '0' } },
        UpdateExpression: 'SET pastDueAlertSentAt = :now',
        ExpressionAttributeValues: {
          ':now': { N: String(Math.floor(Date.now() / 1000)) },
        },
      }));
    } catch (alertErr) {
      console.error('Could not send payment failed alert', alertErr);
    }
  }
  if (!eventType || QUOTA_UPGRADE_EVENTS.has(eventType)) {
    await updateQuotaOnSubscriptionChange(userId, occurredAt, attributes, previousBilling);
  }
}

async function updateQuotaOnSubscriptionChange(userId, occurredAt, attributes, previousBilling) {
  const tier = tierFromAttributes(attributes);
  try {
    await syncUserUsagePlans(userId, tier);
  } catch (syncErr) {
    console.warn(`Could not sync usage plans for user ${userId}:`, syncErr);
  }
  const status = String(attributes?.status || 'unknown').toLowerCase();
  const newBaseQuota = monthlyQuotaForBilling({ tier, status });
  if (newBaseQuota <= FREE_MONTHLY_QUOTA) return;

  const month = dateKey(occurredAt).slice(0, 7);
  const quotaKey = `USER_QUOTA#${userId}#${month}`;
  const previousBaseQuota = monthlyQuotaForBilling(previousBilling);
  const quotaRecord = await getQuotaRecord(userId, occurredAt);
  const overageCredits = quotaRecord.limit > 0 ? Math.max(0, quotaRecord.limit - previousBaseQuota) : 0;
  const newLimit = newBaseQuota + overageCredits;
  const expiresAt = Math.floor(new Date(Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth() + 2, 1)).getTime() / 1000);

  await ddb.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: { requestId: { S: quotaKey }, timestamp: { N: '0' } },
    UpdateExpression: 'SET #limit = :limit, entityType = :entity, expiresAt = :expiresAt, #used = if_not_exists(#used, :zero)',
    ExpressionAttributeNames: { '#limit': 'limit', '#used': 'used' },
    ExpressionAttributeValues: {
      ':limit': { N: String(newLimit) },
      ':entity': { S: 'USER_QUOTA' },
      ':expiresAt': { N: String(expiresAt) },
      ':zero': { N: '0' },
    },
  }));
}

async function syncUserUsagePlans(userId, tier) {
  const freePlanId = process.env.FREE_USAGE_PLAN_ID || FREE_USAGE_PLAN_ID;
  const starterPlanId = process.env.STARTER_USAGE_PLAN_ID || STARTER_USAGE_PLAN_ID;
  const proPlanId = process.env.PRO_USAGE_PLAN_ID || PRO_USAGE_PLAN_ID;
  const apiKeysTable = process.env.API_KEYS_TABLE || API_KEYS_TABLE;

  if (!freePlanId && !starterPlanId && !proPlanId) return;
  if (!apiKeysTable || !userId) return;

  const targetPlanId = (tier === 'pro' || tier === 'enterprise') ? (proPlanId || freePlanId)
    : tier === 'starter' ? (starterPlanId || freePlanId)
    : freePlanId;

  if (!targetPlanId) return;

  try {
    const keysResult = await ddb.send(new QueryCommand({
      TableName: apiKeysTable,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': { S: `USER#${userId}` },
        ':sk': { S: 'APIKEY#' },
      },
    }));

    const items = keysResult.Items || [];
    const allPlanIds = [freePlanId, starterPlanId, proPlanId].filter(Boolean);

    for (const item of items) {
      if (!item.isActive?.BOOL || !item.apiGatewayKeyId?.S) continue;
      const keyId = item.apiGatewayKeyId.S;

      for (const oldPlanId of allPlanIds) {
        if (oldPlanId === targetPlanId) continue;
        try {
          await apigw.send(new DeleteUsagePlanKeyCommand({
            UsagePlanId: oldPlanId,
            KeyId: keyId,
          }));
        } catch (_) {
          // Ignore if key was not in this plan
        }
      }

      try {
        await apigw.send(new CreateUsagePlanKeyCommand({
          UsagePlanId: targetPlanId,
          KeyId: keyId,
          KeyType: 'API_KEY',
        }));
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

function billingFields(userId, subscriptionId, attributes, eventId, occurredAt) {
  const value = (input) => ({ S: String(input || '') });
  const billingPeriod = attributes.current_billing_period || {};
  const tier = tierFromAttributes(attributes);
  const interval = intervalFromAttributes(attributes);
  const scheduledChange = attributes.scheduled_change || {};
  return {
    requestId: value(`BILLING#${userId}`),
    timestamp: { N: '0' },
    entityType: value('BILLING'),
    customerId: value(userId),
    subscriptionId: value(subscriptionId),
    paddleCustomerId: value(attributes.customer_id),
    tier: value(tier),
    interval: value(interval),
    status: value(attributes.status || 'unknown'),
    plan: value(planNameForTier(tier, interval)),
    renewsAt: value(attributes.next_billed_at || billingPeriod.ends_at),
    endsAt: value(attributes.canceled_at),
    scheduledAction: value(scheduledChange.action),
    scheduledAt: value(scheduledChange.effective_at),
    paddleEventId: value(eventId),
    paddleEventOccurredAt: value(occurredAt.toISOString()),
    paddleEventOccurredAtMs: { N: String(occurredAt.getTime()) },
    updatedAt: { N: String(Math.floor(Date.now() / 1000)) },
  };
  const email = String(attributes?.custom_data?.user_email || attributes?.customer?.email || '').trim();
  if (email && email.includes('@')) {
    fields.customerEmail = value(email);
  }
  return fields;
}

function paddleEventTime(value) {
  const text = String(value || '').trim();
  // Paddle emits RFC 3339 UTC timestamps. Requiring the explicit UTC suffix
  // avoids accepting ambiguous local-time values in the ordering predicate.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text)) return null;
  const time = new Date(text);
  return Number.isFinite(time.getTime()) ? time : null;
}

function publicBilling(billing) {
  return {
    status: billing.status || 'unknown',
    plan: billing.plan || 'RenderPDF Pro',
    tier: billing.tier || 'pro',
    interval: billing.interval || 'month',
    renewsAt: billing.renewsAt || null,
    endsAt: billing.endsAt || null,
    scheduledChange: billing.scheduledAction && billing.scheduledAt
      ? { action: billing.scheduledAction, effectiveAt: billing.scheduledAt }
      : null,
  };
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

async function paddleRequest(path, options = {}) {
  const response = await fetch(`${PADDLE_API_BASE}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Paddle-Version': '1',
      Authorization: `Bearer ${process.env.PADDLE_API_KEY || PADDLE_API_KEY}`,
      ...(options.headers || {}),
    },
  });
  let payload;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const error = new Error(payload?.error?.detail || `Paddle API returned ${response.status}`);
    error.status = response.status;
    error.code = payload?.error?.code || '';
    throw error;
  }
  return payload;
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

function parseDays(value, fallback = DEFAULT_DAYS) {
  const days = Number.parseInt(value, 10);
  if (!Number.isFinite(days) || days < 1) return fallback;
  return Math.min(days, MAX_DAYS);
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
exports.saveBillingWebhook = saveBillingWebhook;
exports.updateQuotaOnSubscriptionChange = updateQuotaOnSubscriptionChange;
exports.monthlyQuotaForBilling = monthlyQuotaForBilling;
exports.tierFromAttributes = tierFromAttributes;
exports.intervalFromAttributes = intervalFromAttributes;
exports.planNameForTier = planNameForTier;
exports.syncSubscriptionWithPaddle = syncSubscriptionWithPaddle;
exports.changePlan = changePlan;
exports.receiveOverageWebhook = receiveOverageWebhook;
exports.creditOverage = creditOverage;
exports.createCheckout = createCheckout;
exports.receivePaymentFailedWebhook = receivePaymentFailedWebhook;
exports.sendPaymentFailedAlert = sendPaymentFailedAlert;
exports.syncUserUsagePlans = syncUserUsagePlans;
exports.ddb = ddb;
exports.apigw = apigw;
exports.PADDLE_PRICES = PADDLE_PRICES;
exports.latencyBucket = latencyBucket;
exports.recordRenderRollup = recordRenderRollup;
exports.recordEventRollup = recordEventRollup;
exports.saveAnalytics = saveAnalytics;
exports.EVENT_ROLLUP_TARGETS = EVENT_ROLLUP_TARGETS;
exports.readAdminAnalytics = readAdminAnalytics;
exports.readAnalytics = readAnalytics;
exports.calculateAwsCost = calculateAwsCost;
exports.calculateGrossMargin = calculateGrossMargin;
exports.calculateP95 = calculateP95;
exports.calculateMedianTtfc = calculateMedianTtfc;
exports.isAuthorizedAdmin = isAuthorizedAdmin;
exports.aggregateDayData = aggregateDayData;
exports.recordPublicEvent = recordPublicEvent;
exports.dateKey = dateKey;
exports.cognito = cognito;
exports.searchAdminUsers = searchAdminUsers;
exports.readAdminUserDossier = readAdminUserDossier;
exports.getCognitoAttr = getCognitoAttr;
exports.getRecentRequestsForUser = getRecentRequestsForUser;
exports.findCognitoUser = findCognitoUser;
exports.handleAdminUserPlanOverride = handleAdminUserPlanOverride;
exports.handleAdminUserQuotaAdjust = handleAdminUserQuotaAdjust;
exports.recordAdminAudit = recordAdminAudit;
exports.handleAdminUserStatus = handleAdminUserStatus;
exports.handleAdminKeyRevoke = handleAdminKeyRevoke;
exports.listAdminAuditLogs = listAdminAuditLogs;
exports.handleChatMessage = handleChatMessage;
exports.buildSystemPrompt = buildSystemPrompt;
exports.listAdminChats = listAdminChats;
exports.getAdminChatTranscript = getAdminChatTranscript;
exports.postAdminChatReply = postAdminChatReply;
exports.updateAdminChatStatus = updateAdminChatStatus;

// ─── GOVERNANCE APIS ──────────────────────────────────────────────────────────

/**
 * POST /api/v1/admin/users/{userId}/status
 * Body: { action: "disable" | "enable", reason }
 */
async function handleAdminUserStatus(request, explicitUserId) {
  if (!isAuthorizedAdmin(request)) {
    return response(403, { error: 'Forbidden' });
  }

  const routeParam = request?.queryStringParameters?.route || '';
  const routePath = routeParam
    ? (routeParam.startsWith('/') ? routeParam : `/${routeParam}`)
    : (request?.path || request?.resource || '');
  const match = routePath.match(/\/(?:admin\/)?users\/([^/?#]+)\/status$/);
  const userIdParam = explicitUserId || request?.pathParameters?.userId;
  const userId = (userIdParam && userIdParam !== '{userId}') ? userIdParam : (match ? match[1] : null);

  if (!userId || userId === 'users') {
    return response(400, { error: 'userId is required' });
  }

  const body = parseJsonBody(request);
  if (!body) return response(400, { error: 'Invalid JSON body' });

  const action = String(body.action || '').toLowerCase().trim();
  if (action !== 'disable' && action !== 'enable') {
    return response(400, { error: 'action must be "disable" or "enable"' });
  }

  const reason = String(body.reason || '').trim();
  if (!reason) return response(400, { error: 'Reason is required for audit trail' });

  const userPoolId = process.env.USER_POOL_ID || USER_POOL_ID;
  const adminEmail = getAdminEmail(request);

  const CognitoCmd = action === 'disable' ? AdminDisableUserCommand : AdminEnableUserCommand;
  await cognito.send(new CognitoCmd({ UserPoolId: userPoolId, Username: userId }));

  if (action === 'disable') {
    const apiKeysTable = process.env.API_KEYS_TABLE || API_KEYS_TABLE;
    if (apiKeysTable) {
      try {
        const keysResult = await ddb.send(new QueryCommand({
          TableName: apiKeysTable,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: {
            ':pk': { S: `USER#${userId}` },
            ':sk': { S: 'APIKEY#' },
          },
        }));
        for (const item of (keysResult.Items || [])) {
          const sk = item.SK?.S;
          if (!sk) continue;
          await ddb.send(new UpdateItemCommand({
            TableName: apiKeysTable,
            Key: { PK: { S: `USER#${userId}` }, SK: { S: sk } },
            UpdateExpression: 'SET isActive = :false',
            ExpressionAttributeValues: { ':false': { BOOL: false } },
          }));
        }
      } catch (err) {
        console.warn(`Could not deactivate API keys for user ${userId}:`, err);
      }
    }
  }

  await recordAdminAudit({
    adminEmail,
    targetUserId: userId,
    action: action === 'disable' ? 'USER_SUSPEND' : 'USER_ACTIVATE',
    reason,
    details: { cognitoAction: action },
  });

  return response(200, { success: true, userId, action });
}

/**
 * POST /api/v1/admin/users/{userId}/keys/{keyId}/revoke
 * Body: { reason }
 */
async function handleAdminKeyRevoke(request, explicitUserId, explicitKeyId) {
  if (!isAuthorizedAdmin(request)) {
    return response(403, { error: 'Forbidden' });
  }

  const routeParam = request?.queryStringParameters?.route || '';
  const routePath = routeParam
    ? (routeParam.startsWith('/') ? routeParam : `/${routeParam}`)
    : (request?.path || request?.resource || '');
  const routeMatch = routePath.match(/\/(?:admin\/)?users\/([^/?#]+)\/keys\/([^/?#]+)\/revoke$/);

  const userIdParam = explicitUserId || request?.pathParameters?.userId;
  const keyIdParam = explicitKeyId || request?.pathParameters?.keyId;
  const userId = (userIdParam && userIdParam !== '{userId}') ? userIdParam : (routeMatch ? routeMatch[1] : null);
  const keyId = (keyIdParam && keyIdParam !== '{keyId}') ? keyIdParam : (routeMatch ? routeMatch[2] : null);

  if (!userId || userId === 'users') return response(400, { error: 'userId is required' });
  if (!keyId) return response(400, { error: 'keyId is required' });

  const body = parseJsonBody(request);
  if (!body) return response(400, { error: 'Invalid JSON body' });

  const reason = String(body.reason || '').trim();
  if (!reason) return response(400, { error: 'Reason is required for audit trail' });

  const apiKeysTable = process.env.API_KEYS_TABLE || API_KEYS_TABLE;
  const adminEmail = getAdminEmail(request);

  let apiGatewayKeyId = null;
  if (apiKeysTable) {
    const keysResult = await ddb.send(new QueryCommand({
      TableName: apiKeysTable,
      KeyConditionExpression: 'PK = :pk AND SK = :sk',
      ExpressionAttributeValues: {
        ':pk': { S: `USER#${userId}` },
        ':sk': { S: `APIKEY#${keyId}` },
      },
    }));
    const keyItem = (keysResult.Items || [])[0];
    apiGatewayKeyId = keyItem?.apiGatewayKeyId?.S || null;

    await ddb.send(new UpdateItemCommand({
      TableName: apiKeysTable,
      Key: { PK: { S: `USER#${userId}` }, SK: { S: `APIKEY#${keyId}` } },
      UpdateExpression: 'SET isActive = :false',
      ExpressionAttributeValues: { ':false': { BOOL: false } },
    }));
  }

  if (apiGatewayKeyId) {
    const freePlanId = process.env.FREE_USAGE_PLAN_ID || FREE_USAGE_PLAN_ID;
    const starterPlanId = process.env.STARTER_USAGE_PLAN_ID || STARTER_USAGE_PLAN_ID;
    const proPlanId = process.env.PRO_USAGE_PLAN_ID || PRO_USAGE_PLAN_ID;
    for (const planId of [freePlanId, starterPlanId, proPlanId].filter(Boolean)) {
      try {
        await apigw.send(new DeleteUsagePlanKeyCommand({ UsagePlanId: planId, KeyId: apiGatewayKeyId }));
      } catch (_) {
        // Key may not be in this plan — ignore
      }
    }
  }

  await recordAdminAudit({
    adminEmail,
    targetUserId: userId,
    action: 'KEY_REVOKE',
    reason,
    details: { keyId, apiGatewayKeyId },
  });

  return response(200, { success: true, userId, keyId });
}

/**
 * GET /api/v1/admin/audit-logs?days={days}&limit={limit}
 * Queries ADMIN_AUDIT#YYYY-MM-DD partitions across the requested days.
 * Returns { logs: [...], count } sorted by timestamp descending.
 */
async function listAdminAuditLogs(request) {
  if (!isAuthorizedAdmin(request)) {
    return response(403, { error: 'Forbidden' });
  }

  const qs = request?.queryStringParameters || {};
  const days = Math.min(Math.max(parseInt(qs.days, 10) || 30, 1), 90);
  const limitParam = Math.min(Math.max(parseInt(qs.limit, 10) || 100, 1), 500);

  const now = new Date();
  const allLogs = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const dk = d.toISOString().slice(0, 10);
    try {
      const result = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'requestId = :pk',
        ExpressionAttributeValues: { ':pk': { S: `ADMIN_AUDIT#${dk}` } },
        ScanIndexForward: false,
        Limit: limitParam,
      }));
      const items = (result.Items || []).map((item) => ({
        requestId: item.requestId?.S,
        timestamp: Number(item.timestamp?.N || 0),
        auditId: item.auditId?.S,
        adminEmail: item.adminEmail?.S,
        targetUserId: item.targetUserId?.S,
        action: item.action?.S,
        reason: item.reason?.S,
        details: (() => { try { return JSON.parse(item.details?.S || '{}'); } catch (_) { return {}; } })(),
      }));
      allLogs.push(...items);
      if (allLogs.length >= limitParam) break;
    } catch (err) {
      console.warn(`Could not query audit logs for ADMIN_AUDIT#${dk}:`, err);
    }
  }

  allLogs.sort((a, b) => b.timestamp - a.timestamp);
  const page = allLogs.slice(0, limitParam);

  return response(200, { logs: page, count: page.length });
}
