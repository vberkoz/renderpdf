/**
 * Governance Module — Audit Trail Tab & Danger Zone Modals
 * Provides the Audit Logs table and two danger-zone action modals:
 *   - Suspend / Activate User Account
 *   - Revoke API Key
 */

import { adminFetch } from '../../shared/api.js';
import { openModal, closeModal, showToast } from '../../shared/ui.js';

// ─── Module State ─────────────────────────────────────────────────────────────

let suspendModalEl = null;
let revokeModalEl = null;
let auditTableLoaded = false;

// ─── Audit Logs Table ─────────────────────────────────────────────────────────

/**
 * Initialises the Audit Trail tab — builds filter controls, fetches log data,
 * and renders the table. Idempotent: re-fetches data on every call.
 * @param {HTMLElement} containerElement - The #audit-logs tab pane
 */
export async function initGovernanceTab(containerElement) {
  if (!containerElement) return;

  // Replace static placeholder with real structure if not yet initialized in this container
  if (!containerElement.querySelector('.admin-users-toolbar') && !containerElement.querySelector('.admin-audit-toolbar')) {
    containerElement.innerHTML = `
      <div class="admin-view-header">
        <div class="admin-view-title-group">
          <h2>Audit Trail &amp; Governance</h2>
          <p class="admin-subtitle">Immutable security log of all administrative actions, key revocations, and status mutations.</p>
        </div>
      </div>

      <!-- Search & Filter Toolbar (matches User Directory toolbar) -->
      <div class="admin-users-toolbar admin-audit-toolbar">
        <div class="admin-search-wrapper">
          <svg class="admin-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            type="search"
            id="audit-search-input"
            class="admin-search-input"
            placeholder="Search by user ID, email, or reason…"
            aria-label="Search audit logs"
            autocomplete="off"
            spellcheck="false"
          >
        </div>

        <div class="admin-filters-group">
          <div class="custom-select" data-custom-select>
            <label for="audit-action-filter" class="custom-select-label visually-hidden">Filter by action</label>
            <input id="audit-action-filter" type="hidden" value="">
            <button class="custom-select-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="audit-action-filter-menu">
              <span class="custom-select-value">All Actions</span>
              <span class="custom-select-icon" aria-hidden="true"><svg class="lucide lucide-chevron-down" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></span>
            </button>
            <div id="audit-action-filter-menu" class="custom-select-menu" role="listbox" hidden>
              <button class="custom-select-option is-active" type="button" role="option" aria-selected="true" data-custom-select-option data-value="">All Actions</button>
              <button class="custom-select-option" type="button" role="option" aria-selected="false" data-custom-select-option data-value="PLAN_OVERRIDE">Plan Override</button>
              <button class="custom-select-option" type="button" role="option" aria-selected="false" data-custom-select-option data-value="QUOTA_ADJUST">Quota Adjust</button>
              <button class="custom-select-option" type="button" role="option" aria-selected="false" data-custom-select-option data-value="USER_SUSPEND">User Suspend</button>
              <button class="custom-select-option" type="button" role="option" aria-selected="false" data-custom-select-option data-value="USER_ACTIVATE">User Activate</button>
              <button class="custom-select-option" type="button" role="option" aria-selected="false" data-custom-select-option data-value="KEY_REVOKE">Key Revoke</button>
            </div>
          </div>

          <div class="custom-select" data-custom-select>
            <label for="audit-days-filter" class="custom-select-label visually-hidden">Time range</label>
            <input id="audit-days-filter" type="hidden" value="30">
            <button class="custom-select-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="audit-days-filter-menu">
              <span class="custom-select-value">Last 30 days</span>
              <span class="custom-select-icon" aria-hidden="true"><svg class="lucide lucide-chevron-down" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></span>
            </button>
            <div id="audit-days-filter-menu" class="custom-select-menu" role="listbox" hidden>
              <button class="custom-select-option" type="button" role="option" aria-selected="false" data-custom-select-option data-value="7">Last 7 days</button>
              <button class="custom-select-option" type="button" role="option" aria-selected="false" data-custom-select-option data-value="14">Last 14 days</button>
              <button class="custom-select-option is-active" type="button" role="option" aria-selected="true" data-custom-select-option data-value="30">Last 30 days</button>
              <button class="custom-select-option" type="button" role="option" aria-selected="false" data-custom-select-option data-value="90">Last 90 days</button>
            </div>
          </div>

          <button id="audit-refresh-btn" class="admin-btn admin-btn-secondary" type="button" aria-label="Refresh audit trail">
            <span>↻</span> Refresh
          </button>
        </div>
      </div>

      <!-- Audit Data Table Container (matches Users Table) -->
      <div id="audit-table-region" role="region" aria-label="Audit log entries" aria-live="polite">
        <div class="admin-loading-spinner" style="text-align:center;padding:40px;color:var(--admin-muted);">Loading audit trail…</div>
      </div>

      <!-- Bottom Bar / Summary -->
      <div class="admin-pagination-bar">
        <div id="audit-count-badge" class="admin-pagination-info" aria-live="polite">
          Showing <strong class="admin-audit-stat-count">0</strong> records
        </div>
      </div>
    `;
    auditTableLoaded = true;
  }
  window.customSelect?.init();

  const actionFilter = containerElement.querySelector('#audit-action-filter');
  const daysFilter = containerElement.querySelector('#audit-days-filter');
  const searchInput = containerElement.querySelector('#audit-search-input');
  const refreshBtn = containerElement.querySelector('#audit-refresh-btn');
  const tableRegion = containerElement.querySelector('#audit-table-region');
  const countBadge = containerElement.querySelector('#audit-count-badge');

  let currentLogs = [];

  function applyFiltersAndRender() {
    if (!tableRegion) return;
    const actionVal = actionFilter ? actionFilter.value : '';
    const query = searchInput ? (searchInput.value || '').trim().toLowerCase() : '';

    let filtered = currentLogs;
    if (actionVal) {
      filtered = filtered.filter((l) => l.action === actionVal);
    }
    if (query) {
      filtered = filtered.filter((l) => {
        const email = (l.adminEmail || '').toLowerCase();
        const user = (l.targetUserId || '').toLowerCase();
        const reason = (l.reason || '').toLowerCase();
        const act = (l.action || '').toLowerCase();
        return email.includes(query) || user.includes(query) || reason.includes(query) || act.includes(query);
      });
    }

    if (countBadge) {
      countBadge.innerHTML = `Showing <strong class="admin-audit-stat-count">${filtered.length}</strong> record${filtered.length !== 1 ? 's' : ''}`;
    }

    renderAuditTable(tableRegion, filtered);
  }

  async function loadAuditLogs() {
    if (!tableRegion) return;
    tableRegion.innerHTML = '<div class="admin-loading-spinner" style="text-align:center;padding:40px;color:var(--admin-muted);">Loading audit trail…</div>';

    const days = daysFilter ? daysFilter.value || '30' : '30';
    try {
      const data = await adminFetch(`/admin/audit-logs?days=${days}&limit=200`);
      currentLogs = data?.logs || [];
      applyFiltersAndRender();
    } catch (err) {
      tableRegion.innerHTML = `
        <div class="admin-error-banner" role="alert" style="margin-top: 12px;">
          <div class="admin-error-details">
            <span class="admin-error-icon" aria-hidden="true"><svg class="lucide lucide-alert-triangle" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>
            <div>
              <h3 class="admin-error-title">Failed to load audit logs</h3>
              <p class="admin-error-message">${escHtml(err.message || 'Unable to retrieve audit history from server.')}</p>
            </div>
          </div>
          <button id="audit-retry-btn" class="admin-btn admin-btn-retry" type="button">Retry</button>
        </div>
      `;
      const retryBtn = tableRegion.querySelector('#audit-retry-btn');
      if (retryBtn) {
        retryBtn.addEventListener('click', () => loadAuditLogs());
      }
    }
  }

  if (actionFilter) {
    actionFilter.addEventListener('change', () => applyFiltersAndRender());
  }
  if (daysFilter) {
    daysFilter.addEventListener('change', () => loadAuditLogs());
  }
  if (searchInput) {
    searchInput.addEventListener('input', () => applyFiltersAndRender());
  }
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadAuditLogs());
  }

  await loadAuditLogs();
}

