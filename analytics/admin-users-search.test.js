'use strict';

require('./test-aws-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const analytics = require('./index');

test('admin users endpoints return 403 Forbidden for non-admin callers', async () => {
  const nonAdminEvent = {
    resource: '/api/v1/admin/users',
    path: '/api/v1/admin/users',
    httpMethod: 'GET',
    requestContext: {
      authorizer: { claims: { email: 'regular@user.com' } },
    },
  };
  const dossierEvent = {
    resource: '/api/v1/admin/users/{userId}',
    path: '/api/v1/admin/users/c1f7b76e-3c2e-4b21-8273-df3e18a992bc',
    pathParameters: { userId: 'c1f7b76e-3c2e-4b21-8273-df3e18a992bc' },
    httpMethod: 'GET',
    requestContext: {
      authorizer: { claims: { email: 'regular@user.com' } },
    },
  };

  const res1 = await analytics.handler(nonAdminEvent);
  assert.strictEqual(res1.statusCode, 403);

  const res2 = await analytics.handler(dossierEvent);
  assert.strictEqual(res2.statusCode, 403);

  const res3 = await analytics.searchAdminUsers({ requestContext: {} });
  assert.strictEqual(res3.statusCode, 403);

  const res4 = await analytics.readAdminUserDossier({ requestContext: {} }, 'u1');
  assert.strictEqual(res4.statusCode, 403);
});

test('searchAdminUsers by email prefix matches users and joins billing, quota, and active keys', async () => {
  const origCognitoSend = analytics.cognito.send;
  const origDdbSend = analytics.ddb.send;
  const cognitoCommands = [];
  const ddbCommands = [];

  const userId = 'c1f7b76e-3c2e-4b21-8273-df3e18a992bc';
  const email = 'customer@acme.com';

  analytics.cognito.send = async (cmd) => {
    cognitoCommands.push(cmd);
    if (cmd.constructor.name === 'ListUsersCommand') {
      assert.strictEqual(cmd.input.Filter, 'email ^= "customer@acme.com"');
      return {
        Users: [
          {
            Username: userId,
            Attributes: [
              { Name: 'sub', Value: userId },
              { Name: 'email', Value: email },
            ],
            UserCreateDate: new Date('2026-04-12T14:22:00Z'),
          },
        ],
        PaginationToken: 'next-page-tok-123',
      };
    }
    return {};
  };

  analytics.ddb.send = async (cmd) => {
    ddbCommands.push(cmd);
    if (cmd.constructor.name === 'BatchGetItemCommand') {
      const tableName = Object.keys(cmd.input.RequestItems)[0];
      return {
        Responses: {
          [tableName]: [
            {
              requestId: { S: `BILLING#${userId}` },
              tier: { S: 'starter' },
              status: { S: 'active' },
              provider: { S: 'paddle' },
              manualOverride: { BOOL: false },
            },
            {
              requestId: { S: `USER_QUOTA#${userId}#2026-09` },
              used: { N: '412' },
              limit: { N: '5000' },
            },
          ],
        },
      };
    }
    if (cmd.constructor.name === 'QueryCommand') {
      // API_KEYS_TABLE query
      return {
        Items: [
          { keyId: { S: 'key_1' }, isActive: { BOOL: true } },
          { keyId: { S: 'key_2' }, isActive: { BOOL: true } },
          { keyId: { S: 'key_3' }, isActive: { BOOL: false } },
        ],
      };
    }
    return {};
  };

  try {
    const event = {
      resource: '/api/v1/admin/users',
      path: '/api/v1/admin/users',
      httpMethod: 'GET',
      queryStringParameters: { q: 'customer@acme.com', tier: 'all', status: 'all' },
      requestContext: {
        authorizer: { claims: { 'cognito:groups': ['Admins'] } },
      },
    };

    const res = await analytics.handler(event);
    assert.strictEqual(res.statusCode, 200);

    const body = JSON.parse(res.body);
    assert.strictEqual(body.nextCursor, 'next-page-tok-123');
    assert.strictEqual(body.users.length, 1);

    const u = body.users[0];
    assert.strictEqual(u.id, userId);
    assert.strictEqual(u.email, email);
    assert.strictEqual(u.tier, 'starter');
    assert.strictEqual(u.status, 'active');
    assert.strictEqual(u.provider, 'paddle');
    assert.strictEqual(u.manualOverride, false);
    assert.strictEqual(u.quotaUsed, 412);
    assert.strictEqual(u.quotaLimit, 5000);
    assert.strictEqual(u.activeKeys, 2);
    assert.strictEqual(u.createdAt, '2026-04-12T14:22:00.000Z');
  } finally {
    analytics.cognito.send = origCognitoSend;
    analytics.ddb.send = origDdbSend;
  }
});

test('searchAdminUsers by UUID queries Cognito AdminGetUser directly', async () => {
  const origCognitoSend = analytics.cognito.send;
  const origDdbSend = analytics.ddb.send;
  const uuid = 'c1f7b76e-3c2e-4b21-8273-df3e18a992bc';

  let adminGetUserCalled = false;

  analytics.cognito.send = async (cmd) => {
    if (cmd.constructor.name === 'AdminGetUserCommand') {
      adminGetUserCalled = true;
      assert.strictEqual(cmd.input.Username, uuid);
      return {
        Username: uuid,
        UserAttributes: [
          { Name: 'sub', Value: uuid },
          { Name: 'email', Value: 'direct_uuid@example.com' },
        ],
        UserCreateDate: new Date('2026-01-15T00:00:00Z'),
      };
    }
    return {};
  };

  analytics.ddb.send = async (cmd) => {
    if (cmd.constructor.name === 'BatchGetItemCommand') {
      const tableName = Object.keys(cmd.input.RequestItems)[0];
      return { Responses: { [tableName]: [] } };
    }
    if (cmd.constructor.name === 'QueryCommand') {
      return { Items: [] };
    }
    return {};
  };

  try {
    const res = await analytics.searchAdminUsers({
      queryStringParameters: { q: uuid },
      requestContext: {
        authorizer: { claims: { email: 'vberkoz@gmail.com' } },
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(adminGetUserCalled, true);

    const body = JSON.parse(res.body);
    assert.strictEqual(body.users.length, 1);
    assert.strictEqual(body.users[0].id, uuid);
    assert.strictEqual(body.users[0].email, 'direct_uuid@example.com');
    assert.strictEqual(body.users[0].tier, 'free');
    assert.strictEqual(body.users[0].quotaLimit, 25);
    assert.strictEqual(body.nextCursor, null);
  } finally {
    analytics.cognito.send = origCognitoSend;
    analytics.ddb.send = origDdbSend;
  }
});

test('readAdminUserDossier joins all 5 data sources combined', async () => {
  const origCognitoSend = analytics.cognito.send;
  const origDdbSend = analytics.ddb.send;
  const userId = 'c1f7b76e-3c2e-4b21-8273-df3e18a992bc';

  analytics.cognito.send = async (cmd) => {
    if (cmd.constructor.name === 'AdminGetUserCommand') {
      assert.strictEqual(cmd.input.Username, userId);
      return {
        Username: userId,
        UserAttributes: [
          { Name: 'sub', Value: userId },
          { Name: 'email', Value: 'customer@acme.com' },
          { Name: 'email_verified', Value: 'true' },
        ],
        Enabled: true,
        UserCreateDate: new Date('2026-04-12T14:22:00Z'),
      };
    }
    return {};
  };

  analytics.ddb.send = async (cmd) => {
    if (cmd.constructor.name === 'GetItemCommand') {
      const key = cmd.input.Key.requestId.S;
      if (key === `BILLING#${userId}`) {
        return {
          Item: {
            tier: { S: 'starter' },
            status: { S: 'active' },
            plan: { S: 'RenderPDF Starter' },
            provider: { S: 'paddle' },
            manualOverride: { BOOL: false },
            subscriptionId: { S: 'sub_01h6t8z' },
            renewsAt: { S: '2026-10-12T14:22:00Z' },
          },
        };
      }
      if (key.startsWith(`USER_QUOTA#${userId}`)) {
        return {
          Item: {
            used: { N: '412' },
            limit: { N: '5000' },
          },
        };
      }
    }
    if (cmd.constructor.name === 'QueryCommand') {
      // Check if querying API keys or Recent Requests
      if (
        cmd.input.TableName === process.env.API_KEYS_TABLE ||
        cmd.input.KeyConditionExpression?.includes('APIKEY#')
      ) {
        return {
          Items: [
            {
              keyId: { S: 'key_9f82d1c' },
              name: { S: 'Production Backend' },
              isActive: { BOOL: true },
              createdAt: { N: '1712931720' },
              lastUsed: { N: '1727289120' },
            },
          ],
        };
      }
      // USAGE requests (via CustomerIdDateIndex or customer partition)
      return {
        Items: [
          {
            requestId: { S: 'req_8471b0' },
            timestamp: { N: '1727289120' },
            status: { S: 'success' },
            errorType: { S: '' },
            durationMs: { N: '482' },
            size: { N: '184920' },
          },
        ],
      };
    }
    return {};
  };

  try {
    const event = {
      resource: '/api/v1/admin/users/{userId}',
      path: `/api/v1/admin/users/${userId}`,
      pathParameters: { userId },
      httpMethod: 'GET',
      requestContext: {
        authorizer: { claims: { 'cognito:groups': ['Admins'] } },
      },
    };

    const res = await analytics.handler(event);
    assert.strictEqual(res.statusCode, 200);

    const body = JSON.parse(res.body);

    // 1. User
    assert.deepStrictEqual(body.user, {
      id: userId,
      email: 'customer@acme.com',
      emailVerified: true,
      enabled: true,
      createdAt: '2026-04-12T14:22:00.000Z',
    });

    // 2. Billing
    assert.deepStrictEqual(body.billing, {
      tier: 'starter',
      status: 'active',
      plan: 'RenderPDF Starter',
      provider: 'paddle',
      manualOverride: false,
      subscriptionId: 'sub_01h6t8z',
      renewsAt: '2026-10-12T14:22:00Z',
    });

    // 3. Quota
    assert.strictEqual(body.quota.used, 412);
    assert.strictEqual(body.quota.limit, 5000);
    assert.strictEqual(body.quota.remaining, 4588);

    // 4. API Keys
    assert.strictEqual(body.apiKeys.length, 1);
    assert.deepStrictEqual(body.apiKeys[0], {
      keyId: 'key_9f82d1c',
      name: 'Production Backend',
      isActive: true,
      createdAt: 1712931720,
      lastUsed: 1727289120,
    });

    // 5. Recent Requests
    assert.strictEqual(body.recentRequests.length, 1);
    assert.deepStrictEqual(body.recentRequests[0], {
      requestId: 'req_8471b0',
      timestamp: 1727289120,
      status: 'success',
      errorType: '',
      durationMs: 482,
      size: 184920,
    });
  } finally {
    analytics.cognito.send = origCognitoSend;
    analytics.ddb.send = origDdbSend;
  }
});

test('searchAdminUsers filters by tier and status in-memory', async () => {
  const origCognitoSend = analytics.cognito.send;
  const origDdbSend = analytics.ddb.send;

  analytics.cognito.send = async () => {
    return {
      Users: [
        {
          Username: 'user-starter',
          Attributes: [
            { Name: 'sub', Value: 'user-starter' },
            { Name: 'email', Value: 'starter@example.com' },
          ],
        },
        {
          Username: 'user-pro',
          Attributes: [
            { Name: 'sub', Value: 'user-pro' },
            { Name: 'email', Value: 'pro@example.com' },
          ],
        },
      ],
    };
  };

  analytics.ddb.send = async (cmd) => {
    if (cmd.constructor.name === 'BatchGetItemCommand') {
      const tableName = Object.keys(cmd.input.RequestItems)[0];
      return {
        Responses: {
          [tableName]: [
            {
              requestId: { S: 'BILLING#user-starter' },
              tier: { S: 'starter' },
              status: { S: 'active' },
            },
            { requestId: { S: 'BILLING#user-pro' }, tier: { S: 'pro' }, status: { S: 'past_due' } },
          ],
        },
      };
    }
    return { Items: [] };
  };

  try {
    const resStarter = await analytics.searchAdminUsers({
      queryStringParameters: { tier: 'starter' },
      requestContext: { authorizer: { claims: { 'cognito:groups': ['Admins'] } } },
    });
    const bodyStarter = JSON.parse(resStarter.body);
    assert.strictEqual(bodyStarter.users.length, 1);
    assert.strictEqual(bodyStarter.users[0].id, 'user-starter');

    const resPastDue = await analytics.searchAdminUsers({
      queryStringParameters: { status: 'past_due' },
      requestContext: { authorizer: { claims: { 'cognito:groups': ['Admins'] } } },
    });
    const bodyPastDue = JSON.parse(resPastDue.body);
    assert.strictEqual(bodyPastDue.users.length, 1);
    assert.strictEqual(bodyPastDue.users[0].id, 'user-pro');
  } finally {
    analytics.cognito.send = origCognitoSend;
    analytics.ddb.send = origDdbSend;
  }
});

test('readAdminUserDossier returns 404 when user not found in Cognito', async () => {
  const origCognitoSend = analytics.cognito.send;

  analytics.cognito.send = async () => {
    const err = new Error('User does not exist');
    err.name = 'UserNotFoundException';
    throw err;
  };

  try {
    const res = await analytics.readAdminUserDossier(
      { requestContext: { authorizer: { claims: { 'cognito:groups': ['Admins'] } } } },
      'non-existent-user'
    );
    assert.strictEqual(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'User not found');
  } finally {
    analytics.cognito.send = origCognitoSend;
  }
});

test('handler correctly handles OPTIONS and 405 for /admin/users', async () => {
  const optRes1 = await analytics.handler({
    resource: '/api/v1/admin/users',
    httpMethod: 'OPTIONS',
  });
  assert.strictEqual(optRes1.statusCode, 204);

  const optRes2 = await analytics.handler({
    resource: '/api/v1/admin/users/{userId}',
    pathParameters: { userId: '123' },
    httpMethod: 'OPTIONS',
  });
  assert.strictEqual(optRes2.statusCode, 204);

  const postRes = await analytics.handler({
    resource: '/api/v1/admin/users',
    httpMethod: 'POST',
    requestContext: { authorizer: { claims: { 'cognito:groups': ['Admins'] } } },
  });
  assert.strictEqual(postRes.statusCode, 405);
});

test('handler correctly routes admin/users via route query parameter override', async () => {
  const optRes = await analytics.handler({
    resource: '/api/v1/analytics',
    queryStringParameters: { route: 'admin/users' },
    httpMethod: 'OPTIONS',
  });
  assert.strictEqual(optRes.statusCode, 204);

  const optResUser = await analytics.handler({
    resource: '/api/v1/analytics',
    queryStringParameters: { route: 'admin/users/user-123' },
    httpMethod: 'OPTIONS',
  });
  assert.strictEqual(optResUser.statusCode, 204);
});

test('readAdminUserDossier resolves Google federated user by sub UUID', async () => {
  const origCognitoSend = analytics.cognito.send;
  const origDdbSend = analytics.ddb.send;
  const targetSub = '8408c4f8-f0a1-704d-092d-6d17fb091fa8';
  const federatedUsername = 'Google_107286376204740932967';

  analytics.cognito.send = async (cmd) => {
    if (cmd.constructor.name === 'ListUsersCommand') {
      if (cmd.input?.Filter === `sub = "${targetSub}"`) {
        return {
          Users: [
            {
              Username: federatedUsername,
              Attributes: [
                { Name: 'sub', Value: targetSub },
                { Name: 'email', Value: 'basilsergius@gmail.com' },
                { Name: 'email_verified', Value: 'false' },
              ],
              Enabled: true,
              UserCreateDate: new Date('2026-09-18T05:52:12Z'),
            },
          ],
        };
      }
    }
    const err = new Error('User not found');
    err.name = 'UserNotFoundException';
    throw err;
  };

  analytics.ddb.send = async (cmd) => {
    if (cmd.constructor.name === 'GetItemCommand') {
      const key = cmd.input.Key.requestId.S;
      if (key === `BILLING#${targetSub}`) {
        return {
          Item: {
            tier: { S: 'free' },
            status: { S: 'active' },
            plan: { S: 'Free' },
            provider: { S: 'none' },
          },
        };
      }
      if (key.startsWith(`USER_QUOTA#${targetSub}`)) {
        return { Item: { used: { N: '5' }, limit: { N: '25' } } };
      }
    }
    return {};
  };

  try {
    const res = await analytics.readAdminUserDossier(
      { requestContext: { authorizer: { claims: { 'cognito:groups': ['Admins'] } } } },
      targetSub
    );
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.user.id, targetSub);
    assert.strictEqual(body.user.email, 'basilsergius@gmail.com');
    assert.strictEqual(body.billing.tier, 'free');
    assert.strictEqual(body.quota.used, 5);
  } finally {
    analytics.cognito.send = origCognitoSend;
    analytics.ddb.send = origDdbSend;
  }
});
