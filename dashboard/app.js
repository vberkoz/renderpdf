const API_URL = '/api/v1';
const IS_LOCAL_PREVIEW =
  window.location.protocol === 'file:' ||
  ['localhost', '127.0.0.1'].includes(window.location.hostname);
const dashboardViewNames = new Set([
  'overview',
  'create-render',
  'keys',
  'billing',
  'sources',
  'files',
  'batches',
  'logs',
]);
const requestedDashboardView = new URLSearchParams(window.location.search).get('view');
let activeDashboardView = dashboardViewNames.has(requestedDashboardView)
  ? requestedDashboardView
  : 'overview';

function decodeTokenPayload(token) {
  try {
    const encodedPayload = token.split('.')[1];
    const base64 = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(
      decodeURIComponent(
        atob(base64)
          .split('')
          .map((character) => `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`)
          .join('')
      )
    );
  } catch (error) {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem('id_token');
  localStorage.removeItem('access_token');
}

function checkAuth() {
  if (IS_LOCAL_PREVIEW) return true;

  const idToken = localStorage.getItem('id_token');
  const payload = idToken ? decodeTokenPayload(idToken) : null;

  if (!payload || (payload.exp && payload.exp * 1000 <= Date.now())) {
    clearSession();
    window.location.href = '/app/login';
    return false;
  }

  return true;
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, options);

  if (response.status === 401) {
    clearSession();
    window.location.href = '/app/login';
    throw new Error('Your session has expired');
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = await response.json();
      message = payload.error || payload.message || message;
      if (payload.code) message = `${message} [${payload.code}]`;
    } catch (error) {
      // Keep the status-based message when the response is not JSON.
    }
    throw new Error(message);
  }

  if (response.status === 204) return null;
  return response.json();
}

function authHeaders() {
  return {
    Authorization: `Bearer ${localStorage.getItem('id_token')}`,
    'Content-Type': 'application/json',
  };
}

window.apiRequest = apiRequest;
window.authHeaders = authHeaders;

// Shared in-app replacement for browser prompts. Keep it generic so future
// dashboard actions can request text without relying on transient native UI.
function showDashboardDialog({
  title,
  description,
  label = 'Name',
  value = '',
  confirmLabel = 'Save',
  requiresText = true,
  destructive = false,
}) {
  const dialog = document.getElementById('dashboardTextDialog');
  const form = document.getElementById('dashboardTextDialogForm');
  const input = document.getElementById('dashboardDialogInput');
  const field = document.getElementById('dashboardDialogField');
  const cancelButton = document.getElementById('dashboardDialogCancel');
  const confirmButton = document.getElementById('dashboardDialogConfirm');
  document.getElementById('dashboardDialogTitle').textContent = title;
  document.getElementById('dashboardDialogDescription').textContent = description;
  document.getElementById('dashboardDialogLabel').textContent = label;
  confirmButton.textContent = confirmLabel;
  field.hidden = !requiresText;
  input.required = requiresText;
  confirmButton.classList.toggle('dashboard-button-danger', destructive);
  confirmButton.classList.toggle('dashboard-button-primary', !destructive);
  input.value = value;
  input.setCustomValidity('');

  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      form.removeEventListener('submit', onSubmit);
      cancelButton.removeEventListener('click', onCancel);
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('close', onClose);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (dialog.open) dialog.close();
      resolve(result);
    };
    const onSubmit = (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (requiresText && !text) {
        input.setCustomValidity(`${label} is required`);
        input.reportValidity();
        return;
      }
      finish(requiresText ? text : true);
    };
    const onCancel = (event) => {
      event?.preventDefault();
      finish(requiresText ? null : false);
    };
    const onClose = () => finish(null);
    form.addEventListener('submit', onSubmit);
    cancelButton.addEventListener('click', onCancel);
    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('close', onClose);
    dialog.showModal();
    window.requestAnimationFrame(() => {
      if (requiresText) {
        input.focus();
        input.select();
      } else {
        confirmButton.focus();
      }
    });
  });
}

function promptDashboardText(options) {
  return showDashboardDialog({ ...options, requiresText: true });
}

function confirmDashboardAction(options) {
  return showDashboardDialog({ ...options, requiresText: false, destructive: true });
}

window.dashboardDialog = { promptText: promptDashboardText, confirm: confirmDashboardAction };


function loadDashboard() {
  return apiRequest('/dashboard', { headers: authHeaders() });
}

let currentBilling = (typeof window !== 'undefined' && window.currentBilling) || { status: 'free', tier: 'free' };

function dashboardTemplateRequest(path, options = {}) {
  return apiRequest(path, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
  });
}

function listTemplates() {
  return dashboardTemplateRequest('/dashboard/templates');
}
function createTemplate(template) {
  return dashboardTemplateRequest('/dashboard/templates', {
    method: 'POST',
    body: JSON.stringify(template),
  });
}
function getStoredTemplate(templateId) {
  return dashboardTemplateRequest(`/dashboard/templates/${encodeURIComponent(templateId)}`);
}
function updateTemplate(templateId, template) {
  return dashboardTemplateRequest(`/dashboard/templates/${encodeURIComponent(templateId)}`, {
    method: 'PUT',
    body: JSON.stringify(template),
  });
}
function removeTemplate(templateId) {
  return dashboardTemplateRequest(`/dashboard/templates/${encodeURIComponent(templateId)}`, {
    method: 'DELETE',
  });
}
function renderStoredTemplate(templateId, variables) {
  return dashboardTemplateRequest('/dashboard/render-template', {
    method: 'POST',
    body: JSON.stringify({ templateId, variables }),
  });
}
function setNotice(element, message = '', state = '') {
  element.textContent = message;
  element.dataset.state = state;
  element.hidden = !message;
}

function setButtonPending(button, pending, pendingLabel) {
  if (!button.dataset.label) button.dataset.label = button.innerHTML;
  button.disabled = pending;
  button.setAttribute('aria-busy', String(pending));
  button.classList.toggle('is-processing', pending);
  button.innerHTML = pending ? pendingLabel : button.dataset.label;
}

const templateCodeEditors = {};

