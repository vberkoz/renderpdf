'use strict';

const {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminLinkProviderForUserCommand,
  AdminGetUserCommand
} = require('@aws-sdk/client-cognito-identity-provider');
const {
  DynamoDBClient,
  QueryCommand,
  GetItemCommand,
  PutItemCommand,
  ScanCommand
} = require('@aws-sdk/client-dynamodb');
const crypto = require('node:crypto');

const cognito = new CognitoIdentityProviderClient({});
const ddb = new DynamoDBClient({});

const API_KEYS_TABLE = process.env.API_KEYS_TABLE;
const TEMPLATES_TABLE = process.env.TEMPLATE_TABLE_NAME;
const USAGE_TABLE = process.env.TABLE_NAME;

async function migrateUserData(oldSub, newSub) {
  console.log(`Migrating data from old sub ${oldSub} to new sub ${newSub}`);

  // 1. Migrate API keys
  if (API_KEYS_TABLE) {
    try {
      const keysRes = await ddb.send(new QueryCommand({
        TableName: API_KEYS_TABLE,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: {
          ':pk': { S: `USER#${oldSub}` }
        }
      }));

      for (const item of (keysRes.Items || [])) {
        const newItem = { ...item };
        newItem.PK = { S: `USER#${newSub}` };
        newItem.userId = { S: newSub };
        await ddb.send(new PutItemCommand({
          TableName: API_KEYS_TABLE,
          Item: newItem
        }));
        console.log(`Copied API key ${item.keyId?.S} to new user ${newSub}`);
      }
    } catch (err) {
      console.error('Error migrating API keys:', err);
    }
  }

  // 2. Migrate Templates
  if (TEMPLATES_TABLE) {
    try {
      const oldOwnerKey = 'OWNER#' + crypto.createHash('sha256').update('renderpdf-template-owner:' + oldSub).digest('hex');
      const newOwnerKey = 'OWNER#' + crypto.createHash('sha256').update('renderpdf-template-owner:' + newSub).digest('hex');

      const tmplRes = await ddb.send(new QueryCommand({
        TableName: TEMPLATES_TABLE,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: {
          ':pk': { S: oldOwnerKey }
        }
      }));

      for (const item of (tmplRes.Items || [])) {
        const newItem = { ...item };
        newItem.PK = { S: newOwnerKey };
        if (newItem.ownerId) newItem.ownerId = { S: newSub };
        await ddb.send(new PutItemCommand({
          TableName: TEMPLATES_TABLE,
          Item: newItem
        }));
        console.log(`Copied template ${item.id?.S} to new owner ${newSub}`);
      }
    } catch (err) {
      console.error('Error migrating templates:', err);
    }
  }

  // 3. Migrate Billing record
  // The usage table has a composite key: requestId (HASH) + timestamp (RANGE).
  // BILLING records always use timestamp=0.
  if (USAGE_TABLE) {
    try {
      const billingRes = await ddb.send(new GetItemCommand({
        TableName: USAGE_TABLE,
        Key: {
          requestId: { S: `BILLING#${oldSub}` },
          timestamp: { N: '0' }
        }
      }));

      if (billingRes.Item) {
        const newItem = { ...billingRes.Item };
        newItem.requestId = { S: `BILLING#${newSub}` };
        if (newItem.customerId) newItem.customerId = { S: newSub };
        await ddb.send(new PutItemCommand({
          TableName: USAGE_TABLE,
          Item: newItem
        }));
        console.log(`Copied BILLING record to new user ${newSub}`);
      } else {
        console.log(`No BILLING record found for old sub ${oldSub}`);
      }
    } catch (err) {
      console.error('Error migrating billing record:', err);
    }
  }

  // 4. Migrate USER_QUOTA records (one per calendar month).
  // Real key format: USER_QUOTA#<sub>#<YYYY-MM> — not QUOTA#<sub>.
  // Scan with begins_with filter because begins_with on the HASH key alone is
  // not supported by Query (which requires an equality condition on the key).
  if (USAGE_TABLE) {
    try {
      const quotaPrefix = `USER_QUOTA#${oldSub}#`;
      const scanRes = await ddb.send(new ScanCommand({
        TableName: USAGE_TABLE,
        FilterExpression: 'begins_with(requestId, :prefix)',
        ExpressionAttributeValues: {
          ':prefix': { S: quotaPrefix }
        }
      }));

      for (const item of (scanRes.Items || [])) {
        const oldKey = item.requestId?.S || '';
        const monthSuffix = oldKey.slice(quotaPrefix.length); // e.g. "2026-09"
        const newItem = { ...item };
        newItem.requestId = { S: `USER_QUOTA#${newSub}#${monthSuffix}` };
        await ddb.send(new PutItemCommand({
          TableName: USAGE_TABLE,
          Item: newItem
        }));
        console.log(`Copied USER_QUOTA record for ${monthSuffix} to new user ${newSub}`);
      }
    } catch (err) {
      console.error('Error migrating quota records:', err);
    }
  }
}