/**
 * Renders the audit log table into the target region element.
 * @param {HTMLElement} region
 * @param {Array<Object>} logs
 */
function renderAuditTable(region, logs) {
  if (!region) return;

  if (!logs || logs.length === 0) {
    region.innerHTML = `
      <div class="admin-empty-state" style="padding:48px 24px;text-align:center;">
        <svg class="lucide lucide-shield-check" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:block;margin:0 auto 8px;color:var(--admin-muted);" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>
        <p style="color:var(--admin-muted);font-size:14px;margin:0;">No audit records found matching your filters.</p>
      </div>
    `;
    return;
  }

  const ACTION_BADGE_CLASS = {
    PLAN_OVERRIDE: 'admin-badge-blue',
    QUOTA_ADJUST: 'admin-badge-purple',
    USER_SUSPEND: 'admin-badge-red',
    USER_ACTIVATE: 'admin-badge-green',
    KEY_REVOKE: 'admin-badge-orange',
  };

  const rows = logs.map((entry) => {
    const ts = entry.timestamp ? new Date(entry.timestamp) : null;
    const absTime = ts ? ts.toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—';
    const relTime = ts ? formatRelativeTime(ts) : '—';
    const badgeClass = ACTION_BADGE_CLASS[entry.action] || 'admin-badge-grey';
    const detailStr = entry.details && typeof entry.details === 'object'
      ? Object.entries(entry.details).map(([k, v]) => `${k}: ${v}`).join('; ')
      : '';
    return `
      <tr>
        <td class="admin-audit-ts" title="${escHtml(absTime)}">${escHtml(relTime)}</td>
        <td class="admin-audit-admin">${escHtml(entry.adminEmail || '—')}</td>
        <td><span class="admin-audit-user" title="${escHtml(entry.targetUserId || '')}">${escHtml(entry.targetUserId || '—')}</span></td>
        <td><span class="admin-badge ${badgeClass}">${escHtml(entry.action || '—')}</span></td>
        <td class="admin-audit-reason" title="${escHtml(entry.reason || '')}">${escHtml(entry.reason || '—')}</td>
        <td class="admin-audit-detail" title="${escHtml(detailStr)}">${escHtml(detailStr || '—')}</td>
      </tr>
    `;
  }).join('');

  region.innerHTML = `
    <div class="admin-table-container">
      <table class="admin-table admin-audit-table" aria-label="Audit log">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Admin</th>
            <th scope="col">Target User</th>
            <th scope="col">Action</th>
            <th scope="col">Reason</th>
            <th scope="col">Details</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

// ─── Suspend User Modal ───────────────────────────────────────────────────────

/**
 * Opens the Suspend / Activate User Account danger modal.
 * @param {string} userId       - Cognito sub UUID
 * @param {string} userEmail    - Customer email shown in confirmation prompt
 * @param {'disable'|'enable'}  [actionType='disable'] - Whether to suspend or re-enable
 */
export function openSuspendUserModal(userId, userEmail, actionType = 'disable') {
  const modal = getOrCreateSuspendModal();
  const isSuspend = actionType === 'disable';

  // Update heading & copy based on action
  const heading = modal.querySelector('#suspend-modal-heading');
  const warning = modal.querySelector('#suspend-modal-warning');
  const confirmPrompt = modal.querySelector('#suspend-confirm-prompt');
  const submitBtn = modal.querySelector('#suspend-submit-btn');
  const confirmInput = modal.querySelector('#suspend-confirm-input');
  const reasonInput = modal.querySelector('#suspend-reason-input');
  const errorEl = modal.querySelector('#suspend-modal-error');

  if (heading) heading.textContent = isSuspend ? '⛔ Suspend Account' : '✅ Activate Account';
  if (warning) {
    warning.textContent = isSuspend
      ? 'This will immediately disable the user\'s Cognito login and deactivate all API keys. Active integrations will fail with 401.'
      : 'This will re-enable the user\'s Cognito login. API keys remain deactivated and must be manually re-enabled.';
  }
  if (confirmPrompt) {
    confirmPrompt.textContent = isSuspend
      ? `Type the customer's email address "${userEmail}" or SUSPEND to confirm:`
      : `Type "${userEmail}" or ACTIVATE to confirm:`;
  }
  if (submitBtn) {
    submitBtn.textContent = isSuspend ? 'Suspend Account' : 'Activate Account';
    submitBtn.className = `admin-btn ${isSuspend ? 'admin-btn-danger' : 'admin-btn-success'}`;
  }
  if (confirmInput) confirmInput.value = '';
  if (reasonInput) reasonInput.value = '';
  if (errorEl) { errorEl.textContent = ''; errorEl.setAttribute('hidden', ''); }

  // Wire form handler via onsubmit (re-assignable, no clone needed)
  const form = modal.querySelector('#suspend-modal-form');
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const confirmVal = (modal.querySelector('#suspend-confirm-input')?.value || '').trim();
      const reason = (modal.querySelector('#suspend-reason-input')?.value || '').trim();
      const errEl = modal.querySelector('#suspend-modal-error');
      const expectedTokens = isSuspend
        ? [userEmail, 'SUSPEND']
        : [userEmail, 'ACTIVATE'];

      if (!expectedTokens.includes(confirmVal)) {
        if (errEl) { errEl.textContent = `Confirmation text does not match. Type "${userEmail}" or ${isSuspend ? 'SUSPEND' : 'ACTIVATE'}.`; errEl.removeAttribute('hidden'); }
        return;
      }
      if (!reason) {
        if (errEl) { errEl.textContent = 'A reason is required for the audit trail.'; errEl.removeAttribute('hidden'); }
        return;
      }

      const submitBtnEl = modal.querySelector('#suspend-submit-btn');
      if (submitBtnEl) { submitBtnEl.disabled = true; submitBtnEl.textContent = 'Processing…'; }
      if (errEl) { errEl.textContent = ''; errEl.setAttribute('hidden', ''); }

      try {
        await adminFetch(`/admin/users/${userId}/status`, {
          method: 'POST',
          body: JSON.stringify({ action: actionType, reason }),
        });
        closeModal(modal);
        showToast(
          isSuspend ? `Account suspended for ${userEmail}.` : `Account activated for ${userEmail}.`,
          isSuspend ? 'warning' : 'success'
        );
        document.dispatchEvent(new CustomEvent('user-updated', { detail: { userId } }));
      } catch (err) {
        if (errEl) { errEl.textContent = err.message || 'Request failed. Please try again.'; errEl.removeAttribute('hidden'); }
        if (submitBtnEl) { submitBtnEl.disabled = false; submitBtnEl.textContent = isSuspend ? 'Suspend Account' : 'Activate Account'; }
      }
    };
  }

  // Wire cancel / backdrop
  const cancelBtn = modal.querySelector('#suspend-cancel-btn');
  if (cancelBtn) {
    cancelBtn.onclick = () => closeModal(modal);
  }
  const backdrop = modal.querySelector('.admin-modal-backdrop');
  if (backdrop) {
    backdrop.onclick = (e) => { if (e.target === backdrop) closeModal(modal); };
  }

  openModal(modal);
}

