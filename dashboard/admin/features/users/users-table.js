/**
 * User Directory & Search Table Module (Route: /admin/users)
 * Handles customer search with 300ms debounce, plan & status dropdown filtering,
 * visual quota progress tracking, and pagination.
 */

import { adminFetch } from '../../shared/api.js';
import { escapeHtml, formatCount } from './users-common.js';
import { openUserDossier } from './users-dossier.js';

/**
 * Fetches users from the admin backend API.
 * @param {object} params
 * @returns {Promise<{ users: Array, nextCursor: string|null }>}
 */
export async function fetchUsers({
  query = '',
  tier = 'all',
  status = 'all',
  limit = 25,
  cursor = null,
} = {}) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (tier && tier !== 'all') params.set('tier', tier);
  if (status && status !== 'all') params.set('status', status);
  if (limit && limit !== 25) params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);

  const qs = params.toString();
  const endpoint = qs ? `/admin/users?${qs}` : '/admin/users';
  return await adminFetch(endpoint);
}

/**
 * Helper to render the initial tab shell (toolbar, table structure, pagination container).
 * @param {HTMLElement} container
 * @param {object} state
 */
function renderShell(container, state) {
  container.innerHTML = `
    <div class="admin-view-header">
      <div class="admin-view-title-group">
        <h2>User Directory</h2>
        <p class="admin-subtitle">Search customers, inspect Cognito identities, monitor monthly quotas, and review operational state.</p>
      </div>
    </div>

    <!-- Search & Filter Toolbar -->
    <div class="admin-users-toolbar">
      <div class="admin-search-wrapper">
        <svg class="admin-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input
          type="search"
          id="admin-users-search"
          class="admin-search-input"
          placeholder="Search by email prefix or UUID..."
          aria-label="Search users by email or UUID"
          value="${escapeHtml(state.query)}"
          autocomplete="off"
          spellcheck="false"
        >
      </div>

      <div class="admin-filters-group">
        <div class="custom-select" data-custom-select>
          <label for="admin-filter-tier" class="custom-select-label visually-hidden">Filter by Tier</label>
          <input id="admin-filter-tier" type="hidden" value="${escapeHtml(state.tier || 'all')}">
          <button class="custom-select-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="admin-filter-tier-menu">
            <span class="custom-select-value">${state.tier === 'free' ? 'Free' : state.tier === 'starter' ? 'Starter' : state.tier === 'pro' ? 'Pro' : 'All Tiers'}</span>
            <span class="custom-select-icon" aria-hidden="true"><svg class="lucide lucide-chevron-down" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></span>
          </button>
          <div id="admin-filter-tier-menu" class="custom-select-menu" role="listbox" hidden>
            <button class="custom-select-option ${state.tier === 'all' || !state.tier ? 'is-active' : ''}" type="button" role="option" aria-selected="${state.tier === 'all' || !state.tier ? 'true' : 'false'}" data-custom-select-option data-value="all">All Tiers</button>
            <button class="custom-select-option ${state.tier === 'free' ? 'is-active' : ''}" type="button" role="option" aria-selected="${state.tier === 'free' ? 'true' : 'false'}" data-custom-select-option data-value="free">Free</button>
            <button class="custom-select-option ${state.tier === 'starter' ? 'is-active' : ''}" type="button" role="option" aria-selected="${state.tier === 'starter' ? 'true' : 'false'}" data-custom-select-option data-value="starter">Starter</button>
            <button class="custom-select-option ${state.tier === 'pro' ? 'is-active' : ''}" type="button" role="option" aria-selected="${state.tier === 'pro' ? 'true' : 'false'}" data-custom-select-option data-value="pro">Pro</button>
          </div>
        </div>

        <div class="custom-select" data-custom-select>
          <label for="admin-filter-status" class="custom-select-label visually-hidden">Filter by Status</label>
          <input id="admin-filter-status" type="hidden" value="${escapeHtml(state.status || 'all')}">
          <button class="custom-select-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="admin-filter-status-menu">
            <span class="custom-select-value">${state.status === 'active' ? 'Active' : state.status === 'past_due' ? 'Past Due' : state.status === 'canceled' ? 'Canceled' : 'All Statuses'}</span>
            <span class="custom-select-icon" aria-hidden="true"><svg class="lucide lucide-chevron-down" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></span>
          </button>
          <div id="admin-filter-status-menu" class="custom-select-menu" role="listbox" hidden>
            <button class="custom-select-option ${state.status === 'all' || !state.status ? 'is-active' : ''}" type="button" role="option" aria-selected="${state.status === 'all' || !state.status ? 'true' : 'false'}" data-custom-select-option data-value="all">All Statuses</button>
            <button class="custom-select-option ${state.status === 'active' ? 'is-active' : ''}" type="button" role="option" aria-selected="${state.status === 'active' ? 'true' : 'false'}" data-custom-select-option data-value="active">Active</button>
            <button class="custom-select-option ${state.status === 'past_due' ? 'is-active' : ''}" type="button" role="option" aria-selected="${state.status === 'past_due' ? 'true' : 'false'}" data-custom-select-option data-value="past_due">Past Due</button>
            <button class="custom-select-option ${state.status === 'canceled' ? 'is-active' : ''}" type="button" role="option" aria-selected="${state.status === 'canceled' ? 'true' : 'false'}" data-custom-select-option data-value="canceled">Canceled</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Users Data Table Container -->
    <div class="admin-table-container">
      <table class="admin-table" aria-label="Users directory table">
        <thead>
          <tr>
            <th scope="col">User</th>
            <th scope="col">Tier</th>
            <th scope="col">Status</th>
            <th scope="col">Monthly Quota</th>
            <th scope="col" class="admin-col-num">Active Keys</th>
            <th scope="col">Created</th>
            <th scope="col" style="text-align: right;">Action</th>
          </tr>
        </thead>
        <tbody id="admin-users-tbody">
          <!-- Populated dynamically -->
        </tbody>
      </table>
    </div>

    <!-- Pagination Bar Container -->
    <div id="admin-users-pagination" class="admin-pagination-bar"></div>
  `;
}

