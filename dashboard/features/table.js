(function (global) {
  'use strict';

  function formatDate(timestamp) {
    if (!timestamp) return '—';
    try {
      const date = new Date(timestamp * 1000);
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        date
      );
    } catch {
      return '—';
    }
  }

  function formatAssetDate(timestamp) {
    if (!timestamp) return '—';
    const date = new Date(Number(timestamp) * 1000);
    return Number.isNaN(date.getTime())
      ? '—'
      : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function renderTable(container, { columns = [], rows = [], empty, loading, caption }) {
    if (!container) return;
    if (loading) {
      const message = document.createElement('p');
      message.className = 'dashboard-table-empty';
      message.setAttribute('role', 'status');
      message.setAttribute('aria-live', 'polite');
      message.textContent = loading;
      container.replaceChildren(message);
      return;
    }
    if (!rows.length) {
      const message = document.createElement('p');
      message.className = 'dashboard-table-empty';
      message.setAttribute('role', 'status');
      message.setAttribute('aria-live', 'polite');
      message.textContent = empty;
      container.replaceChildren(message);
      return;
    }

    const table = document.createElement('table');
    table.className = 'dashboard-table';
    if (caption) {
      const tableCaption = document.createElement('caption');
      tableCaption.className = 'visually-hidden';
      tableCaption.textContent = caption;
      table.appendChild(tableCaption);
    }

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    columns.forEach(({ label, className = '' }) => {
      const th = document.createElement('th');
      th.scope = 'col';
      if (className) th.className = className;
      th.textContent = label;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      row.cells.forEach((cell, cellIndex) => {
        const td = document.createElement('td');
        const column = columns[cellIndex] || {};
        if (column.className) td.className = column.className;
        if (cell instanceof Node) {
          td.appendChild(cell);
        } else {
          td.innerHTML = cell;
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    const wrap = document.createElement('div');
    wrap.className = 'dashboard-table-wrap';
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', caption || 'Data table');
    wrap.appendChild(table);
    container.replaceChildren(wrap);
  }

  const moduleExports = {
    formatDate,
    formatAssetDate,
    renderTable,
  };

  global.formatDate = formatDate;
  global.formatAssetDate = formatAssetDate;
  global.renderTable = renderTable;

  Object.assign(global, moduleExports);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = moduleExports;
  }
})(typeof window === 'undefined' ? globalThis : window);
