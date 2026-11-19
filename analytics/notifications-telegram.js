'use strict';

let customTelegramFetch = null;

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

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

function formatErrorTelegramMessage({ context, error, details }) {
  const errMessage = error?.message || String(error || 'Unknown error');
  const contextName = context || 'System';
  let detailsStr = '';
  if (details) {
    const formattedDetails =
      typeof details === 'object' ? JSON.stringify(details, null, 2) : String(details);
    detailsStr = `\n\n📋 <b>Details:</b>\n<code>${escapeHtml(formattedDetails)}</code>`;
  }

  return (
    `❌ <b>[RenderPDF Error: ${escapeHtml(contextName)}]</b>\n\n` +
    `⚠️ <b>Error:</b> <code>${escapeHtml(errMessage)}</code>` +
    detailsStr
  );
}

async function sendTelegramErrorAlert({ context, error, details }) {
  const text = formatErrorTelegramMessage({ context, error, details });
  return sendTelegramMessage(text);
}

function formatBillingAlertTelegramMessage({ userId, customerEmail, eventType, reason }) {
  const user = customerEmail || userId || 'Unknown user';
  const event = eventType || 'payment_failed';

  return (
    `💳 <b>[RenderPDF Billing Alert]</b>\n\n` +
    `👤 <b>Customer:</b> <code>${escapeHtml(user)}</code>\n` +
    `⚠️ <b>Event:</b> <code>${escapeHtml(event)}</code>` +
    (reason ? `\n📝 <b>Reason:</b> ${escapeHtml(reason)}` : '')
  );
}

async function sendTelegramBillingAlert({ userId, customerEmail, eventType, reason }) {
  const text = formatBillingAlertTelegramMessage({ userId, customerEmail, eventType, reason });
  return sendTelegramMessage(text);
}

module.exports = {
  escapeHtml,
  sendTelegramMessage,
  formatErrorTelegramMessage,
  sendTelegramErrorAlert,
  formatBillingAlertTelegramMessage,
  sendTelegramBillingAlert,
  setTelegramFetch,
  resetTelegramClient,
};
