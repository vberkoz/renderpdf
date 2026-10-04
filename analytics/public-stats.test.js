'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id, ...args) {
  if (id === '@aws-sdk/client-dynamodb') {
    class MockDynamoDBClient {
      send() {}
    }
    class BatchGetItemCommand {
      constructor(input) {
        this.input = input;
      }
    }
    class GetItemCommand {
      constructor(input) {
        this.input = input;
      }
    }
    class UpdateItemCommand {
      constructor(input) {
        this.input = input;
      }
    }
    class PutItemCommand {
      constructor(input) {
        this.input = input;
      }
    }
    class QueryCommand {
      constructor(input) {
        this.input = input;
      }
    }
    class TransactWriteItemsCommand {
      constructor(input) {
        this.input = input;
      }
    }
    return {
      BatchGetItemCommand,
      DynamoDBClient: MockDynamoDBClient,
      GetItemCommand,
      PutItemCommand,
      QueryCommand,
      TransactWriteItemsCommand,
      UpdateItemCommand,
    };
  }
  if (id === '@aws-sdk/client-ses') {
    class MockSESClient {
      send() {}
    }
    class SendEmailCommand {
      constructor(input) {
        this.input = input;
      }
    }
    return { SESClient: MockSESClient, SendEmailCommand };
  }
  if (id === '@aws-sdk/client-cognito-identity-provider') {
    class MockCognitoClient {
      send() {}
    }
    class AdminGetUserCommand {
      constructor(input) {
        this.input = input;
      }
    }
    class AdminDisableUserCommand {
      constructor(input) {
        this.input = input;
      }
    }
    class AdminEnableUserCommand {
      constructor(input) {
        this.input = input;
      }
    }
    class ListUsersCommand {
      constructor(input) {
        this.input = input;
      }
    }
    return {
      CognitoIdentityProviderClient: MockCognitoClient,
      AdminGetUserCommand,
      AdminDisableUserCommand,
      AdminEnableUserCommand,
      ListUsersCommand,
    };
  }
  if (id === '@aws-sdk/client-api-gateway') {
    class MockAPIGatewayClient {
      send() {}
    }
    class CreateUsagePlanKeyCommand {
      constructor(input) {
        this.input = input;
      }
    }
    class DeleteUsagePlanKeyCommand {
      constructor(input) {
        this.input = input;
      }
    }
    return {
      APIGatewayClient: MockAPIGatewayClient,
      CreateUsagePlanKeyCommand,
      DeleteUsagePlanKeyCommand,
    };
  }
  return originalRequire.apply(this, [id, ...args]);
};

const publicStats = require('./public-stats');
const analytics = require('./index');

test('publicStatsResponse returns proper status, body, and headers', () => {
  const optionsRes = publicStats.publicStatsResponse(204);
  assert.strictEqual(optionsRes.statusCode, 204);
  assert.strictEqual(optionsRes.body, '');
  assert.strictEqual(optionsRes.headers['Access-Control-Allow-Origin'], '*');
  assert.strictEqual(optionsRes.headers['Cache-Control'], 'public, max-age=300, s-maxage=300');

  const okRes = publicStats.publicStatsResponse(200, { test: 123 });
  assert.strictEqual(okRes.statusCode, 200);
  assert.strictEqual(JSON.parse(okRes.body).test, 123);
});

test('recordPublicEvent writes analytics event and updates rollup for valid event', async () => {
  const commands = [];
  const mockDdb = {
    send: async (cmd) => {
      commands.push(cmd);
      return {};
    },
  };

  publicStats.setDdbClient(mockDdb);
  try {
    // Untracked event does nothing
    await publicStats.recordPublicEvent('invalid_event', { path: '/test' });
    assert.strictEqual(commands.length, 0);

    // Tracked event records PutItem and UpdateItem
    await publicStats.recordPublicEvent('page_viewed', { path: '/landing' });
    assert.strictEqual(commands.length, 2);
    assert.strictEqual(commands[0].constructor.name, 'PutItemCommand');
    assert.strictEqual(commands[0].input.Item.eventName.S, 'page_viewed');
    assert.strictEqual(commands[0].input.Item.path.S, '/landing');

    assert.strictEqual(commands[1].constructor.name, 'UpdateItemCommand');
    assert.ok(commands[1].input.UpdateExpression.includes('ADD acquisition.pageViews :one'));
  } finally {
    publicStats.setDdbClient(null);
  }
});

