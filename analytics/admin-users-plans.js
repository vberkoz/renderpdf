'use strict';

const {
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
  CreateUsagePlanKeyCommand,
  DeleteUsagePlanKeyCommand,
  getDdbClient,
  getApigwClient,
  dateKey,
  stringValue,
  numberValue,
  PLAN_QUOTAS,
  FREE_MONTHLY_QUOTA,
  response,
  getAdminEmail,
  parseJsonBody,
  isAuthorizedAdmin,
  unwrap,
} = require('./admin-users-common');

const { recordAdminAudit } = require('./admin-audit');

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
  const tableName = process.env.TABLE_NAME;
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
  const tableName = process.env.TABLE_NAME;
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

async function handleAdminUserPlanOverride(request, explicitUserId = null) {
  if (!isAuthorizedAdmin(request)) {
    return response(403, { error: 'Forbidden' });
  }

  const userIdParam =
    explicitUserId || request?.pathParameters?.userId || request?.queryStringParameters?.userId;
  const routeParam =
    request?.queryStringParameters?.route || request?.queryStringParameters?.view || '';
  const match = (
    routeParam
      ? routeParam.startsWith('/')
        ? routeParam
        : `/${routeParam}`
      : request?.path || request?.resource || ''
  ).match(/\/(?:admin\/)?users\/([^/?#]+)\/plan$/);
  const userId = userIdParam && userIdParam !== '{userId}' ? userIdParam : match ? match[1] : null;

  if (!userId || userId === 'users') {
    return response(400, { error: 'userId is required' });
  }

  const body = parseJsonBody(request);
  if (!body) {
    return response(400, { error: 'Invalid JSON body' });
  }

  const tier = String(body.tier || '')
    .toLowerCase()
    .trim();
  const validTiers = ['free', 'starter', 'pro', 'enterprise'];
  if (!validTiers.includes(tier)) {
    return response(400, { error: `Invalid tier. Allowed tiers: ${validTiers.join(', ')}` });
  }

  const reason = String(body.reason || '').trim();
  if (!reason) {
    return response(400, { error: 'Reason is required for audit trail' });
  }

  const manualOverride = body.manualOverride !== undefined ? Boolean(body.manualOverride) : true;
  const customMonthlyQuota =
    body.customMonthlyQuota != null && body.customMonthlyQuota !== ''
      ? parseInt(body.customMonthlyQuota, 10)
      : null;
  const quotaLimit =
    customMonthlyQuota != null && !isNaN(customMonthlyQuota) && customMonthlyQuota > 0
      ? customMonthlyQuota
      : PLAN_QUOTAS[tier] || PLAN_QUOTAS.pro;

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
  const tableName = process.env.TABLE_NAME;
  const planName = planNameForTier(tier, 'month');
  await getDdbClient().send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { requestId: { S: `BILLING#${userId}` }, timestamp: { N: '0' } },
      UpdateExpression:
        'SET entityType = :entity, customerId = :customerId, #tier = :tier, #status = :status, #plan = :plan, manualOverride = :manualOverride, overrideReason = :reason, overrideSetBy = :admin, overrideSetAt = :setAt, updatedAt = :updatedAt',
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
    })
  );

  // 2. Update USER_QUOTA#<userId>#YYYY-MM
  const month = dateKey(now).slice(0, 7);
  const quotaKey = `USER_QUOTA#${userId}#${month}`;
  const expiresAt = Math.floor(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1)).getTime() / 1000
  );
  await getDdbClient().send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { requestId: { S: quotaKey }, timestamp: { N: '0' } },
      UpdateExpression:
        'SET #limit = :limit, entityType = :entity, expiresAt = :expiresAt, #used = if_not_exists(#used, :zero)',
      ExpressionAttributeNames: { '#limit': 'limit', '#used': 'used' },
      ExpressionAttributeValues: {
        ':limit': { N: String(quotaLimit) },
        ':entity': { S: 'USER_QUOTA' },
        ':expiresAt': { N: String(expiresAt) },
        ':zero': { N: '0' },
      },
    })
  );

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

  const userIdParam =
    explicitUserId || request?.pathParameters?.userId || request?.queryStringParameters?.userId;
  const routeParam =
    request?.queryStringParameters?.route || request?.queryStringParameters?.view || '';
  const match = (
    routeParam
      ? routeParam.startsWith('/')
        ? routeParam
        : `/${routeParam}`
      : request?.path || request?.resource || ''
  ).match(/\/(?:admin\/)?users\/([^/?#]+)\/quota$/);
  const userId = userIdParam && userIdParam !== '{userId}' ? userIdParam : match ? match[1] : null;

  if (!userId || userId === 'users') {
    return response(400, { error: 'userId is required' });
  }

  const body = parseJsonBody(request);
  if (!body) {
    return response(400, { error: 'Invalid JSON body' });
  }

  const action = String(body.action || '')
    .toLowerCase()
    .trim();
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

  const tableName = process.env.TABLE_NAME;
  const quotaKey = `USER_QUOTA#${userId}#${month}`;
  const expiresAt = Math.floor(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1)).getTime() / 1000
  );

  await getDdbClient().send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { requestId: { S: quotaKey }, timestamp: { N: '0' } },
      UpdateExpression:
        'SET #limit = :limit, #used = :used, entityType = :entity, expiresAt = :expiresAt',
      ExpressionAttributeNames: { '#limit': 'limit', '#used': 'used' },
      ExpressionAttributeValues: {
        ':limit': { N: String(newLimit) },
        ':used': { N: String(newUsed) },
        ':entity': { S: 'USER_QUOTA' },
        ':expiresAt': { N: String(expiresAt) },
      },
    })
  );

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

module.exports = {
  monthlyQuotaForBilling,
  planNameForTier,
  getBilling,
  getQuotaRecord,
  syncUserUsagePlans,
  handleAdminUserPlanOverride,
  handleAdminUserQuotaAdjust,
};
