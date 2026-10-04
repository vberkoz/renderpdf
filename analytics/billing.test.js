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

const billing = require('./billing');

test('billing module exports all required functions and constants', () => {
  assert.strictEqual(typeof billing.receivePaddleWebhook, 'function');
  assert.strictEqual(typeof billing.receiveOverageWebhook, 'function');
  assert.strictEqual(typeof billing.receivePaymentFailedWebhook, 'function');
  assert.strictEqual(typeof billing.createCheckout, 'function');
  assert.strictEqual(typeof billing.openBillingPortal, 'function');
  assert.strictEqual(typeof billing.changePlan, 'function');
  assert.strictEqual(typeof billing.readCustomerDashboard, 'function');
  assert.strictEqual(typeof billing.syncSubscriptionWithPaddle, 'function');
  assert.strictEqual(typeof billing.syncUserUsagePlans, 'function');
  assert.strictEqual(typeof billing.updateQuotaOnSubscriptionChange, 'function');
  assert.strictEqual(typeof billing.saveBillingWebhook, 'function');
  assert.strictEqual(typeof billing.creditOverage, 'function');
  assert.strictEqual(typeof billing.paddleRequest, 'function');
  assert.strictEqual(typeof billing.tierFromAttributes, 'function');
  assert.strictEqual(typeof billing.intervalFromAttributes, 'function');
  assert.ok(billing.PADDLE_PRICES);
  assert.ok(billing.PADDLE_SUBSCRIPTION_EVENTS);
  assert.ok(billing.QUOTA_UPGRADE_EVENTS);
});

test('billing.tierFromAttributes and intervalFromAttributes resolve accurately', () => {
  const proSub = {
    items: [{ price: { name: 'RenderPDF Pro Plan' } }],
  };
  assert.strictEqual(billing.tierFromAttributes(proSub), 'pro');

  const starterSub = {
    items: [{ price: { name: 'RenderPDF Starter Plan' } }],
    billing_cycle: { interval: 'year' },
  };
  assert.strictEqual(billing.tierFromAttributes(starterSub), 'starter');
  assert.strictEqual(billing.intervalFromAttributes(starterSub), 'year');
});

test('billing.createCheckout validates plan and auth', async () => {
  const unauthRes = await billing.createCheckout({
    requestContext: {},
    body: JSON.stringify({ plan: 'pro' }),
  });
  assert.strictEqual(unauthRes.statusCode, 401);

  const invalidPlanRes = await billing.createCheckout({
    requestContext: { authorizer: { claims: { sub: 'usr_test' } } },
    body: JSON.stringify({ plan: 'nonexistent_plan' }),
  });
  assert.strictEqual(invalidPlanRes.statusCode, 422);
});
