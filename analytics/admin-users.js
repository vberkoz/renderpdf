'use strict';

let BatchGetItemCommand;
let DynamoDBClient;
let GetItemCommand;
let QueryCommand;
let UpdateItemCommand;
try {
  ({
    BatchGetItemCommand,
    DynamoDBClient,
    GetItemCommand,
    QueryCommand,
    UpdateItemCommand,
  } = require('@aws-sdk/client-dynamodb'));
} catch {
  BatchGetItemCommand = class BatchGetItemCommand {
    constructor(input) {
      this.input = input;
    }
  };
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

let CognitoIdentityProviderClient;
let AdminDisableUserCommand;
let AdminEnableUserCommand;
let ListUsersCommand;
let AdminGetUserCommand;
try {
  ({
    CognitoIdentityProviderClient,
    AdminDisableUserCommand,
    AdminEnableUserCommand,
    ListUsersCommand,
    AdminGetUserCommand,
  } = require('@aws-sdk/client-cognito-identity-provider'));
} catch {
  CognitoIdentityProviderClient = class MockCognitoClient {
    async send() {
      return {};
    }
  };
  AdminDisableUserCommand = class AdminDisableUserCommand {
    constructor(input) {
      this.input = input;
    }
  };
  AdminEnableUserCommand = class AdminEnableUserCommand {
    constructor(input) {
      this.input = input;
    }
  };
  ListUsersCommand = class ListUsersCommand {
    constructor(input) {
      this.input = input;
    }
  };
  AdminGetUserCommand = class AdminGetUserCommand {
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

const { ddb, isAuthorizedAdmin, unwrap, queryDay } = require('./admin-analytics');
const { recordAdminAudit } = require('./admin-audit');

const cognito = new CognitoIdentityProviderClient({});
const apigw = new APIGatewayClient({});

let customDdbClient = null;
let customCognitoClient = null;
let customApigwClient = null;

function setDdbClient(client) {
  customDdbClient = client;
}

function setCognitoClient(client) {
  customCognitoClient = client;
}

function setApigwClient(client) {
  customApigwClient = client;
}

function getDdbClient() {
  return customDdbClient || ddb;
}

function getCognitoClient() {
  return customCognitoClient || cognito;
}

function getApigwClient() {
  return customApigwClient || apigw;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function dateKey(date) {
  return (date instanceof Date ? date : new Date(date)).toISOString().slice(0, 10);
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

const FREE_MONTHLY_QUOTA = positiveInteger(process.env.FREE_MONTHLY_QUOTA, 25);
const PLAN_QUOTAS = {
  free: positiveInteger(process.env.FREE_MONTHLY_QUOTA, 25),
  starter: positiveInteger(process.env.STARTER_MONTHLY_QUOTA, 5000),
  pro: positiveInteger(process.env.PRO_MONTHLY_QUOTA, 20000),
  enterprise: positiveInteger(process.env.ENTERPRISE_MONTHLY_QUOTA, 100000),
};

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
    ? routeParam.startsWith('/')
      ? routeParam
      : `/${routeParam}`
    : request?.path || request?.resource || '';
  const match = routePath.match(/\/(?:admin\/)?users\/([^/?#]+)\/status$/);
  const userIdParam = explicitUserId || request?.pathParameters?.userId;
  const userId = userIdParam && userIdParam !== '{userId}' ? userIdParam : match ? match[1] : null;

  if (!userId || userId === 'users') {
    return response(400, { error: 'userId is required' });
  }

  const body = parseJsonBody(request);
  if (!body) return response(400, { error: 'Invalid JSON body' });

  const action = String(body.action || '')
    .toLowerCase()
    .trim();
  if (action !== 'disable' && action !== 'enable') {
    return response(400, { error: 'action must be "disable" or "enable"' });
  }

  const reason = String(body.reason || '').trim();
  if (!reason) return response(400, { error: 'Reason is required for audit trail' });

  const userPoolId = process.env.USER_POOL_ID || 'renderpdf-users-v2';
  const adminEmail = getAdminEmail(request);

  const CognitoCmd = action === 'disable' ? AdminDisableUserCommand : AdminEnableUserCommand;
  await getCognitoClient().send(new CognitoCmd({ UserPoolId: userPoolId, Username: userId }));

  if (action === 'disable') {
    const apiKeysTable = process.env.API_KEYS_TABLE || '';
    if (apiKeysTable) {
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
        for (const item of keysResult.Items || []) {
          const sk = item.SK?.S;
          if (!sk) continue;
          await getDdbClient().send(
            new UpdateItemCommand({
              TableName: apiKeysTable,
              Key: { PK: { S: `USER#${userId}` }, SK: { S: sk } },
              UpdateExpression: 'SET isActive = :false',
              ExpressionAttributeValues: { ':false': { BOOL: false } },
            })
          );
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
    ? routeParam.startsWith('/')
      ? routeParam
      : `/${routeParam}`
    : request?.path || request?.resource || '';
  const routeMatch = routePath.match(/\/(?:admin\/)?users\/([^/?#]+)\/keys\/([^/?#]+)\/revoke$/);

  const userIdParam = explicitUserId || request?.pathParameters?.userId;
  const keyIdParam = explicitKeyId || request?.pathParameters?.keyId;
  const userId =
    userIdParam && userIdParam !== '{userId}' ? userIdParam : routeMatch ? routeMatch[1] : null;
  const keyId =
    keyIdParam && keyIdParam !== '{keyId}' ? keyIdParam : routeMatch ? routeMatch[2] : null;

  if (!userId || userId === 'users') return response(400, { error: 'userId is required' });
  if (!keyId) return response(400, { error: 'keyId is required' });

  const body = parseJsonBody(request);
  if (!body) return response(400, { error: 'Invalid JSON body' });

  const reason = String(body.reason || '').trim();
  if (!reason) return response(400, { error: 'Reason is required for audit trail' });

  const apiKeysTable = process.env.API_KEYS_TABLE || '';
  const adminEmail = getAdminEmail(request);

  let apiGatewayKeyId = null;
  if (apiKeysTable) {
    const keysResult = await getDdbClient().send(
      new QueryCommand({
        TableName: apiKeysTable,
        KeyConditionExpression: 'PK = :pk AND SK = :sk',
        ExpressionAttributeValues: {
          ':pk': { S: `USER#${userId}` },
          ':sk': { S: `APIKEY#${keyId}` },
        },
      })
    );
    const keyItem = (keysResult.Items || [])[0];
    apiGatewayKeyId = keyItem?.apiGatewayKeyId?.S || null;

    await getDdbClient().send(
      new UpdateItemCommand({
        TableName: apiKeysTable,
        Key: { PK: { S: `USER#${userId}` }, SK: { S: `APIKEY#${keyId}` } },
        UpdateExpression: 'SET isActive = :false',
        ExpressionAttributeValues: { ':false': { BOOL: false } },
      })
    );
  }

  if (apiGatewayKeyId) {
    const freePlanId = process.env.FREE_USAGE_PLAN_ID || '';
    const starterPlanId = process.env.STARTER_USAGE_PLAN_ID || '';
    const proPlanId = process.env.PRO_USAGE_PLAN_ID || '';
    for (const planId of [freePlanId, starterPlanId, proPlanId].filter(Boolean)) {
      try {
        await getApigwClient().send(
          new DeleteUsagePlanKeyCommand({ UsagePlanId: planId, KeyId: apiGatewayKeyId })
        );
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

module.exports = {
  findCognitoUser,
  getCognitoAttr,
  formatCognitoDate,
  getRecentRequestsForUser,
  mapRecentRequest,
  searchAdminUsers,
  readAdminUserDossier,
  handleAdminUserPlanOverride,
  handleAdminUserQuotaAdjust,
  handleAdminUserStatus,
  handleAdminKeyRevoke,
  cognito,
  apigw,
  syncUserUsagePlans,
  getBilling,
  getQuotaRecord,
  monthlyQuotaForBilling,
  planNameForTier,
  PLAN_QUOTAS,
  FREE_MONTHLY_QUOTA,
  positiveInteger,
  dateKey,
  stringValue,
  numberValue,
  getAdminEmail,
  parseJsonBody,
  setDdbClient,
  setCognitoClient,
  setApigwClient,
  getDdbClient,
  getCognitoClient,
  getApigwClient,
  response,
};
