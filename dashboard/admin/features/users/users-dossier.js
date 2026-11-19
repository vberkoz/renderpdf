/**
 * Customer Dossier Drawer Module (Route: /admin/users/:userId)
 * Sliding drawer displaying identity, billing, monthly quota track, active API keys,
 * recent render telemetry, and account suspension controls.
 */

import { adminFetch } from '../../shared/api.js';
import { openModal, closeModal, showToast } from '../../shared/ui.js';
import { escapeHtml, formatCount, formatDate, formatBytes } from './users-common.js';

/**
 * Fetches the detailed user dossier from the backend.
 * @param {string} userId
 * @returns {Promise<object>}
 */
export async function fetchUserDossier(userId) {
  if (!userId) throw new Error('User ID is required');
  return await adminFetch(`/users/${encodeURIComponent(userId)}`);
}

/**
 * Retrieves the existing dossier drawer DOM element or creates it if missing.
 * @returns {HTMLElement|null}
 */
export function getOrCreateDrawerElement() {
  if (typeof document === 'undefined') return null;
  let drawer = document.getElementById('admin-user-dossier-drawer');
  if (!drawer) {
    drawer = document.createElement('div');
    drawer.id = 'admin-user-dossier-drawer';
    drawer.className = 'admin-drawer-backdrop';
    drawer.setAttribute('hidden', '');
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-labelledby', 'admin-dossier-title');

    drawer.innerHTML = `
      <div class="admin-drawer" tabindex="-1">
        <header class="admin-drawer-header">
          <div class="admin-drawer-title-group">
            <h2 id="admin-dossier-title" class="admin-drawer-title">
              <span>Customer Dossier</span>
            </h2>
            <span id="admin-dossier-subtitle" class="admin-drawer-subtitle">Loading customer profile...</span>
          </div>
          <button type="button" id="admin-dossier-close-btn" class="admin-drawer-close" aria-label="Close dossier drawer">&times;</button>
        </header>
        <div id="admin-dossier-body" class="admin-drawer-body">
          <div class="admin-drawer-loading">
            <span class="admin-loading-spinner-small"></span>
            <span>Loading user telemetry and identity...</span>
          </div>
        </div>
      </div>
    `;

    const container = document.getElementById('admin-modal-container') || document.body;
    if (container && typeof container.appendChild === 'function') {
      container.appendChild(drawer);
    }
  }

  // Bind close button and backdrop click once
  if (!drawer._listenersBound) {
    drawer._listenersBound = true;
    drawer.addEventListener('click', (e) => {
      if (
        e.target === drawer ||
        (e.target.classList && e.target.classList.contains('admin-drawer-backdrop'))
      ) {
        closeModal(drawer);
      }
    });

    const closeBtn = drawer.querySelector('#admin-dossier-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        closeModal(drawer);
      });
    }
  }

  return drawer;
}

/**
 * Renders the 6 dossier sub-panel cards into the drawer body.
 * @param {HTMLElement} bodyEl
 * @param {object} data
 */
