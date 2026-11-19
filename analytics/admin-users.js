'use strict';

const common = require('./admin-users-common');
const plans = require('./admin-users-plans');
const dossier = require('./admin-users-dossier');
const actions = require('./admin-users-actions');

const {
  ListUsersCommand,
  BatchGetItemCommand,
  QueryCommand,
  getCognitoClient,
  getDdbClient,
  positiveInteger,
  dateKey,
  response,
  isAuthorizedAdmin,
  unwrap,
} = common;

const { monthlyQuotaForBilling } = plans;
const { findCognitoUser, getCognitoAttr, formatCognitoDate } = dossier;

async function searchAdminUsers(request) {
  if (!isAuthorizedAdmin(request)) {
    return response(403, { error: 'Forbidden' });
  }

  const userPoolId = process.env.USER_POOL_ID || 'renderpdf-users-v2';
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
      const listRes = await getCognitoClient().send(new ListUsersCommand(listParams));
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
  const tableName = process.env.TABLE_NAME || 'RenderPdfTable';
  const apiKeysTable = process.env.API_KEYS_TABLE || '';

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
        const batchRes = await getDdbClient().send(
          new BatchGetItemCommand({
            RequestItems: { [tableName]: { Keys: chunk } },
          })
        );
        const rawItems =
          batchRes?.Responses?.[tableName] ||
          (process.env.TABLE_NAME && batchRes?.Responses?.[process.env.TABLE_NAME]) ||
          (batchRes?.Responses && Object.values(batchRes.Responses)[0]) ||
          [];
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
    await Promise.all(
      cognitoUsers.map(async (u) => {
        const uid = getCognitoAttr(u, 'sub') || u.Username;
        if (!uid) return;
        try {
          const keysRes = await getDdbClient().send(
            new QueryCommand({
              TableName: apiKeysTable,
              KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
              ExpressionAttributeValues: {
                ':pk': { S: `USER#${uid}` },
                ':sk': { S: 'APIKEY#' },
              },
            })
          );
          const count = (keysRes.Items || []).filter((k) => {
            const item = unwrap(k);
            return item.isActive !== false;
          }).length;
          activeKeysMap.set(uid, count);
        } catch (_) {
          activeKeysMap.set(uid, 0);
        }
      })
    );
  }

  const assembledUsers = cognitoUsers.map((u) => {
    const uid = getCognitoAttr(u, 'sub') || u.Username;
    const billing = billingMap.get(uid) || {};
    const quota = quotaMap.get(uid) || {};

    const tier = billing.tier || 'free';
    const status = billing.status || 'active';
    const manualOverride = Boolean(
      billing.manualOverride === true || billing.manualOverride === 'true'
    );
    const provider =
      billing.provider ||
      (billing.subscriptionId ? 'paddle' : manualOverride ? 'manual' : 'paddle');
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
    filteredUsers = filteredUsers.filter(
      (u) => u.status.toLowerCase() === statusParam.toLowerCase()
    );
  }

  return response(200, {
    users: filteredUsers,
    nextCursor,
  });
}

module.exports = {
  // Functions from dossier
  findCognitoUser: dossier.findCognitoUser,
  getCognitoAttr: dossier.getCognitoAttr,
  formatCognitoDate: dossier.formatCognitoDate,
  getRecentRequestsForUser: dossier.getRecentRequestsForUser,
  mapRecentRequest: dossier.mapRecentRequest,
  readAdminUserDossier: dossier.readAdminUserDossier,

  // Functions from search
  searchAdminUsers,

  // Functions from plans
  handleAdminUserPlanOverride: plans.handleAdminUserPlanOverride,
  handleAdminUserQuotaAdjust: plans.handleAdminUserQuotaAdjust,
  syncUserUsagePlans: plans.syncUserUsagePlans,
  getBilling: plans.getBilling,
  getQuotaRecord: plans.getQuotaRecord,
  monthlyQuotaForBilling: plans.monthlyQuotaForBilling,
  planNameForTier: plans.planNameForTier,

  // Functions from actions
  handleAdminUserStatus: actions.handleAdminUserStatus,
  handleAdminKeyRevoke: actions.handleAdminKeyRevoke,

  // Common objects & helpers
  cognito: common.cognito,
  apigw: common.apigw,
  PLAN_QUOTAS: common.PLAN_QUOTAS,
  FREE_MONTHLY_QUOTA: common.FREE_MONTHLY_QUOTA,
  positiveInteger: common.positiveInteger,
  dateKey: common.dateKey,
  stringValue: common.stringValue,
  numberValue: common.numberValue,
  getAdminEmail: common.getAdminEmail,
  parseJsonBody: common.parseJsonBody,
  setDdbClient: common.setDdbClient,
  setCognitoClient: common.setCognitoClient,
  setApigwClient: common.setApigwClient,
  getDdbClient: common.getDdbClient,
  getCognitoClient: common.getCognitoClient,
  getApigwClient: common.getApigwClient,
  response: common.response,
};