test('queryDay queries items with GSI1PK and handles pagination', async () => {
  let callCount = 0;
  const mockDdb = {
    send: async (cmd) => {
      callCount++;
      if (callCount === 1) {
        return {
          Items: [{ id: { S: 'item1' } }],
          LastEvaluatedKey: { id: { S: 'item1' } },
        };
      }
      return {
        Items: [{ id: { S: 'item2' } }],
      };
    },
  };

  publicStats.setDdbClient(mockDdb);
  try {
    const items = await publicStats.queryDay('USAGE#2026-10-04');
    assert.strictEqual(items.length, 2);
    assert.strictEqual(callCount, 2);
  } finally {
    publicStats.setDdbClient(null);
  }
});

test('readPublicStats computes statistics and utilizes in-memory cache', async () => {
  publicStats.resetPublicStatsCache();

  const mockDdb = {
    send: async (cmd) => {
      if (cmd.constructor.name === 'QueryCommand') {
        return {
          Items: [
            {
              entityType: { S: 'PDF_REQUEST' },
              status: { S: 'success' },
              plan: { S: 'trial' },
              renderDurationMs: { N: '250' },
              country: { S: 'US' },
            },
            {
              entityType: { S: 'PDF_REQUEST' },
              status: { S: 'success' },
              plan: { S: 'pro' },
              renderDurationMs: { N: '500' },
              country: { S: 'DE' },
            },
          ],
        };
      }
      return {};
    },
  };

  publicStats.setDdbClient(mockDdb);
  try {
    const res = await publicStats.readPublicStats({
      queryStringParameters: { event: 'trial_render_succeeded' },
    });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.windowDays, 30);
    assert.ok(body.totalRequests > 0);
    assert.strictEqual(body.status, 'operational');
    assert.ok(body.byCountry.length > 0);
    assert.ok(body.byDay.length === 30);

    // Call again to verify cache hit (queryDay should not be called)
    let queryCalled = false;
    publicStats.setDdbClient({
      send: async (cmd) => {
        if (cmd.constructor.name === 'QueryCommand') {
          queryCalled = true;
        }
        return {};
      },
    });

    const cachedRes = await publicStats.readPublicStats({});
    assert.strictEqual(cachedRes.statusCode, 200);
    assert.strictEqual(queryCalled, false, 'Expected response to be served from cache');
  } finally {
    publicStats.resetPublicStatsCache();
    publicStats.setDdbClient(null);
  }
});

test('analytics handler routes /public-stats, /stats/public, and /stats/summary', async () => {
  publicStats.resetPublicStatsCache();
  const mockDdb = {
    send: async () => ({ Items: [] }),
  };
  publicStats.setDdbClient(mockDdb);

  try {
    for (const route of ['/public-stats', '/stats/public', '/stats/summary']) {
      const optionsRes = await analytics.handler({
        httpMethod: 'OPTIONS',
        path: `/api/v1${route}`,
      });
      assert.strictEqual(optionsRes.statusCode, 204);

      const getRes = await analytics.handler({
        httpMethod: 'GET',
        path: `/api/v1${route}`,
      });
      assert.strictEqual(getRes.statusCode, 200);
      const body = JSON.parse(getRes.body);
      assert.strictEqual(body.windowDays, 30);
    }
  } finally {
    publicStats.resetPublicStatsCache();
    publicStats.setDdbClient(null);
  }
});