export function renderDossierContent(bodyEl, data) {
  if (!bodyEl) return;
  const user = data?.user || {};
  const billing = data?.billing || {};
  const quota = data?.quota || {};
  const apiKeys = Array.isArray(data?.apiKeys) ? data.apiKeys : [];
  const recentRequests = Array.isArray(data?.recentRequests) ? data.recentRequests : [];

  const quotaUsed = Number(quota.used) || 0;
  const quotaLimit = Number(quota.limit) || 1;
  const quotaPct = Math.min(100, Math.round((quotaUsed / quotaLimit) * 100));
  let quotaColorClass = '';
  if (quotaPct >= 100) quotaColorClass = 'progress-danger';
  else if (quotaPct >= 80) quotaColorClass = 'progress-warning';

  const tierClass = `badge-${(billing.tier || 'free').toLowerCase()}`;
  const statusClass = `badge-status-${(billing.status || 'active').toLowerCase()}`;

  bodyEl.innerHTML = `
    <!-- Card A: Identity -->
    <div class="admin-dossier-card" id="dossier-card-identity">
      <div class="admin-dossier-card-header">
        <h3 class="admin-dossier-card-title">
          <span><svg class="lucide lucide-user" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span>
          <span>Customer Identity</span>
        </h3>
        <span class="badge ${user.enabled ? 'badge-status-active' : 'badge-status-canceled'}">
          ${user.enabled ? 'Enabled' : 'Suspended'}
        </span>
      </div>
      <div class="admin-dossier-grid">
        <div class="admin-dossier-field full-width">
          <span class="admin-dossier-label">Cognito User ID (sub)</span>
          <span class="admin-dossier-value">
            <code class="admin-dossier-code" id="dossier-val-sub">${escapeHtml(user.id)}</code>
            <button type="button" class="admin-btn-icon-copy" data-copy="${escapeHtml(user.id)}" title="Copy User ID" aria-label="Copy User ID"><svg class="lucide lucide-copy" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button>
          </span>
        </div>
        <div class="admin-dossier-field">
          <span class="admin-dossier-label">Email Address</span>
          <span class="admin-dossier-value" id="dossier-val-email">
            ${escapeHtml(user.email || '—')}
            ${user.emailVerified ? '<span class="badge badge-status-active" style="font-size: 10px;">Verified</span>' : '<span class="badge badge-status-past-due" style="font-size: 10px;">Unverified</span>'}
          </span>
        </div>
        <div class="admin-dossier-field">
          <span class="admin-dossier-label">Account Created</span>
          <span class="admin-dossier-value" id="dossier-val-created">${formatDate(user.createdAt)}</span>
        </div>
      </div>
    </div>

    <!-- Card B: Plan & Billing -->
    <div class="admin-dossier-card" id="dossier-card-billing">
      <div class="admin-dossier-card-header">
        <h3 class="admin-dossier-card-title">
          <span><svg class="lucide lucide-credit-card" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg></span>
          <span>Plan &amp; Billing</span>
        </h3>
        <div style="display: flex; gap: 6px; align-items: center;">
          ${billing.manualOverride ? '<span class="badge badge-override-active" title="Locked from Paddle overwrite"><svg class="lucide lucide-lock" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-1px;margin-right:3px;"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Override Active</span>' : ''}
          <span class="badge ${tierClass}">${escapeHtml(billing.tier || 'free')}</span>
        </div>
      </div>
      <div class="admin-dossier-grid">
        <div class="admin-dossier-field">
          <span class="admin-dossier-label">Subscription Plan</span>
          <span class="admin-dossier-value" id="dossier-val-plan">${escapeHtml(billing.plan || 'Free')}</span>
        </div>
        <div class="admin-dossier-field">
          <span class="admin-dossier-label">Billing Status</span>
          <span class="admin-dossier-value">
            <span class="badge ${statusClass}">${escapeHtml(billing.status || 'active')}</span>
          </span>
        </div>
        <div class="admin-dossier-field">
          <span class="admin-dossier-label">Billing Provider</span>
          <span class="admin-dossier-value" id="dossier-val-provider">
            ${billing.provider === 'paddle' ? 'Paddle Billing' : billing.provider === 'manual' ? 'Manual Operator Grant' : 'None'}
          </span>
        </div>
        <div class="admin-dossier-field">
          <span class="admin-dossier-label">${billing.endsAt ? 'Access Ends At' : 'Next Renewal'}</span>
          <span class="admin-dossier-value" id="dossier-val-renewal">
            ${billing.renewsAt ? formatDate(billing.renewsAt) : billing.endsAt ? formatDate(billing.endsAt) : 'N/A'}
          </span>
        </div>
        ${
          billing.subscriptionId
            ? `
          <div class="admin-dossier-field full-width">
            <span class="admin-dossier-label">Paddle Subscription ID</span>
            <span class="admin-dossier-value">
              <code class="admin-dossier-code">${escapeHtml(billing.subscriptionId)}</code>
              <button type="button" class="admin-btn-icon-copy" data-copy="${escapeHtml(billing.subscriptionId)}" title="Copy Subscription ID" aria-label="Copy Subscription ID"><svg class="lucide lucide-copy" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button>
            </span>
          </div>
        `
            : ''
        }
      </div>
      <div class="admin-dossier-actions">
        <button
          type="button"
          class="admin-btn admin-btn-secondary admin-btn-change-plan"
          id="admin-dossier-change-plan-btn"
          data-user-id="${escapeHtml(user.id)}"
          data-user-email="${escapeHtml(user.email || '')}"
          data-current-tier="${escapeHtml(billing.tier || 'free')}"
          data-manual-override="${billing.manualOverride ? 'true' : 'false'}"
        >
          Change Plan
        </button>
      </div>
    </div>

    <!-- Card C: Monthly Quota -->
    <div class="admin-dossier-card" id="dossier-card-quota">
      <div class="admin-dossier-card-header">
        <h3 class="admin-dossier-card-title">
          <span><svg class="lucide lucide-bar-chart-2" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;"><line x1="18" x2="18" y1="20" y2="10"/><line x1="12" x2="12" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="10"/><line x1="6" x2="6" y1="20" y2="14"/></svg></span>
          <span>Monthly Render Quota</span>
        </h3>
        <span class="admin-text-dim" style="font-size: 12px; font-family: var(--admin-font-mono);">
          Period: ${escapeHtml(quota.month || 'Current')}
        </span>
      </div>
      <div class="admin-progress-wrapper" style="margin: 4px 0;">
        <div class="admin-progress-header">
          <span class="admin-progress-text" id="dossier-quota-text">
            <strong>${formatCount(quotaUsed)}</strong> / ${formatCount(quotaLimit)} renders
          </span>
          <span class="admin-progress-pct" id="dossier-quota-pct">${quotaPct}%</span>
        </div>
        <div class="admin-progress-track" role="progressbar" aria-valuenow="${quotaUsed}" aria-valuemin="0" aria-valuemax="${quotaLimit}">
          <div class="admin-progress-fill ${quotaColorClass}" style="width: ${quotaPct}%;"></div>
        </div>
      </div>
      <div style="font-size: 12px; color: var(--admin-muted); display: flex; justify-content: space-between;">
        <span>Remaining: <strong style="color: var(--admin-text);">${formatCount(quota.remaining != null ? quota.remaining : Math.max(0, quotaLimit - quotaUsed))}</strong></span>
        <span>${quotaPct >= 100 ? '<svg class="lucide lucide-alert-triangle" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-1px;margin-right:3px;"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>Quota limit reached' : quotaPct >= 80 ? '<svg class="lucide lucide-alert-triangle" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-1px;margin-right:3px;"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>Approaching quota limit' : '<svg class="lucide lucide-check-circle-2" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-1px;margin-right:3px;"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>Usage within plan'}</span>
      </div>
      <div class="admin-dossier-actions">
        <button
          type="button"
          class="admin-btn admin-btn-secondary admin-btn-grant-credits"
          id="admin-dossier-grant-credits-btn"
          data-user-id="${escapeHtml(user.id)}"
          data-user-email="${escapeHtml(user.email || '')}"
        >
          Grant Credits
        </button>
      </div>
    </div>

    <!-- Card D: API Keys -->
    <div class="admin-dossier-card" id="dossier-card-keys">
      <div class="admin-dossier-card-header">
        <h3 class="admin-dossier-card-title">
          <span><svg class="lucide lucide-key-round" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;"><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg></span>
          <span>Active API Keys (${apiKeys.length})</span>
        </h3>
      </div>
      ${
        apiKeys.length === 0
          ? `
        <p class="admin-dossier-empty">No API keys created for this customer.</p>
      `
          : `
        <div class="admin-dossier-table-wrapper">
          <table class="admin-dossier-table">
            <thead>
              <tr>
                <th>Key Identifier</th>
                <th>Name</th>
                <th>Status</th>
                <th>Created</th>
                <th>Last Used</th>
                <th style="text-align: right;">Action</th>
              </tr>
            </thead>
            <tbody>
              ${apiKeys
                .map(
                  (key) => `
                <tr>
                  <td><code class="admin-dossier-code">${escapeHtml(key.keyId ? key.keyId.slice(0, 12) + '…' : '—')}</code></td>
                  <td>${escapeHtml(key.name || 'API Key')}</td>
                  <td>
                    <span class="badge ${key.isActive ? 'badge-status-active' : 'badge-status-canceled'}">
                      ${key.isActive ? 'Active' : 'Revoked'}
                    </span>
                  </td>
                  <td>${formatDate(key.createdAt)}</td>
                  <td>${key.lastUsed ? formatDate(key.lastUsed) : '<span class="admin-text-dim">Never</span>'}</td>
                  <td style="text-align: right;">
                    ${
                      key.isActive
                        ? `
                      <button
                        type="button"
                        class="admin-btn-danger-outline admin-btn-revoke-key"
                        data-user-id="${escapeHtml(user.id)}"
                        data-user-email="${escapeHtml(user.email || '')}"
                        data-key-id="${escapeHtml(key.keyId)}"
                        data-key-name="${escapeHtml(key.name || '')}"
                      >
                        Revoke
                      </button>
                    `
                        : '<span class="admin-text-dim">Revoked</span>'
                    }
                  </td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      `
      }
    </div>

    <!-- Card E: Recent Telemetry -->
    <div class="admin-dossier-card" id="dossier-card-telemetry">
      <div class="admin-dossier-card-header">
        <h3 class="admin-dossier-card-title">
          <span><svg class="lucide lucide-activity" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;"><path d="22 12h-4l-3 9L9 3l-3 9H2"/></svg></span>
          <span>Recent Render Telemetry (${recentRequests.length})</span>
        </h3>
      </div>
      ${
        recentRequests.length === 0
          ? `
        <p class="admin-dossier-empty">No render activity recorded in the telemetry window.</p>
      `
          : `
        <div class="admin-dossier-table-wrapper">
          <table class="admin-dossier-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Status</th>
                <th>Duration</th>
                <th>Size</th>
                <th>Error Details</th>
              </tr>
            </thead>
            <tbody>
              ${recentRequests
                .map(
                  (req) => `
                <tr>
                  <td>${formatDate(req.timestamp)}</td>
                  <td>
                    <span class="badge ${req.status === 'success' ? 'badge-status-active' : 'badge-status-canceled'}">
                      ${req.status === 'success' ? '200 OK' : escapeHtml(req.status || '500 Error')}
                    </span>
                  </td>
                  <td>${req.durationMs ? `${req.durationMs} ms` : '—'}</td>
                  <td>${formatBytes(req.size)}</td>
                  <td>
                    ${req.errorType ? `<span style="color: var(--admin-rose-light); font-family: var(--admin-font-mono); font-size: 11px;">${escapeHtml(req.errorType)}</span>` : '<span class="admin-text-dim">—</span>'}
                  </td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      `
      }
    </div>

    <!-- Card F: Danger Zone -->
    <div class="admin-dossier-card danger-zone" id="dossier-card-danger">
      <div class="admin-dossier-card-header">
        <h3 class="admin-dossier-card-title">
          <span><svg class="lucide lucide-alert-triangle" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>
          <span>Danger Zone</span>
        </h3>
      </div>
      <p class="admin-danger-text">
        ${
          user.enabled
            ? 'Suspending this customer terminates all active sessions, revokes API render authorization, and prevents dashboard sign-in.'
            : 'This customer account is currently suspended and blocked from all API and dashboard operations.'
        }
      </p>
      <div class="admin-dossier-actions">
        <button
          type="button"
          class="admin-btn ${user.enabled ? 'admin-btn-danger' : 'admin-btn-secondary'} admin-btn-suspend-user"
          id="admin-dossier-suspend-user-btn"
          data-user-id="${escapeHtml(user.id)}"
          data-user-email="${escapeHtml(user.email || '')}"
          data-user-enabled="${user.enabled ? 'true' : 'false'}"
        >
          ${user.enabled ? 'Suspend Account' : 'Re-enable Account'}
        </button>
      </div>
    </div>
  `;
}

/**
 * Attaches interactive action handlers to the rendered dossier controls.
 * @param {HTMLElement} drawerEl
 * @param {object} data
 */
export function attachDossierActionListeners(drawerEl, data) {
  if (!drawerEl) return;
  const user = data?.user || {};
  const billing = data?.billing || {};
  const quota = data?.quota || {};

  // Copy buttons
  drawerEl.querySelectorAll('.admin-btn-icon-copy').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const textToCopy = btn.dataset.copy || btn.getAttribute('data-copy');
      if (textToCopy && typeof navigator !== 'undefined' && navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(textToCopy);
          showToast('Copied to clipboard', 'info');
        } catch (_) {}
      }
    });
  });

  // Change Plan
  const changePlanBtn = drawerEl.querySelector('#admin-dossier-change-plan-btn');
  if (changePlanBtn) {
    changePlanBtn.addEventListener('click', () => {
      const detail = {
        userId: user.id,
        userEmail: user.email,
        currentTier: billing.tier,
        manualOverride: billing.manualOverride,
      };
      const evt = new CustomEvent('open-change-plan', { bubbles: true, composed: true, detail });
      const evtAdmin = new CustomEvent('admin-open-change-plan', {
        bubbles: true,
        composed: true,
        detail,
      });
      drawerEl.dispatchEvent(evt);
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(evt);
        window.dispatchEvent(evtAdmin);
      }
    });
  }

  // Grant Credits
  const grantCreditsBtn = drawerEl.querySelector('#admin-dossier-grant-credits-btn');
  if (grantCreditsBtn) {
    grantCreditsBtn.addEventListener('click', () => {
      const detail = {
        userId: user.id,
        userEmail: user.email,
        currentQuota: quota,
      };
      const evt = new CustomEvent('open-grant-credits', { bubbles: true, composed: true, detail });
      const evtAdmin = new CustomEvent('admin-open-grant-credits', {
        bubbles: true,
        composed: true,
        detail,
      });
      drawerEl.dispatchEvent(evt);
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(evt);
        window.dispatchEvent(evtAdmin);
      }
    });
  }

  // Revoke Key
  drawerEl.querySelectorAll('.admin-btn-revoke-key').forEach((btn) => {
    btn.addEventListener('click', () => {
      const keyId = btn.dataset.keyId || btn.getAttribute('data-key-id');
      const keyName = btn.dataset.keyName || btn.getAttribute('data-key-name');
      const detail = {
        userId: user.id,
        userEmail: user.email,
        keyId,
        keyName,
      };
      const evt = new CustomEvent('open-revoke-key', { bubbles: true, composed: true, detail });
      const evtAdmin = new CustomEvent('admin-open-revoke-key', {
        bubbles: true,
        composed: true,
        detail,
      });
      drawerEl.dispatchEvent(evt);
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(evt);
        window.dispatchEvent(evtAdmin);
      }
      showToast(`Opening key revocation dialog for ${keyName || keyId}...`, 'warning');
    });
  });

  // Suspend User
  const suspendBtn = drawerEl.querySelector('#admin-dossier-suspend-user-btn');
  if (suspendBtn) {
    suspendBtn.addEventListener('click', () => {
      const detail = {
        userId: user.id,
        userEmail: user.email,
        enabled: user.enabled,
      };
      const evt = new CustomEvent('open-suspend-user', { bubbles: true, composed: true, detail });
      const evtAdmin = new CustomEvent('admin-open-suspend-user', {
        bubbles: true,
        composed: true,
        detail,
      });
      drawerEl.dispatchEvent(evt);
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(evt);
        window.dispatchEvent(evtAdmin);
      }
      showToast(`Opening suspension dialog for ${user.email || user.id}...`, 'warning');
    });
  }
}

