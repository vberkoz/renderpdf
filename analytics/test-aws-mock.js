'use strict';

process.env.TABLE_NAME = process.env.TABLE_NAME || 'RenderPdfTable';
process.env.API_KEYS_TABLE = process.env.API_KEYS_TABLE || 'ApiKeysTable';
process.env.USER_POOL_ID = process.env.USER_POOL_ID || 'renderpdf-users-v2';

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
    return {
      SESClient: MockSESClient,
      SendEmailCommand,
    };
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
  if (id === '@aws-sdk/client-bedrock-runtime') {
    class MockBedrockRuntimeClient {
      send() {}
    }
    class ConverseCommand {
      constructor(input) {
        this.input = input;
      }
    }
    return {
      BedrockRuntimeClient: MockBedrockRuntimeClient,
      ConverseCommand,
    };
  }
  return originalRequire.apply(this, [id, ...args]);
};