/**
 * Renders the table body rows from the user list.
 * @param {HTMLElement} tbody
 * @param {Array} users
 */
function renderTableRows(tbody, users) {
  if (!users || users.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7">
          <div class="admin-empty-state" style="padding: 40px 20px; text-align: center;">
            <span style="display: flex; justify-content: center; margin-bottom: 8px;" aria-hidden="true"><svg class="lucide lucide-users" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span>
            <p style="color: var(--admin-muted); font-size: 14px; margin: 0;">No users found matching your search criteria.</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = users
    .map((user) => {
      const tier = String(user.tier || 'free').toLowerCase();
      const status = String(user.status || 'active').toLowerCase();
      const quotaUsed = Number(user.quotaUsed) || 0;
      const quotaLimit = Number(user.quotaLimit) || 25;
      const pct = quotaLimit > 0 ? Math.round((quotaUsed / quotaLimit) * 100) : 0;
      const clampedPct = Math.min(100, Math.max(0, pct));
      const progressClass =
        pct >= 100 ? 'progress-danger' : pct >= 80 ? 'progress-warning' : 'progress-normal';

      const tierClass =
        tier === 'starter' ? 'badge-starter' : tier === 'pro' ? 'badge-pro' : 'badge-free';
      const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);

      const statusClass =
        status === 'active'
          ? 'badge-status-active'
          : status === 'past_due'
            ? 'badge-status-past-due'
            : 'badge-status-canceled';
      const statusLabel =
        status === 'past_due' ? 'Past Due' : status.charAt(0).toUpperCase() + status.slice(1);

      const createdStr = user.createdAt ? user.createdAt.slice(0, 10) : '—';
      const userIdSnippet = user.id
        ? user.id.length > 8
          ? `${user.id.slice(0, 8)}…`
          : user.id
        : '—';

      return `
      <tr data-user-id="${escapeHtml(user.id)}">
        <td>
          <div class="admin-user-cell">
            <span class="admin-user-email">${escapeHtml(user.email || 'No email')}</span>
            <span class="admin-user-id" title="${escapeHtml(user.id)}">${escapeHtml(userIdSnippet)}</span>
          </div>
        </td>
        <td>
          <span class="admin-badge-tier ${tierClass}">
            ${tierLabel}${user.manualOverride ? '<span class="admin-tier-override" title="Manual plan override active">*</span>' : ''}
          </span>
        </td>
        <td>
          <span class="admin-badge-status ${statusClass}">${statusLabel}</span>
        </td>
        <td>
          <div class="admin-quota-cell">
            <div class="admin-quota-text">
              <span>${formatCount(quotaUsed)} / ${formatCount(quotaLimit)}</span>
              <span class="admin-quota-pct">${pct}%</span>
            </div>
            <div class="admin-progress-track" role="progressbar" aria-valuenow="${quotaUsed}" aria-valuemin="0" aria-valuemax="${quotaLimit}" aria-label="Monthly quota consumption">
              <div class="admin-progress-fill ${progressClass}" style="width: ${clampedPct}%;"></div>
            </div>
          </div>
        </td>
        <td class="admin-col-num">${formatCount(user.activeKeys || 0)}</td>
        <td class="admin-col-date">${escapeHtml(createdStr)}</td>
        <td style="text-align: right;">
          <button
            type="button"
            class="admin-btn admin-btn-inspect"
            data-user-id="${escapeHtml(user.id)}"
            aria-label="Inspect user ${escapeHtml(user.email || user.id)}"
          >
            Inspect
          </button>
        </td>
      </tr>
    `;
    })
    .join('');
}

