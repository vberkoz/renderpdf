'use strict';

require('./test-aws-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const analytics = require('./index');

test('saveBillingWebhook ignores downgrade/cancel when manualOverride is true (Task 3.1)', async () => {
  const origDdbSend = analytics.ddb.send;
  const updates = [];

  analytics.ddb.send = async (cmd) => {
    if (cmd.constructor.name === 'GetItemCommand') {
      const key = cmd.input.Key.requestId.S;
      if (key === 'BILLING#user_vip') {
        return {
          Item: {
            tier: { S: 'pro' },
            status: { S: 'active' },
            manualOverride: { BOOL: true },
          },
        };
      }
    }
    if (cmd.constructor.name === 'UpdateItemCommand') {
      updates.push(cmd);
      return {};
    }
    return {};
  };

  try {
    // 1. Canceled webhook should be ignored for VIP account
    await analytics.saveBillingWebhook(
      'user_vip',
      'sub_vip',
      { status: 'canceled' },
      'evt_cancel_1',
      new Date(),
      'subscription.canceled'
    );
    assert.strictEqual(
      updates.length,
      0,
      'No UpdateItemCommand sent when manualOverride is active'
    );

    // 2. Past due webhook should also be ignored
    await analytics.saveBillingWebhook(
      'user_vip',
      'sub_vip',
      { status: 'past_due' },
      'evt_pastdue_1',
      new Date(),
      'subscription.past_due'
    );
    assert.strictEqual(updates.length, 0, 'No UpdateItemCommand sent on past_due for VIP account');

    // 3. Paused webhook should also be ignored
    await analytics.saveBillingWebhook(
      'user_vip',
      'sub_vip',
      { status: 'paused' },
      'evt_paused_1',
      new Date(),
      'subscription.paused'
    );
    assert.strictEqual(updates.length, 0, 'No UpdateItemCommand sent on paused for VIP account');

    // 4. Status = 'canceled' in attributes should be ignored even if eventType is generic
    await analytics.saveBillingWebhook(
      'user_vip',
      'sub_vip',
      { status: 'canceled' },
      'evt_cancel_generic',
      new Date(),
      'subscription.updated'
    );
    assert.strictEqual(
      updates.length,
      0,
      'No UpdateItemCommand sent when attributes.status is canceled'
    );

    // 5. Legitimate paid upgrade clears manualOverride and adopts new paid tier
    await analytics.saveBillingWebhook(
      'user_vip',
      'sub_vip_paid',
      {
        status: 'active',
        customer_id: 'ctm_paid_1',
        items: [{ price: { id: 'pri_pro_monthly' } }],
        custom_data: { tier: 'pro' },
      },
      'evt_paid_upgrade',
      new Date(),
      'subscription.updated'
    );
    const billingUpdate = updates.find(
      (cmd) => cmd.input?.Key?.requestId?.S === 'BILLING#user_vip'
    );
    assert.ok(billingUpdate, 'BILLING# update was sent for paid upgrade');
    assert.strictEqual(
      billingUpdate.input.ExpressionAttributeValues[':manualOverride'].BOOL,
      false
    );
  } finally {
    analytics.ddb.send = origDdbSend;
  }
});

test('saveBillingWebhook permits downgrade for standard user without manualOverride', async () => {
  const origDdbSend = analytics.ddb.send;
  const updates = [];

  analytics.ddb.send = async (cmd) => {
    if (cmd.constructor.name === 'GetItemCommand') {
      const key = cmd.input.Key.requestId.S;
      if (key === 'BILLING#user_standard') {
        return {
          Item: {
            tier: { S: 'pro' },
            status: { S: 'active' },
            manualOverride: { BOOL: false },
          },
        };
      }
    }
    if (cmd.constructor.name === 'UpdateItemCommand') {
      updates.push(cmd);
      return {};
    }
    return {};
  };

  try {
    await analytics.saveBillingWebhook(
      'user_standard',
      'sub_std',
      { status: 'canceled' },
      'evt_cancel_2',
      new Date(),
      'subscription.canceled'
    );
    assert.ok(
      updates.length > 0,
      'UpdateItemCommand was sent to record cancellation for standard user'
    );
  } finally {
    analytics.ddb.send = origDdbSend;
  }
});

test('handleAdminUserPlanOverride enforces auth, validates input, updates quota and audit trail (Task 3.2)', async () => {
  const origDdbSend = analytics.ddb.send;
  const origApigwSend = analytics.apigw.send;
  const origApiKeysTable = process.env.API_KEYS_TABLE;
  const origProUsagePlanId = process.env.PRO_USAGE_PLAN_ID;
  process.env.API_KEYS_TABLE = 'ApiKeysTable';
  process.env.PRO_USAGE_PLAN_ID = 'pro-plan-id';

  const ddbCommands = [];
  const apigwCommands = [];

  analytics.ddb.send = async (cmd) => {
    ddbCommands.push(cmd);
    if (cmd.constructor.name === 'GetItemCommand') {
      return {
        Item: {
          tier: { S: 'free' },
          status: { S: 'active' },
        },
      };
    }
    if (cmd.constructor.name === 'QueryCommand') {
      // Mock active API key for syncUserUsagePlans
      return {
        Items: [
          {
            PK: { S: 'USER#target_user_1' },
            SK: { S: 'APIKEY#key_1' },
            isActive: { BOOL: true },
            apiGatewayKeyId: { S: 'ag_key_123' },
          },
        ],
      };
    }
    return {};
  };

  analytics.apigw.send = async (cmd) => {
    apigwCommands.push(cmd);
    return {};
  };

  try {
    // 1. Non-admin receives 403
    const forbiddenRes = await analytics.handleAdminUserPlanOverride(
      { requestContext: { authorizer: { claims: { 'cognito:groups': ['Users'] } } } },
      'target_user_1'
    );
    assert.strictEqual(forbiddenRes.statusCode, 403);

    // 2. Missing reason returns 400
    const missingReasonRes = await analytics.handleAdminUserPlanOverride(
      {
        requestContext: {
          authorizer: { claims: { 'cognito:groups': ['Admins'], email: 'operator@renderpdf.com' } },
        },
        body: JSON.stringify({ tier: 'pro', reason: '' }),
      },
      'target_user_1'
    );
    assert.strictEqual(missingReasonRes.statusCode, 400);

    // 3. Valid admin plan change to Pro
    const successRes = await analytics.handleAdminUserPlanOverride(
      {
        requestContext: {
          authorizer: { claims: { 'cognito:groups': ['Admins'], email: 'operator@renderpdf.com' } },
        },
        body: JSON.stringify({
          tier: 'pro',
          manualOverride: true,
          reason: 'VIP contract Q4',
          customMonthlyQuota: 25000,
        }),
      },
      'target_user_1'
    );
    assert.strictEqual(successRes.statusCode, 200);
    const body = JSON.parse(successRes.body);
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.tier, 'pro');
    assert.strictEqual(body.manualOverride, true);
    assert.strictEqual(body.quotaLimit, 25000);

    // Verify BILLING# update
    const billingUpdate = ddbCommands.find(
      (c) =>
        c.constructor.name === 'UpdateItemCommand' &&
        c.input.Key.requestId.S === 'BILLING#target_user_1'
    );
    assert.ok(billingUpdate, 'BILLING# update sent');
    assert.strictEqual(billingUpdate.input.ExpressionAttributeValues[':tier'].S, 'pro');
    assert.strictEqual(billingUpdate.input.ExpressionAttributeValues[':manualOverride'].BOOL, true);
    assert.strictEqual(
      billingUpdate.input.ExpressionAttributeValues[':admin'].S,
      'operator@renderpdf.com'
    );

    // Verify USER_QUOTA# update
    const quotaUpdate = ddbCommands.find(
      (c) =>
        c.constructor.name === 'UpdateItemCommand' &&
        c.input.Key.requestId.S.startsWith('USER_QUOTA#target_user_1')
    );
    assert.ok(quotaUpdate, 'USER_QUOTA# update sent');
    assert.strictEqual(quotaUpdate.input.ExpressionAttributeValues[':limit'].N, '25000');

    // Verify syncUserUsagePlans attached key to Pro usage plan in API Gateway
    const createKeyCmd = apigwCommands.find(
      (c) => c.constructor.name === 'CreateUsagePlanKeyCommand'
    );
    assert.ok(createKeyCmd, 'syncUserUsagePlans attached key to ProUsagePlan');
    assert.strictEqual(createKeyCmd.input.UsagePlanId, 'pro-plan-id');
    assert.strictEqual(createKeyCmd.input.KeyId, 'ag_key_123');

    // Verify ADMIN_AUDIT# put
    const auditPut = ddbCommands.find(
      (c) =>
        c.constructor.name === 'PutItemCommand' &&
        c.input.Item.requestId.S.startsWith('ADMIN_AUDIT#')
    );
    assert.ok(auditPut, 'ADMIN_AUDIT record written');
    assert.strictEqual(auditPut.input.Item.action.S, 'PLAN_OVERRIDE');
    assert.strictEqual(auditPut.input.Item.adminEmail.S, 'operator@renderpdf.com');
    assert.strictEqual(auditPut.input.Item.targetUserId.S, 'target_user_1');
    assert.strictEqual(auditPut.input.Item.reason.S, 'VIP contract Q4');
  } finally {
    analytics.ddb.send = origDdbSend;
    analytics.apigw.send = origApigwSend;
    process.env.API_KEYS_TABLE = origApiKeysTable;
    process.env.PRO_USAGE_PLAN_ID = origProUsagePlanId;
  }
});

