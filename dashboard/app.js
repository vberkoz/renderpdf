const API_URL = '/api/v1';
const IS_LOCAL_PREVIEW =
  typeof window !== 'undefined' &&
  (window.location.protocol === 'file:' ||
    (['localhost', '127.0.0.1'].includes(window.location.hostname) &&
      !window.localStorage?.getItem('id_token')));

const browserWindow = typeof window !== 'undefined' ? window : globalThis;

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
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('id_token');
    localStorage.removeItem('access_token');
  }
}

function checkAuth() {
  if (IS_LOCAL_PREVIEW) return true;

  const idToken = typeof localStorage !== 'undefined' ? localStorage.getItem('id_token') : null;
  const payload = idToken ? decodeTokenPayload(idToken) : null;

  if (!payload || (payload.exp && payload.exp * 1000 <= Date.now())) {
    clearSession();
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.style.display = 'none';
    }
    if (typeof window !== 'undefined' && window.location) {
      const loc = window.location;
      const currentPath =
        (loc.pathname || '') + (loc.search || '') + (loc.hash || '');
      if (typeof localStorage !== 'undefined' && currentPath && currentPath !== '/app/login') {
        localStorage.setItem('post_login_redirect', currentPath);
      }
      if (typeof loc.replace === 'function') {
        loc.replace('/app/login');
      } else {
        loc.href = '/app/login';
      }
    }
    return false;
  }

  return true;
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, options);

  if (response.status === 401) {
    clearSession();
    if (typeof window !== 'undefined' && window.location) {
      try {
        const loc = window.location;
        localStorage.setItem('post_login_redirect', (loc.pathname || '') + (loc.search || ''));
      } catch (error) {}
      window.location.href = '/app/login';
    }
    throw new Error('Your session has expired');
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = await response.json();
      message = payload.error || payload.message || message;
      if (payload.code) message = `${message} [${payload.code}]`;
    } catch (error) {}
    throw new Error(message);
  }

  if (response.status === 204) return null;
  return response.json();
}

function authHeaders() {
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('id_token') : null;
  return {
    Authorization: token ? `Bearer ${token}` : '',
    'Content-Type': 'application/json',
  };
}

browserWindow.apiRequest = apiRequest;
browserWindow.authHeaders = authHeaders;

function setNotice(element, message = '', state = '') {
  if (!element) return;
  element.textContent = message;
  element.dataset.state = state;
  element.hidden = !message;
}

function setButtonPending(button, pending, pendingLabel) {
  if (!button) return;
  if (pending) {
    button.dataset.originalText = button.textContent;
    button.textContent = pendingLabel || 'Working...';
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.classList.add('is-processing');
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.classList.remove('is-processing');
  }
}

let currentBilling =
  (typeof window !== 'undefined' && window.currentBilling) || { status: 'free', tier: 'free' };

function dashboardTemplateRequest(path, options = {}) {
  return apiRequest(path, {
    ...options,
    headers: {
      ...authHeaders(),
      ...(options.headers || {}),
    },
  });
}

browserWindow.managedRequest = dashboardTemplateRequest;

function loadDashboard(options = {}) {
  const req = (typeof globalThis !== 'undefined' && globalThis.apiRequest) || apiRequest;
  const hdrs = (typeof globalThis !== 'undefined' && globalThis.authHeaders) || authHeaders;
  const params = new URLSearchParams();
  if (options && options.limit != null) params.set('limit', String(options.limit));
  if (options && options.cursor != null && options.cursor !== '') {
    params.set('cursor', String(options.cursor));
  }
  if (options && options.status && options.status !== 'all') {
    params.set('status', String(options.status));
  }
  if (options && options.sort && options.sort !== 'newest') {
    params.set('sort', String(options.sort));
  }
  const qs = params.toString();
  return req(qs ? `/dashboard?${qs}` : '/dashboard', {
    headers: hdrs(),
  });
}

browserWindow.loadDashboard = loadDashboard;