/**
 * Renders the pagination controls and item counts.
 * @param {HTMLElement} paginationEl
 * @param {object} state
 */
function renderPagination(paginationEl, state) {
  if (!paginationEl) return;
  const count = state.users ? state.users.length : 0;
  const pageNum = state.cursorHistory.length + 1;
  const hasPrev = state.cursorHistory.length > 0;
  const hasNext = Boolean(state.nextCursor);

  paginationEl.innerHTML = `
    <div class="admin-pagination-info">
      <span>Showing <strong>${count}</strong> ${count === 1 ? 'user' : 'users'}</span>
      ${state.cursorHistory.length > 0 ? `<span>(Page ${pageNum})</span>` : ''}
    </div>
    <div class="admin-pagination-controls">
      <button
        type="button"
        id="admin-pagination-prev"
        class="admin-btn admin-btn-pagination"
        ${hasPrev ? '' : 'disabled'}
        aria-label="Previous page"
      >
        &larr; Previous
      </button>
      <button
        type="button"
        id="admin-pagination-next"
        class="admin-btn admin-btn-pagination"
        ${hasNext ? '' : 'disabled'}
        aria-label="Next page"
      >
        Next &rarr;
      </button>
    </div>
  `;
}

/**
 * Initializes the User Directory tab in the provided container.
 * @param {HTMLElement} containerElement
 */
