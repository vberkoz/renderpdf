'use strict';

const crypto = require('node:crypto');
let UpdateItemCommand;
let TransactWriteItemsCommand;

try {
  ({
    UpdateItemCommand,
    TransactWriteItemsCommand,
  } = require('@aws-sdk/client-dynamodb'));
} catch {
  UpdateItemCommand = class UpdateItemCommand {
    constructor(input) {
      this.input = input;
    }
  };
  TransactWriteItemsCommand = class TransactWriteItemsCommand {
    constructor(input) {
      this.input = input;
    }
  };
}
const { ddb, queryDay } = require('./admin-analytics');
const {
  syncUserUsagePlans,
  getBilling,
  getQuotaRecord,
  monthlyQuotaForBilling,
  planNameForTier,
  PLAN_QUOTAS,
  FREE_MONTHLY_QUOTA,
} = require('./admin-users');
const { sendPaymentFailedAlert } = require('./notifications');

const TABLE_NAME = process.env.TABLE_NAME || 'RenderPdfTable';
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

function tierFromAttributes(attributes) {
  const proPrice = process.env.PADDLE_PRO_PRICE_ID || PADDLE_PRICES.pro || '';
  const proAnnualPrice = process.env.PADDLE_PRO_ANNUAL_PRICE_ID || PADDLE_PRICES.pro_annual || '';
  const starterPrice = process.env.PADDLE_STARTER_PRICE_ID || PADDLE_PRICES.starter || '';
  const starterAnnualPrice =
    process.env.PADDLE_STARTER_ANNUAL_PRICE_ID || PADDLE_PRICES.starter_annual || '';

  const extractItemDetails = (item) => {
    if (!item) return { ids: [], name: '' };
    const ids = [item.price?.id, item.price_id, item.id, item.price?.product_id]
      .filter(Boolean)
      .map(String);
    const name = [
      item.price?.product?.name,
      item.price?.name,
      item.price?.description,
      item.description,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
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
  const customPlan = String(attributes?.custom_data?.plan || '')
    .trim()
    .toLowerCase();
  if (customPlan === 'starter' || customPlan === 'starter_annual') return 'starter';
  if (customPlan === 'pro' || customPlan === 'pro_annual') return 'pro';

  return 'pro';
}

function intervalFromAttributes(attributes) {
  const proAnnualPrice = process.env.PADDLE_PRO_ANNUAL_PRICE_ID || PADDLE_PRICES.pro_annual || '';
  const starterAnnualPrice =
    process.env.PADDLE_STARTER_ANNUAL_PRICE_ID || PADDLE_PRICES.starter_annual || '';
  const annualIds = [proAnnualPrice, starterAnnualPrice].filter(Boolean);

  if (attributes?.billing_cycle?.interval === 'year') return 'year';

  const items = Array.isArray(attributes?.items) ? attributes.items : [];
  for (const item of items) {
    const ids = [item.price?.id, item.price_id, item.id].filter(Boolean).map(String);
    if (annualIds.some((id) => ids.includes(id))) return 'year';
    const name = [item.price?.product?.name, item.price?.name, item.description]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (name.includes('annual') || name.includes('yearly')) return 'year';
    if (item.price?.billing_cycle?.interval === 'year') return 'year';
  }

  const customPlan = String(attributes?.custom_data?.plan || '')
    .trim()
    .toLowerCase();
  if (customPlan.includes('annual') || customPlan.includes('year')) return 'year';

  return 'month';
}

async function syncSubscriptionWithPaddle(userId, billing) {
  const apiKey = process.env.PADDLE_API_KEY || PADDLE_API_KEY;
  if (!billing?.subscriptionId || !apiKey) return billing;
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
  const currentTableName = process.env.TABLE_NAME || TABLE_NAME;
  if (userEmail && billing && !billing.customerEmail) {
    try {
      await ddb.send(
        new UpdateItemCommand({
          TableName: currentTableName,
          Key: { requestId: { S: `BILLING#${userId}` }, timestamp: { N: '0' } },
          UpdateExpression: 'SET customerEmail = :email',
          ExpressionAttributeValues: { ':email': { S: userEmail } },
        })
      );
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
        if (
          stringValue(item, 'entityType') !== 'PDF_REQUEST' ||
          stringValue(item, 'customerId') !== userId
        )
          continue;
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
  try {
    quotaRecord = await getQuotaRecord(userId, monthStart);
  } catch (err) {
    console.error('Could not read customer quota', err);
    return customerResponse(500, { error: 'Could not read quota' });
  }
  const usedThisMonth = quotaRecord.used;
  const quota = Math.max(quotaRecord.limit || 0, baseQuota);

  if (
    quotaRecord.limit < baseQuota &&
    ['active', 'trialing', 'past_due'].includes(billing?.status)
  ) {
    try {
      const prevTier = quotaRecord.limit >= PLAN_QUOTAS.starter ? 'starter' : 'free';
      const tierPrice =
        billing?.tier === 'starter'
          ? (process.env.PADDLE_STARTER_PRICE_ID || PADDLE_PRICES.starter)
          : billing?.tier === 'pro'
            ? (process.env.PADDLE_PRO_PRICE_ID || PADDLE_PRICES.pro)
            : (PADDLE_PRICES[billing?.tier] || '');
      await updateQuotaOnSubscriptionChange(
        userId,
        now,
        {
          custom_data: { plan: billing?.tier },
          status: billing?.status,
          items: [{ price: { id: tierPrice } }],
        },
        { tier: prevTier, status: 'active' }
      );
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
  try {
    checkout = JSON.parse(request.body || '{}');
  } catch {
    return customerResponse(400, { error: 'Invalid checkout request' });
  }
  const tier = String(checkout.plan || 'pro').toLowerCase();
  const isOverage = tier === 'overage';
  if (!isOverage && !Object.hasOwn(PADDLE_PRICES, tier))
    return customerResponse(422, { error: 'Choose a valid plan' });
  const apiKey = process.env.PADDLE_API_KEY || PADDLE_API_KEY;
  const clientToken = process.env.PADDLE_CLIENT_TOKEN || PADDLE_CLIENT_TOKEN;
  const checkoutUrl = process.env.PADDLE_CHECKOUT_URL || PADDLE_CHECKOUT_URL;
  const environment = process.env.PADDLE_ENVIRONMENT || PADDLE_ENVIRONMENT;
  const priceID = isOverage
    ? process.env.PADDLE_OVERAGE_PRICE_ID || PADDLE_OVERAGE_PRICE_ID
    : PADDLE_PRICES[tier] ||
      process.env[
        tier === 'starter'
          ? 'PADDLE_STARTER_PRICE_ID'
          : tier === 'starter_annual'
            ? 'PADDLE_STARTER_ANNUAL_PRICE_ID'
            : tier === 'pro_annual'
              ? 'PADDLE_PRO_ANNUAL_PRICE_ID'
              : 'PADDLE_PRO_PRICE_ID'
      ];
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
  if (!billing?.paddleCustomerId)
    return customerResponse(404, { error: 'No subscription is linked to this account' });
  const apiKey = process.env.PADDLE_API_KEY || PADDLE_API_KEY;
  if (!apiKey) return customerResponse(503, { error: 'Billing is not configured yet' });
  try {
    const result = await paddleRequest(
      `/customers/${encodeURIComponent(billing.paddleCustomerId)}/portal-sessions`,
      {
        method: 'POST',
        body: JSON.stringify({
          subscription_ids: billing.subscriptionId ? [billing.subscriptionId] : [],
        }),
      }
    );
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
  try {
    input = JSON.parse(request.body || '{}');
  } catch {
    return customerResponse(400, { error: 'Invalid plan change request' });
  }
  const requestedPlan = String(input.plan || '').toLowerCase();
  const priceID =
    PADDLE_PRICES[requestedPlan] ||
    process.env[
      requestedPlan === 'starter'
        ? 'PADDLE_STARTER_PRICE_ID'
        : requestedPlan === 'starter_annual'
          ? 'PADDLE_STARTER_ANNUAL_PRICE_ID'
          : requestedPlan === 'pro_annual'
            ? 'PADDLE_PRO_ANNUAL_PRICE_ID'
            : 'PADDLE_PRO_PRICE_ID'
    ] ||
    '';
  if (!priceID) return customerResponse(422, { error: 'Choose a valid plan' });
  const apiKey = process.env.PADDLE_API_KEY || PADDLE_API_KEY;
  if (!apiKey)
    return customerResponse(503, { error: 'Billing is not configured yet' });

  const billing = await getBilling(userId);
  if (!billing?.subscriptionId || !['active', 'trialing'].includes(billing.status)) {
    return customerResponse(409, { error: 'No active subscription is available to change' });
  }
  const currentTier = billing.tier;
  const currentInterval =
    billing.interval ||
    (billing.plan && billing.plan.toLowerCase().includes('annual') ? 'year' : 'month');
  const targetTier = requestedPlan.startsWith('starter') ? 'starter' : 'pro';
  const targetInterval =
    requestedPlan.includes('annual') || requestedPlan.includes('year') ? 'year' : 'month';
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
    const result = await paddleRequest(
      `/subscriptions/${encodeURIComponent(billing.subscriptionId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(patchBody),
      }
    );

    const updatedSub = result?.data || {};
    const occurredAt = new Date();
    const eventId = `plan-change-${Date.now()}`;
    const subAttributes = {
      ...updatedSub,
      status: updatedSub.status || 'active',
      custom_data: { user_id: userId, plan: requestedPlan, ...(updatedSub.custom_data || {}) },
      items: [
        { price: { id: priceID } },
        ...(Array.isArray(updatedSub.items) ? updatedSub.items.slice(1) : []),
      ],
    };
    try {
      await saveBillingWebhook(
        userId,
        billing.subscriptionId,
        subAttributes,
        eventId,
        occurredAt,
        'subscription.updated'
      );
    } catch (saveErr) {
      console.warn('Could not immediately sync billing after changePlan', saveErr);
    }

    return customerResponse(200, { requested: true, plan: requestedPlan, changed: true });
  } catch (err) {
    console.error('Could not change Paddle subscription plan', err);
    if (err?.status === 403) {
      return customerResponse(503, {
        error: 'Paddle billing key needs Subscription write permission to change plans',
      });
    }
    return customerResponse(502, { error: 'Could not change the subscription plan' });
  }
}

async function receivePaddleWebhook(request) {
  const webhookSecret = process.env.PADDLE_WEBHOOK_SECRET || PADDLE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('Paddle webhook rejected: secret is not configured');
    return response(503, { error: 'Billing webhook is not configured' });
  }
  const rawBody = request.body || '';
  const signatureParts = signaturePartsFrom(header(request.headers, 'paddle-signature'));
  if (
    !signatureParts.timestamp ||
    !signatureParts.hash ||
    Math.abs(Math.floor(Date.now() / 1000) - Number(signatureParts.timestamp)) > 300
  ) {
    console.warn('Paddle webhook rejected: signature header is missing or stale');
    return response(401, { error: 'Invalid webhook signature' });
  }
  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(`${signatureParts.timestamp}:${rawBody}`)
    .digest('hex');
  if (!safeEqual(signatureParts.hash, expected)) {
    console.warn('Paddle webhook rejected: signature mismatch');
    return response(401, { error: 'Invalid webhook signature' });
  }
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return response(400, { error: 'Invalid JSON body' });
  }
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
    console.warn(
      `Paddle webhook ignored: ${eventType} is missing a valid event ID or occurred_at timestamp`
    );
    return response(200, { received: true, ignored: true });
  }
  const attributes = payload?.data || {};
  const userId = String(attributes?.custom_data?.user_id || '').trim();
  const subscriptionId = String(attributes?.id || '').trim();
  if (!userId || !subscriptionId) {
    console.log(
      `Paddle webhook ignored: ${eventType} does not contain RenderPDF subscription custom data`
    );
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
  const itemPriceId = String(
    transaction.items?.[0]?.price?.id || transaction.items?.[0]?.price_id || ''
  );
  const isOverage =
    transaction?.custom_data?.entitlement === 'overage' &&
    Array.isArray(transaction.items) &&
    transaction.items.length === 1 &&
    itemPriceId === overagePriceId &&
    Number(transaction.items[0]?.quantity) === 1;
  if (!eventId || !occurredAt || !userId || !transactionId || !isOverage) {
    console.log('Paddle transaction.completed ignored: not a valid RenderPDF overage purchase');
    return response(200, { received: true, ignored: true });
  }
  try {
    await creditOverage(userId, transactionId, eventId, occurredAt);
  } catch (err) {
    if (
      err?.name === 'TransactionCanceledException' ||
      err?.name === 'ConditionalCheckFailedException'
    ) {
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
  const customerEmail = String(
    transaction?.custom_data?.user_email || transaction?.customer?.email || ''
  ).trim();
  if (userId) {
    const previousBilling = await getBilling(userId);
    if (!previousBilling?.pastDueAlertSentAt) {
      try {
        const currentTableName = process.env.TABLE_NAME || TABLE_NAME;
        await sendPaymentFailedAlert(ddb, currentTableName, userId, customerEmail);
        await ddb.send(
          new UpdateItemCommand({
            TableName: currentTableName,
            Key: { requestId: { S: `BILLING#${userId}` }, timestamp: { N: '0' } },
            UpdateExpression:
              'SET pastDueAlertSentAt = :now, #status = if_not_exists(#status, :pastDue)',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':now': { N: String(Math.floor(Date.now() / 1000)) },
              ':pastDue': { S: 'past_due' },
            },
          })
        );
      } catch (alertErr) {
        console.error('Could not send payment failed alert from transaction webhook', alertErr);
      }
    }
  }
  return response(200, { received: true });
}

async function creditOverage(userId, transactionId, eventId, occurredAt) {
  const month = dateKey(occurredAt).slice(0, 7);
  const quotaKey = `USER_QUOTA#${userId}#${month}`;
  const billing = await getBilling(userId);
  const baseQuota = monthlyQuotaForBilling(billing);
  const expiresAt = Math.floor(
    new Date(Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth() + 2, 1)).getTime() /
      1000
  );
  const currentTableName = process.env.TABLE_NAME || TABLE_NAME;
  await ddb.send(
    new TransactWriteItemsCommand({
      TransactItems: [
        {
          Put: {
            TableName: currentTableName,
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
            TableName: currentTableName,
            Key: { requestId: { S: quotaKey }, timestamp: { N: '0' } },
            UpdateExpression:
              'SET #limit = if_not_exists(#limit, :baseQuota) + :credits, entityType = :entity, expiresAt = :expiresAt',
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
    })
  );
}

async function saveBillingWebhook(
  userId,
  subscriptionId,
  attributes,
  eventId,
  occurredAt,
  eventType = ''
) {
  const previousBilling = await getBilling(userId);
  if (previousBilling?.manualOverride === true) {
    const isDowngradeOrCancel =
      ['subscription.canceled', 'subscription.paused', 'subscription.past_due'].includes(
        eventType
      ) ||
      attributes?.status === 'canceled' ||
      attributes?.status === 'past_due';

    if (isDowngradeOrCancel) {
      console.log(
        `Paddle webhook ignored: manualOverride is active for user ${userId} (${eventType})`
      );
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
  const currentTableName = process.env.TABLE_NAME || TABLE_NAME;
  const updateInput = {
    TableName: currentTableName,
    Key: { requestId: { S: `BILLING#${userId}` }, timestamp: { N: '0' } },
    UpdateExpression: `SET ${updates.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
  if (!isDirectAction) {
    // A webhook can be retried or arrive after a newer state transition. Only
    // strictly newer Paddle events may replace the entitlement record.
    updateInput.ConditionExpression =
      '(attribute_not_exists(#eventTime) OR #eventTime < :eventTime) AND (attribute_not_exists(#eventId) OR #eventId <> :eventId)';
  }
  await ddb.send(new UpdateItemCommand(updateInput));
  const isPastDue = attributes?.status === 'past_due' || eventType === 'subscription.past_due';
  if (
    isPastDue &&
    (previousBilling?.status !== 'past_due' || !previousBilling?.pastDueAlertSentAt)
  ) {
    const customerEmail = String(
      attributes?.custom_data?.user_email ||
        attributes?.customer?.email ||
        previousBilling?.customerEmail ||
        ''
    ).trim();
    try {
      await sendPaymentFailedAlert(ddb, currentTableName, userId, customerEmail);
      await ddb.send(
        new UpdateItemCommand({
          TableName: currentTableName,
          Key: { requestId: { S: `BILLING#${userId}` }, timestamp: { N: '0' } },
          UpdateExpression: 'SET pastDueAlertSentAt = :now',
          ExpressionAttributeValues: {
            ':now': { N: String(Math.floor(Date.now() / 1000)) },
          },
        })
      );
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
  const overageCredits =
    quotaRecord.limit > 0 ? Math.max(0, quotaRecord.limit - previousBaseQuota) : 0;
  const newLimit = newBaseQuota + overageCredits;
  const expiresAt = Math.floor(
    new Date(Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth() + 2, 1)).getTime() /
      1000
  );

  const currentTableName = process.env.TABLE_NAME || TABLE_NAME;
  await ddb.send(
    new UpdateItemCommand({
      TableName: currentTableName,
      Key: { requestId: { S: quotaKey }, timestamp: { N: '0' } },
      UpdateExpression:
        'SET #limit = :limit, entityType = :entity, expiresAt = :expiresAt, #used = if_not_exists(#used, :zero)',
      ExpressionAttributeNames: { '#limit': 'limit', '#used': 'used' },
      ExpressionAttributeValues: {
        ':limit': { N: String(newLimit) },
        ':entity': { S: 'USER_QUOTA' },
        ':expiresAt': { N: String(expiresAt) },
        ':zero': { N: '0' },
      },
    })
  );
}

function billingFields(userId, subscriptionId, attributes, eventId, occurredAt) {
  const value = (input) => ({ S: String(input || '') });
  const billingPeriod = attributes.current_billing_period || {};
  const tier = tierFromAttributes(attributes);
  const interval = intervalFromAttributes(attributes);
  const scheduledChange = attributes.scheduled_change || {};
  const fields = {
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
  const email = String(
    attributes?.custom_data?.user_email || attributes?.customer?.email || ''
  ).trim();
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
    scheduledChange:
      billing.scheduledAction && billing.scheduledAt
        ? { action: billing.scheduledAction, effectiveAt: billing.scheduledAt }
        : null,
  };
}

async function paddleRequest(path, options = {}) {
  const apiBase = String(process.env.PADDLE_API_BASE || PADDLE_API_BASE || 'https://api.paddle.com').replace(
    /\/+$/,
    ''
  );
  const apiKey = process.env.PADDLE_API_KEY || PADDLE_API_KEY;
  const response = await fetch(`${apiBase}${path}`, {
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
    payload = await response.json();
  } catch {
    payload = null;
  }
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

exports.receivePaddleWebhook = receivePaddleWebhook;
exports.receiveOverageWebhook = receiveOverageWebhook;
exports.receivePaymentFailedWebhook = receivePaymentFailedWebhook;
exports.createCheckout = createCheckout;
exports.openBillingPortal = openBillingPortal;
exports.changePlan = changePlan;
exports.readCustomerDashboard = readCustomerDashboard;
exports.syncSubscriptionWithPaddle = syncSubscriptionWithPaddle;
exports.syncUserUsagePlans = syncUserUsagePlans;
exports.updateQuotaOnSubscriptionChange = updateQuotaOnSubscriptionChange;
exports.saveBillingWebhook = saveBillingWebhook;
exports.creditOverage = creditOverage;
exports.paddleRequest = paddleRequest;
exports.tierFromAttributes = tierFromAttributes;
exports.intervalFromAttributes = intervalFromAttributes;
exports.PADDLE_PRICES = PADDLE_PRICES;
exports.PADDLE_SUBSCRIPTION_EVENTS = PADDLE_SUBSCRIPTION_EVENTS;
exports.QUOTA_UPGRADE_EVENTS = QUOTA_UPGRADE_EVENTS;
exports.OVERAGE_RENDER_CREDITS = OVERAGE_RENDER_CREDITS;
exports.billingFields = billingFields;
exports.paddleEventTime = paddleEventTime;
exports.publicBilling = publicBilling;
exports.customerId = customerId;
exports.customerResponse = customerResponse;
