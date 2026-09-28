/**
 * Shared API Client for RenderPDF Admin Console
 * Automatically injects Cognito Bearer token and formats errors.
 */

import { getSessionToken, startSignIn } from './auth.js';

const API_PREFIX = '/api/v1';

/**
 * Standardized fetch wrapper for admin endpoints.
 * @param {string} endpoint - Relative path under /api/v1 (e.g. '/analytics', '/admin/users')
 * @param {RequestInit} [options] - Standard fetch options
 * @returns {Promise<any>}
 */
export async function adminFetch(endpoint, options = {}) {
  const token = getSessionToken();
  if (!token) {
    startSignIn();
    throw new Error('Authentication required');
  }

  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;

  // Map route to the active API Gateway resource path.
  // /analytics lives under /api/v1/analytics; other admin paths live under /api/v1/admin/*
  let primaryUrl;
  let fallbackUrl;

  if (endpoint.startsWith('http') || endpoint.startsWith('/api/')) {
    primaryUrl = endpoint;
  } else if (cleanEndpoint.startsWith('/analytics')) {
    primaryUrl = `${API_PREFIX}${cleanEndpoint}`;
    fallbackUrl = `${API_PREFIX}/admin${cleanEndpoint}`;
  } else if (cleanEndpoint.startsWith('/admin/analytics')) {
    primaryUrl = `${API_PREFIX}${cleanEndpoint.replace('/admin', '')}`;
    fallbackUrl = `${API_PREFIX}${cleanEndpoint}`;
  } else if (cleanEndpoint.startsWith('/admin/')) {
    primaryUrl = `${API_PREFIX}${cleanEndpoint}`;
    fallbackUrl = `${API_PREFIX}${cleanEndpoint.replace('/admin', '')}`;
  } else {
    primaryUrl = `${API_PREFIX}/admin${cleanEndpoint}`;
    fallbackUrl = `${API_PREFIX}${cleanEndpoint}`;
  }

  const candidateUrls = fallbackUrl ? [primaryUrl, fallbackUrl] : [primaryUrl];

  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...(options.headers || {})
  };

  let lastResponse = null;
  let lastPayload = null;

  for (const url of candidateUrls) {
    const response = await fetch(url, { ...options, headers });
    lastResponse = response;

    if (response.status === 401) {
      startSignIn();
      throw new Error('Session expired. Redirecting to sign in...');
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    lastPayload = payload;

    // AWS API Gateway returns 403 {"message":"Missing Authentication Token"} for unmapped routes
    const isUnmapped = response.status === 404 || 
      (response.status === 403 && (payload?.message === 'Missing Authentication Token' || payload?.message === 'Forbidden'));

    if (isUnmapped && candidateUrls.length > 1 && url === candidateUrls[0]) {
      continue;
    }

    if (!response.ok) {
      if (response.status === 403) {
        throw new Error('Administrative privileges required (403 Forbidden)');
      }
      const errorMsg = payload?.error || payload?.message || `API error (${response.status})`;
      const error = new Error(errorMsg);
      error.status = response.status;
      error.data = payload;
      throw error;
    }

    return payload;
  }

  if (lastResponse && !lastResponse.ok) {
    if (lastResponse.status === 403) {
      throw new Error('Administrative privileges required (403 Forbidden)');
    }
    const errorMsg = lastPayload?.error || lastPayload?.message || `API error (${lastResponse.status})`;
    const error = new Error(errorMsg);
    error.status = lastResponse.status;
    error.data = lastPayload;
    throw error;
  }

  return lastPayload;
}
