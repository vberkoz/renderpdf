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
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function stringValue(item, key) {
  return item && item[key] && typeof item[key].S === 'string' ? item[key].S : '';
}

function numberValue(item, key) {
  if (!item || !item[key] || typeof item[key].N !== 'string') return 0;
  const parsed = parseInt(item[key].N, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

const FREE_MONTHLY_QUOTA = positiveInteger(process.env.FREE_MONTHLY_QUOTA, 25);
const PLAN_QUOTAS = {
  free: positiveInteger(process.env.FREE_MONTHLY_QUOTA, 25),
  starter: positiveInteger(process.env.STARTER_MONTHLY_QUOTA, 5000),
  pro: positiveInteger(process.env.PRO_MONTHLY_QUOTA, 20000),
  enterprise: positiveInteger(process.env.ENTERPRISE_MONTHLY_QUOTA, 100000),
};

function response(statusCode, payload) {
  return {
    statusCode,
    body: payload == null ? '' : JSON.stringify(payload),
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Api-Key',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
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

module.exports = {
  BatchGetItemCommand,
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
  CognitoIdentityProviderClient,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  ListUsersCommand,
  AdminGetUserCommand,
  APIGatewayClient,
  CreateUsagePlanKeyCommand,
  DeleteUsagePlanKeyCommand,
  ddb,
  isAuthorizedAdmin,
  unwrap,
  queryDay,
  cognito,
  apigw,
  setDdbClient,
  setCognitoClient,
  setApigwClient,
  getDdbClient,
  getCognitoClient,
  getApigwClient,
  positiveInteger,
  dateKey,
  stringValue,
  numberValue,
  PLAN_QUOTAS,
  FREE_MONTHLY_QUOTA,
  response,
  getAdminEmail,
  parseJsonBody,
};
