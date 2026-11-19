'use strict';

const {
  receivePaddleWebhook,
  createCheckout,
  changePlan,
  openBillingPortal,
  readCustomerDashboard,
} = require('./billing');

const {
  readPublicStats,
  publicStatsResponse,
} = require('./public-stats');

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

async function routeRequest(event, saveAnalyticsFn) {
  const path = event.resource || event.path || '';
  let routeOverride = event.queryStringParameters?.route || event.queryStringParameters?.view || '';
  if (routeOverride && typeof routeOverride === 'string' && routeOverride.includes('%')) {
    try {
      routeOverride = decodeURIComponent(routeOverride);
    } catch {
      // keep original
    }
  }
  const effectivePath = routeOverride
    ? routeOverride.startsWith('/')
      ? routeOverride
      : `/${routeOverride}`
    : path;

  if (path.endsWith('/billing/webhook')) return receivePaddleWebhook(event);
  if (path.endsWith('/billing/checkout')) return createCheckout(event);
  if (path.endsWith('/billing/change-plan')) return changePlan(event);
  if (path.endsWith('/billing/portal')) return openBillingPortal(event);
  if (path.endsWith('/dashboard')) return readCustomerDashboard(event);
  if (
    path.endsWith('/public-stats') ||
    path.endsWith('/stats/public') ||
    path.endsWith('/stats/summary') ||
    effectivePath.endsWith('/public-stats') ||
    effectivePath.endsWith('/stats/public') ||
    effectivePath.endsWith('/stats/summary')
  ) {
    if (event.httpMethod === 'OPTIONS') return publicStatsResponse(204);
    return readPublicStats(event);
  }
  if (
    effectivePath.endsWith('/chat') ||
    effectivePath === '/api/v1/chat' ||
    effectivePath.includes('/admin/') ||
    effectivePath.startsWith('/users') ||
    effectivePath.includes('/api/v1/users') ||
    effectivePath.endsWith('/audit-logs') ||
    effectivePath.startsWith('/chats') ||
    effectivePath.endsWith('/chats')
  ) {
    return response(404, { error: 'Not found' });
  }

  switch (event.httpMethod) {
    case 'POST':
      return saveAnalyticsFn(event);
    case 'OPTIONS':
      return response(204);
    default:
      return response(405, { error: 'Method not allowed' });
  }
}

module.exports = {
  response,
  routeRequest,
};