function renderDashboard(data) {
  const usage = data.usage || {};
  const billing = data.billing || { status: 'free', plan: 'Free' };
  currentBilling = billing;
  if (typeof window !== 'undefined') {
    window.currentBilling = billing;
  }

  const pdfsToday = document.getElementById('pdfsToday');
  const monthlyUsage = document.getElementById('monthlyUsage');
  const quotaDetail = document.getElementById('quotaDetail');
  const dailyActivityDetail = document.getElementById('dailyActivityDetail');

  if (pdfsToday) pdfsToday.textContent = String(usage.pdfsToday ?? 0);
  if (monthlyUsage)
    monthlyUsage.textContent = `${usage.usedThisMonth ?? 0} of ${usage.quota ?? 0}`;
  if (quotaDetail)
    quotaDetail.textContent = `${usage.remaining ?? 0} PDFs remaining this month`;
  if (dailyActivityDetail)
    dailyActivityDetail.textContent = usage.failedToday
      ? `${usage.failedToday} failed`
      : 'No failed renders';

  if (typeof renderBillingView === 'function') {
    renderBillingView(billing, usage);
  }

  if (typeof renderLogs === 'function') {
    renderLogs(data.logs, data.logsPagination);
  }
  if (typeof renderRecentActivity === 'function') {
    renderRecentActivity(data.logs);
  }
}

let refreshDashboardPromise = null;

async function refreshDashboard(preserveNotice = false) {
  if (refreshDashboardPromise) return refreshDashboardPromise;
  const billingStatus = typeof document !== 'undefined' ? document.getElementById('billingStatus') : null;
  const existingRetry =
    billingStatus && typeof billingStatus.querySelector === 'function'
      ? billingStatus.querySelector('[data-action="retry-dashboard"]')
      : null;
  if (existingRetry) {
    existingRetry.disabled = true;
    existingRetry.setAttribute('aria-busy', 'true');
  }
  refreshDashboardPromise = (async () => {
    try {
      const loadFn = (typeof globalThis !== 'undefined' && globalThis.loadDashboard) || loadDashboard;
      const renderFn = (typeof globalThis !== 'undefined' && globalThis.renderDashboard) || renderDashboard;
      renderFn(await loadFn());
      if (!preserveNotice) setNotice(billingStatus);
      else if (existingRetry && typeof existingRetry.remove === 'function') existingRetry.remove();
    } catch (error) {
      setNotice(billingStatus, `Could not load dashboard data. ${error.message}`, 'error');
      if (
        billingStatus &&
        typeof document !== 'undefined' &&
        typeof document.createElement === 'function' &&
        typeof billingStatus.appendChild === 'function'
      ) {
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'dashboard-button dashboard-button-secondary dashboard-notice-retry';
        if (retryBtn.dataset) retryBtn.dataset.action = 'retry-dashboard';
        retryBtn.textContent = 'Retry';
        if (typeof retryBtn.addEventListener === 'function') {
          retryBtn.addEventListener('click', async () => {
            retryBtn.disabled = true;
            if (typeof retryBtn.setAttribute === 'function') retryBtn.setAttribute('aria-busy', 'true');
            await refreshDashboard();
          });
        }
        billingStatus.appendChild(retryBtn);
      }
      const recentActivityList = typeof document !== 'undefined' ? document.getElementById('recentActivityList') : null;
      if (recentActivityList) {
        recentActivityList.innerHTML = '<p class="empty-state">Could not load recent activity. Please try again later.</p>';
      }
    } finally {
      refreshDashboardPromise = null;
    }
  })();
  return refreshDashboardPromise;
}

browserWindow.refreshDashboard = refreshDashboard;

// ─── DOM INITIALIZATION ───────────────────────────────────────────────────────

