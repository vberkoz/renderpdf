'use strict';

const crypto = require('node:crypto');

const TABLE_NAME = process.env.TABLE_NAME || 'RenderPdfTable';
const PADDLE_API_KEY = process.env.PADDLE_API_KEY || '';
const PADDLE_API_BASE = String(process.env.PADDLE_API_BASE || 'https://api.paddle.com').replace(
  /\/+$/,
  ''
);
const PADDLE_CLIENT_TOKEN = process.env.PADDLE_CLIENT_TOKEN || '';
const PADDLE_ENVIRONMENT = process.env.PADDLE_ENVIRONMENT || 'production';
const PADDLE_PRICES = {
  starter: process.env.PADDLE_STARTER_PRICE_ID || '',
  pro: process.env.PADDLE_PRO_PRICE_ID || '',
  starter_annual: process.env.PADDLE_STARTER_ANNUAL_PRICE_ID || '',
  pro_annual: process.env.PADDLE_PRO_ANNUAL_PRICE_ID || '',
};
const PADDLE_OVERAGE_PRICE_ID = process.env.PADDLE_OVERAGE_PRICE_ID || '';
const OVERAGE_RENDER_CREDITS = positiveInteger(process.env.OVERAGE_RENDER_CREDITS, 1000);
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET || '';
const PADDLE_CHECKOUT_URL = process.env.PADDLE_CHECKOUT_URL || '';
const PADDLE_SUBSCRIPTION_EVENTS = new Set([
  'subscription.created',
  'subscription.updated',
  'subscription.activated',
  'subscription.trialing',
  'subscription.canceled',
  'subscription.past_due',
  'subscription.paused',
  'subscription.resumed',
]);
const QUOTA_UPGRADE_EVENTS = new Set([
  'subscription.created',
  'subscription.updated',
  'subscription.activated',
]);

function response(statusCode, payload) {
  return {
    statusCode,
    body: payload == null ? '' : JSON.stringify(payload),
    headers: {
      'Access-Control-Allow-Origin': 'https://renderpdf.vberkoz.com',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, max-age=0',
    },
  };
}

function customerId(request) {
  return String(request.requestContext?.authorizer?.claims?.sub || '').trim();
}

function customerResponse(statusCode, payload) {
  return response(statusCode, payload);
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nextMonthStart(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function stringValue(item, key) {
  return item?.[key]?.S || (typeof item?.[key] === 'string' ? item[key] : '');
}

function numberValue(item, key) {
  if (item?.[key]?.N != null) {
    const value = Number.parseInt(item[key].N, 10);
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof item?.[key] === 'number') return item[key];
  if (typeof item?.[key] === 'string') {
    const parsed = Number.parseInt(item[key], 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function header(headers, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === target) return String(value || '');
  }
  return '';
}

function safeEqual(left, right) {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signaturePartsFrom(value) {
  const parts = {};
  for (const pair of String(value || '').split(';')) {
    const [key, item] = pair.trim().split('=', 2);
    if (key === 'ts') parts.timestamp = item;
    if (key === 'h1' && !parts.hash) parts.hash = item;
  }
  return parts;
}

async function paddleRequest(path, options = {}) {
  const apiBase = String(process.env.PADDLE_API_BASE || PADDLE_API_BASE || 'https://api.paddle.com').replace(
    /\/+$/,
    ''
  );
  const apiKey = process.env.PADDLE_API_KEY || PADDLE_API_KEY;
  const res = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Paddle-Version': '1',
      Authorization: `Bearer ${apiKey}`,
      ...(options.headers || {}),
    },
  });
  let payload;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    const error = new Error(payload?.error?.detail || `Paddle API returned ${res.status}`);
    error.status = res.status;
    error.code = payload?.error?.code || '';
    throw error;
  }
  return payload;
}

module.exports = {
  TABLE_NAME,
  PADDLE_API_KEY,
  PADDLE_API_BASE,
  PADDLE_CLIENT_TOKEN,
  PADDLE_ENVIRONMENT,
  PADDLE_PRICES,
  PADDLE_OVERAGE_PRICE_ID,
  OVERAGE_RENDER_CREDITS,
  PADDLE_WEBHOOK_SECRET,
  PADDLE_CHECKOUT_URL,
  PADDLE_SUBSCRIPTION_EVENTS,
  QUOTA_UPGRADE_EVENTS,
  response,
  customerId,
  customerResponse,
  positiveInteger,
  nextMonthStart,
  dateKey,
  stringValue,
  numberValue,
  header,
  safeEqual,
  signaturePartsFrom,
  paddleRequest,
};