// ─── Revoke Key Modal ─────────────────────────────────────────────────────────

/**
 * Opens the Revoke API Key danger modal.
 * @param {string} userId   - Owner's Cognito sub UUID
 * @param {string} keyId    - RenderPDF API key ID (without APIKEY# prefix)
 * @param {string} keyName  - Display name or truncated key prefix shown in UI
 */
export function openRevokeKeyModal(userId, keyId, keyName) {
  const modal = getOrCreateRevokeModal();

  const heading = modal.querySelector('#revoke-modal-heading');
  const keyDisplay = modal.querySelector('#revoke-key-display');
  const reasonInput = modal.querySelector('#revoke-reason-input');
  const errorEl = modal.querySelector('#revoke-modal-error');

  if (heading) heading.textContent = `🔑 Revoke API Key`;
  if (keyDisplay) keyDisplay.textContent = keyName || keyId;
  if (reasonInput) reasonInput.value = '';
  if (errorEl) { errorEl.textContent = ''; errorEl.setAttribute('hidden', ''); }

  const form = modal.querySelector('#revoke-modal-form');
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const reason = (modal.querySelector('#revoke-reason-input')?.value || '').trim();
      const errEl = modal.querySelector('#revoke-modal-error');

      if (!reason) {
        if (errEl) { errEl.textContent = 'A reason is required for the audit trail.'; errEl.removeAttribute('hidden'); }
        return;
      }

      const submitBtnEl = modal.querySelector('#revoke-submit-btn');
      if (submitBtnEl) { submitBtnEl.disabled = true; submitBtnEl.textContent = 'Revoking…'; }
      if (errEl) { errEl.textContent = ''; errEl.setAttribute('hidden', ''); }

      try {
        await adminFetch(`/admin/users/${userId}/keys/${keyId}/revoke`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
        closeModal(modal);
        showToast(`API key "${keyName || keyId}" has been revoked.`, 'warning');
        document.dispatchEvent(new CustomEvent('user-updated', { detail: { userId } }));
      } catch (err) {
        if (errEl) { errEl.textContent = err.message || 'Request failed. Please try again.'; errEl.removeAttribute('hidden'); }
        if (submitBtnEl) { submitBtnEl.disabled = false; submitBtnEl.textContent = 'Revoke Key'; }
      }
    };
  }

  const cancelBtn = modal.querySelector('#revoke-cancel-btn');
  if (cancelBtn) {
    cancelBtn.onclick = () => closeModal(modal);
  }
  const backdrop = modal.querySelector('.admin-modal-backdrop');
  if (backdrop) {
    backdrop.onclick = (e) => { if (e.target === backdrop) closeModal(modal); };
  }

  openModal(modal);
}