/**
 * Opens the sliding user dossier drawer, fetches user profile telemetry, and renders sub-panels.
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
export async function openUserDossier(userId) {
  if (!userId) return null;
  const drawer = getOrCreateDrawerElement();
  if (!drawer) return null;

  drawer.dataset.currentUserId = userId;
  const subtitleEl = drawer.querySelector('#admin-dossier-subtitle');
  const bodyEl = drawer.querySelector('#admin-dossier-body');

  if (subtitleEl) subtitleEl.textContent = `User ID: ${userId}`;
  if (bodyEl) {
    bodyEl.innerHTML = `
      <div class="admin-drawer-loading">
        <span class="admin-loading-spinner-small"></span>
        <span>Loading customer dossier...</span>
      </div>
    `;
  }

  openModal(drawer);

  try {
    const data = await fetchUserDossier(userId);
    if (subtitleEl && data?.user?.email) {
      subtitleEl.textContent = data.user.email;
    }
    renderDossierContent(bodyEl, data);
    attachDossierActionListeners(drawer, data);
    return data;
  } catch (err) {
    console.error('Failed to load user dossier:', err);
    if (bodyEl) {
      bodyEl.innerHTML = `
        <div class="admin-error-banner" style="margin: 16px;">
          <div class="admin-error-details">
            <span class="admin-error-icon"><svg class="lucide lucide-alert-triangle" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>
            <div>
              <h3 class="admin-error-title">Failed to load customer dossier</h3>
              <p class="admin-error-message">${escapeHtml(err.message || 'Could not retrieve user dossier')}</p>
            </div>
          </div>
          <button type="button" id="admin-dossier-retry-btn" class="admin-btn admin-btn-retry">Retry</button>
        </div>
      `;
      const retryBtn = bodyEl.querySelector('#admin-dossier-retry-btn');
      if (retryBtn) {
        retryBtn.addEventListener('click', () => openUserDossier(userId));
      }
    }
    throw err;
  }
}

/**
 * Closes the active user dossier drawer.
 */
export function closeUserDossier() {
  const drawer =
    typeof document !== 'undefined' ? document.getElementById('admin-user-dossier-drawer') : null;
  if (drawer) {
    closeModal(drawer);
  }
}