if (typeof window !== 'undefined' && typeof document !== 'undefined' && checkAuth()) {
  document.querySelectorAll('label[role="button"][for]').forEach((label) => {
    label.addEventListener('keydown', (event) => {
      if (!['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      document.getElementById(label.htmlFor)?.click();
    });
  });

  if (typeof initializeDashboardNavigation === 'function') {
    initializeDashboardNavigation();
  }

  const appFrame = document.querySelector('.dashboard-app-frame');
  const appLayout = document.querySelector('.dashboard-app-layout');
  const railToggle = document.querySelector('[data-action="nav"]');
  if (appLayout && railToggle) {
    const syncRailState = (isCollapsed) => {
      for (const el of [appFrame, appLayout]) {
        if (!el) continue;
        if (isCollapsed) el.dataset.nav = 'collapsed';
        else delete el.dataset.nav;
      }
      railToggle.setAttribute('aria-expanded', String(!isCollapsed));
    };
    try {
      if (localStorage.getItem('ds-rail') === 'collapsed') syncRailState(true);
    } catch {}
    railToggle.addEventListener('click', () => {
      const nextCollapsed = appLayout.dataset.nav !== 'collapsed';
      syncRailState(nextCollapsed);
      try { localStorage.setItem('ds-rail', nextCollapsed ? 'collapsed' : 'open'); } catch {}
    });
  }

  const generateButton = document.getElementById('generateKeyBtn');
  const keysStatus = document.getElementById('keysStatus');
  const templatesStatus = document.getElementById('templatesStatus');
  const templatePickerInput = document.getElementById('templatePickerInput');
  const createRenderModeInput = document.getElementById('createRenderModeInput');
  const documentJsonStatus = document.getElementById('documentJsonStatus');

  window.customSelect?.init();

  if (typeof initializeTemplateCodeEditor === 'function') {
    initializeTemplateCodeEditor('templateHtmlInput', 'htmlmixed');
    initializeTemplateCodeEditor('templateVariablesInput', 'application/json');
    initializeTemplateCodeEditor('documentJsonInput', 'application/json');
    initializeTemplateCodeEditor('documentMarkdownInput', 'markdown');
    initializeTemplateCodeEditor('documentMarkdownSettingsInput', 'application/json');
  }

  document.querySelectorAll('.editor-secondary').forEach((details) => {
    details.addEventListener('toggle', () => {
      if (!details.open) return;
      window.requestAnimationFrame(() =>
        details.querySelectorAll('textarea').forEach((textarea) => {
          if (window.templateCodeEditors) {
            window.templateCodeEditors[textarea.id]?.refresh();
          }
        })
      );
    });
  });

  if (createRenderModeInput && typeof setCreateRenderMode === 'function') {
    setCreateRenderMode(createRenderModeInput.value);
  }

  let savedTemplates = new Map();
  let starterTemplates = new Map();

  function setSavedTemplatesState(templates, starters) {
    savedTemplates = new Map((templates || []).map((template) => [template.id, template]));
    starterTemplates = new Map((starters || []).map((template) => [template.type, template]));
  }
  window.setSavedTemplatesState = setSavedTemplatesState;

  async function openStoredTemplate(summary) {
    try {
      if (typeof getStoredTemplate === 'function') {
        const template = await getStoredTemplate(summary.id);
        if (typeof populateTemplateEditor === 'function') {
          populateTemplateEditor(template, `saved:${template.id}`);
        }
      }
      setNotice(templatesStatus);
    } catch (error) {
      setNotice(templatesStatus, `Could not load template. ${error.message}`, 'error');
    }
  }

  async function loadTemplates(selectedValue = templatePickerInput?.value) {
    if (!templatePickerInput || typeof listTemplates !== 'function') return;
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
    if (typeof renderKeys === 'function') renderKeys([]);
    if (typeof setSavedSourceInventory === 'function') {
      setSavedSourceInventory([], '');
    }
    renderDashboard({
      usage: { usedThisMonth: 0, quota: 25, remaining: 25, pdfsToday: 0 },
      billing: { status: 'free', plan: 'Free' },
      logs: [],
    });
  } else {
    if (typeof loadKeys === 'function') loadKeys();
    loadTemplates();
    if (typeof loadSavedSources === 'function') loadSavedSources();
    refreshDashboard();
  }

  if (typeof resetTemplateEditor === 'function') resetTemplateEditor();
  if (typeof loadDocumentEditorSample === 'function') {
    loadDocumentEditorSample('html');
    loadDocumentEditorSample('markdown');
  }
  if (typeof setDocumentEditorMode === 'function') setDocumentEditorMode('html');
  if (typeof previewDocumentJson === 'function') {
    try {
      previewDocumentJson();
    } catch (previewError) {
      console.warn('Initial document preview deferred:', previewError);
    }
  }

  if (window.matchMedia && window.matchMedia('(max-width: 760px)').matches) {
    document.querySelectorAll('.workflow-preview-details').forEach((details) => {
      details.open = false;
    });
  }

  if (typeof initQuickstartModal === 'function') initQuickstartModal();
  if (typeof initBillingListeners === 'function') initBillingListeners();
  if (typeof initializeLogExplorer === 'function') initializeLogExplorer();

  const mergeFeature = typeof initMergeFeature === 'function' ? initMergeFeature() : null;

  document.getElementById('copyOverviewDefaultKeyBtn')?.addEventListener('click', (event) => {
    const key = document.getElementById('overviewDefaultKeyValue')?.textContent?.trim();
    if (key && typeof copyToClipboard === 'function') copyToClipboard(key, event.currentTarget, 'Copy Key');
  });

  document.getElementById('dismissOverviewDefaultKeyBtn')?.addEventListener('click', () => {
    const card = document.getElementById('overviewDefaultKeyCard');
    if (card) card.hidden = true;
  });

  document.getElementById('copyNewKeyBtn')?.addEventListener('click', (event) => {
    const key = document.getElementById('newKeyValue')?.textContent?.trim();
    if (key && typeof copyToClipboard === 'function') copyToClipboard(key, event.currentTarget, 'Copy Key');
  });

  if (generateButton) {
    generateButton.addEventListener('click', async () => {
      setButtonPending(generateButton, true, 'Creating key...');
      setNotice(keysStatus);
      try {
        if (typeof generateKey === 'function') {
          const data = await generateKey();
          if (typeof showNewlyGeneratedKey === 'function') showNewlyGeneratedKey(data, false);
          const keysContainer = document.getElementById('keysList');
          const existingKeys = Array.isArray(browserWindow.currentKeys) ? browserWindow.currentKeys : [];
          const hasRenderedRows = Boolean(
            keysContainer &&
              typeof keysContainer.querySelector === 'function' &&
              keysContainer.querySelector('tbody tr')
          );
          if (
            data &&
            data.keyId &&
            existingKeys.length > 0 &&
            hasRenderedRows &&
            typeof renderKeys === 'function'
          ) {
            renderKeys([
              {
                keyId: data.keyId,
                name: data.name || 'Default API Key',
                createdAt: data.createdAt || Math.floor(Date.now() / 1000),
                lastUsed: data.lastUsed || null,
                isActive: true,
              },
              ...existingKeys,
            ]);
          } else if (typeof loadKeys === 'function') {
            await loadKeys();
          }
        }
      } catch (error) {
        setNotice(keysStatus, `Could not create an API key. ${error.message}`, 'error');
      } finally {
        setButtonPending(generateButton, false);
      }
    });
  }

  if (templatePickerInput) {
    templatePickerInput.addEventListener('change', async () => {
      const [kind, value] = templatePickerInput.value.split(':', 2);
      if (kind === 'new') {
        if (typeof resetTemplateEditor === 'function') resetTemplateEditor();
        setNotice(templatesStatus);
      } else if (kind === 'starter') {
        const starter = starterTemplates.get(value);
        if (starter) {
          if (typeof populateTemplateEditor === 'function') {
            populateTemplateEditor({ ...starter, id: '' }, templatePickerInput.value);
          }
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
  }

  document.querySelectorAll('[data-source-choice]').forEach((choice) => {
    choice.addEventListener('click', () => {
      const nextMode = choice.dataset.sourceChoice;
      if (!nextMode || nextMode === createRenderModeInput?.value) return;
      if (createRenderModeInput) createRenderModeInput.value = nextMode;
      if (typeof setCreateRenderMode === 'function') setCreateRenderMode(nextMode, true);
      if (nextMode === 'html' || nextMode === 'markdown') {
        try {
          if (typeof previewDocumentJson === 'function') previewDocumentJson();
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

  document.getElementById('storedSourcePickerInput')?.addEventListener('change', () => {
    if (typeof selectStoredSource === 'function') {
      selectStoredSource(document.getElementById('storedSourcePickerInput').value);
    }
  });

  document.addEventListener('dashboardviewchange', () => {
    const curView = window.activeDashboardView || 'overview';
    if (['sources', 'files', 'batches', 'merge'].includes(curView)) {
      if (typeof refreshManagers === 'function') refreshManagers();
      if (curView === 'merge' && mergeFeature?.loadMergeFiles) mergeFeature.loadMergeFiles();
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    loadDashboard,
    renderDashboard,
    refreshDashboard,
    dashboardTemplateRequest,
    decodeTokenPayload,
    clearSession,
    checkAuth,
    setNotice,
    setButtonPending,
  };
}
