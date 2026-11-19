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

module.exports = {
  // Email functions
  sendSESEmail: email.sendSESEmail,
  buildPaymentFailedEmail: email.buildPaymentFailedEmail,
  resolveCustomerEmail: email.resolveCustomerEmail,
  setSESClient: email.setSESClient,
  setCognitoClient: email.setCognitoClient,

  // Telegram functions
  sendTelegramMessage: telegram.sendTelegramMessage,
  sendTelegramErrorAlert: telegram.sendTelegramErrorAlert,
  sendTelegramBillingAlert: telegram.sendTelegramBillingAlert,
  formatErrorTelegramMessage: telegram.formatErrorTelegramMessage,
  formatBillingAlertTelegramMessage: telegram.formatBillingAlertTelegramMessage,
  setTelegramFetch: telegram.setTelegramFetch,
  resetTelegramClient: telegram.resetTelegramClient,

  // Orchestrators
  sendPaymentFailedAlert,
};
