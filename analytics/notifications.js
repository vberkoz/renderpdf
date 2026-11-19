'use strict';

const email = require('./notifications-email');
const telegram = require('./notifications-telegram');

async function sendPaymentFailedAlert(ddb, tableName, userId, customerEmail) {
  const resolvedEmail = await email.resolveCustomerEmail(ddb, tableName, userId, customerEmail);
  if (!resolvedEmail) {
    console.warn(`No email found for past due user ${userId}; skipping email notification`);
    await telegram
      .sendTelegramBillingAlert({
        userId,
        customerEmail: null,
        eventType: 'subscription.past_due',
        reason: 'Missing email',
      })
      .catch(() => {});
    return { sent: false, reason: 'missing_email' };
  }

  const { subject, html, text } = email.buildPaymentFailedEmail(resolvedEmail);
  try {
    const [sesRes, tgRes] = await Promise.allSettled([
      email.sendSESEmail({ to: resolvedEmail, subject, html, text }),
      telegram.sendTelegramBillingAlert({
        userId,
        customerEmail: resolvedEmail,
        eventType: 'subscription.past_due',
      }),
    ]);
    console.log(`Payment failed alert email sent to ${resolvedEmail} (userId: ${userId})`);
    const emailSent = sesRes.status === 'fulfilled';
    const tgSent = tgRes.status === 'fulfilled' && tgRes.value?.sent;
    return { sent: emailSent, recipient: resolvedEmail, telegramSent: Boolean(tgSent) };
  } catch (err) {
    console.error(`Failed to send payment failed alert email to ${resolvedEmail}:`, err);
    return { sent: false, error: err.message };
  }
}

async function sendChatEscalationAlert({ session, recentMessages }) {
  const recipient = process.env.OPERATIONS_ALERT_EMAIL || 'vberkoz@gmail.com';
  const { subject, html, text } = email.buildChatEscalationEmail({ session, recentMessages });

  const [sesOutcome, tgOutcome] = await Promise.allSettled([
    email.sendSESEmail({ to: recipient, subject, html, text }),
    telegram.sendTelegramChatEscalation({ session, recentMessages }),
  ]);

  const emailSent = sesOutcome.status === 'fulfilled';
  if (emailSent) {
    console.log(
      `Chat escalation alert email sent to ${recipient} (sessionId: ${session?.sessionId})`
    );
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

module.exports = {
  // Email functions
  sendSESEmail: email.sendSESEmail,
  buildPaymentFailedEmail: email.buildPaymentFailedEmail,
  resolveCustomerEmail: email.resolveCustomerEmail,
  buildChatEscalationEmail: email.buildChatEscalationEmail,
  sendOperatorChatReply: email.sendOperatorChatReply,
  setSESClient: email.setSESClient,
  setCognitoClient: email.setCognitoClient,

  // Telegram functions
  sendTelegramMessage: telegram.sendTelegramMessage,
  sendTelegramChatEscalation: telegram.sendTelegramChatEscalation,
  sendTelegramErrorAlert: telegram.sendTelegramErrorAlert,
  sendTelegramBillingAlert: telegram.sendTelegramBillingAlert,
  formatChatEscalationTelegramMessage: telegram.formatChatEscalationTelegramMessage,
  formatErrorTelegramMessage: telegram.formatErrorTelegramMessage,
  formatBillingAlertTelegramMessage: telegram.formatBillingAlertTelegramMessage,
  setTelegramFetch: telegram.setTelegramFetch,
  resetTelegramClient: telegram.resetTelegramClient,

  // Orchestrators
  sendPaymentFailedAlert,
  sendChatEscalationAlert,
};
