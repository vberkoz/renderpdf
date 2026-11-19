'use strict';

const crypto = require('node:crypto');

let UpdateItemCommand;
try {
  ({ UpdateItemCommand } = require('@aws-sdk/client-dynamodb'));
} catch {
  UpdateItemCommand = class UpdateItemCommand {
    constructor(input) {
      this.input = input;
    }
  };
}

const { ddb } = require('./admin-analytics');
const { getBilling } = require('./admin-users');
const { sendPaymentFailedAlert } = require('./notifications');
const {
  TABLE_NAME,
  PADDLE_WEBHOOK_SECRET,
  PADDLE_OVERAGE_PRICE_ID,
  OVERAGE_RENDER_CREDITS,
  PADDLE_SUBSCRIPTION_EVENTS,
  QUOTA_UPGRADE_EVENTS,
  response,
  header,
  safeEqual,
  signaturePartsFrom,
} = require('./billing-common');

const {
  billingFields,
  paddleEventTime,
  creditOverage,
  updateQuotaOnSubscriptionChange,
} = require('./billing-subscriptions');

async function receivePaddleWebhook(request) {
  const webhookSecret = process.env.PADDLE_WEBHOOK_SECRET || PADDLE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('Paddle webhook rejected: secret is not configured');
    return response(503, { error: 'Billing webhook is not configured' });
  }
  const rawBody = request.body || '';
  const signatureParts = signaturePartsFrom(header(request.headers, 'paddle-signature'));
  if (
    !signatureParts.timestamp ||
    !signatureParts.hash ||
    Math.abs(Math.floor(Date.now() / 1000) - Number(signatureParts.timestamp)) > 300
  ) {
    console.warn('Paddle webhook rejected: signature header is missing or stale');
    return response(401, { error: 'Invalid webhook signature' });
  }
  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(`${signatureParts.timestamp}:${rawBody}`)
    .digest('hex');
  if (!safeEqual(signatureParts.hash, expected)) {
    console.warn('Paddle webhook rejected: signature mismatch');
    return response(401, { error: 'Invalid webhook signature' });
  }
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return response(400, { error: 'Invalid JSON body' });
  }
  const eventType = String(payload?.event_type || '').trim();
  if (eventType === 'transaction.completed') {
    return receiveOverageWebhook(payload);
  }
  if (eventType === 'transaction.payment_failed') {
    return receivePaymentFailedWebhook(payload);
  }
  if (!PADDLE_SUBSCRIPTION_EVENTS.has(eventType)) {
    console.log(`Paddle webhook ignored: unsupported event type ${eventType || 'unknown'}`);
    return response(200, { received: true, ignored: true });
  }
  const eventId = String(payload?.event_id || '').trim();
  const occurredAt = paddleEventTime(payload?.occurred_at);
  if (!eventId || !occurredAt) {
    console.warn(
      `Paddle webhook ignored: ${eventType} is missing a valid event ID or occurred_at timestamp`
    );
    return response(200, { received: true, ignored: true });
  }
  const attributes = payload?.data || {};
  const userId = String(attributes?.custom_data?.user_id || '').trim();
  const subscriptionId = String(attributes?.id || '').trim();
  if (!userId || !subscriptionId) {
    console.log(
      `Paddle webhook ignored: ${eventType} does not contain RenderPDF subscription custom data`
    );
    return response(200, { received: true, ignored: true });
  }
  try {
    await saveBillingWebhook(userId, subscriptionId, attributes, eventId, occurredAt, eventType);
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      console.log(`Paddle webhook ignored: duplicate or out-of-order ${eventType} (${eventId})`);
      return response(200, { received: true, ignored: true });
    }
    console.error('Could not save billing webhook', err);
    return response(500, { error: 'Could not save billing state' });
  }
  console.log(`Paddle subscription synced: ${eventType} (${attributes.status || 'unknown'})`);
  return response(200, { received: true });
}

async function receiveOverageWebhook(payload) {
  const eventId = String(payload?.event_id || '').trim();
  const occurredAt = paddleEventTime(payload?.occurred_at);
  const transaction = payload?.data || {};
  const userId = String(transaction?.custom_data?.user_id || '').trim();
  const transactionId = String(transaction?.id || '').trim();
  const overagePriceId = process.env.PADDLE_OVERAGE_PRICE_ID || PADDLE_OVERAGE_PRICE_ID || '';
  const itemPriceId = String(
    transaction.items?.[0]?.price?.id || transaction.items?.[0]?.price_id || ''
  );
  const isOverage =
    transaction?.custom_data?.entitlement === 'overage' &&
    Array.isArray(transaction.items) &&
    transaction.items.length === 1 &&
    itemPriceId === overagePriceId &&
    Number(transaction.items[0]?.quantity) === 1;
  if (!eventId || !occurredAt || !userId || !transactionId || !isOverage) {
    console.log('Paddle transaction.completed ignored: not a valid RenderPDF overage purchase');
    return response(200, { received: true, ignored: true });
  }
  try {
    await creditOverage(userId, transactionId, eventId, occurredAt);
  } catch (err) {
    if (
      err?.name === 'TransactionCanceledException' ||
      err?.name === 'ConditionalCheckFailedException'
    ) {
      console.log(`Paddle overage webhook ignored: duplicate transaction ${transactionId}`);
      return response(200, { received: true, ignored: true });
    }
    console.error('Could not apply overage credit', err);
    return response(500, { error: 'Could not apply overage credit' });
  }
  console.log(`Paddle overage credit applied: ${transactionId} (+${OVERAGE_RENDER_CREDITS})`);
  return response(200, { received: true });
}