test('handleAdminUserQuotaAdjust applies add_credits, set_limit, reset_usage and records audit', async () => {
  const origDdbSend = analytics.ddb.send;
  const ddbCommands = [];

  analytics.ddb.send = async (cmd) => {
    ddbCommands.push(cmd);
    if (cmd.constructor.name === 'GetItemCommand') {
      const key = cmd.input.Key.requestId.S;
      if (key.startsWith('USER_QUOTA#')) {
        return { Item: { used: { N: '200' }, limit: { N: '5000' } } };
      }
    }
    return {};
  };

  try {
    // 1. Non-admin receives 403
    const forbiddenRes = await analytics.handleAdminUserQuotaAdjust(
      { requestContext: { authorizer: { claims: { 'cognito:groups': ['Users'] } } } },
      'target_user_2'
    );
    assert.strictEqual(forbiddenRes.statusCode, 403);

    // 2. add_credits increases limit
    const addRes = await analytics.handleAdminUserQuotaAdjust(
      {
        requestContext: {
          authorizer: { claims: { 'cognito:groups': ['Admins'], email: 'admin@renderpdf.com' } },
        },
        body: JSON.stringify({
          action: 'add_credits',
          amount: 1000,
          reason: 'Goodwill grant for webhook retry issue',
        }),
      },
      'target_user_2'
    );
    assert.strictEqual(addRes.statusCode, 200);
    const addBody = JSON.parse(addRes.body);
    assert.strictEqual(addBody.success, true);
    assert.strictEqual(addBody.limit, 6000);
    assert.strictEqual(addBody.used, 200);
    assert.strictEqual(addBody.remaining, 5800);

    // 3. set_limit sets exact limit
    const setRes = await analytics.handleAdminUserQuotaAdjust(
      {
        requestContext: {
          authorizer: { claims: { 'cognito:groups': ['Admins'], email: 'admin@renderpdf.com' } },
        },
        body: JSON.stringify({
          action: 'set_limit',
          amount: 15000,
          reason: 'Custom trial limit',
        }),
      },
      'target_user_2'
    );
    assert.strictEqual(setRes.statusCode, 200);
    const setBody = JSON.parse(setRes.body);
    assert.strictEqual(setBody.limit, 15000);

    // 4. reset_usage clears used count
    const resetRes = await analytics.handleAdminUserQuotaAdjust(
      {
        requestContext: {
          authorizer: { claims: { 'cognito:groups': ['Admins'], email: 'admin@renderpdf.com' } },
        },
        body: JSON.stringify({
          action: 'reset_usage',
          reason: 'Operator testing usage reset',
        }),
      },
      'target_user_2'
    );
    assert.strictEqual(resetRes.statusCode, 200);
    const resetBody = JSON.parse(resetRes.body);
    assert.strictEqual(resetBody.used, 0);

    // Verify audit logs were written for all actions
    const auditLogs = ddbCommands.filter(
      (c) =>
        c.constructor.name === 'PutItemCommand' &&
        c.input.Item.requestId.S.startsWith('ADMIN_AUDIT#')
    );
    assert.strictEqual(auditLogs.length, 3, 'Audit log written for each quota adjustment');
  } finally {
    analytics.ddb.send = origDdbSend;
  }
});