// ─── Modal DOM Builders ───────────────────────────────────────────────────────

function getOrCreateSuspendModal() {
  if (suspendModalEl) return suspendModalEl;

  const container = document.getElementById('admin-modal-container') || document.body;
  const modal = document.createElement('div');
  modal.id = 'admin-suspend-modal';
  modal.className = 'admin-modal-backdrop admin-modal-danger';
  modal.setAttribute('hidden', '');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'suspend-modal-heading');
  modal.innerHTML = `
    <div class="admin-modal admin-modal-danger-content" role="document" style="max-width:480px;">
      <header class="admin-modal-header admin-modal-danger-header">
        <h2 id="suspend-modal-heading" class="admin-modal-title">⛔ Suspend Account</h2>
        <button type="button" id="suspend-cancel-btn" class="admin-modal-close" aria-label="Cancel and close"><svg class="lucide lucide-x" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
      </header>
      <div class="admin-modal-body">
        <p id="suspend-modal-warning" class="admin-danger-notice" style="color:var(--admin-danger,#e53e3e);font-weight:500;margin-bottom:16px;"></p>
        <form id="suspend-modal-form" novalidate>
          <p id="suspend-confirm-prompt" class="admin-label" style="margin-bottom:8px;"></p>
          <input
            id="suspend-confirm-input"
            type="text"
            class="admin-input"
            autocomplete="off"
            spellcheck="false"
            aria-required="true"
            placeholder="Type to confirm"
            style="margin-bottom:16px;width:100%;"
          />
          <label for="suspend-reason-input" class="admin-label">Reason (required for audit trail)</label>
          <textarea
            id="suspend-reason-input"
            class="admin-input"
            rows="3"
            aria-required="true"
            placeholder="e.g. Fraudulent usage pattern detected"
            style="width:100%;margin-top:4px;"
          ></textarea>
          <p id="suspend-modal-error" class="admin-field-error" role="alert" hidden style="color:var(--admin-danger,#e53e3e);margin-top:8px;"></p>
          <div class="admin-modal-actions" style="margin-top:20px;display:flex;gap:10px;justify-content:flex-end;">
            <button type="button" id="suspend-cancel-btn-form" class="admin-btn admin-btn-secondary">Cancel</button>
            <button type="submit" id="suspend-submit-btn" class="admin-btn admin-btn-danger">Suspend Account</button>
          </div>
        </form>
      </div>
    </div>
  `;

  // Wire the cancel in footer as well
  const cancelFooter = modal.querySelector('#suspend-cancel-btn-form');
  if (cancelFooter) cancelFooter.addEventListener('click', () => closeModal(modal));

  container.appendChild(modal);
  suspendModalEl = modal;
  return modal;
}

