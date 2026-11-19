/**
 * Governance Module — Audit Trail Tab & Danger Zone Modals
 * Provides the Audit Logs table and re-exports danger-zone action modals:
 *   - Suspend / Activate User Account
 *   - Revoke API Key
 */

import { adminFetch } from '../../shared/api.js';

export {
  openSuspendUserModal,
  openRevokeKeyModal,
  initGovernanceModals,
} from './governance-modals.js';

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
  if (
    !containerElement.querySelector('.admin-users-toolbar') &&
    !containerElement.querySelector('.admin-audit-toolbar')
  ) {
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
        return (
          email.includes(query) ||
          user.includes(query) ||
          reason.includes(query) ||
          act.includes(query)
        );
      });
    }

    if (countBadge) {
      countBadge.innerHTML = `Showing <strong class="admin-audit-stat-count">${filtered.length}</strong> record${filtered.length !== 1 ? 's' : ''}`;
    }

    renderAuditTable(tableRegion, filtered);
  }

  async function loadAuditLogs() {
    if (!tableRegion) return;
    tableRegion.innerHTML =
      '<div class="admin-loading-spinner" style="text-align:center;padding:40px;color:var(--admin-muted);">Loading audit trail…</div>';

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

  const rows = logs
    .map((entry) => {
      const ts = entry.timestamp ? new Date(entry.timestamp) : null;
      const absTime = ts ? ts.toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—';
      const relTime = ts ? formatRelativeTime(ts) : '—';
      const badgeClass = ACTION_BADGE_CLASS[entry.action] || 'admin-badge-grey';
      const detailStr =
        entry.details && typeof entry.details === 'object'
          ? Object.entries(entry.details)
              .map(([k, v]) => `${k}: ${v}`)
              .join('; ')
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
    })
    .join('');

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