test('handler correctly routes POST /api/v1/admin/users/{userId}/plan and quota directly and via route override', async () => {
  const origDdbSend = analytics.ddb.send;
  analytics.ddb.send = async (cmd) => {
    if (cmd.constructor.name === 'GetItemCommand') {
      return { Item: { tier: { S: 'free' }, limit: { N: '25' }, used: { N: '0' } } };
    }
    return {};
  };

  try {
    // 1. Direct POST /admin/users/{userId}/plan
    const planRes = await analytics.handler({
      resource: '/api/v1/admin/users/{userId}/plan',
      path: '/api/v1/admin/users/user_abc/plan',
      pathParameters: { userId: 'user_abc' },
      httpMethod: 'POST',
      requestContext: {
        authorizer: { claims: { 'cognito:groups': ['Admins'], email: 'admin@renderpdf.com' } },
      },
      body: JSON.stringify({ tier: 'starter', reason: 'Upgraded by support' }),
    });
    assert.strictEqual(planRes.statusCode, 200);

    // 2. Query override route=admin/users/user_abc/quota
    const quotaRes = await analytics.handler({
      resource: '/api/v1/analytics',
      path: '/api/v1/analytics',
      queryStringParameters: { route: 'admin/users/user_abc/quota' },
      httpMethod: 'POST',
      requestContext: {
        authorizer: { claims: { 'cognito:groups': ['Admins'], email: 'admin@renderpdf.com' } },
      },
      body: JSON.stringify({ action: 'add_credits', amount: 500, reason: 'Support bonus' }),
    });
    assert.strictEqual(quotaRes.statusCode, 200);

    // 3. OPTIONS for plan and quota sub-resources return 204
    const optPlan = await analytics.handler({
      resource: '/api/v1/admin/users/{userId}/plan',
      httpMethod: 'OPTIONS',
    });
    assert.strictEqual(optPlan.statusCode, 204);

    const optQuota = await analytics.handler({
      resource: '/api/v1/admin/users/{userId}/quota',
      httpMethod: 'OPTIONS',
    });
    assert.strictEqual(optQuota.statusCode, 204);
  } finally {
    analytics.ddb.send = origDdbSend;
  }
});

