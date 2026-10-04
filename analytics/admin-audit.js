'use strict';

const crypto = require('node:crypto');

let DynamoDBClient;
let PutItemCommand;
let QueryCommand;
try {
  ({
    DynamoDBClient,
    PutItemCommand,
    QueryCommand,
  } = require('@aws-sdk/client-dynamodb'));
} catch {
  DynamoDBClient = class MockDynamoDBClient {
    async send() {
      return {};
    }
  };
  PutItemCommand = class PutItemCommand {
    constructor(input) {
      this.input = input;
    }
  };
  QueryCommand = class QueryCommand {
    constructor(input) {
      this.input = input;
    }
  };
}

const { ddb, isAuthorizedAdmin } = require('./admin-analytics');

let customDdbClient = null;

function setDdbClient(client) {
  customDdbClient = client;
}

function getDdbClient() {
  return customDdbClient || ddb;
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

async function recordAdminAudit({ adminEmail, targetUserId, action, reason, details }) {
  const tableName = process.env.TABLE_NAME;
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  const auditId = crypto.randomUUID
    ? crypto.randomUUID()
    : `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const expiresAt = Math.floor(now.getTime() / 1000) + 365 * 86400;

  await getDdbClient().send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        requestId: { S: `ADMIN_AUDIT#${dateKey}` },
        timestamp: { N: String(Math.floor(now.getTime() / 1000)) },
        entityType: { S: 'ADMIN_AUDIT' },
        auditId: { S: auditId },
        adminEmail: { S: adminEmail || 'unknown' },
        targetUserId: { S: targetUserId || '' },
        action: { S: action },
        reason: { S: reason || '' },
        details: { S: JSON.stringify(details || {}) },
        expiresAt: { N: String(expiresAt) },
      },
    })
  );
}

/**
 * GET /api/v1/admin/audit-logs?days={days}&limit={limit}
 * Queries ADMIN_AUDIT#YYYY-MM-DD partitions across the requested days.
 * Returns { logs: [...], count } sorted by timestamp descending.
 */
async function listAdminAuditLogs(request) {
  if (!isAuthorizedAdmin(request)) {
    return response(403, { error: 'Forbidden' });
  }

  const tableName = process.env.TABLE_NAME;
  const qs = request?.queryStringParameters || {};
  const days = Math.min(Math.max(parseInt(qs.days, 10) || 30, 1), 90);
  const limitParam = Math.min(Math.max(parseInt(qs.limit, 10) || 100, 1), 500);

  const now = new Date();
  const allLogs = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const dk = d.toISOString().slice(0, 10);
    try {
      const result = await getDdbClient().send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'requestId = :pk',
          ExpressionAttributeValues: { ':pk': { S: `ADMIN_AUDIT#${dk}` } },
          ScanIndexForward: false,
          Limit: limitParam,
        })
      );
      const items = (result.Items || []).map((item) => ({
        requestId: item.requestId?.S,
        timestamp: Number(item.timestamp?.N || 0),
        auditId: item.auditId?.S,
        adminEmail: item.adminEmail?.S,
        targetUserId: item.targetUserId?.S,
        action: item.action?.S,
        reason: item.reason?.S,
        details: (() => {
          try {
            return JSON.parse(item.details?.S || '{}');
          } catch (_) {
            return {};
          }
        })(),
      }));
      allLogs.push(...items);
      if (allLogs.length >= limitParam) break;
    } catch (err) {
      console.warn(`Could not query audit logs for ADMIN_AUDIT#${dk}:`, err);
    }
  }

  allLogs.sort((a, b) => b.timestamp - a.timestamp);
  const page = allLogs.slice(0, limitParam);

  return response(200, { logs: page, count: page.length });
}

module.exports = {
  recordAdminAudit,
  listAdminAuditLogs,
  setDdbClient,
  getDdbClient,
  response,
};
