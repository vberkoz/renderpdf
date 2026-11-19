'use strict';

const {
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  QueryCommand,
  UpdateItemCommand,
  DeleteUsagePlanKeyCommand,
  getCognitoClient,
  getDdbClient,
  getApigwClient,
  response,
  getAdminEmail,
  parseJsonBody,
  isAuthorizedAdmin,
} = require('./admin-users-common');

const { recordAdminAudit } = require('./admin-audit');

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
  handleAdminUserStatus,
  handleAdminKeyRevoke,
};