test('handleAdminUserStatus - disabling user calls AdminDisableUserCommand and deactivates keys (Task 4.2)', async () => {
  const origDdbSend = analytics.ddb.send;
  const origCognitoSend = analytics.cognito.send;
  const ddbCommands = [];
  const cognitoCommands = [];

  analytics.ddb.send = async (cmd) => {
    ddbCommands.push(cmd);
    if (cmd.constructor.name === 'QueryCommand') {
      return { Items: [{ PK: { S: 'USER#u1' }, SK: { S: 'APIKEY#k1' } }] };
    }
    return {};
  };
  analytics.cognito.send = async (cmd) => {
    cognitoCommands.push(cmd);
    return {};
  };

  const prevTable = process.env.API_KEYS_TABLE;
  const prevPool = process.env.USER_POOL_ID;
  try {
    process.env.API_KEYS_TABLE = 'keys-table';
    process.env.USER_POOL_ID = 'us-east-1_pool';

    const adminRequest = {
      httpMethod: 'POST',
      path: '/api/v1/admin/users/u1/status',
      requestContext: {
        authorizer: { claims: { email: 'admin@test.com', 'cognito:groups': 'Admins' } },
      },
      body: JSON.stringify({ action: 'disable', reason: 'Fraudulent activity' }),
    };

    const res = await analytics.handleAdminUserStatus(adminRequest, 'u1');
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.action, 'disable');

    // Cognito AdminDisableUserCommand was called
    assert.strictEqual(cognitoCommands.length, 1);
    assert.strictEqual(cognitoCommands[0].constructor.name, 'AdminDisableUserCommand');
    assert.strictEqual(cognitoCommands[0].input.Username, 'u1');
    assert.strictEqual(cognitoCommands[0].input.UserPoolId, 'us-east-1_pool');

    // API key deactivated via UpdateItemCommand
    const updateCmd = ddbCommands.find((c) => c.constructor.name === 'UpdateItemCommand');
    assert.ok(updateCmd, 'UpdateItemCommand should be sent to deactivate key');
    assert.strictEqual(updateCmd.input.Key.SK.S, 'APIKEY#k1');

    // Audit written via PutItemCommand
    const auditCmd = ddbCommands.find((c) => c.constructor.name === 'PutItemCommand');
    assert.ok(auditCmd, 'PutItemCommand should be sent for audit record');
    assert.strictEqual(auditCmd.input.Item.action.S, 'USER_SUSPEND');
  } finally {
    analytics.ddb.send = origDdbSend;
    analytics.cognito.send = origCognitoSend;
    if (prevTable === undefined) delete process.env.API_KEYS_TABLE;
    else process.env.API_KEYS_TABLE = prevTable;
    if (prevPool === undefined) delete process.env.USER_POOL_ID;
    else process.env.USER_POOL_ID = prevPool;
  }
});

