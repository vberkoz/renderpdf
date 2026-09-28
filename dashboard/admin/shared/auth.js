/**
 * Shared Authentication Module for RenderPDF Admin Console
 * Validates Cognito ID token and enforces RBAC guards.
 */

const COGNITO_DOMAIN = 'https://renderpdf-auth-653268860643.auth.us-east-1.amazoncognito.com';
const COGNITO_CLIENT_ID = '78pkhoj4ml959gb80coslgm42t';
const COGNITO_REDIRECT_URI = 'https://renderpdf.vberkoz.com/app/callback';
const STATS_ALLOWED_EMAIL = 'vberkoz@gmail.com';

/**
 * Decodes the base64 URL encoded JWT payload safely.
 */
export function decodeTokenPayload(token) {
  try {
    const encodedPayload = token.split('.')[1];
    const base64 = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(atob(base64).split('').map((char) =>
      `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`
    ).join('')));
  } catch {
    return null;
  }
}

/**
 * Retrieves the active ID token from localStorage if valid and unexpired.
 */
export function getSessionToken() {
  const token = localStorage.getItem('id_token');
  if (!token) return null;
  const payload = decodeTokenPayload(token);
  if (!payload || !payload.exp || payload.exp * 1000 <= Date.now()) {
    localStorage.removeItem('id_token');
    localStorage.removeItem('access_token');
    return null;
  }
  return token;
}

/**
 * Enforces admin authorization:
 * - Redirects to /app/login if unauthenticated.
 * - Returns { authorized: false } if authenticated but lacking admin privileges.
 * - Returns { authorized: true, email, sub, token } if an approved admin.
 */
export function checkAdminAuth() {
  const token = getSessionToken();
  if (!token) {
    startSignIn();
    return { authorized: false, reason: 'unauthenticated' };
  }

  const payload = decodeTokenPayload(token);
  const email = String(payload?.email || '').trim().toLowerCase();
  const groups = Array.isArray(payload?.['cognito:groups']) ? payload['cognito:groups'] : [];
  const isAdmin = groups.includes('Admins') || email === STATS_ALLOWED_EMAIL;

  if (!isAdmin) {
    return { authorized: false, reason: 'forbidden', email };
  }

  return { authorized: true, email, sub: payload.sub, token };
}

/**
 * Redirects to the login flow with post_login_redirect set to /app/admin.
 */
export function startSignIn() {
  localStorage.setItem('post_login_redirect', '/app/admin');
  const authUrl = `${COGNITO_DOMAIN}/oauth2/authorize?` +
    `client_id=${COGNITO_CLIENT_ID}&` +
    'response_type=token&scope=email+openid+profile&' +
    `redirect_uri=${encodeURIComponent(COGNITO_REDIRECT_URI)}&identity_provider=Google`;
  window.location.replace(authUrl);
}

/**
 * Clears tokens and signs out the current operator.
 */
export function signOut() {
  localStorage.removeItem('id_token');
  localStorage.removeItem('access_token');
  localStorage.removeItem('post_login_redirect');
  window.location.assign('/app/login');
}
