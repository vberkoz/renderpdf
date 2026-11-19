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

const {
  handleChatMessage,
  listAdminChats,
  getAdminChatTranscript,
  postAdminChatReply,
  updateAdminChatStatus,
} = require('./chat');

const {
  readAdminAnalytics,
} = require('./admin-analytics');

const {
  searchAdminUsers,
  readAdminUserDossier,
  handleAdminUserPlanOverride,
  handleAdminUserQuotaAdjust,
  handleAdminUserStatus,
  handleAdminKeyRevoke,
} = require('./admin-users');

const {
  listAdminAuditLogs,
} = require('./admin-audit');

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
  if (effectivePath.endsWith('/chat') || effectivePath === '/api/v1/chat') {
    if (event.httpMethod === 'OPTIONS' || event.httpMethod === 'POST')
      return handleChatMessage(event);
    return response(405, { error: 'Method not allowed' });
  }
  if (effectivePath.endsWith('/admin/analytics') || effectivePath.includes('/admin/analytics')) {
    if (event.httpMethod === 'OPTIONS') return response(204);
    if (event.httpMethod === 'GET') return readAdminAnalytics(event);
    return response(405, { error: 'Method not allowed' });
  }
  if (
    effectivePath.includes('/admin/users') ||
    effectivePath.includes('/api/v1/users') ||
    effectivePath.endsWith('/users') ||
    effectivePath.startsWith('/users/')
  ) {
    if (event.httpMethod === 'OPTIONS') return response(204);

    const planMatch =
      effectivePath.match(/\/(?:admin\/)?users\/([^/?#]+)\/plan$/) ||
      (event.path || '').match(/\/(?:admin\/)?users\/([^/?#]+)\/plan$/);
    if (planMatch || event.resource?.endsWith('/plan')) {
      const userId =
        event.pathParameters?.userId && event.pathParameters?.userId !== '{userId}'
          ? event.pathParameters.userId
          : planMatch
            ? planMatch[1]
            : null;
      if (event.httpMethod === 'POST') return handleAdminUserPlanOverride(event, userId);
      return response(405, { error: 'Method not allowed' });
    }

    const quotaMatch =
      effectivePath.match(/\/(?:admin\/)?users\/([^/?#]+)\/quota$/) ||
      (event.path || '').match(/\/(?:admin\/)?users\/([^/?#]+)\/quota$/);
    if (quotaMatch || event.resource?.endsWith('/quota')) {
      const userId =
        event.pathParameters?.userId && event.pathParameters?.userId !== '{userId}'
          ? event.pathParameters.userId
          : quotaMatch
            ? quotaMatch[1]
            : null;
      if (event.httpMethod === 'POST') return handleAdminUserQuotaAdjust(event, userId);
      return response(405, { error: 'Method not allowed' });
    }

    const statusMatch =
      effectivePath.match(/\/(?:admin\/)?users\/([^/?#]+)\/status$/) ||
      (event.path || '').match(/\/(?:admin\/)?users\/([^/?#]+)\/status$/);
    if (statusMatch || event.resource?.endsWith('/status')) {
      const userId =
        event.pathParameters?.userId && event.pathParameters?.userId !== '{userId}'
          ? event.pathParameters.userId
          : statusMatch
            ? statusMatch[1]
            : null;
      if (event.httpMethod === 'POST') return handleAdminUserStatus(event, userId);
      return response(405, { error: 'Method not allowed' });
    }

    const revokeMatch =
      effectivePath.match(/\/(?:admin\/)?users\/([^/?#]+)\/keys\/([^/?#]+)\/revoke$/) ||
      (event.path || '').match(/\/(?:admin\/)?users\/([^/?#]+)\/keys\/([^/?#]+)\/revoke$/);
    if (revokeMatch || event.resource?.endsWith('/revoke')) {
      const userId =
        event.pathParameters?.userId && event.pathParameters?.userId !== '{userId}'
          ? event.pathParameters.userId
          : revokeMatch
            ? revokeMatch[1]
            : null;
      const keyId =
        event.pathParameters?.keyId && event.pathParameters?.keyId !== '{keyId}'
          ? event.pathParameters.keyId
          : revokeMatch
            ? revokeMatch[2]
            : null;
      if (event.httpMethod === 'POST') return handleAdminKeyRevoke(event, userId, keyId);
      return response(405, { error: 'Method not allowed' });
    }

    const userIdParam = event.pathParameters?.userId || event.queryStringParameters?.userId;
    const match =
      effectivePath.match(/\/(?:admin\/)?users\/([^/?#]+)$/) ||
      (event.path || '').match(/\/(?:admin\/)?users\/([^/?#]+)$/);
    const userId =
      userIdParam && userIdParam !== '{userId}' ? userIdParam : match ? match[1] : null;
    if (userId && userId !== 'users') {
      if (event.httpMethod === 'GET') return readAdminUserDossier(event, userId);
      return response(405, { error: 'Method not allowed' });
    }
    if (event.httpMethod === 'GET') return searchAdminUsers(event);
    return response(405, { error: 'Method not allowed' });
  }
  if (effectivePath.includes('/admin/audit-logs') || effectivePath.endsWith('/audit-logs')) {
    if (event.httpMethod === 'OPTIONS') return response(204);
    if (event.httpMethod === 'GET') return listAdminAuditLogs(event);
    return response(405, { error: 'Method not allowed' });
  }
  if (
    effectivePath.includes('/admin/chats') ||
    effectivePath.endsWith('/chats') ||
    effectivePath.startsWith('/chats/')
  ) {
    if (event.httpMethod === 'OPTIONS') return response(204);

    const replyMatch =
      effectivePath.match(/\/(?:admin\/)?chats\/([^/?#]+)\/reply$/) ||
      (event.path || '').match(/\/(?:admin\/)?chats\/([^/?#]+)\/reply$/);
    if (replyMatch || event.resource?.endsWith('/reply')) {
      const sessionId =
        event.pathParameters?.sessionId && event.pathParameters?.sessionId !== '{sessionId}'
          ? event.pathParameters.sessionId
          : replyMatch
            ? replyMatch[1]
            : null;
      if (event.httpMethod === 'POST') return postAdminChatReply(event, sessionId);
      return response(405, { error: 'Method not allowed' });
    }

    const statusMatch =
      effectivePath.match(/\/(?:admin\/)?chats\/([^/?#]+)\/status$/) ||
      (event.path || '').match(/\/(?:admin\/)?chats\/([^/?#]+)\/status$/);
    if (
      statusMatch ||
      (event.resource?.includes('/chats/') && event.resource?.endsWith('/status'))
    ) {
      const sessionId =
        event.pathParameters?.sessionId && event.pathParameters?.sessionId !== '{sessionId}'
          ? event.pathParameters.sessionId
          : statusMatch
            ? statusMatch[1]
            : null;
      if (event.httpMethod === 'POST') return updateAdminChatStatus(event, sessionId);
      return response(405, { error: 'Method not allowed' });
    }

    const sessionIdParam =
      event.pathParameters?.sessionId || event.queryStringParameters?.sessionId;
    const match =
      effectivePath.match(/\/(?:admin\/)?chats\/([^/?#]+)$/) ||
      (event.path || '').match(/\/(?:admin\/)?chats\/([^/?#]+)$/);
    const sessionId =
      sessionIdParam && sessionIdParam !== '{sessionId}' ? sessionIdParam : match ? match[1] : null;
    if (sessionId && sessionId !== 'chats') {
      if (event.httpMethod === 'GET') return getAdminChatTranscript(event, sessionId);
      return response(405, { error: 'Method not allowed' });
    }

    if (event.httpMethod === 'GET') return listAdminChats(event);
    return response(405, { error: 'Method not allowed' });
  }

  switch (event.httpMethod) {
    case 'GET':
      return readAdminAnalytics(event);
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