test('handleAdminKeyRevoke - marks key inactive in DynamoDB and records audit (Task 4.2)', async () => {
  const origDdbSend = analytics.ddb.send;
  const origApigwSend = analytics.apigw.send;
  const ddbCommands = [];
  const apigwCommands = [];

  analytics.ddb.send = async (cmd) => {
    ddbCommands.push(cmd);
    if (cmd.constructor.name === 'QueryCommand') {
      return {
        Items: [
          { PK: { S: 'USER#u1' }, SK: { S: 'APIKEY#k1' }, apiGatewayKeyId: { S: 'gw-key-id' } },
        ],
      };
    }
    return {};
  };
  analytics.apigw.send = async (cmd) => {
    apigwCommands.push(cmd);
    return {};
  };

  const prevTable = process.env.API_KEYS_TABLE;
  const prevPro = process.env.PRO_USAGE_PLAN_ID;
  try {
    process.env.API_KEYS_TABLE = 'keys-table';
    process.env.PRO_USAGE_PLAN_ID = 'pro-plan';

    const adminRequest = {
      httpMethod: 'POST',
      path: '/api/v1/admin/users/u1/keys/k1/revoke',
      requestContext: {
        authorizer: { claims: { email: 'admin@test.com', 'cognito:groups': 'Admins' } },
      },
      body: JSON.stringify({ reason: 'API key compromised' }),
    };

    const res = await analytics.handleAdminKeyRevoke(adminRequest, 'u1', 'k1');
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.keyId, 'k1');

    // UpdateItemCommand marks key inactive
    const updateCmd = ddbCommands.find((c) => c.constructor.name === 'UpdateItemCommand');
    assert.ok(updateCmd, 'UpdateItemCommand should mark key isActive = false');
    assert.strictEqual(updateCmd.input.Key.SK.S, 'APIKEY#k1');
    assert.deepStrictEqual(updateCmd.input.ExpressionAttributeValues[':false'], { BOOL: false });

    // DeleteUsagePlanKeyCommand removes key from API Gateway
    assert.ok(apigwCommands.length > 0, 'DeleteUsagePlanKeyCommand should be called');
    assert.strictEqual(apigwCommands[0].constructor.name, 'DeleteUsagePlanKeyCommand');
    assert.strictEqual(apigwCommands[0].input.KeyId, 'gw-key-id');

    // Audit written
    const auditCmd = ddbCommands.find((c) => c.constructor.name === 'PutItemCommand');
    assert.ok(auditCmd, 'PutItemCommand should record audit');
    assert.strictEqual(auditCmd.input.Item.action.S, 'KEY_REVOKE');
    assert.strictEqual(auditCmd.input.Item.reason.S, 'API key compromised');
  } finally {
    analytics.ddb.send = origDdbSend;
    analytics.apigw.send = origApigwSend;
    if (prevTable === undefined) delete process.env.API_KEYS_TABLE;
    else process.env.API_KEYS_TABLE = prevTable;
    if (prevPro === undefined) delete process.env.PRO_USAGE_PLAN_ID;
    else process.env.PRO_USAGE_PLAN_ID = prevPro;
  }
});
