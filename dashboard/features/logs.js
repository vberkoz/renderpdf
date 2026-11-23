(function (global) {
  'use strict';

  function formatLogDate(timestamp) {
    if (!timestamp) return 'Unknown time';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(timestamp * 1000)
    );
  }

  const requestLogState = {
    logs: [],
    page: 1,
    pageSize: 5,
    nextCursor: null,
    total: 0,
    hasServerPagination: false,
    loadingMore: false,
  };

  function getLoadDashboard() {
    if (typeof global.loadDashboard === 'function') return global.loadDashboard;
    if (typeof loadDashboard === 'function') return loadDashboard;
    return null;
  }

  function renderLogs(logs, pagination = null) {
    requestLogState.logs = (logs || []).slice();
    requestLogState.page = 1;
    requestLogState.nextCursor = pagination?.nextCursor ?? null;
    requestLogState.total = Number.isFinite(pagination?.total)
      ? pagination.total
      : requestLogState.logs.length;
    requestLogState.hasServerPagination = Boolean(pagination);
    requestLogState.loadingMore = false;
    updateVisibleLogs();
  }

  function renderRecentActivity(logs) {
    const container = document.getElementById('recentActivityList');
    if (!container) return;
    container.replaceChildren();
    const recent = (logs || [])
      .slice()
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 4);
    if (!recent.length) {
      container.innerHTML = '<p class="empty-state">No authenticated PDF requests yet.</p>';
      return;
    }
    recent.forEach((log) => {
      const item = document.createElement('div');
      item.className = `log-item ${log.status === 'success' ? 'is-success' : 'is-error'}`;
      const main = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = log.status === 'success' ? 'PDF generated' : 'PDF failed';
      const detail = document.createElement('span');
      detail.textContent = `${formatLogDate(log.timestamp)} · ${log.apiKeyId ? `key ${log.apiKeyId.slice(0, 8)}` : 'account request'}`;
      main.append(title, detail);
      const meta = document.createElement('span');
      meta.textContent =
        log.status === 'success' && Number.isFinite(log.size)
          ? `${(log.size / 1024).toFixed(1)} KB`
          : log.errorType || log.status;
      item.append(main, meta);
      container.appendChild(item);
    });
  }

  function updateVisibleLogs() {
    const container = document.getElementById('logsList');
    const pagination = document.getElementById('logsPagination');
    const previous = document.getElementById('logsPreviousPage');
    const next = document.getElementById('logsNextPage');
    const pageStatus = document.getElementById('logsPageStatus');
    if (!container) return;
    container.replaceChildren();
    const status = document.getElementById('logsStatusFilter')?.value || 'all';
    const sort = document.getElementById('logsSort')?.value || 'newest';
    const logs = requestLogState.logs
      .filter((log) =>
        status === 'all'
          ? true
          : status === 'error'
            ? log.status !== 'success'
            : log.status === status
      )
      .sort((a, b) =>
        sort === 'oldest'
          ? (a.timestamp || 0) - (b.timestamp || 0)
          : (b.timestamp || 0) - (a.timestamp || 0)
      );
    if (!logs.length) {
      container.innerHTML = '<p class="empty-state">No authenticated PDF requests yet.</p>';
      if (pagination) pagination.hidden = true;
      return;
    }
    const totalCount = requestLogState.hasServerPagination
      ? Math.max(logs.length, requestLogState.total)
      : logs.length;
    const pageCount = Math.ceil(totalCount / requestLogState.pageSize);
    requestLogState.page = Math.min(requestLogState.page, pageCount);
    const start = (requestLogState.page - 1) * requestLogState.pageSize;
    logs.slice(start, start + requestLogState.pageSize).forEach((log) => {
      const item = document.createElement('div');
      item.className = `log-item ${log.status === 'success' ? 'is-success' : 'is-error'}`;
      const main = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = log.status === 'success' ? 'PDF generated' : 'PDF failed';
      const details = document.createElement('span');
      details.textContent = `${formatLogDate(log.timestamp)} · ${log.apiKeyId ? `key ${log.apiKeyId.slice(0, 8)}` : 'account request'}`;
      main.append(title, details);
      const meta = document.createElement('span');
      meta.textContent =
        log.status === 'success' && Number.isFinite(log.size)
          ? `${(log.size / 1024).toFixed(1)} KB`
          : log.errorType || log.status;
      item.append(main, meta);
      container.appendChild(item);
    });
    if (pagination) pagination.hidden = pageCount < 2 && !requestLogState.nextCursor;
    if (previous) previous.disabled = requestLogState.loadingMore || requestLogState.page === 1;
    if (next) next.disabled = requestLogState.loadingMore || (requestLogState.page >= pageCount && !requestLogState.nextCursor);
    if (pageStatus) pageStatus.textContent = `${requestLogState.page} / ${pageCount}`;
  }

  function showLogFetchError(message) {
    const container = document.getElementById('logsList');
    if (!container || typeof document.createElement !== 'function') return;
    const notice = document.createElement('p');
    notice.className = 'dashboard-notice';
    if (notice.dataset) notice.dataset.state = 'error';
    if (typeof notice.setAttribute === 'function') notice.setAttribute('role', 'status');
    notice.textContent = message;
    if (typeof container.prepend === 'function') {
      container.prepend(notice);
    } else if (typeof container.appendChild === 'function') {
      container.appendChild(notice);
    }
  }

  function initializeLogExplorer() {
    const refresh = async () => {
      const status = document.getElementById('logsStatusFilter')?.value || 'all';
      const sort = document.getElementById('logsSort')?.value || 'newest';
      const loadFn = getLoadDashboard();
      if (requestLogState.hasServerPagination && loadFn && !requestLogState.loadingMore) {
        requestLogState.loadingMore = true;
        updateVisibleLogs();
        let fetchFailed = false;
        try {
          const data = await loadFn({ cursor: 0, status, sort });
          renderLogs((data && data.logs) || [], (data && data.logsPagination) || { nextCursor: null, total: 0 });
          return;
        } catch {
          fetchFailed = true;
        } finally {
          requestLogState.loadingMore = false;
        }
        if (fetchFailed) {
          updateVisibleLogs();
          showLogFetchError('Could not load request logs. Please try again.');
          return;
        }
      }
      requestLogState.page = 1;
      updateVisibleLogs();
    };
    document.getElementById('logsStatusFilter')?.addEventListener('change', refresh);
    document.getElementById('logsSort')?.addEventListener('change', refresh);
    document.getElementById('logsPreviousPage')?.addEventListener('click', () => {
      if (requestLogState.page > 1) {
        requestLogState.page -= 1;
        updateVisibleLogs();
      }
    });
    document.getElementById('logsNextPage')?.addEventListener('click', async () => {
      const nextPage = requestLogState.page + 1;
      const nextStart = (nextPage - 1) * requestLogState.pageSize;
      const status = document.getElementById('logsStatusFilter')?.value || 'all';
      const sort = document.getElementById('logsSort')?.value || 'newest';
      const currentMatches = requestLogState.logs.filter((log) =>
        status === 'all'
          ? true
          : status === 'error'
            ? log.status !== 'success'
            : log.status === status
      );
      const loadFn = getLoadDashboard();
      if (
        nextStart >= currentMatches.length &&
        requestLogState.nextCursor &&
        loadFn &&
        !requestLogState.loadingMore
      ) {
        requestLogState.loadingMore = true;
        updateVisibleLogs();
        let fetchFailed = false;
        try {
          const data = await loadFn({ cursor: requestLogState.nextCursor, status, sort });
          const more = (data && data.logs) || [];
          const seen = new Set(requestLogState.logs.map((l) => l.requestId).filter(Boolean));
          more.forEach((l) => {
            if (!l.requestId || !seen.has(l.requestId)) requestLogState.logs.push(l);
          });
          requestLogState.nextCursor = data?.logsPagination?.nextCursor ?? null;
          if (Number.isFinite(data?.logsPagination?.total)) {
            requestLogState.total = data.logsPagination.total;
          }
        } catch {
          fetchFailed = true;
        } finally {
          requestLogState.loadingMore = false;
        }
        if (fetchFailed) {
          updateVisibleLogs();
          showLogFetchError('Could not load more request logs. Please try again.');
          return;
        }
      }
      requestLogState.page = nextPage;
      updateVisibleLogs();
    });
  }

  const moduleExports = {
    formatLogDate,
    requestLogState,
    renderLogs,
    renderRecentActivity,
    updateVisibleLogs,
    initializeLogExplorer,
  };

  Object.assign(global, moduleExports);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = moduleExports;
  }
})(typeof window === 'undefined' ? globalThis : window);