async function receivePaymentFailedWebhook(payload) {
  const transaction = payload?.data || {};
  const userId = String(transaction?.custom_data?.user_id || '').trim();
  const customerEmail = String(
    transaction?.custom_data?.user_email || transaction?.customer?.email || ''
  ).trim();
  if (userId) {
    const previousBilling = await getBilling(userId);
    if (!previousBilling?.pastDueAlertSentAt) {
      try {
        const currentTableName = process.env.TABLE_NAME || TABLE_NAME;
        await sendPaymentFailedAlert(ddb, currentTableName, userId, customerEmail);
        await ddb.send(
          new UpdateItemCommand({
            TableName: currentTableName,
            Key: { requestId: { S: `BILLING#${userId}` }, timestamp: { N: '0' } },
            UpdateExpression:
              'SET pastDueAlertSentAt = :now, #status = if_not_exists(#status, :pastDue)',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':now': { N: String(Math.floor(Date.now() / 1000)) },
              ':pastDue': { S: 'past_due' },
            },
          })
        );
      } catch (alertErr) {
        console.error('Could not send payment failed alert from transaction webhook', alertErr);
      }
    }
  }
  return response(200, { received: true });
}

async function saveBillingWebhook(
  userId,
  subscriptionId,
  attributes,
  eventId,
  occurredAt,
  eventType = ''
) {
  const previousBilling = await getBilling(userId);
  if (previousBilling?.manualOverride === true) {
    const isDowngradeOrCancel =
      ['subscription.canceled', 'subscription.paused', 'subscription.past_due'].includes(
        eventType
      ) ||
      attributes?.status === 'canceled' ||
      attributes?.status === 'past_due';

    if (isDowngradeOrCancel) {
      console.log(
        `Paddle webhook ignored: manualOverride is active for user ${userId} (${eventType})`
      );
      return;
    }
  }

  const fields = billingFields(userId, subscriptionId, attributes, eventId, occurredAt);
  const names = {};
  const values = {};
  const updates = [];
  for (const [name, value] of Object.entries(fields)) {
    const token = `#${name}`;
    const valueToken = `:${name}`;
    names[token] = name;
    values[valueToken] = value;
    updates.push(`${token} = ${valueToken}`);
  }
  if (previousBilling?.manualOverride === true) {
    names['#manualOverride'] = 'manualOverride';
    values[':manualOverride'] = { BOOL: false };
    updates.push('#manualOverride = :manualOverride');
  }
  names['#eventTime'] = 'paddleEventOccurredAtMs';
  names['#eventId'] = 'paddleEventId';
  values[':eventTime'] = fields.paddleEventOccurredAtMs;
  values[':eventId'] = fields.paddleEventId;
  const isDirectAction = eventId.startsWith('sync-') || eventId.startsWith('plan-change-');
  const currentTableName = process.env.TABLE_NAME || TABLE_NAME;
  const updateInput = {
    TableName: currentTableName,
    Key: { requestId: { S: `BILLING#${userId}` }, timestamp: { N: '0' } },
    UpdateExpression: `SET ${updates.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
  if (!isDirectAction) {
    updateInput.ConditionExpression =
      '(attribute_not_exists(#eventTime) OR #eventTime < :eventTime) AND (attribute_not_exists(#eventId) OR #eventId <> :eventId)';
  }
  await ddb.send(new UpdateItemCommand(updateInput));
  const isPastDue = attributes?.status === 'past_due' || eventType === 'subscription.past_due';
  if (
    isPastDue &&
    (previousBilling?.status !== 'past_due' || !previousBilling?.pastDueAlertSentAt)
  ) {
    const customerEmail = String(
      attributes?.custom_data?.user_email ||
        attributes?.customer?.email ||
        previousBilling?.customerEmail ||
        ''
    ).trim();
    try {
      await sendPaymentFailedAlert(ddb, currentTableName, userId, customerEmail);
      await ddb.send(
        new UpdateItemCommand({
          TableName: currentTableName,
          Key: { requestId: { S: `BILLING#${userId}` }, timestamp: { N: '0' } },
          UpdateExpression: 'SET pastDueAlertSentAt = :now',
          ExpressionAttributeValues: {
            ':now': { N: String(Math.floor(Date.now() / 1000)) },
          },
        })
      );
    } catch (alertErr) {
      console.error('Could not send payment failed alert', alertErr);
    }
  }
  if (!eventType || QUOTA_UPGRADE_EVENTS.has(eventType)) {
    await updateQuotaOnSubscriptionChange(userId, occurredAt, attributes, previousBilling);
  }
}

module.exports = {
  receivePaddleWebhook,
  receiveOverageWebhook,
  receivePaymentFailedWebhook,
  saveBillingWebhook,
};
