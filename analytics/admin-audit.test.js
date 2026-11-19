'use strict';

require('./test-aws-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const analytics = require('./index');

test('recordAdminAudit writes immutable audit trail record with 365-day TTL (Task 4.1)', async () => {
  const origDdbSend = analytics.ddb.send;
  const ddbCommands = [];
  analytics.ddb.send = async (cmd) => {
    ddbCommands.push(cmd);
    return {};
  };

  try {
    const beforeSeconds = Math.floor(Date.now() / 1000);
    const todayKey = new Date().toISOString().slice(0, 10);

    await analytics.recordAdminAudit({
      adminEmail: 'secops@renderpdf.com',
      targetUserId: 'user_audit_test_123',
      action: 'PLAN_OVERRIDE',
      reason: 'Manual tier upgrade for enterprise pilot',
      details: { previousTier: 'starter', newTier: 'enterprise' },
    });

    const afterSeconds = Math.floor(Date.now() / 1000);

    assert.strictEqual(ddbCommands.length, 1);
    const putCmd = ddbCommands[0];
    assert.strictEqual(putCmd.constructor.name, 'PutItemCommand');
    assert.strictEqual(putCmd.input.TableName, process.env.TABLE_NAME);

    const item = putCmd.input.Item;
    // Partition Key: ADMIN_AUDIT#YYYY-MM-DD
    assert.strictEqual(item.requestId.S, `ADMIN_AUDIT#${todayKey}`);

    // Sort Key: unix seconds
    const itemTimestamp = Number(item.timestamp.N);
    assert.ok(
      itemTimestamp >= beforeSeconds && itemTimestamp <= afterSeconds,
      'Timestamp is current unix seconds'
    );

    // Entity type
    assert.strictEqual(item.entityType.S, 'ADMIN_AUDIT');

    // Audit ID
    assert.ok(item.auditId.S && item.auditId.S.length > 0, 'AuditId is populated');

    // Attributes
    assert.strictEqual(item.adminEmail.S, 'secops@renderpdf.com');
    assert.strictEqual(item.targetUserId.S, 'user_audit_test_123');
    assert.strictEqual(item.action.S, 'PLAN_OVERRIDE');
    assert.strictEqual(item.reason.S, 'Manual tier upgrade for enterprise pilot');
    assert.deepStrictEqual(JSON.parse(item.details.S), {
      previousTier: 'starter',
      newTier: 'enterprise',
    });

    // 365-day TTL: expiresAt = timestamp + 365 * 86400
    const expiresAt = Number(item.expiresAt.N);
    const expectedExpires = itemTimestamp + 365 * 86400;
    assert.strictEqual(expiresAt, expectedExpires, 'Expires exactly 365 days after creation');

    // Test with missing/default optional fields
    ddbCommands.length = 0;
    await analytics.recordAdminAudit({
      action: 'KEY_REVOKE',
    });

    assert.strictEqual(ddbCommands.length, 1);
    const defaultItem = ddbCommands[0].input.Item;
    assert.strictEqual(defaultItem.adminEmail.S, 'unknown');
    assert.strictEqual(defaultItem.targetUserId.S, '');
    assert.strictEqual(defaultItem.action.S, 'KEY_REVOKE');
    assert.strictEqual(defaultItem.reason.S, '');
    assert.strictEqual(defaultItem.details.S, '{}');
  } finally {
    analytics.ddb.send = origDdbSend;
  }
});

test('listAdminAuditLogs - queries audit partitions and returns sorted logs; non-admin gets 403 (Task 4.2)', async () => {
  const origDdbSend = analytics.ddb.send;
  const ddbCommands = [];

  const fakeNow = Date.now();
  const todayKey = new Date(fakeNow).toISOString().slice(0, 10);

  analytics.ddb.send = async (cmd) => {
    ddbCommands.push(cmd);
    if (cmd.constructor.name === 'QueryCommand') {
      return {
        Items: [
          {
            requestId: { S: `ADMIN_AUDIT#${todayKey}` },
            timestamp: { N: String(fakeNow - 1000) },
            auditId: { S: 'audit-1' },
            adminEmail: { S: 'admin@test.com' },
            targetUserId: { S: 'u1' },
            action: { S: 'USER_SUSPEND' },
            reason: { S: 'Fraud' },
            details: { S: '{"cognitoAction":"disable"}' },
          },
          {
            requestId: { S: `ADMIN_AUDIT#${todayKey}` },
            timestamp: { N: String(fakeNow - 2000) },
            auditId: { S: 'audit-2' },
            adminEmail: { S: 'admin@test.com' },
            targetUserId: { S: 'u2' },
            action: { S: 'KEY_REVOKE' },
            reason: { S: 'Compromised' },
            details: { S: '{}' },
          },
        ],
      };
    }
    return {};
  };

  try {
    // Non-admin caller receives 403
    const anonRes = await analytics.listAdminAuditLogs({ httpMethod: 'GET' });
    assert.strictEqual(anonRes.statusCode, 403);

    const adminRequest = {
      httpMethod: 'GET',
      requestContext: {
        authorizer: { claims: { email: 'admin@test.com', 'cognito:groups': 'Admins' } },
      },
      queryStringParameters: { days: '1', limit: '10' },
    };
    const res = await analytics.listAdminAuditLogs(adminRequest);
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.logs), 'logs should be an array');
    assert.strictEqual(body.logs.length, 2);
    // Sorted descending by timestamp
    assert.ok(body.logs[0].timestamp >= body.logs[1].timestamp, 'logs should be sorted descending');
    assert.strictEqual(body.logs[0].action, 'USER_SUSPEND');
    assert.deepStrictEqual(body.logs[0].details, { cognitoAction: 'disable' });

    // QueryCommand sent with ADMIN_AUDIT#<date> partition
    const queryCmd = ddbCommands.find((c) => c.constructor.name === 'QueryCommand');
    assert.ok(queryCmd, 'QueryCommand should be sent');
    assert.ok(
      queryCmd.input.ExpressionAttributeValues[':pk'].S.startsWith('ADMIN_AUDIT#'),
      'partition key should start with ADMIN_AUDIT#'
    );
  } finally {
    analytics.ddb.send = origDdbSend;
  }
});
