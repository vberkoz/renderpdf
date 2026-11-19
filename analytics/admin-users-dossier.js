'use strict';

const {
  ListUsersCommand,
  AdminGetUserCommand,
  QueryCommand,
  getCognitoClient,
  getDdbClient,
  dateKey,
  stringValue,
  response,
  isAuthorizedAdmin,
  unwrap,
  queryDay,
} = require('./admin-users-common');

const {
  getBilling,
  getQuotaRecord,
  monthlyQuotaForBilling,
  planNameForTier,
} = require('./admin-users-plans');

function getCognitoAttr(user, attrName) {
  if (!user) return '';
  const attrs = user.Attributes || user.UserAttributes || [];
  if (Array.isArray(attrs)) {
    const found = attrs.find((a) => a.Name === attrName || a.name === attrName);
    if (found) return found.Value != null ? found.Value : found.value != null ? found.value : '';
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
      const listRes = await getCognitoClient().send(
        new ListUsersCommand({
          UserPoolId: userPoolId,
          Filter: `sub = "${identifier}"`,
          Limit: 1,
        })
      );
      if (listRes?.Users && listRes.Users.length > 0) {
        return listRes.Users[0];
      }
    } catch (err) {
      console.warn(`Cognito ListUsers by sub failed for ${identifier}:`, err);
    }
  }

  // 2. Try AdminGetUser (matches Username exactly)
  try {
    const userRes = await getCognitoClient().send(
      new AdminGetUserCommand({
        UserPoolId: userPoolId,
        Username: identifier,
      })
    );
    if (userRes) return userRes;
  } catch (err) {
    if (err.name !== 'UserNotFoundException') {
      console.warn(`Cognito AdminGetUser failed for ${identifier}:`, err);
    }
  }

  // 3. Try ListUsers by email
  if (identifier.includes('@')) {
    try {
      const listRes = await getCognitoClient().send(
        new ListUsersCommand({
          UserPoolId: userPoolId,
          Filter: `email = "${identifier}"`,
          Limit: 1,
        })
      );
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
      const listRes = await getCognitoClient().send(
        new ListUsersCommand({
          UserPoolId: userPoolId,
          Filter: `sub = "${identifier}"`,
          Limit: 1,
        })
      );
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
  const tableName = process.env.TABLE_NAME || 'RenderPdfTable';

  // 1. Try querying CustomerIdDateIndex
  try {
    const res = await getDdbClient().send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'CustomerIdDateIndex',
        KeyConditionExpression: 'customerId = :cid',
        ExpressionAttributeValues: { ':cid': { S: userId } },
        ScanIndexForward: false,
        Limit: 25,
      })
    );
    if (res?.Items && res.Items.length > 0) {
      return res.Items.map(mapRecentRequest);
    }
  } catch (_) {
    // If index query fails or does not exist, continue to fallback
  }

  // 2. Try customer partition CUSTOMER#<userId>
  try {
    const res = await getDdbClient().send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'requestId = :pk',
        ExpressionAttributeValues: { ':pk': { S: `CUSTOMER#${userId}` } },
        ScanIndexForward: false,
        Limit: 25,
      })
    );
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
        if (
          stringValue(item, 'entityType') === 'PDF_REQUEST' &&
          stringValue(item, 'customerId') === userId
        ) {
          logs.push(mapRecentRequest(item));
        }
      }
    } catch (_) {}
  }
  logs.sort((a, b) => b.timestamp - a.timestamp);
  return logs.slice(0, 25);
}

async function readAdminUserDossier(request, explicitUserId = null) {
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
  ).match(/\/(?:admin\/)?users\/([^/?#]+)$/);
  const userId = userIdParam && userIdParam !== '{userId}' ? userIdParam : match ? match[1] : null;

  if (!userId || userId === 'users') {
    return response(400, { error: 'userId is required' });
  }

  const userPoolId = process.env.USER_POOL_ID || 'renderpdf-users-v2';

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
  const manualOverride = Boolean(
    billingRecord?.manualOverride === true || billingRecord?.manualOverride === 'true'
  );
  const provider =
    billingRecord?.provider ||
    (billingRecord?.subscriptionId
      ? 'paddle'
      : manualOverride
        ? 'manual'
        : tier === 'free'
          ? 'none'
          : 'paddle');
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
  const apiKeysTable = process.env.API_KEYS_TABLE || '';
  let apiKeys = [];
  if (apiKeysTable) {
    try {
      const keysRes = await getDdbClient().send(
        new QueryCommand({
          TableName: apiKeysTable,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: {
            ':pk': { S: `USER#${canonicalUserId}` },
            ':sk': { S: 'APIKEY#' },
          },
        })
      );
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

module.exports = {
  getCognitoAttr,
  formatCognitoDate,
  findCognitoUser,
  mapRecentRequest,
  getRecentRequestsForUser,
  readAdminUserDossier,
};
