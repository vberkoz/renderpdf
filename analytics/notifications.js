'use strict';

const { UpdateItemCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');

const DEFAULT_SES_FROM = 'RenderPDF <support@renderpdf.vberkoz.com>';
const SES_REGION = process.env.SES_REGION || process.env.AWS_REGION || 'us-east-1';

let ses = null;
let cognito = null;

function getSESClient() {
  if (!ses) {
    const { SESClient } = require('@aws-sdk/client-ses');
    ses = new SESClient({ region: SES_REGION });
  }
  return ses;
}

function getCognitoClient() {
  if (!cognito) {
    const { CognitoIdentityProviderClient } = require('@aws-sdk/client-cognito-identity-provider');
    cognito = new CognitoIdentityProviderClient({ region: SES_REGION });
  }
  return cognito;
}

function setSESClient(client) {
  ses = client;
}

function setCognitoClient(client) {
  cognito = client;
}

function notificationSenderAddress() {
  return String(process.env.NOTIFICATION_FROM_EMAIL || DEFAULT_SES_FROM).trim();
}

async function sendSESEmail({ to, subject, html, text }) {
  const recipient = String(to || '').trim();
  if (!recipient) throw new Error('Recipient email is required');

  const fromEmail = notificationSenderAddress();
  const { SendEmailCommand } = require('@aws-sdk/client-ses');
  const client = getSESClient();
  const command = new SendEmailCommand({
    Source: fromEmail,
    Destination: {
      ToAddresses: [recipient],
    },
    Message: {
      Subject: {
        Data: subject,
        Charset: 'UTF-8',
      },
      Body: {
        Html: {
          Data: html,
          Charset: 'UTF-8',
        },
        Text: {
          Data: text,
          Charset: 'UTF-8',
        },
      },
    },
  });

  return client.send(command);
}

function buildPaymentFailedEmail(customerEmail) {
  const subject = 'Action Required: Payment failed for your RenderPDF subscription';
  const updateUrl = 'https://renderpdf.vberkoz.com/app/#billing';

  const text = `RenderPDF Billing Alert

Your recent RenderPDF subscription renewal payment could not be processed, and your account is now past due. Please update your payment method promptly to prevent your API access from being suspended.

Update your payment method here:
${updateUrl}

If you have already resolved this with your bank or updated your payment details, no further action is needed.

— RenderPDF Team
https://renderpdf.vberkoz.com
`;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Failed - RenderPDF</title>
</head>
<body style="margin: 0; padding: 24px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f7f9fb; color: #17212b;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 540px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8ef; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
    <tr>
      <td style="padding: 32px 32px 20px 32px; text-align: center; border-bottom: 1px solid #f1f5f9;">
        <h1 style="margin: 0; font-size: 20px; font-weight: 700; color: #0f172a; letter-spacing: -0.02em;">RenderPDF</h1>
      </td>
    </tr>
    <tr>
      <td style="padding: 32px;">
        <div style="display: inline-block; padding: 4px 12px; border-radius: 9999px; background: #fee2e2; color: #991b1b; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 16px;">Payment Failed</div>
        <h2 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #1e293b;">Action Required: Account Past Due</h2>
        <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6; color: #475569;">
          Your recent RenderPDF subscription renewal payment could not be processed, and your account is now past due.
        </p>
        <p style="margin: 0 0 24px 0; font-size: 15px; line-height: 1.6; color: #475569;">
          Please update your payment method promptly before service is suspended to avoid any interruption to your PDF rendering API workflows.
        </p>
        <div style="text-align: center; margin: 28px 0;">
          <a href="${updateUrl}" style="display: inline-block; padding: 12px 28px; background: #dc2626; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;">Update Payment Method</a>
        </div>
        <p style="margin: 24px 0 0 0; font-size: 13px; line-height: 1.5; color: #64748b;">
          If you have recently updated your card or resolved this with your bank, our billing system will automatically re-attempt the charge shortly.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding: 20px 32px; background: #f8fafc; border-top: 1px solid #f1f5f9; text-align: center; font-size: 12px; color: #94a3b8;">
        RenderPDF Billing Operations &bull; <a href="${updateUrl}" style="color: #64748b; text-decoration: underline;">Billing Dashboard</a>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html, text };
}

async function resolveCustomerEmail(ddb, tableName, userId, fallbackEmail = '') {
  if (fallbackEmail && String(fallbackEmail).includes('@')) {
    return String(fallbackEmail).trim();
  }

  // 1. Check USER_PROFILE#<userId> in UsageTable
  if (ddb && tableName) {
    try {
      const profile = await ddb.send(new GetItemCommand({
        TableName: tableName,
        Key: { requestId: { S: `USER_PROFILE#${userId}` }, timestamp: { N: '0' } },
        ConsistentRead: true,
      }));
      const email = profile?.Item?.customerEmail?.S;
      if (email && email.includes('@')) return email.trim();
    } catch (err) {
      console.warn('Could not read USER_PROFILE for email resolution', err);
    }
  }

  // 2. Fallback to Cognito AdminGetUser if USER_POOL_ID is set
  const userPoolId = process.env.USER_POOL_ID;
  if (userPoolId) {
    try {
      const { AdminGetUserCommand } = require('@aws-sdk/client-cognito-identity-provider');
      const client = getCognitoClient();
      const userRes = await client.send(new AdminGetUserCommand({
        UserPoolId: userPoolId,
        Username: userId,
      }));
      const emailAttr = userRes?.UserAttributes?.find(a => a.Name === 'email');
      if (emailAttr?.Value && emailAttr.Value.includes('@')) {
        const found = emailAttr.Value.trim();
        // Cache to USER_PROFILE
        if (ddb && tableName) {
          try {
            await ddb.send(new UpdateItemCommand({
              TableName: tableName,
              Key: { requestId: { S: `USER_PROFILE#${userId}` }, timestamp: { N: '0' } },
              UpdateExpression: 'SET customerEmail = :email, entityType = :entity, updatedAt = :now',
              ExpressionAttributeValues: {
                ':email': { S: found },
                ':entity': { S: 'USER_PROFILE' },
                ':now': { N: String(Math.floor(Date.now() / 1000)) },
              },
            }));
          } catch {}
        }
        return found;
      }
    } catch (err) {
      console.warn('Could not look up user email in Cognito', err);
    }
  }

  return '';
}

async function sendPaymentFailedAlert(ddb, tableName, userId, customerEmail) {
  const email = await resolveCustomerEmail(ddb, tableName, userId, customerEmail);
  if (!email) {
    console.warn(`No email found for past due user ${userId}; skipping notification`);
    return { sent: false, reason: 'missing_email' };
  }

  const { subject, html, text } = buildPaymentFailedEmail(email);
  try {
    await sendSESEmail({ to: email, subject, html, text });
    console.log(`Payment failed alert email sent to ${email} (userId: ${userId})`);
    return { sent: true, recipient: email };
  } catch (err) {
    console.error(`Failed to send payment failed alert email to ${email}:`, err);
    return { sent: false, error: err.message };
  }
}

module.exports = {
  sendSESEmail,
  buildPaymentFailedEmail,
  resolveCustomerEmail,
  sendPaymentFailedAlert,
  setSESClient,
  setCognitoClient,
};
