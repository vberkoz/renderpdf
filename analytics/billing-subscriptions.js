'use strict';

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

const {
  ddb,
  syncUserUsagePlans,
  getBilling,
  getQuotaRecord,
  monthlyQuotaForBilling,
  planNameForTier,
  PLAN_QUOTAS,
  FREE_MONTHLY_QUOTA,
  TABLE_NAME,
  PADDLE_API_KEY,
  PADDLE_PRICES,
  OVERAGE_RENDER_CREDITS,
  dateKey,
  paddleRequest,
} = require('./billing-common');

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

async function syncSubscriptionWithPaddle(userId, billing, saveBillingWebhookFn) {
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
      await saveBillingWebhookFn(
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

module.exports = {
  tierFromAttributes,
  intervalFromAttributes,
  billingFields,
  paddleEventTime,
  publicBilling,
  creditOverage,
  updateQuotaOnSubscriptionChange,
  syncSubscriptionWithPaddle,
};