exports.handler = async (event) => {
  console.log('Cognito trigger invoked:', event.triggerSource, JSON.stringify(event));

  try {
    // ----------------------------------------------------------------------
    // Scenario 1: User signs in with Google, check if native user exists
    // ----------------------------------------------------------------------
    if (event.triggerSource === 'PreSignUp_ExternalProvider') {
      const email = event.request?.userAttributes?.email;
      if (!email) return event;

      const listRes = await cognito.send(new ListUsersCommand({
        UserPoolId: event.userPoolId,
        Filter: `email = "${email}"`
      }));

      const nativeUser = listRes.Users?.find(u => u.UserStatus !== 'EXTERNAL_PROVIDER');
      if (nativeUser) {
        const parts = event.userName.split('_');
        const providerName = parts[0] || 'Google';
        const providerUserId = parts.slice(1).join('_') || event.userName;

        console.log(`PreSignUp_ExternalProvider: Linking ${providerName} (${providerUserId}) to existing native user ${nativeUser.Username}`);
        await cognito.send(new AdminLinkProviderForUserCommand({
          UserPoolId: event.userPoolId,
          DestinationUser: {
            ProviderName: 'Cognito',
            ProviderAttributeValue: nativeUser.Username
          },
          SourceUser: {
            ProviderName: providerName,
            ProviderAttributeName: 'Cognito_Subject',
            ProviderAttributeValue: providerUserId
          }
        }));
      }
      return event;
    }

    // ----------------------------------------------------------------------
    // Scenario 2: User registers with Email & Password
    // Check if Google user exists; if so, auto-confirm and verify email
    // ----------------------------------------------------------------------
    if (event.triggerSource === 'PreSignUp_SignUp') {
      const email = event.request?.userAttributes?.email;
      if (!email) return event;

      const listRes = await cognito.send(new ListUsersCommand({
        UserPoolId: event.userPoolId,
        Filter: `email = "${email}"`
      }));

      const externalUser = listRes.Users?.find(u => u.UserStatus === 'EXTERNAL_PROVIDER');
      if (externalUser) {
        console.log(`PreSignUp_SignUp: Found external Google user for ${email}. Auto-confirming native sign-up.`);
        event.response.autoConfirmUser = true;
        event.response.autoVerifyEmail = true;
      }
      return event;
    }

    // ----------------------------------------------------------------------
    // Scenario 3: Native user is confirmed (either auto or manual)
    // Link existing Google identity to this native user and migrate data
    // ----------------------------------------------------------------------
    if (event.triggerSource === 'PostConfirmation_ConfirmSignUp') {
      const email = event.request?.userAttributes?.email;
      if (!email) return event;

      const listRes = await cognito.send(new ListUsersCommand({
        UserPoolId: event.userPoolId,
        Filter: `email = "${email}"`
      }));

      const externalUser = listRes.Users?.find(u => u.UserStatus === 'EXTERNAL_PROVIDER');
      if (externalUser) {
        const parts = externalUser.Username.split('_');
        const providerName = parts[0] || 'Google';
        const providerUserId = parts.slice(1).join('_') || externalUser.Username;
        const googleSub = externalUser.Attributes?.find(a => a.Name === 'sub')?.Value;

        const getUserRes = await cognito.send(new AdminGetUserCommand({
          UserPoolId: event.userPoolId,
          Username: event.userName
        }));
        const nativeSub = getUserRes.UserAttributes?.find(a => a.Name === 'sub')?.Value;

        console.log(`PostConfirmation: Linking ${providerName} (${providerUserId}) to native user ${event.userName}`);
        try {
          await cognito.send(new AdminLinkProviderForUserCommand({
            UserPoolId: event.userPoolId,
            DestinationUser: {
              ProviderName: 'Cognito',
              ProviderAttributeValue: event.userName
            },
            SourceUser: {
              ProviderName: providerName,
              ProviderAttributeName: 'Cognito_Subject',
              ProviderAttributeValue: providerUserId
            }
          }));
        } catch (linkErr) {
          console.error('Failed to link provider in PostConfirmation:', linkErr);
        }

        if (googleSub && nativeSub && googleSub !== nativeSub) {
          await migrateUserData(googleSub, nativeSub);
        }
      }
      return event;
    }
  } catch (err) {
    console.error('Unhandled error in account-linker trigger:', err);
  }

  return event;
};
