(function (global) {
  'use strict';

  function formatLogDate(timestamp) {
    if (!timestamp) return 'Unknown time';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(timestamp * 1000)
    );
  }

  const requestLogState = { logs: [], page: 1, pageSize: 5 };

  function renderLogs(logs) {
    requestLogState.logs = logs || [];
    requestLogState.page = 1;
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
        log.status === 'success' ? `${(log.size / 1024).toFixed(1)} KB` : log.errorType || log.status;
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
      .filter((log) => status === 'all' || log.status === status)
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
    const pageCount = Math.ceil(logs.length / requestLogState.pageSize);
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
        log.status === 'success' ? `${(log.size / 1024).toFixed(1)} KB` : log.errorType || log.status;
      item.append(main, meta);
      container.appendChild(item);
    });
    if (pagination) pagination.hidden = pageCount < 2;
    if (previous) previous.disabled = requestLogState.page === 1;
    if (next) next.disabled = requestLogState.page === pageCount;
    if (pageStatus) pageStatus.textContent = `${requestLogState.page} / ${pageCount}`;
  }

  function initializeLogExplorer() {
    const refresh = () => {
      requestLogState.page = 1;
      updateVisibleLogs();
    };
    document.getElementById('logsStatusFilter')?.addEventListener('change', refresh);
    document.getElementById('logsSort')?.addEventListener('change', refresh);
    document.getElementById('logsPreviousPage')?.addEventListener('click', () => {
      requestLogState.page -= 1;
      updateVisibleLogs();
    });
    document.getElementById('logsNextPage')?.addEventListener('click', () => {
      requestLogState.page += 1;
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