function initializeTemplateCodeEditor(id, mode) {
  const textarea = document.getElementById(id);
  if (!textarea || !window.CodeMirror) return null;

  const editor = window.CodeMirror.fromTextArea(textarea, {
    mode,
    lineNumbers: true,
    lineWrapping: true,
    indentUnit: 2,
    tabSize: 2,
  });
  editor.on('change', () => {
    editor.save();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  templateCodeEditors[id] = editor;
  return editor;
}

function templateEditorValue(id) {
  return templateCodeEditors[id]?.getValue() ?? document.getElementById(id).value;
}

function setTemplateEditorValue(id, value) {
  const textarea = document.getElementById(id);
  const nextValue = String(value ?? '');
  if (templateCodeEditors[id]) {
    templateCodeEditors[id].setValue(nextValue);
  } else {
    textarea.value = nextValue;
  }
}

function templatePayloadFromForm() {
  return {
    name: document.getElementById('templateNameInput').value.trim(),
    type: document.getElementById('templateTypeInput').value,
    html: templateEditorValue('templateHtmlInput').trim(),
    variables: templateVariablesFromEditor(),
  };
}

function templateVariablesFromEditor() {
  const variables = JSON.parse(templateEditorValue('templateVariablesInput'));
  if (!variables || Array.isArray(variables) || typeof variables !== 'object')
    throw new Error('Variables must be an object');
  return variables;
}

const pagedPreviewHead = `
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https:; font-src data: https:; script-src 'unsafe-inline' https://unpkg.com; connect-src https:">
<style>
  html, body { overflow-x: hidden !important; background: #eef1f3 !important; }
  /* The template's @page rule owns printable margins. Padding here would be
     copied into every Paged.js sheet and create a different page height. */
  body { margin: 0 !important; padding: 0 !important; }
  /* Templates often define a screen A4 canvas. Paged.js supplies the paper,
     so that canvas must not consume a second A4 height or apply screen zoom. */
  .a4-page { height: auto !important; min-height: 0 !important; width: auto !important; margin: 0 !important; overflow: visible !important; padding: 0 !important; zoom: 1 !important; }
  /* Templates may opt in when their final signature block belongs at the
     bottom of a single A4 sheet, rather than immediately after the clauses. */
  .a4-page.pin-signatures { display: flex !important; flex-direction: column !important; min-height: 279mm !important; }
  .a4-page.pin-signatures .signatures { margin-top: auto !important; }
  .pagedjs_pages { box-sizing: border-box; display: grid; justify-content: center; gap: 18px; width: 100%; margin: 0 !important; padding: 0; transform-origin: top center; }
  .pagedjs_page { margin: 0 !important; box-shadow: 0 8px 24px rgba(23, 32, 42, .16); transform-origin: top center; }
  .pagedjs_sheet { background: #fff; }
  /* Paged.js cannot continue the template's 14mm + 6mm grid across a sheet:
     the continuation inherits only the narrow first column. Use an equivalent
     20mm inset in previews so the continued text keeps its full width. */
  .pagedjs_page .clauses li { display: block !important; position: relative !important; padding-left: 20mm !important; }
  .pagedjs_page .clauses li::before { position: absolute !important; top: 4mm; left: 0; }
  .pagedjs_page .scope { -webkit-box-decoration-break: clone; box-decoration-break: clone; }
</style>
<script>
  function collectPrintRules(rules, output, insidePrintMedia = false) {
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule) {
        if (/(^|\\W)print(\\W|$)/i.test(rule.conditionText)) collectPrintRules(rule.cssRules, output, true);
        continue;
      }
      if (rule.cssRules) {
        collectPrintRules(rule.cssRules, output, insidePrintMedia);
        continue;
      }
      if (insidePrintMedia) output.push(rule.cssText);
    }
  }

  function applyTemplatePrintRules() {
    const printRules = [];
    for (const sheet of document.styleSheets) {
      try { collectPrintRules(sheet.cssRules, printRules); } catch (_) { /* Ignore unreadable cross-origin font stylesheets. */ }
    }
    if (!printRules.length) return;
    const style = document.createElement('style');
    style.textContent = printRules.join('\\n');
    document.head.appendChild(style);
  }

  function reducePagedPreviewMargins() {
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (!/^@page\\b/i.test(rule.cssText)) continue;
          const match = rule.cssText.match(/\\bmargin\\s*:\s*([^;}]+)/i);
          if (!match) continue;
          const values = match[1].trim().split(/\\s+/);
          if (!values.every((value) => /^-?\\d*\\.?\\d+mm$/i.test(value))) continue;
          const reduced = values.map((value) => (parseFloat(value) * 0.96).toFixed(4) + 'mm');
          const style = document.createElement('style');
          style.textContent = '@page { margin: ' + reduced.join(' ') + '; }';
          document.head.appendChild(style);
          return;
        }
      } catch (_) { /* Ignore unreadable cross-origin font stylesheets. */ }
    }
  }

  function fitPagedPreviewPages() {
    const pages = document.querySelector('.pagedjs_pages');
    const page = document.querySelector('.pagedjs_page');
    if (!pages || !page) return;
    pages.style.zoom = '1';
    const pagePadding = getComputedStyle(pages);
    const availableWidth = Math.max(1, pages.clientWidth - parseFloat(pagePadding.paddingLeft) - parseFloat(pagePadding.paddingRight));
    pages.style.zoom = String(Math.min(1, availableWidth / page.getBoundingClientRect().width));
  }

  function reportPagedPreviewSize() {
    const pages = document.querySelector('.pagedjs_pages');
    const height = pages
      ? Math.ceil(pages.getBoundingClientRect().height)
      : Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
    window.parent.postMessage({ type: 'renderpdf-paged-preview-size', height: Math.max(1, height) }, '*');
  }

  window.PagedConfig = { auto: false };
  window.addEventListener('load', () => {
    applyTemplatePrintRules();
    reducePagedPreviewMargins();
    if (!window.PagedPolyfill) {
      reportPagedPreviewSize();
      return;
    }
    const render = window.PagedPolyfill.preview();
    if (render && typeof render.then === 'function') render.then(
      () => { fitPagedPreviewPages(); reportPagedPreviewSize(); },
      // A parent iframe refresh cancels an in-flight pagination run. Paged.js
      // can then measure a node it has already removed; retain the unpaged
      // document as the preview rather than surfacing an uncaught rejection.
      () => { reportPagedPreviewSize(); }
    );
    else requestAnimationFrame(() => { fitPagedPreviewPages(); reportPagedPreviewSize(); });
    window.setTimeout(reportPagedPreviewSize, 250);
    if (window.ResizeObserver) new ResizeObserver(reportPagedPreviewSize).observe(document.body);
  });
  window.addEventListener('resize', fitPagedPreviewPages);
</script>
<script src="https://unpkg.com/pagedjs@0.4.3/dist/paged.polyfill.js"></script>`;

const pendingPagedPreviews = new Map();

function setPagedPreview(previewId, srcdoc) {
  const preview = document.getElementById(previewId);
  const pending = pendingPagedPreviews.get(previewId);
  if (pending) window.clearTimeout(pending);
  preview.style.height = '1px';
  preview.parentElement.scrollTop = 0;
  // CodeMirror emits an input event for every edit. Coalesce those updates
  // before replacing srcdoc so Paged.js never has competing render passes.
  const timer = window.setTimeout(() => {
    pendingPagedPreviews.delete(previewId);
    preview.srcdoc = srcdoc;
  }, 160);
  pendingPagedPreviews.set(previewId, timer);
}

function revealWorkflowPreview(detailsId) {
  const details = document.getElementById(detailsId);
  if (!details) return;
  details.open = true;
  if (window.matchMedia('(max-width: 760px)').matches) {
    details.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function previewTemplateHTML(html) {
  const fallback =
    '<main style="font-family:\'IBM Plex Sans\',Arial,sans-serif;padding:24px;color:#586473">Your template preview appears here.</main>';
  const documentPreview = new DOMParser().parseFromString(html || fallback, 'text/html');
  documentPreview
    .querySelectorAll('script, iframe, object, embed')
    .forEach((element) => element.remove());
  documentPreview.querySelectorAll('*').forEach((element) => {
    element.getAttributeNames().forEach((name) => {
      const value = element.getAttribute(name)?.trim().toLowerCase() || '';
      if (name.toLowerCase().startsWith('on') || value.startsWith('javascript:'))
        element.removeAttribute(name);
    });
  });
  documentPreview.head.insertAdjacentHTML('afterbegin', pagedPreviewHead);
  setPagedPreview('templatePreview', `<!doctype html>${documentPreview.documentElement.outerHTML}`);
}

function escapeTemplatePreviewHTML(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function previewTemplateWithVariables() {
  const templateHTML = templateEditorValue('templateHtmlInput');
  let variables;
  try {
    variables = templateVariablesFromEditor();
  } catch (_) {
    previewTemplateHTML(templateHTML);
    return;
  }
  const renderedHTML = templateHTML.replace(
    /{{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*}}/g,
    (placeholder, path) => {
      const value = path.split('.').reduce((current, key) => current && current[key], variables);
      return value === undefined || value === null || typeof value === 'object'
        ? placeholder
        : escapeTemplatePreviewHTML(value);
    }
  );
  previewTemplateHTML(renderedHTML);
}

function resetTemplateEditor() {
  document.getElementById('templateForm').reset();
  document.getElementById('templateId').value = '';
  document.getElementById('deleteTemplateBtn').hidden = true;
  document.getElementById('saveTemplateBtn').disabled = false;
  ['templateNameInput', 'templateTypeInput', 'templateHtmlInput'].forEach((id) => {
    document.getElementById(id).disabled = false;
  });
  document.getElementById('templateTypeInput').value = 'custom';
  setTemplateEditorValue('templateHtmlInput', '');
  setTemplateEditorValue('templateVariablesInput', '{}');
  window.customSelect?.setValue('templatePickerInput', 'new');
  previewTemplateHTML('');
}

function populateTemplateEditor(template, pickerValue) {
  document.getElementById('templateId').value = template.id || '';
  document.getElementById('templateNameInput').value = template.name || '';
  document.getElementById('templateTypeInput').value = template.type || 'custom';
  if (pickerValue) window.customSelect?.setValue('templatePickerInput', pickerValue);
  setTemplateEditorValue('templateHtmlInput', template.html || '');
  // Starters include variable documentation as well as a concrete example
  // payload. The latter is what both the local preview and PDF renderer need.
  setTemplateEditorValue(
    'templateVariablesInput',
    JSON.stringify(template.exampleVariables || template.variables || {}, null, 2)
  );
  document.getElementById('deleteTemplateBtn').hidden = !template.id;
  document.getElementById('saveTemplateBtn').disabled = false;
  ['templateNameInput', 'templateTypeInput', 'templateHtmlInput'].forEach((id) => {
    document.getElementById(id).disabled = false;
  });
  previewTemplateWithVariables();
}

function formatDate(timestamp) {
  if (!timestamp) return 'Not used yet';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp * 1000));
}

function formatAssetDate(timestamp) {
  if (!timestamp) return 'Updated recently';
  const date = typeof timestamp === 'string' ? new Date(timestamp) : new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return 'Updated recently';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

function renderTable(container, { columns = [], rows = [], empty, loading, caption }) {
  container.replaceChildren();
  container.classList.add('dashboard-table-wrap');
  container.scrollLeft = 0;
  if (loading) {
    container.textContent = loading;
    return;
  }
  if (!rows.length) {
    if (empty instanceof Node) container.append(empty);
    else container.textContent = empty || 'No data available.';
    return;
  }
  const table = document.createElement('table');
  table.className = 'dashboard-table';
  if (caption) {
    const tableCaption = document.createElement('caption');
    tableCaption.textContent = caption;
    table.append(tableCaption);
  }
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  columns.forEach((column) => {
    const cell = document.createElement('th');
    cell.scope = 'col';
    if (column.className) cell.classList.add(column.className);
    cell.textContent = column.label;
    headRow.append(cell);
  });
  head.append(headRow);
  table.append(head);
  const body = document.createElement('tbody');
  rows.forEach((row) => {
    const tableRow = document.createElement('tr');
    row.cells.forEach((content, index) => {
      const cell = document.createElement('td');
      cell.classList.add(`dashboard-table-cell-${index + 1}`);
      if (columns[index]?.className) cell.classList.add(columns[index].className);
      if (columns[index]?.label) cell.dataset.label = columns[index].label;
      if (content instanceof Node) cell.append(content);
      else cell.textContent = content ?? '';
      tableRow.append(cell);
    });
    body.append(tableRow);
  });
  table.append(body);
  container.append(table);
}

function renderKeys(keys) {
  const container = document.getElementById('keysList');
  if (!keys || keys.length === 0) {
    const empty = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = 'No API keys yet';
    const explanation = document.createElement('span');
    explanation.textContent =
      'An API key authenticates server-side requests. Store it in a secret manager or environment variable—never in browser code.';
    const exampleLink = document.createElement('a');
    exampleLink.className = 'empty-state-link';
    exampleLink.href = '/docs/api/render/';
    exampleLink.textContent = 'See your first render example →';
    empty.append(title, explanation, exampleLink);
    renderTable(container, { caption: 'API keys', empty });
    return;
  }
  const rows = keys.map((key) => {
    const identity = document.createElement('div');
    identity.className = 'dashboard-table-primary';
    if (key.name) {
      const nameLabel = document.createElement('strong');
      nameLabel.className = 'dashboard-key-name';
      nameLabel.textContent = key.name;
      identity.appendChild(nameLabel);
    }
    const keyLabel = document.createElement('code');
    keyLabel.textContent = key.keyId;
    const created = document.createElement('span');
    created.textContent = `Created ${formatDate(key.createdAt)}`;
    identity.append(keyLabel, created);

    const activity = document.createElement('div');
    activity.className = 'dashboard-table-activity';
    const activityValue = document.createElement('strong');
    activityValue.textContent = formatDate(key.lastUsed);
    activity.append(activityValue);

    const state = document.createElement('span');
    state.className = 'dashboard-table-state';
    state.textContent = key.isActive ? 'Active' : 'Revoked';
    const actions = document.createElement('div');
    actions.className = 'dashboard-table-actions';

    if (key.isActive) {
      const revokeButton = document.createElement('button');
      revokeButton.className = 'table-action danger revoke-key-action';
      revokeButton.type = 'button';
      revokeButton.textContent = 'Revoke';
      revokeButton.dataset.keyId = key.keyId;
      revokeButton.setAttribute(
        'aria-label',
        `Revoke API key ${key.name ? `${key.name} (${key.keyId})` : key.keyId}`
      );
      actions.appendChild(revokeButton);
    }

    return {
      cells: [identity, activity, state, actions],
      sortValues: [key.name || key.keyId, key.lastUsed || 0, key.isActive ? 1 : 0],
    };
  });
  renderTable(container, {
    caption: 'API keys',
    density: 'comfortable',
    columns: [
      { label: 'Credential', sortable: true },
      { label: 'Last used', sortable: true },
      { label: 'State', sortable: true, className: 'state' },
      { label: 'Actions', className: 'dashboard-table-actions-cell' },
    ],
    rows,
  });
}

async function loadKeys() {
  const status = document.getElementById('keysStatus');
  try {
    const data = await listKeys();
    if (!data.keys || data.keys.length === 0) {
      try {
        const autoKey = await generateKey({ name: 'Default Key' });
        showNewlyGeneratedKey(autoKey, true);
        const refreshed = await listKeys();
        renderKeys(refreshed.keys);
        setNotice(status);
        return;
      } catch (autoErr) {
        console.error('Could not auto-generate default API key:', autoErr);
      }
    }
    renderKeys(data.keys);
    setNotice(status);
  } catch (error) {
    setNotice(status, `Could not load API keys. ${error.message}`, 'error');
  }
}

function formatLogDate(timestamp) {
  if (!timestamp) return 'Unknown time';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(timestamp * 1000)
  );
}

const requestLogState = { logs: [], page: 1, pageSize: 5 };

const dashboardPageContexts = {
  overview: {
    kicker: 'Developer dashboard',
    title: 'Home',
    description: 'Your PDF activity, capacity, and next steps.',
  },
  'create-render': {
    kicker: 'Create and render',
    title: 'Create a PDF',
    description: 'Start with a template, saved source, or inline document, then render a PDF.',
  },
  keys: {
    kicker: 'Account',
    title: 'API Keys',
    description:
      'Create credentials for trusted server-side use, then store each key securely and revoke keys you no longer need.',
  },
  sources: {
    kicker: 'Reusable content',
    title: 'Saved sources',
    description:
      'Choose and manage templates alongside reusable document definitions for future renders and batches.',
  },
  files: {
    kicker: 'Files',
    title: 'Files',
    description: '',
  },
  batches: {
    kicker: 'Batches',
    title: 'Batch jobs',
    description: '',
  },
  logs: {
    kicker: 'Activity',
    title: 'Activity',
    description: '',
  },
  billing: {
    kicker: 'Billing',
    title: 'Plan and billing',
    description: 'Review your current PDF capacity and manage your subscription.',
  },
};

function setDashboardPageContext(view) {
  const context = dashboardPageContexts[view] || dashboardPageContexts.overview;
  const kicker = document.getElementById('dashboardPageKicker');
  const title = document.getElementById('dashboardPageTitle');
  const description = document.getElementById('dashboardPageDescription');
  kicker.textContent = context.kicker;
  kicker.hidden = !context.kicker;
  title.textContent = context.title;
  description.textContent = context.description;
  description.hidden = !context.description;
  const mobileCurrent = document.getElementById('dashboardMobileCurrentView');
  if (mobileCurrent) mobileCurrent.textContent = context.title;
}

function setDashboardView(view, { history = 'none', focus = false } = {}) {
  const nextView = dashboardViewNames.has(view) ? view : 'overview';
  activeDashboardView = nextView;
  document.documentElement.dataset.dashboardCurrentView = nextView;
  document.body.dataset.dashboardCurrentView = nextView;

  document.querySelectorAll('[data-dashboard-view]').forEach((panel) => {
    panel.hidden = panel.dataset.dashboardView !== nextView;
  });
  document.querySelectorAll('[data-dashboard-nav]').forEach((item) => {
    const isActive = item.dataset.dashboardNav === nextView;
    item.classList.toggle('is-active', isActive);
    item.toggleAttribute('aria-current', isActive);
    if (isActive) item.setAttribute('aria-current', 'page');
  });
  setDashboardPageContext(nextView);
  document.title = `RenderPDF | ${dashboardPageContexts[nextView].title}`;

  if (history !== 'none') {
    const url = new URL(window.location.href);
    url.searchParams.set('view', nextView);
    url.hash = '';
    window.history[history === 'replace' ? 'replaceState' : 'pushState']({}, '', url);
  }
  if (focus) {
    document.querySelector('.dashboard-mobile-navigation')?.removeAttribute('open');
    document.getElementById('main-content')?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function initializeDashboardNavigation() {
  setDashboardView(activeDashboardView);
  document.querySelectorAll('.dashboard-mobile-navigation > summary').forEach((summary) => {
    summary.addEventListener('keydown', (event) => {
      if (!['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      const navigation = summary.parentElement;
      if (navigation instanceof HTMLDetailsElement) navigation.open = !navigation.open;
    });
  });
  document.querySelectorAll('[data-dashboard-nav]').forEach((item) => {
    item.addEventListener('click', (event) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const url = new URL(item.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname !== window.location.pathname)
        return;
      const view = url.searchParams.get('view');
      if (!dashboardViewNames.has(view)) return;
      event.preventDefault();
      setDashboardView(view, { history: 'push', focus: true });
      document.dispatchEvent(new CustomEvent('dashboardviewchange', { detail: { view } }));
    });
  });
  window.addEventListener('popstate', () => {
    setDashboardView(new URLSearchParams(window.location.search).get('view') || 'overview', {
      focus: true,
    });
    document.dispatchEvent(
      new CustomEvent('dashboardviewchange', { detail: { view: activeDashboardView } })
    );
  });
}

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
    pagination.hidden = true;
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
  pagination.hidden = pageCount < 2;
  previous.disabled = requestLogState.page === 1;
  next.disabled = requestLogState.page === pageCount;
  pageStatus.textContent = `${requestLogState.page} / ${pageCount}`;
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

initializeLogExplorer();

function renderDashboard(data) {
  const usage = data.usage || {};
  const billing = data.billing || { status: 'free', plan: 'Free' };
  currentBilling = billing;
  window.currentBilling = billing;
  document.getElementById('pdfsToday').textContent = String(usage.pdfsToday ?? 0);
  document.getElementById('monthlyUsage').textContent =
    `${usage.usedThisMonth ?? 0} of ${usage.quota ?? 0}`;
  document.getElementById('quotaDetail').textContent =
    `${usage.remaining ?? 0} PDFs remaining this month`;
  document.getElementById('dailyActivityDetail').textContent = usage.failedToday
    ? `${usage.failedToday} failed`
    : 'No failed renders';
  if (typeof renderBillingView === 'function') {
    renderBillingView(billing, usage);
  }
  renderLogs(data.logs);
  renderRecentActivity(data.logs);
}

async function refreshDashboard(preserveNotice = false) {
  const billingStatus = document.getElementById('billingStatus');
  try {
    renderDashboard(await loadDashboard());
    if (!preserveNotice) setNotice(billingStatus);
  } catch (error) {
    setNotice(billingStatus, `Could not load dashboard data. ${error.message}`, 'error');
  }
}
window.refreshDashboard = refreshDashboard;

if (checkAuth()) {
  document.querySelectorAll('label[role="button"][for]').forEach((label) => {
    label.addEventListener('keydown', (event) => {
      if (!['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      document.getElementById(label.htmlFor)?.click();
    });
  });
  initializeDashboardNavigation();
  const generateButton = document.getElementById('generateKeyBtn');
  const keysList = document.getElementById('keysList');
  const keysStatus = document.getElementById('keysStatus');
  const templatesStatus = document.getElementById('templatesStatus');
  const templatePickerInput = document.getElementById('templatePickerInput');
  const createRenderModeInput = document.getElementById('createRenderModeInput');
  const templateForm = document.getElementById('templateForm');
  const templateRenderResult = document.getElementById('templateRenderResult');
  const saveTemplateButton = document.getElementById('saveTemplateBtn');
  const previewTemplateButton = document.getElementById('previewTemplateBtn');
  const renderTemplateButton = document.getElementById('renderTemplateBtn');
  const documentJsonStatus = document.getElementById('documentJsonStatus');
  const documentJsonResult = document.getElementById('documentJsonResult');
  const previewDocumentJsonButton = document.getElementById('previewDocumentJsonBtn');
  const renderDocumentJsonButton = document.getElementById('renderDocumentJsonBtn');

  window.customSelect?.init();
  initializeTemplateCodeEditor('templateHtmlInput', 'htmlmixed');
  initializeTemplateCodeEditor('templateVariablesInput', 'application/json');
  initializeTemplateCodeEditor('documentJsonInput', 'application/json');
  initializeTemplateCodeEditor('documentMarkdownInput', 'markdown');
  initializeTemplateCodeEditor('documentMarkdownSettingsInput', 'application/json');
  document.querySelectorAll('.editor-secondary').forEach((details) => {
    details.addEventListener('toggle', () => {
      if (!details.open) return;
      window.requestAnimationFrame(() =>
        details.querySelectorAll('textarea').forEach((textarea) => {
          templateCodeEditors[textarea.id]?.refresh();
        })
      );
    });
  });
  setCreateRenderMode(createRenderModeInput.value);
  let savedTemplates = new Map();
  let starterTemplates = new Map();
  let savedSources = new Map();

  function setSavedSourceInventory(
    sources,
    selectedValue = document.getElementById('storedSourcePickerInput').value
  ) {
    savedSources = new Map((sources || []).map((source) => [source.id, source]));
    const options = (sources || []).map((source) => ({ value: source.id, label: source.name }));
    const selected = savedSources.has(selectedValue) ? selectedValue : '';
    window.customSelect?.replaceOptions(
      'storedSourcePickerInput',
      [
        {
          label: 'Saved sources',
          options: options.length ? options : [{ value: '', label: 'No saved sources yet' }],
        },
      ],
      selected
    );
    return selected;
  }

  function describeStoredSource(source) {
    return source
      ? `${source.name} · ${source.sourceType} source`
      : 'Select a saved source to add data and create PDFs.';
  }

  function selectStoredSource(sourceID) {
    const selected = setSavedSourceInventory([...savedSources.values()], sourceID);
    const source = savedSources.get(selected);
    setNotice(
      document.getElementById('storedSourceStatus'),
      describeStoredSource(source),
      source ? 'success' : ''
    );
    return source;
  }

  async function loadSavedSources(selectedValue) {
    try {
      const result = await dashboardTemplateRequest('/dashboard/sources');
      const selected = setSavedSourceInventory(result.sources || [], selectedValue);
      selectStoredSource(selected);
      return result.sources || [];
    } catch (error) {
      setSavedSourceInventory([], '');
      setNotice(
        document.getElementById('storedSourceStatus'),
        `Could not load saved sources. ${error.message}`,
        'error'
      );
      return [];
    }
  }

  function openReusableAsset(assetType, asset) {
    setDashboardView('create-render', { history: 'push', focus: true });
    document.dispatchEvent(
      new CustomEvent('dashboardviewchange', { detail: { view: 'create-render' } })
    );
    if (assetType === 'template') {
      createRenderModeInput.value = 'template';
      setCreateRenderMode('template');
      openStoredTemplate(asset);
      return;
    }
    createRenderModeInput.value = 'stored';
    setCreateRenderMode('stored');
    selectStoredSource(asset.id);
  }

  async function openStoredTemplate(summary) {
    try {
      const template = await getStoredTemplate(summary.id);
      populateTemplateEditor(template, `saved:${template.id}`);
      setNotice(templatesStatus);
    } catch (error) {
      setNotice(templatesStatus, `Could not load template. ${error.message}`, 'error');
    }
  }

  async function loadTemplates(selectedValue = templatePickerInput.value) {
    try {
      const data = await listTemplates();
      savedTemplates = new Map((data.templates || []).map((template) => [template.id, template]));
      starterTemplates = new Map(
        (data.starters || []).map((template) => [template.type, template])
      );
      window.customSelect?.replaceOptions(
        'templatePickerInput',
        [
          {
            label: 'Custom templates',
            options: [
              { value: 'new', label: 'Blank custom template' },
              ...(data.templates || []).map((template) => ({
                value: `saved:${template.id}`,
                label: template.name,
              })),
            ],
          },
          {
            label: 'Starter templates',
            options: (data.starters || []).map((template) => ({
              value: `starter:${template.type}`,
              label: `${template.name} starter`,
            })),
          },
        ],
        selectedValue
      );
      setNotice(templatesStatus);
    } catch (error) {
      setNotice(templatesStatus, `Could not load templates. ${error.message}`, 'error');
    }
  }

  if (IS_LOCAL_PREVIEW) {
    renderKeys([]);
    setSavedSourceInventory([], '');
  } else {
    loadKeys();
    loadTemplates();
    loadSavedSources();
  }
  if (!IS_LOCAL_PREVIEW) refreshDashboard();
  resetTemplateEditor();
  loadDocumentEditorSample('html');
  loadDocumentEditorSample('markdown');
  setDocumentEditorMode('html');
  previewDocumentJson();
  // On a phone, editing remains the active stage. The paged preview is still
  // one tap away (and Preview opens it), instead of competing for the whole
  // screen before the source has been reviewed.
  if (window.matchMedia('(max-width: 760px)').matches) {
    document.querySelectorAll('.workflow-preview-details').forEach((details) => {
      details.open = false;
    });
  }
  initQuickstartModal();

  initBillingListeners();

  document.getElementById('copyOverviewDefaultKeyBtn')?.addEventListener('click', (event) => {
    const key = document.getElementById('overviewDefaultKeyValue')?.textContent?.trim();
    if (key) copyToClipboard(key, event.currentTarget, 'Copy Key');
  });

  document.getElementById('dismissOverviewDefaultKeyBtn')?.addEventListener('click', () => {
    const card = document.getElementById('overviewDefaultKeyCard');
    if (card) card.hidden = true;
  });

  document.getElementById('copyNewKeyBtn')?.addEventListener('click', (event) => {
    const key = document.getElementById('newKeyValue')?.textContent?.trim();
    if (key) copyToClipboard(key, event.currentTarget, 'Copy Key');
  });

  generateButton.addEventListener('click', async () => {
    setButtonPending(generateButton, true, 'Creating key...');
    setNotice(keysStatus);
    try {
      const data = await generateKey();
      showNewlyGeneratedKey(data, false);
      await loadKeys();
    } catch (error) {
      setNotice(keysStatus, `Could not create an API key. ${error.message}`, 'error');
    } finally {
      setButtonPending(generateButton, false);
    }
  });

  templatePickerInput.addEventListener('change', async () => {
    const [kind, value] = templatePickerInput.value.split(':', 2);
    if (kind === 'new') {
      resetTemplateEditor();
      setNotice(templatesStatus);
    } else if (kind === 'starter') {
      const starter = starterTemplates.get(value);
      if (starter) {
        populateTemplateEditor({ ...starter, id: '' }, templatePickerInput.value);
        setNotice(
          templatesStatus,
          `Loaded the ${starter.name} starter. Save it to create your editable copy.`,
          'success'
        );
      }
    } else if (kind === 'saved') {
      const template = savedTemplates.get(value);
      if (template) await openStoredTemplate(template);
    }
  });

  document.querySelectorAll('[data-source-choice]').forEach((choice) => {
    choice.addEventListener('click', () => {
      const nextMode = choice.dataset.sourceChoice;
      if (!nextMode || nextMode === createRenderModeInput.value) return;
      createRenderModeInput.value = nextMode;
      setCreateRenderMode(nextMode, true);
      if (nextMode === 'html' || nextMode === 'markdown') {
        try {
          previewDocumentJson();
          setNotice(
            documentJsonStatus,
            `Loaded the ${nextMode === 'markdown' ? 'Markdown' : 'HTML/CSS JSON'} sample.`,
            'success'
          );
        } catch (error) {
          setNotice(documentJsonStatus, error.message, 'error');
        }
      }
    });
  });

  document.getElementById('storedSourcePickerInput').addEventListener('change', () => {
    selectStoredSource(document.getElementById('storedSourcePickerInput').value);
  });

  document.getElementById('continueSavedSourceBtn').addEventListener('click', () => {
    const source = savedSources.get(document.getElementById('storedSourcePickerInput').value);
    if (!source) {
      setNotice(
        document.getElementById('storedSourceStatus'),
        'Choose a saved source first.',
        'error'
      );
      return;
    }
    window.customSelect?.replaceOptions(
      'batchSourceSelect',
      [
        {
          label: 'Saved sources',
          options: [...savedSources.values()].map((savedSource) => ({
            value: savedSource.id,
            label: savedSource.name,
          })),
        },
      ],
      source.id
    );
    updateBatchReview();
    setDashboardView('batches', { history: 'push', focus: true });
    document.dispatchEvent(new CustomEvent('dashboardviewchange', { detail: { view: 'batches' } }));
  });

  document
    .getElementById('templateHtmlInput')
    .addEventListener('input', previewTemplateWithVariables);
  document
    .getElementById('templateVariablesInput')
    .addEventListener('input', previewTemplateWithVariables);
  previewTemplateButton.addEventListener('click', () => {
    try {
      templateVariablesFromEditor();
      previewTemplateWithVariables();
      revealWorkflowPreview('templatePreviewDetails');
      setNotice(
        templatesStatus,
        'Preview updated with the current template and variable data.',
        'success'
      );
    } catch (error) {
      previewTemplateHTML(templateEditorValue('templateHtmlInput'));
      revealWorkflowPreview('templatePreviewDetails');
      setNotice(
        templatesStatus,
        `Preview uses template HTML only: Variable JSON is invalid. ${error.message}`,
        'error'
      );
    }
  });

  templateForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    let template;
    try {
      template = templatePayloadFromForm();
    } catch (error) {
      setNotice(templatesStatus, `Variable JSON is invalid. ${error.message}`, 'error');
      return;
    }
    if (!template.name || !template.html) {
      setNotice(templatesStatus, 'Template name and HTML are required.', 'error');
      return;
    }
    setButtonPending(saveTemplateButton, true, 'Saving...');
    try {
      const templateId = document.getElementById('templateId').value;
      const saved = templateId
        ? await updateTemplate(templateId, template)
        : await createTemplate(template);
      populateTemplateEditor(saved, `saved:${saved.id}`);
      await loadTemplates(`saved:${saved.id}`);
      setNotice(templatesStatus, 'Template saved.', 'success');
    } catch (error) {
      setNotice(templatesStatus, `Could not save template. ${error.message}`, 'error');
    } finally {
      setButtonPending(saveTemplateButton, false);
    }
  });

  document.getElementById('deleteTemplateBtn').addEventListener('click', async () => {
    const templateId = document.getElementById('templateId').value;
    if (!templateId) return;
    if (
      !(await confirmDashboardAction({
        title: 'Delete this template?',
        description: 'This cannot be undone.',
        confirmLabel: 'Delete template',
      }))
    )
      return;
    const button = document.getElementById('deleteTemplateBtn');
    setButtonPending(button, true, 'Deleting...');
    try {
      await removeTemplate(templateId);
      resetTemplateEditor();
      await loadTemplates();
      setNotice(templatesStatus, 'Template deleted.', 'success');
    } catch (error) {
      setNotice(templatesStatus, `Could not delete template. ${error.message}`, 'error');
    } finally {
      setButtonPending(button, false);
    }
  });

  renderTemplateButton.addEventListener('click', async () => {
    const templateId = document.getElementById('templateId').value;
    if (!templateId) {
      setNotice(templateRenderResult, 'Save this template before rendering a test PDF.', 'error');
      return;
    }
    let variables;
    try {
      variables = templateVariablesFromEditor();
    } catch (error) {
      setNotice(templateRenderResult, `Variable JSON is invalid. ${error.message}`, 'error');
      return;
    }
    setButtonPending(renderTemplateButton, true, 'Rendering PDF...');
    setNotice(templateRenderResult, 'Resolving template variables and rendering PDF...', 'pending');
    try {
      const result = await renderStoredTemplate(templateId, variables);
      templateRenderResult.dataset.state = 'success';
      templateRenderResult.replaceChildren();
      const link = document.createElement('a');
      link.href = result.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = `Download test PDF (${(result.size / 1024).toFixed(1)} KB) →`;
      templateRenderResult.append(link);
      templateRenderResult.hidden = false;
    } catch (error) {
      setNotice(templateRenderResult, `Could not render template. ${error.message}`, 'error');
    } finally {
      setButtonPending(renderTemplateButton, false);
    }
  });

  ['documentJsonInput', 'documentMarkdownInput', 'documentMarkdownSettingsInput'].forEach((id) =>
    document.getElementById(id).addEventListener('input', () => {
      try {
        parseDocumentEditor();
        setNotice(documentJsonStatus);
      } catch (error) {
        setNotice(documentJsonStatus, error.message, 'error');
      }
      setNotice(documentJsonResult);
    })
  );

  previewDocumentJsonButton.addEventListener('click', () => {
    try {
      previewDocumentJson();
      revealWorkflowPreview('documentPreviewDetails');
      setNotice(
        documentJsonStatus,
        'Preview updated. Values are HTML-escaped and network access is disabled.',
        'success'
      );
    } catch (error) {
      setNotice(documentJsonStatus, error.message, 'error');
    }
  });

  document.getElementById('resetDocumentJsonBtn').addEventListener('click', () => {
    const type = document.getElementById('documentSourceTypeInput').value;
    loadDocumentEditorSample(type);
    previewDocumentJson();
    setNotice(
      documentJsonStatus,
      `${type === 'markdown' ? 'Markdown' : 'HTML/CSS JSON'} sample restored.`,
      'success'
    );
    setNotice(documentJsonResult);
  });

  renderDocumentJsonButton.addEventListener('click', async () => {
    let request;
    try {
      request = previewDocumentJson();
      setNotice(documentJsonStatus);
    } catch (error) {
      setNotice(documentJsonStatus, error.message, 'error');
      return;
    }
    if (IS_LOCAL_PREVIEW) {
      setNotice(
        documentJsonResult,
        'PDF rendering requires a signed-in dashboard session.',
        'error'
      );
      return;
    }
    setButtonPending(renderDocumentJsonButton, true, 'Rendering PDF...');
    setNotice(documentJsonResult, 'Validating the document and rendering its PDF...', 'pending');
    try {
      const result = await renderInlineDocument(request);
      documentJsonResult.dataset.state = 'success';
      documentJsonResult.replaceChildren();
      const summary = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = 'PDF ready';
      const detail = document.createElement('span');
      detail.textContent = `${(result.size / 1024).toFixed(1)} KB · request ${result.requestId}`;
      summary.append(title, detail);
      const link = document.createElement('a');
      link.href = result.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.download = '';
      link.textContent = 'Download PDF →';
      documentJsonResult.append(summary, link);
      documentJsonResult.hidden = false;
    } catch (error) {
      setNotice(documentJsonResult, `Could not render document. ${error.message}`, 'error');
    } finally {
      setButtonPending(renderDocumentJsonButton, false);
    }
  });

  document.getElementById('saveDocumentSourceBtn').addEventListener('click', async () => {
    let definition;
    try {
      definition = previewDocumentJson();
      if (definition.html) {
        definition = { ...definition, source: { type: 'html', content: definition.html } };
        delete definition.html;
      }
    } catch (error) {
      setNotice(documentJsonStatus, error.message, 'error');
      return;
    }
    const name = await promptDashboardText({
      title: 'Name this source',
      description: 'Choose a name you will recognize when selecting it for a batch.',
      label: 'Source name',
      confirmLabel: 'Save source',
    });
    if (!name) return;
    const saveBtn = document.getElementById('saveDocumentSourceBtn');
    setButtonPending(saveBtn, true, 'Saving source…');
    try {
      const saved = await dashboardTemplateRequest('/dashboard/sources', {
        method: 'POST',
        body: JSON.stringify({ name, definition }),
      });
      await loadSavedSources(saved.id);
      setNotice(
        documentJsonStatus,
        'Source saved. It is ready to use from Saved sources or batch rendering.',
        'success'
      );
    } catch (error) {
      setNotice(documentJsonStatus, `Could not save source. ${error.message}`, 'error');
    } finally {
      setButtonPending(saveBtn, false);
    }
  });

  const managedRequest = (path, options = {}) => dashboardTemplateRequest(path, options);
  let batchDataUploadError = '';

  function batchSubmission() {
    const sourceID = document.getElementById('batchSourceSelect').value;
    if (!sourceID) throw new Error('Choose a saved source first.');
    let items;
    try {
      items = JSON.parse(document.getElementById('batchItemsInput').value);
    } catch (error) {
      throw new Error('Item data must be valid JSON.');
    }
    if (!Array.isArray(items) || items.length < 1 || items.length > 99)
      throw new Error('Provide a JSON array with 1–99 items.');
    return { sourceID, items };
  }

  function updateBatchReview() {
    const review = document.getElementById('batchReview');
    const sourceID = document.getElementById('batchSourceSelect').value;
    const sourceName = [
      ...document.querySelectorAll('#batchSourceSelect-menu [data-custom-select-option]'),
    ]
      .find((option) => option.dataset.value === sourceID)
      ?.textContent?.trim();
    const input = document.getElementById('batchItemsInput').value;
    const steps = {
      source: Boolean(sourceID),
      data: false,
      review: false,
      submit: false,
    };
    let items;
    let message = 'Choose a saved source and add item data to review this batch.';
    let state = 'pending';

    if (sourceID) {
      message = 'Add a JSON array with 1–99 items to continue.';
      try {
        if (batchDataUploadError) throw new Error(batchDataUploadError);
        items = JSON.parse(input);
        if (!Array.isArray(items)) {
          message = 'Item data must be a JSON array.';
          state = 'error';
        } else if (items.length < 1 || items.length > 99) {
          message = 'Provide a JSON array with 1–99 items.';
          state = 'error';
        } else {
          steps.data = true;
          steps.review = true;
          steps.submit = true;
          message = `Ready to render ${items.length} PDF${items.length === 1 ? '' : 's'} from ${sourceName || 'the selected source'}.`;
          state = 'success';
        }
      } catch (error) {
        if (batchDataUploadError) {
          message = batchDataUploadError;
          state = 'error';
        } else if (input.trim()) {
          message = 'Item data must be valid JSON.';
          state = 'error';
        }
      }
    }

    review.textContent = message;
    review.dataset.state = state;
    document.getElementById('submitBatchBtn').disabled = !steps.submit;
    Object.entries(steps).forEach(([step, complete]) => {
      document
        .querySelector(`[data-batch-step="${step}"]`)
        ?.classList.toggle('is-ready', complete || (step === 'source' && !steps.source));
    });
    return steps.submit ? { sourceID, items } : null;
  }

  function renderManagerEmpty(container, title, description, action) {
    const empty = document.createElement('div');
    empty.className = 'reusable-empty-state';
    const heading = document.createElement('strong');
    heading.textContent = title;
    const detail = document.createElement('span');
    detail.textContent = description;
    empty.append(heading, detail);
    if (action) {
      const link = document.createElement('a');
      link.className = 'dashboard-button dashboard-button-secondary';
      link.href = action.href;
      link.textContent = action.label;
      empty.append(link);
    }
    renderTable(container, { caption: container.getAttribute('aria-label') || title, empty });
  }

  function renderManagerLoading(container, label) {
    renderTable(container, { loading: `Loading ${label}` });
  }

  let managersLoaded = false;

  function renderBatchJobs(jobs) {
    const batchesManager = document.getElementById('batchesManager');
    if (!jobs.length) {
      renderManagerEmpty(
        batchesManager,
        'No batch jobs yet',
        'Choose a saved source and add item data to submit your first batch.'
      );
      return;
    }
    const rows = jobs.map((job) => {
      const details = document.createElement('div');
      const name = document.createElement('strong');
      const meta = document.createElement('span');
      details.append(name, meta);
      name.textContent = job.jobId;
      const finished =
        (job.succeededCount || 0) + (job.failedCount || 0) + (job.cancelledCount || 0);
      const createdAt = job.createdAt
        ? new Date(job.createdAt).toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : 'Date unavailable';
      meta.textContent = `${finished}/${job.itemCount} finished · ${job.succeededCount || 0} PDFs · ${createdAt}`;
      const status = document.createElement('span');
      status.textContent = job.status;
      const actions = document.createElement('div');
      if ((job.succeededCount || 0) > 0) {
        const download = document.createElement('button');
        download.className = 'table-action';
        download.type = 'button';
        download.textContent = 'Download ZIP';
        download.setAttribute('aria-label', `Download ZIP for batch ${job.jobId}`);
        download.onclick = async () => {
          const result = await managedRequest(
            `/dashboard/batches/${encodeURIComponent(job.jobId)}/download`
          );
          window.open(result.url, '_blank', 'noopener');
        };
        actions.append(download);
      }
      if (job.status === 'queued' || job.status === 'running') {
        const cancel = document.createElement('button');
        cancel.className = 'table-action';
        cancel.type = 'button';
        cancel.textContent = 'Cancel batch';
        cancel.setAttribute('aria-label', `Cancel batch ${job.jobId}`);
        cancel.onclick = async () => {
          if (
            !(await confirmDashboardAction({
              title: `Cancel batch “${job.jobId}”?`,
              description: 'Pending PDFs in this batch will not be rendered.',
              confirmLabel: 'Cancel batch',
            }))
          )
            return;
          await managedRequest(`/dashboard/batches/${encodeURIComponent(job.jobId)}/cancel`, {
            method: 'POST',
          });
          await refreshManagers();
        };
        actions.append(cancel);
      }
      return {
        cells: [details, status, actions],
        sortValues: [job.jobId, job.status, job.createdAt || ''],
      };
    });
    renderTable(batchesManager, {
      caption: 'Batch jobs',
      columns: [
        { label: 'Batch' },
        { label: 'Status' },
        { label: 'Actions', className: 'dashboard-table-actions-cell' },
      ],
      rows,
    });
  }

  async function refreshManagers() {
    const templatesManager = document.getElementById('templatesManager');
    const sourcesManager = document.getElementById('sourcesManager');
    const filesManager = document.getElementById('filesManager');
    const batchesManager = document.getElementById('batchesManager');
    if (!managersLoaded) {
      renderManagerLoading(templatesManager, 'templates');
      renderManagerLoading(sourcesManager, 'saved sources');
      renderManagerLoading(filesManager, 'private files');
      renderManagerLoading(batchesManager, 'batch jobs');
    }
    try {
      const [templateResult, sourceResult, fileResult, batchResult] = await Promise.all([
        listTemplates(),
        managedRequest('/dashboard/sources'),
        managedRequest('/dashboard/files'),
        managedRequest('/dashboard/batches'),
      ]);
      savedTemplates = new Map(
        (templateResult.templates || []).map((template) => [template.id, template])
      );
      starterTemplates = new Map(
        (templateResult.starters || []).map((template) => [template.type, template])
      );
      window.customSelect?.replaceOptions(
        'templatePickerInput',
        [
          {
            label: 'Custom templates',
            options: [
              { value: 'new', label: 'Blank custom template' },
              ...(templateResult.templates || []).map((template) => ({
                value: `saved:${template.id}`,
                label: template.name,
              })),
            ],
          },
          {
            label: 'Starter templates',
            options: (templateResult.starters || []).map((template) => ({
              value: `starter:${template.type}`,
              label: `${template.name} starter`,
            })),
          },
        ],
        templatePickerInput.value
      );
      const templates = templateResult.templates || [];
      if (!templates.length) {
        renderManagerEmpty(
          templatesManager,
          'No templates yet',
          'Create a reusable layout for individual PDFs.',
          { href: '/app/?view=create-render', label: 'Create template' }
        );
      } else {
        const templateRows = templates.map((template) => {
          const details = document.createElement('div');
          details.className = 'reusable-asset-details';
          const name = document.createElement('strong');
          const meta = document.createElement('span');
          name.textContent = template.name;
          meta.textContent = `${template.type} template · updated ${formatAssetDate(template.updatedAt)}`;
          details.append(name, meta);
          const actions = document.createElement('div');
          actions.className = 'dashboard-table-actions reusable-asset-actions';
          const use = document.createElement('button');
          use.className = 'table-action';
          use.type = 'button';
          use.textContent = 'Use in Create';
          use.setAttribute('aria-label', `Use template ${template.name} in Create PDF`);
          use.onclick = () => openReusableAsset('template', template);
          const remove = document.createElement('button');
          remove.className = 'table-action danger';
          remove.type = 'button';
          remove.textContent = 'Delete';
          remove.setAttribute('aria-label', `Delete template ${template.name}`);
          remove.onclick = async () => {
            if (
              !(await confirmDashboardAction({
                title: `Delete “${template.name}”?`,
                description: 'This template will be permanently deleted.',
                confirmLabel: 'Delete template',
              }))
            )
              return;
            try {
              await removeTemplate(template.id);
              await refreshManagers();
              setNotice(document.getElementById('sourcesStatus'), 'Template deleted.', 'success');
            } catch (error) {
              setNotice(
                document.getElementById('sourcesStatus'),
                `Could not delete this template. ${error.message}`,
                'error'
              );
            }
          };
          actions.append(use, remove);
          return {
            cells: [details, actions],
            sortValues: [template.name, template.updatedAt || ''],
          };
        });
        renderTable(templatesManager, {
          caption: 'Saved templates',
          columns: [
            { label: 'Template' },
            { label: 'Actions', className: 'dashboard-table-actions-cell' },
          ],
          rows: templateRows,
        });
      }
      const sourceList = sourceResult.sources || [];
      setSavedSourceInventory(sourceList);
      const batchOptions = sourceList.map((source) => ({ value: source.id, label: source.name }));
      if (!sourceList.length) {
        renderManagerEmpty(
          sourcesManager,
          'No saved sources yet',
          'Save a document definition for repeat renders and batches.',
          { href: '/app/?view=create-render', label: 'Create PDF' }
        );
      }
      const sourceRows = sourceList.map((source) => {
        const details = document.createElement('div');
        details.className = 'reusable-asset-details';
        const name = document.createElement('strong');
        const meta = document.createElement('span');
        name.textContent = source.name;
        meta.textContent = `${source.sourceType} · ${(source.sizeBytes / 1024).toFixed(1)} KB`;
        details.append(name, meta);
        const actions = document.createElement('div');
        actions.className = 'dashboard-table-actions reusable-asset-actions';
        const use = document.createElement('button');
        use.className = 'table-action';
        use.type = 'button';
        use.textContent = 'Use in Create';
        use.setAttribute('aria-label', `Use saved source ${source.name} in Create PDF`);
        const remove = document.createElement('button');
        remove.className = 'table-action danger';
        remove.type = 'button';
        remove.textContent = 'Delete';
        remove.setAttribute('aria-label', `Delete saved source ${source.name}`);
        actions.append(use, remove);
        use.onclick = () => openReusableAsset('source', source);
        remove.onclick = async () => {
          if (
            !(await confirmDashboardAction({
              title: `Delete “${source.name}”?`,
              description:
                'This saved source will be permanently deleted and cannot be used in future renders or batches.',
              confirmLabel: 'Delete source',
            }))
          )
            return;
          try {
            await managedRequest(`/dashboard/sources/${encodeURIComponent(source.id)}`, {
              method: 'DELETE',
            });
            await refreshManagers();
            setNotice(document.getElementById('sourcesStatus'), 'Source deleted.', 'success');
          } catch (error) {
            setNotice(
              document.getElementById('sourcesStatus'),
              `Could not delete this source. ${error.message}`,
              'error'
            );
          }
        };
        return { cells: [details, actions], sortValues: [source.name, source.sizeBytes || 0] };
      });
      if (sourceRows.length)
        renderTable(sourcesManager, {
          caption: 'Saved sources',
          columns: [
            { label: 'Source' },
            { label: 'Actions', className: 'dashboard-table-actions-cell' },
          ],
          rows: sourceRows,
        });
      const currentBatchSource = document.getElementById('batchSourceSelect').value;
      window.customSelect?.replaceOptions(
        'batchSourceSelect',
        [
          {
            label: 'Saved sources',
            options: batchOptions.length
              ? batchOptions
              : [{ value: '', label: 'No saved sources' }],
          },
        ],
        batchOptions.some((source) => source.value === currentBatchSource)
          ? currentBatchSource
          : batchOptions[0]?.value || ''
      );
      updateBatchReview();
      const files = fileResult.files || [];
      if (!files.length) {
        renderManagerEmpty(
          filesManager,
          'No private files yet',
          'Uploaded packages and rendered PDFs will appear here.'
        );
      }
      const fileRows = files.map((file) => {
        const displayName = file.displayName || file.kind.replace(/_/g, ' ');
        const details = document.createElement('div');
        details.className = 'file-record-details';
        const name = document.createElement('strong');
        const meta = document.createElement('span');
        name.textContent = displayName;
        details.append(name, meta);
        const createdAt = file.createdAt
          ? new Date(file.createdAt).toLocaleString([], {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })
          : 'Date unavailable';
        meta.textContent = `${(file.sizeBytes / 1024).toFixed(1)} KB · ${createdAt}`;
        const kind = document.createElement('span');
        kind.textContent = file.kind.replace(/_/g, ' ');
        const actions = document.createElement('div');
        actions.className = 'dashboard-table-actions';
        const download = document.createElement('button');
        const remove = document.createElement('button');
        download.className = 'table-action';
        download.type = 'button';
        download.textContent = 'Download';
        remove.className = 'table-action danger';
        remove.type = 'button';
        remove.textContent = 'Delete';
        actions.append(download, remove);
        download.setAttribute('aria-label', `Download file ${displayName}`);
        remove.setAttribute('aria-label', `Delete file ${displayName}`);
        download.onclick = async () => {
          const result = await managedRequest(
            `/dashboard/files/${encodeURIComponent(file.id)}/download`
          );
          window.open(result.url, '_blank', 'noopener');
        };
        remove.onclick = async () => {
          const name = displayName;
          if (
            !(await confirmDashboardAction({
              title: `Delete “${name}”?`,
              description:
                'This private file will be permanently deleted and can no longer be downloaded.',
              confirmLabel: 'Delete file',
            }))
          )
            return;
          try {
            await managedRequest(`/dashboard/files/${encodeURIComponent(file.id)}`, {
              method: 'DELETE',
            });
            await refreshManagers();
            setNotice(document.getElementById('filesStatus'), 'File deleted.', 'success');
          } catch (error) {
            setNotice(
              document.getElementById('filesStatus'),
              `Could not delete this file. ${error.message}`,
              'error'
            );
          }
        };
        return {
          cells: [details, kind, actions],
          sortValues: [displayName, file.kind, file.createdAt || ''],
        };
      });
      if (fileRows.length)
        renderTable(filesManager, {
          caption: 'Private files',
          columns: [
            { label: 'File' },
            { label: 'Kind' },
            { label: 'Actions', className: 'dashboard-table-actions-cell' },
          ],
          rows: fileRows,
        });
      renderBatchJobs(batchResult.jobs || []);
      managersLoaded = true;
    } catch (error) {
      const managerView = ['sources', 'files', 'batches'].includes(activeDashboardView)
        ? activeDashboardView
        : 'sources';
      const status = document.getElementById(`${managerView}Status`);
      const resource =
        managerView === 'files'
          ? 'private files'
          : managerView === 'batches'
            ? 'batch jobs'
            : 'saved sources';
      setNotice(status, `Could not load ${resource}. ${error.message}`, 'error');
    }
  }
  document.getElementById('refreshSourcesBtn').onclick = async () => {
    const btn = document.getElementById('refreshSourcesBtn');
    setButtonPending(btn, true, 'Refreshing…');
    try {
      await refreshManagers();
    } finally {
      setButtonPending(btn, false);
    }
  };
  document.getElementById('packageUploadButton').onclick = () =>
    document.getElementById('packageUploadInput').click();
  document.getElementById('packageUploadInput').onchange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const uploadBtn = document.getElementById('packageUploadButton');
    setButtonPending(uploadBtn, true, 'Uploading…');
    const status = document.getElementById('filesStatus');
    setNotice(status, `Uploading ${file.name}…`, 'pending');
    try {
      const upload = await managedRequest('/dashboard/files/upload', { method: 'POST' });
      await fetch(upload.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': 'application/zip' },
      });
      await refreshManagers();
      setNotice(status, 'ZIP package uploaded.', 'success');
    } catch (error) {
      setNotice(status, `Could not upload ${file.name}. ${error.message}`, 'error');
    } finally {
      setButtonPending(uploadBtn, false);
      event.target.value = '';
    }
  };
  document.getElementById('batchSourceSelect').addEventListener('change', updateBatchReview);
  document.getElementById('batchItemsInput').addEventListener('input', () => {
    batchDataUploadError = '';
    updateBatchReview();
  });
  document.getElementById('batchDataUpload').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const data = await file.text();
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) throw new Error('Upload a JSON array of batch items.');
      batchDataUploadError = '';
      document.getElementById('batchItemsInput').value = JSON.stringify(parsed, null, 2);
    } catch (error) {
      batchDataUploadError = error.message || 'Could not read that JSON file.';
    } finally {
      event.target.value = '';
      updateBatchReview();
    }
  });
  document.getElementById('submitBatchBtn').onclick = async () => {
    const submission = updateBatchReview();
    if (!submission) return;
    const button = document.getElementById('submitBatchBtn');
    setButtonPending(button, true, 'Submitting batch...');
    try {
      const job = await managedRequest('/dashboard/batches', {
        method: 'POST',
        body: JSON.stringify({
          version: '1',
          source: { type: 'stored', id: submission.sourceID },
          items: submission.items,
        }),
      });
      await refreshManagers();
      document.getElementById('batchReview').textContent =
        `Batch ${job.jobId} submitted. You can track it below.`;
      document.getElementById('batchReview').dataset.state = 'success';
      document.getElementById('submitBatchBtn').disabled = true;
    } catch (error) {
      document.getElementById('batchReview').textContent =
        `Could not submit batch. ${error.message}`;
      document.getElementById('batchReview').dataset.state = 'error';
    } finally {
      setButtonPending(button, false);
    }
  };
  document.getElementById('refreshBatchesBtn').onclick = async () => {
    const btn = document.getElementById('refreshBatchesBtn');
    setButtonPending(btn, true, 'Refreshing…');
    try {
      await refreshManagers();
    } finally {
      setButtonPending(btn, false);
    }
  };
  document.addEventListener('dashboardviewchange', () => {
    if (['sources', 'files', 'batches'].includes(activeDashboardView)) refreshManagers();
  });
  if (['sources', 'files', 'batches'].includes(activeDashboardView)) refreshManagers();

  keysList.addEventListener('click', async (event) => {
    const revokeButton = event.target.closest('[data-key-id]');
    if (!revokeButton) return;
    if (
      !(await confirmDashboardAction({
        title: 'Revoke this API key?',
        description: 'Requests using this key will stop working immediately.',
        confirmLabel: 'Revoke key',
      }))
    )
      return;

    setButtonPending(revokeButton, true, 'Revoking...');
    try {
      await deleteKey(revokeButton.dataset.keyId);
      await loadKeys();
    } catch (error) {
      setNotice(keysStatus, `Could not revoke the API key. ${error.message}`, 'error');
      setButtonPending(revokeButton, false);
    }
  });

  ['logoutBtn', 'mobileLogoutBtn'].forEach((btnId) => {
    const btn = document.getElementById(btnId);
    if (btn) {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        clearSession();
        window.location.href = '/app/login';
      });
    }
  });
}
