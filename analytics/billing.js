'use strict';

let UpdateItemCommand;
try {
  ({ UpdateItemCommand } = require('@aws-sdk/client-dynamodb'));
} catch {
  UpdateItemCommand = class UpdateItemCommand {
    constructor(input) {
      this.input = input;
    }
  };
}

const {
  ddb,
  queryDay,
  syncUserUsagePlans,
  getBilling,
  getQuotaRecord,
  monthlyQuotaForBilling,
  PLAN_QUOTAS,
} = require('./billing-common');

const common = require('./billing-common');
const subscriptions = require('./billing-subscriptions');
const webhooks = require('./billing-webhooks');

const {
  TABLE_NAME,
  PADDLE_API_KEY,
  PADDLE_CLIENT_TOKEN,
  PADDLE_ENVIRONMENT,
  PADDLE_PRICES,
  PADDLE_OVERAGE_PRICE_ID,
  OVERAGE_RENDER_CREDITS,
  PADDLE_CHECKOUT_URL,
  PADDLE_SUBSCRIPTION_EVENTS,
  QUOTA_UPGRADE_EVENTS,
  customerId,
  customerResponse,
  dateKey,
  nextMonthStart,
  stringValue,
  numberValue,
  paddleRequest,
} = common;

const {
  tierFromAttributes,
  intervalFromAttributes,
  billingFields,
  paddleEventTime,
  publicBilling,
  creditOverage,
  updateQuotaOnSubscriptionChange,
  syncSubscriptionWithPaddle,
} = subscriptions;

const {
  receivePaddleWebhook,
  receiveOverageWebhook,
  receivePaymentFailedWebhook,
  saveBillingWebhook,
} = webhooks;

async function syncSubscriptionWithPaddleWrapper(userId, billing) {
  return syncSubscriptionWithPaddle(userId, billing, saveBillingWebhook);
}

async function readCustomerDashboard(request) {
  const userId = customerId(request);
  if (!userId) return customerResponse(401, { error: 'Sign in is required' });

  let billing = await getBilling(userId);
  if (billing?.subscriptionId) {
    billing = await syncSubscriptionWithPaddleWrapper(userId, billing);
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
    const days = [];
    for (let day = new Date(monthStart); day <= now; day.setUTCDate(day.getUTCDate() + 1)) {
      days.push(dateKey(day));
    }
    const dayResults = await Promise.all(
      days.map(async (d) => {
        try {
          return { dayStr: d, items: await queryDay(`USAGE#${d}`) };
        } catch (err) {
          console.warn(`Could not read usage partition USAGE#${d}:`, err);
          return { dayStr: d, items: [] };
        }
      })
    );
    for (const { dayStr, items } of dayResults) {
      for (const item of items) {
        if (
          stringValue(item, 'entityType') !== 'PDF_REQUEST' ||
          stringValue(item, 'customerId') !== userId
        )
          continue;
        const status = stringValue(item, 'status') || 'success';
        if (dayStr === today) {
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

  const query = request?.queryStringParameters || {};
  const rawLimit = Number(query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(100, Math.floor(rawLimit)) : 25;
  const rawCursor = Number(query.cursor ?? query.offset);
  const cursor = Number.isFinite(rawCursor) && rawCursor >= 0 ? Math.floor(rawCursor) : 0;
  const statusFilter =
    typeof query.status === 'string' && ['success', 'error', 'failed'].includes(query.status)
      ? query.status
      : '';
  const sortOrder = query.sort === 'oldest' ? 'oldest' : 'newest';

  usage.logs.sort((a, b) =>
    sortOrder === 'oldest' ? a.timestamp - b.timestamp : b.timestamp - a.timestamp
  );
  const filteredLogs = statusFilter
    ? usage.logs.filter((log) =>
        statusFilter === 'success' ? log.status === 'success' : log.status !== 'success'
      )
    : usage.logs;
  const pagedLogs = filteredLogs.slice(cursor, cursor + limit);
  const nextCursor = cursor + limit < filteredLogs.length ? String(cursor + limit) : null;

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
    logs: pagedLogs,
    logsPagination: {
      limit,
      cursor,
      nextCursor,
      total: filteredLogs.length,
    },
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

module.exports = {
  receivePaddleWebhook,
  receiveOverageWebhook,
  receivePaymentFailedWebhook,
  createCheckout,
  openBillingPortal,
  changePlan,
  readCustomerDashboard,
  syncSubscriptionWithPaddle: syncSubscriptionWithPaddleWrapper,
  syncUserUsagePlans,
  updateQuotaOnSubscriptionChange,
  saveBillingWebhook,
  creditOverage,
  paddleRequest,
  tierFromAttributes,
  intervalFromAttributes,
  PADDLE_PRICES,
  PADDLE_SUBSCRIPTION_EVENTS,
  QUOTA_UPGRADE_EVENTS,
  OVERAGE_RENDER_CREDITS,
  billingFields,
  paddleEventTime,
  publicBilling,
  customerId,
  customerResponse,
};