export async function initUserDirectoryTab(containerElement) {
  if (!containerElement) return;

  const state = {
    query: '',
    tier: 'all',
    status: 'all',
    limit: 25,
    cursor: null,
    cursorHistory: [],
    users: [],
    nextCursor: null,
    loading: false,
    error: null,
  };

  let debounceTimer = null;

  renderShell(containerElement, state);
  if (typeof window !== 'undefined') {
    window.customSelect?.init();
  }

  const tbody = containerElement.querySelector('#admin-users-tbody');
  const paginationEl = containerElement.querySelector('#admin-users-pagination');
  const searchInput = containerElement.querySelector('#admin-users-search');
  const tierSelect = containerElement.querySelector('#admin-filter-tier');
  const statusSelect = containerElement.querySelector('#admin-filter-status');

  async function loadData() {
    state.loading = true;
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7">
            <div style="padding: 24px; text-align: center; color: var(--admin-muted);">
              Loading users...
            </div>
          </td>
        </tr>
      `;
    }

    try {
      const data = await fetchUsers({
        query: state.query,
        tier: state.tier,
        status: state.status,
        limit: state.limit,
        cursor: state.cursor,
      });

      state.users = Array.isArray(data?.users) ? data.users : [];
      state.nextCursor = data?.nextCursor || null;
      state.error = null;

      if (tbody) renderTableRows(tbody, state.users);
      if (paginationEl) renderPagination(paginationEl, state);
    } catch (err) {
      console.error('Failed to load user directory:', err);
      state.error = err;
      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="7">
              <div class="admin-error-banner" style="margin: 16px;">
                <div class="admin-error-details">
                  <span class="admin-error-icon"><svg class="lucide lucide-alert-triangle" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>
                  <div>
                    <h3 class="admin-error-title">Failed to load users</h3>
                    <p class="admin-error-message">${escapeHtml(err.message || 'Could not connect to the Users API')}</p>
                  </div>
                </div>
                <button type="button" id="admin-users-retry-btn" class="admin-btn admin-btn-retry">Retry</button>
              </div>
            </td>
          </tr>
        `;
        const retryBtn = tbody.querySelector('#admin-users-retry-btn');
        if (retryBtn) {
          retryBtn.addEventListener('click', () => loadData());
        }
      }
    } finally {
      state.loading = false;
    }
  }

  // 1. Debounced search input (300ms)
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const val = e.target.value.trim();
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        state.query = val;
        state.cursor = null;
        state.cursorHistory = [];
        loadData();
      }, 300);
    });
  }

  // 2. Dropdown filters (immediate refilter)
  if (tierSelect) {
    tierSelect.addEventListener('change', (e) => {
      state.tier = e.target.value;
      state.cursor = null;
      state.cursorHistory = [];
      loadData();
    });
  }

  if (statusSelect) {
    statusSelect.addEventListener('change', (e) => {
      state.status = e.target.value;
      state.cursor = null;
      state.cursorHistory = [];
      loadData();
    });
  }

  // 3. Pagination click handlers
  if (paginationEl) {
    paginationEl.addEventListener('click', (e) => {
      const prevBtn = e.target.closest('#admin-pagination-prev');
      const nextBtn = e.target.closest('#admin-pagination-next');

      if (prevBtn && !prevBtn.disabled && state.cursorHistory.length > 0) {
        state.cursor = state.cursorHistory.pop();
        loadData();
      } else if (nextBtn && !nextBtn.disabled && state.nextCursor) {
        state.cursorHistory.push(state.cursor);
        state.cursor = state.nextCursor;
        loadData();
      }
    });
  }

  // 4. Inspect button click handler
  if (tbody) {
    tbody.addEventListener('click', (e) => {
      const inspectBtn = e.target.closest('.admin-btn-inspect');
      if (inspectBtn) {
        const userId = inspectBtn.dataset.userId || inspectBtn.getAttribute('data-user-id');
        if (userId) {
          const dossierEvent = new CustomEvent('open-user-dossier', {
            bubbles: true,
            composed: true,
            detail: { userId },
          });
          containerElement.dispatchEvent(dossierEvent);
          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(dossierEvent);
          }
          openUserDossier(userId).catch(() => {});
        }
      }
    });
  }

  // 5. External open-user-dossier listener on tab container
  containerElement.addEventListener('open-user-dossier', (e) => {
    const userId = e.detail?.userId;
    if (userId) {
      openUserDossier(userId).catch(() => {});
    }
  });

  // 6. user-updated listener to automatically refresh open dossier
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('user-updated', (e) => {
      const updatedUserId = e.detail?.userId;
      const drawer =
        typeof document !== 'undefined'
          ? document.getElementById('admin-user-dossier-drawer')
          : null;
      if (
        drawer &&
        !drawer.hasAttribute('hidden') &&
        drawer.dataset?.currentUserId === updatedUserId
      ) {
        openUserDossier(updatedUserId).catch(() => {});
      }
    });
  }

  // Initial load
  await loadData();
}