function getOrCreateRevokeModal() {
  if (revokeModalEl) return revokeModalEl;

  const container = document.getElementById('admin-modal-container') || document.body;
  const modal = document.createElement('div');
  modal.id = 'admin-revoke-modal';
  modal.className = 'admin-modal-backdrop admin-modal-danger';
  modal.setAttribute('hidden', '');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'revoke-modal-heading');
  modal.innerHTML = `
    <div class="admin-modal admin-modal-danger-content" role="document" style="max-width:440px;">
      <header class="admin-modal-header admin-modal-danger-header">
        <h2 id="revoke-modal-heading" class="admin-modal-title">🔑 Revoke API Key</h2>
        <button type="button" id="revoke-cancel-btn" class="admin-modal-close" aria-label="Cancel and close"><svg class="lucide lucide-x" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
      </header>
      <div class="admin-modal-body">
        <p class="admin-danger-notice" style="color:var(--admin-danger,#e53e3e);font-weight:500;margin-bottom:12px;">
          <svg class="lucide lucide-alert-triangle" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;margin-right:4px;"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>Active client integrations using key
          <strong id="revoke-key-display" style="font-family:monospace;"></strong>
          will immediately fail with <code>401 Unauthorized</code>.
        </p>
        <form id="revoke-modal-form" novalidate>
          <label for="revoke-reason-input" class="admin-label">Reason (required for audit trail)</label>
          <textarea
            id="revoke-reason-input"
            class="admin-input"
            rows="3"
            aria-required="true"
            placeholder="e.g. API key exposed in public repository"
            style="width:100%;margin-top:4px;"
          ></textarea>
          <p id="revoke-modal-error" class="admin-field-error" role="alert" hidden style="color:var(--admin-danger,#e53e3e);margin-top:8px;"></p>
          <div class="admin-modal-actions" style="margin-top:20px;display:flex;gap:10px;justify-content:flex-end;">
            <button type="button" id="revoke-cancel-btn-form" class="admin-btn admin-btn-secondary">Cancel</button>
            <button type="submit" id="revoke-submit-btn" class="admin-btn admin-btn-danger">Revoke Key</button>
          </div>
        </form>
      </div>
    </div>
  `;

  const cancelFooter = modal.querySelector('#revoke-cancel-btn-form');
  if (cancelFooter) cancelFooter.addEventListener('click', () => closeModal(modal));

  container.appendChild(modal);
  revokeModalEl = modal;
  return modal;
}

// ─── Utility Helpers ──────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatRelativeTime(date) {
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toISOString().slice(0, 10);
}

let isGovernanceInitialized = false;

/**
 * Initializes window event listeners for governance danger-zone modals.
 */
export function initGovernanceModals() {
  if (isGovernanceInitialized) return;
  isGovernanceInitialized = true;

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const handleSuspend = (e) => {
      const detail = e.detail || {};
      const actionType = detail.enabled === false ? 'enable' : 'disable';
      openSuspendUserModal(detail.userId, detail.userEmail, actionType);
    };
    window.addEventListener('open-suspend-user', handleSuspend);
    window.addEventListener('admin-open-suspend-user', handleSuspend);

    const handleRevoke = (e) => {
      const detail = e.detail || {};
      openRevokeKeyModal(detail.userId, detail.keyId, detail.keyName);
    };
    window.addEventListener('open-revoke-key', handleRevoke);
    window.addEventListener('admin-open-revoke-key', handleRevoke);
  }
}

