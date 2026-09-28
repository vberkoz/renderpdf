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
    console.warn(`No email found for past due user ${userId}; skipping email notification`);
    await sendTelegramBillingAlert({ userId, customerEmail: null, eventType: 'subscription.past_due', reason: 'Missing email' }).catch(() => {});
    return { sent: false, reason: 'missing_email' };
  }

  const { subject, html, text } = buildPaymentFailedEmail(email);
  try {
    const [sesRes, tgRes] = await Promise.allSettled([
      sendSESEmail({ to: email, subject, html, text }),
      sendTelegramBillingAlert({ userId, customerEmail: email, eventType: 'subscription.past_due' }),
    ]);
    console.log(`Payment failed alert email sent to ${email} (userId: ${userId})`);
    const emailSent = sesRes.status === 'fulfilled';
    const tgSent = tgRes.status === 'fulfilled' && tgRes.value?.sent;
    return { sent: emailSent, recipient: email, telegramSent: Boolean(tgSent) };
  } catch (err) {
    console.error(`Failed to send payment failed alert email to ${email}:`, err);
    return { sent: false, error: err.message };
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function buildChatEscalationEmail({ session, recentMessages }) {
  const visitorIdentifier = session?.visitorEmail || session?.sourceIp || 'Anonymous Visitor';
  const reason = session?.escalationReason || 'human assistance';
  const reasonFormatted = reason.replace(/_/g, ' ');
  const subject = `[RenderPDF Chat Escalation] ${visitorIdentifier} - ${reasonFormatted}`;
  const adminChatUrl = `https://renderpdf.vberkoz.com/app/admin#chats?id=${encodeURIComponent(session?.sessionId || '')}`;

  const textLines = [
    '=== RenderPDF Chat Escalation Alert ===',
    '',
    `Session ID: ${session?.sessionId || ''}`,
    `Visitor Email: ${session?.visitorEmail || 'Not provided'}`,
    `Plan: ${session?.plan || 'anonymous'}`,
    `Reason: ${session?.escalationReason || 'None'}`,
    `Source: ${session?.source || 'landing'}`,
    `Customer ID: ${session?.customerId || 'None'}`,
    '',
    '--- Recent Transcript ---',
  ];

  for (const msg of recentMessages || []) {
    const sender = msg.sender || msg.role || 'user';
    textLines.push(`[${sender.toUpperCase()}]: ${msg.content || ''}`);
  }

  textLines.push('');
  textLines.push(`Open conversation in admin console:\n${adminChatUrl}`);

  const htmlMessages = (recentMessages || []).map((msg) => {
    const isUser = msg.role === 'user' || msg.sender === 'visitor';
    const bg = isUser ? '#f1f5f9' : '#e0e7ff';
    const roleName = isUser ? 'Visitor' : (msg.role === 'assistant' ? 'AI Assistant' : 'Operator');
    return `
      <div style="margin-bottom: 12px; padding: 10px 14px; background: ${bg}; border-radius: 8px;">
        <strong style="font-size: 12px; color: #475569; text-transform: uppercase;">${escapeHtml(roleName)}:</strong>
        <p style="margin: 4px 0 0 0; font-size: 14px; color: #0f172a; white-space: pre-wrap;">${escapeHtml(msg.content || '')}</p>
      </div>
    `;
  }).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>RenderPDF Chat Escalation</title>
</head>
<body style="margin: 0; padding: 24px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; color: #0f172a;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
    <div style="padding: 24px; background: #0f172a; color: #ffffff;">
      <h2 style="margin: 0; font-size: 18px; font-weight: 600;">[Chat Escalation] ${escapeHtml(reasonFormatted)}</h2>
      <p style="margin: 6px 0 0 0; font-size: 13px; color: #94a3b8;">Visitor: ${escapeHtml(visitorIdentifier)} &bull; Plan: ${escapeHtml(session?.plan || 'anonymous')}</p>
    </div>
    <div style="padding: 24px;">
      <table style="width: 100%; font-size: 13px; border-collapse: collapse; margin-bottom: 20px;">
        <tr><td style="padding: 6px 0; color: #64748b; width: 120px;">Session ID:</td><td style="padding: 6px 0; font-family: monospace;">${escapeHtml(session?.sessionId || '')}</td></tr>
        <tr><td style="padding: 6px 0; color: #64748b;">Visitor Email:</td><td style="padding: 6px 0;">${escapeHtml(session?.visitorEmail || 'Not provided')}</td></tr>
        <tr><td style="padding: 6px 0; color: #64748b;">Plan:</td><td style="padding: 6px 0; text-transform: capitalize;">${escapeHtml(session?.plan || 'anonymous')}</td></tr>
        <tr><td style="padding: 6px 0; color: #64748b;">Reason:</td><td style="padding: 6px 0; color: #b91c1c; font-weight: 600;">${escapeHtml(session?.escalationReason || 'None')}</td></tr>
      </table>
      <div style="text-align: center; margin: 24px 0;">
        <a href="${adminChatUrl}" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 14px;">Open in Admin Console</a>
      </div>
      <h3 style="margin: 20px 0 12px 0; font-size: 15px; border-top: 1px solid #e2e8f0; padding-top: 16px;">Recent Transcript</h3>
      ${htmlMessages}
    </div>
  </div>
</body>
</html>`;

  return { subject, html, text: textLines.join('\n') };
}

let customTelegramFetch = null;

function setTelegramFetch(fetchFn) {
  customTelegramFetch = fetchFn;
}

function resetTelegramClient() {
  customTelegramFetch = null;
}

async function sendTelegramMessage(text, options = {}) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    return { sent: false, reason: 'missing_credentials' };
  }

  const payload = {
    chat_id: chatId,
    text: String(text || '').trim(),
    parse_mode: options.parse_mode || 'HTML',
    disable_web_page_preview: options.disable_web_page_preview ?? false,
  };

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const fetcher = customTelegramFetch || globalThis.fetch;

  try {
    const res = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error(`Telegram API error (${res.status}): ${errBody}`);
      return { sent: false, error: `Telegram error ${res.status}: ${errBody}` };
    }

    const data = await res.json();
    return { sent: true, response: data };
  } catch (err) {
    console.error('Failed to dispatch Telegram message:', err);
    return { sent: false, error: err.message };
  }
}

function formatChatEscalationTelegramMessage({ session, recentMessages }) {
  const visitor = session?.visitorEmail || session?.sourceIp || 'Anonymous Visitor';
  const reason = (session?.escalationReason || 'human assistance').replace(/_/g, ' ');
  const plan = session?.plan || 'anonymous';
  const sessionId = session?.sessionId || '';
  const adminChatUrl = `https://renderpdf.vberkoz.com/app/admin#chats?id=${encodeURIComponent(sessionId)}`;

  const lastUserMsg = (recentMessages || [])
    .filter((m) => m.role === 'user' || m.sender === 'visitor')
    .pop()?.content || '(No message content)';

  return `🚨 <b>[RenderPDF Chat Escalated]</b>\n\n` +
    `👤 <b>Visitor:</b> <code>${escapeHtml(visitor)}</code>\n` +
    `💼 <b>Plan:</b> ${escapeHtml(plan)}\n` +
    `🎯 <b>Reason:</b> <code>${escapeHtml(reason)}</code>\n` +
    `🆔 <b>Session:</b> <code>${escapeHtml(sessionId)}</code>\n\n` +
    `💬 <b>Last Message:</b>\n<i>"${escapeHtml(lastUserMsg)}"</i>\n\n` +
    `👉 <a href="${adminChatUrl}">Open in Admin Inbox</a>`;
}

async function sendTelegramChatEscalation({ session, recentMessages }) {
  const text = formatChatEscalationTelegramMessage({ session, recentMessages });
  return sendTelegramMessage(text);
}

function formatErrorTelegramMessage({ context, error, details }) {
  const errMessage = error?.message || String(error || 'Unknown error');
  const contextName = context || 'System';
  let detailsStr = '';
  if (details) {
    const formattedDetails = typeof details === 'object' ? JSON.stringify(details, null, 2) : String(details);
    detailsStr = `\n\n📋 <b>Details:</b>\n<code>${escapeHtml(formattedDetails)}</code>`;
  }

  return `❌ <b>[RenderPDF Error: ${escapeHtml(contextName)}]</b>\n\n` +
    `⚠️ <b>Error:</b> <code>${escapeHtml(errMessage)}</code>` +
    detailsStr;
}

async function sendTelegramErrorAlert({ context, error, details }) {
  const text = formatErrorTelegramMessage({ context, error, details });
  return sendTelegramMessage(text);
}

function formatBillingAlertTelegramMessage({ userId, customerEmail, eventType, reason }) {
  const user = customerEmail || userId || 'Unknown user';
  const event = eventType || 'payment_failed';

  return `💳 <b>[RenderPDF Billing Alert]</b>\n\n` +
    `👤 <b>Customer:</b> <code>${escapeHtml(user)}</code>\n` +
    `⚠️ <b>Event:</b> <code>${escapeHtml(event)}</code>\n` +
    (reason ? `📝 <b>Reason:</b> ${escapeHtml(reason)}\n\n` : '\n') +
    `👉 <a href="https://renderpdf.vberkoz.com/app/admin#users">View in Admin Users</a>`;
}

async function sendTelegramBillingAlert({ userId, customerEmail, eventType, reason }) {
  const text = formatBillingAlertTelegramMessage({ userId, customerEmail, eventType, reason });
  return sendTelegramMessage(text);
}

async function sendChatEscalationAlert({ session, recentMessages }) {
  const recipient = process.env.OPERATIONS_ALERT_EMAIL || 'vberkoz@gmail.com';
  const { subject, html, text } = buildChatEscalationEmail({ session, recentMessages });
  
  const [sesOutcome, tgOutcome] = await Promise.allSettled([
    sendSESEmail({ to: recipient, subject, html, text }),
    sendTelegramChatEscalation({ session, recentMessages }),
  ]);

  const emailSent = sesOutcome.status === 'fulfilled';
  if (emailSent) {
    console.log(`Chat escalation alert email sent to ${recipient} (sessionId: ${session?.sessionId})`);
  } else {
    console.error(`Failed to send chat escalation alert to ${recipient}:`, sesOutcome.reason);
  }

  const tgSent = tgOutcome.status === 'fulfilled' && tgOutcome.value?.sent;
  if (tgSent) {
    console.log(`Chat escalation alert sent to Telegram (sessionId: ${session?.sessionId})`);
  }

  return {
    sent: emailSent || tgSent,
    recipient,
    response: sesOutcome.status === 'fulfilled' ? sesOutcome.value : null,
    telegramSent: Boolean(tgSent),
  };
}

async function sendOperatorChatReply({ to, replyMessage, sessionId }) {
  const recipient = String(to || '').trim();
  if (!recipient) return { sent: false, error: 'Recipient is required' };

  const subject = '[RenderPDF Support] Response to your inquiry';
  const text = `Hi,\n\nOur team has responded to your message on RenderPDF:\n\n${replyMessage}\n\nBest regards,\nRenderPDF Support\nhttps://renderpdf.vberkoz.com`;
  const html = `<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 20px; color: #1e293b;">
  <p>Hi,</p>
  <p>Our team has reviewed your inquiry and replied:</p>
  <div style="background: #f1f5f9; padding: 16px; border-left: 4px solid #2563eb; margin: 16px 0; border-radius: 4px; white-space: pre-wrap;">${escapeHtml(replyMessage)}</div>
  <p style="margin-top: 24px; color: #64748b; font-size: 13px;">— The RenderPDF Team<br><a href="https://renderpdf.vberkoz.com" style="color: #2563eb;">renderpdf.vberkoz.com</a></p>
</body>
</html>`;

  try {
    const res = await sendSESEmail({ to: recipient, subject, html, text });
    console.log(`Operator chat reply sent to ${recipient} (sessionId: ${sessionId})`);
    return { sent: true, recipient, response: res };
  } catch (err) {
    console.error(`Failed to send operator chat reply to ${recipient}:`, err);
    return { sent: false, error: err.message };
  }
}

module.exports = {
  sendSESEmail,
  buildPaymentFailedEmail,
  resolveCustomerEmail,
  sendPaymentFailedAlert,
  buildChatEscalationEmail,
  sendChatEscalationAlert,
  sendOperatorChatReply,
  sendTelegramMessage,
  sendTelegramChatEscalation,
  sendTelegramErrorAlert,
  sendTelegramBillingAlert,
  formatChatEscalationTelegramMessage,
  formatErrorTelegramMessage,
  formatBillingAlertTelegramMessage,
  setSESClient,
  setCognitoClient,
  setTelegramFetch,
  resetTelegramClient,
};
