import test from 'node:test';
import assert from 'node:assert/strict';
import appModule from './app.js';
import logsModule from './features/logs.js';

test('loadDashboard calls apiRequest with /dashboard and authHeaders', async () => {
  const calls = [];
  global.apiRequest = async (path, options) => {
    calls.push({ path, options });
    return {
      usage: { usedThisMonth: 12, quota: 5000, remaining: 4988, pdfsToday: 3 },
      billing: { status: 'active', plan: 'Starter' },
      logs: [],
    };
  };
  global.authHeaders = () => ({
    Authorization: 'Bearer test_token',
    'Content-Type': 'application/json',
  });

  const data = await appModule.loadDashboard();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].path, '/dashboard');
  assert.strictEqual(calls[0].options.headers.Authorization, 'Bearer test_token');
  assert.strictEqual(data.usage.usedThisMonth, 12);
  assert.strictEqual(data.billing.plan, 'Starter');

  await appModule.loadDashboard({ limit: 10, cursor: '20', status: 'error', sort: 'oldest' });
  assert.strictEqual(calls[1].path, '/dashboard?limit=10&cursor=20&status=error&sort=oldest');
});

test('renderDashboard populates usage metrics and activity in the DOM', () => {
  const elements = {
    pdfsToday: { textContent: '' },
    monthlyUsage: { textContent: '' },
    quotaDetail: { textContent: '' },
    dailyActivityDetail: { textContent: '' },
    recentActivityList: {
      children: [],
      replaceChildren() { this.children = []; },
      appendChild(child) { this.children.push(child); },
      innerHTML: '',
    },
    billingStatus: { textContent: '', dataset: {}, hidden: true },
  };

  global.document = {
    getElementById: (id) => elements[id] || null,
    createElement: (tag) => ({
      tagName: tag.toUpperCase(),
      className: '',
      children: [],
      append(...args) { this.children.push(...args); },
      appendChild(child) { this.children.push(child); },
    }),
  };

  let billingRendered = null;
  global.renderBillingView = (billing, usage) => {
    billingRendered = { billing, usage };
  };

  let logsRendered = null;
  global.renderLogs = (logs) => {
    logsRendered = logs;
  };

  global.renderRecentActivity = (logs) => {
    elements.recentActivityList.renderedLogs = logs;
  };

  const sampleData = {
    usage: {
      usedThisMonth: 42,
      quota: 1000,
      remaining: 958,
      pdfsToday: 5,
      failedToday: 0,
    },
    billing: {
      status: 'active',
      plan: 'Professional',
    },
    logs: [
      { timestamp: 1729000000, status: 'success', size: 10240, apiKeyId: 'key-1' },
    ],
  };

  appModule.renderDashboard(sampleData);

  assert.strictEqual(elements.pdfsToday.textContent, '5');
  assert.strictEqual(elements.monthlyUsage.textContent, '42 of 1000');
  assert.strictEqual(elements.quotaDetail.textContent, '958 PDFs remaining this month');
  assert.strictEqual(elements.dailyActivityDetail.textContent, 'No failed renders');
  assert.deepStrictEqual(billingRendered.billing, sampleData.billing);
  assert.deepStrictEqual(billingRendered.usage, sampleData.usage);
  assert.deepStrictEqual(logsRendered, sampleData.logs);
  assert.deepStrictEqual(elements.recentActivityList.renderedLogs, sampleData.logs);
});

test('refreshDashboard fetches data and calls renderDashboard', async () => {
  const calls = [];
  global.apiRequest = async (path, options) => {
    calls.push({ path, options });
    return {
      usage: { usedThisMonth: 10, quota: 25, remaining: 15, pdfsToday: 2 },
      billing: { status: 'free', plan: 'Free' },
      logs: [],
    };
  };
  global.authHeaders = () => ({
    Authorization: 'Bearer valid_jwt',
  });

  const elements = {
    pdfsToday: { textContent: '' },
    monthlyUsage: { textContent: '' },
    quotaDetail: { textContent: '' },
    dailyActivityDetail: { textContent: '' },
    recentActivityList: {
      replaceChildren() {},
      querySelector() { return null; },
    },
    billingStatus: { textContent: '', dataset: {}, hidden: true },
  };

  global.document = {
    getElementById: (id) => elements[id] || null,
  };
  global.renderBillingView = () => {};
  global.renderLogs = () => {};
  global.renderRecentActivity = () => {};

  await appModule.refreshDashboard();

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].path, '/dashboard');
  assert.strictEqual(elements.pdfsToday.textContent, '2');
  assert.strictEqual(elements.monthlyUsage.textContent, '10 of 25');
  assert.strictEqual(elements.quotaDetail.textContent, '15 PDFs remaining this month');
});

test('refreshDashboard catches error and displays failure state', async () => {
  global.apiRequest = async () => {
    throw new Error('Network timeout connecting to server');
  };

  const emptyStateEl = { text: 'Loading recent activity...' };
  const recentActivityEl = {
    innerHTML: '',
    querySelector: (sel) => (sel === '.empty-state' ? emptyStateEl : null),
  };
  const billingStatusEl = { textContent: '', dataset: {}, hidden: true };

  global.document = {
    getElementById: (id) => {
      if (id === 'billingStatus') return billingStatusEl;
      if (id === 'recentActivityList') return recentActivityEl;
      return null;
    },
  };

  await appModule.refreshDashboard();

  assert.ok(billingStatusEl.textContent.includes('Network timeout connecting to server'));
  assert.strictEqual(billingStatusEl.dataset.state, 'error');
  assert.ok(recentActivityEl.innerHTML.includes('Could not load recent activity'));
});

test('refreshDashboard appends a Retry button that disables while in flight and retries load', async () => {
  let attempt = 0;
  let resolveSecond;
  global.apiRequest = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('Temporary outage');
    return new Promise((resolve) => {
      resolveSecond = resolve;
    });
  };
  global.authHeaders = () => ({ Authorization: 'Bearer valid_jwt' });
  global.renderBillingView = () => {};
  global.renderLogs = () => {};
  global.renderRecentActivity = () => {};

  const createdButtons = [];
  const billingStatusEl = {
    textContent: '',
    dataset: {},
    hidden: true,
    children: [],
    appendChild(node) {
      this.children.push(node);
    },
    querySelector(sel) {
      return sel === '[data-action="retry-dashboard"]' ? this.children[0] || null : null;
    },
  };
  const recentActivityEl = { innerHTML: '', replaceChildren() {} };

  global.document = {
    getElementById: (id) => {
      if (id === 'billingStatus') return billingStatusEl;
      if (id === 'recentActivityList') return recentActivityEl;
      return { textContent: '' };
    },
    createElement: (tag) => {
      const listeners = {};
      const el = {
        tagName: tag.toUpperCase(),
        type: '',
        className: '',
        dataset: {},
        attributes: {},
        disabled: false,
        textContent: '',
        setAttribute(k, v) { this.attributes[k] = v; },
        addEventListener(type, fn) { listeners[type] = fn; },
        trigger(type) { return listeners[type]?.(); },
        remove() { billingStatusEl.children = []; },
      };
      createdButtons.push(el);
      return el;
    },
  };

  await appModule.refreshDashboard();
  assert.strictEqual(createdButtons.length, 1);
  const retryBtn = createdButtons[0];
  assert.strictEqual(retryBtn.textContent, 'Retry');
  assert.strictEqual(retryBtn.disabled, false);

  const retryPromise = retryBtn.trigger('click');
  assert.strictEqual(retryBtn.disabled, true);
  assert.strictEqual(retryBtn.attributes['aria-busy'], 'true');

  resolveSecond({
    usage: { usedThisMonth: 1, quota: 25, remaining: 24, pdfsToday: 1 },
    billing: { status: 'free', plan: 'Free' },
    logs: [],
  });
  await retryPromise;
  assert.strictEqual(attempt, 2);
  assert.strictEqual(billingStatusEl.hidden, true);
});

test('checkAuth redirects and hides document when token is missing', () => {
  const store = {};
  global.localStorage = {
    getItem: (key) => store[key] || null,
    setItem: (key, val) => { store[key] = String(val); },
    removeItem: (key) => { delete store[key]; },
  };
  const docElement = { style: {} };
  global.document = { documentElement: docElement };
  let replacedUrl = null;
  global.window = {
    location: {
      pathname: '/app/',
      search: '?view=billing',
      hash: '',
      replace: (url) => { replacedUrl = url; },
    },
  };

  const result = appModule.checkAuth();
  assert.strictEqual(result, false);
  assert.strictEqual(replacedUrl, '/app/login');
  assert.strictEqual(docElement.style.display, 'none');
  assert.strictEqual(store.post_login_redirect, '/app/?view=billing');
});

test('checkAuth returns true for valid, unexpired token without hiding document', () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const payloadB64 = Buffer.from(JSON.stringify({ exp: futureExp, sub: 'user-1' })).toString('base64url');
  const validToken = `eyJhbGciOiJIUzI1NiJ9.${payloadB64}.signature`;

  const store = { id_token: validToken };
  global.localStorage = {
    getItem: (key) => store[key] || null,
    setItem: (key, val) => { store[key] = String(val); },
    removeItem: (key) => { delete store[key]; },
  };
  const docElement = { style: {} };
  global.document = { documentElement: docElement };
  let replacedUrl = null;
  global.window = {
    location: {
      pathname: '/app/',
      search: '',
      hash: '',
      replace: (url) => { replacedUrl = url; },
    },
  };

  const result = appModule.checkAuth();
  assert.strictEqual(result, true);
  assert.strictEqual(replacedUrl, null);
  assert.strictEqual(docElement.style.display, undefined);
});

test('initializeLogExplorer recovers pagination buttons and shows error on fetch failure', async () => {
  const makeNode = (tag = 'DIV') => ({
    tagName: tag,
    className: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    dataset: {},
    attributes: {},
    children: [],
    listeners: {},
    replaceChildren() { this.children = []; },
    append(...args) { this.children.push(...args); },
    appendChild(child) { this.children.push(child); },
    prepend(child) { this.children.unshift(child); },
    setAttribute(k, v) { this.attributes[k] = v; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
  });

  const elements = {
    logsList: makeNode('DIV'),
    logsPagination: makeNode('NAV'),
    logsPreviousPage: makeNode('BUTTON'),
    logsNextPage: makeNode('BUTTON'),
    logsPageStatus: makeNode('SPAN'),
    logsStatusFilter: { value: 'all', listeners: {}, addEventListener(t, fn) { this.listeners[t] = fn; } },
    logsSort: { value: 'newest', listeners: {}, addEventListener(t, fn) { this.listeners[t] = fn; } },
  };

  global.document = {
    getElementById: (id) => elements[id] || null,
    createElement: (tag) => makeNode(tag.toUpperCase()),
  };
  global.loadDashboard = async () => {
    throw new Error('503 Service Unavailable');
  };

  const sampleLogs = Array.from({ length: 10 }, (_, i) => ({
    requestId: `req-${i + 1}`,
    timestamp: 1729000000 - i * 60,
    status: 'success',
    size: 2048,
  }));

  logsModule.renderLogs(sampleLogs, { nextCursor: '10', total: 20 });
  logsModule.initializeLogExplorer();

  // Move to page 2 so both Previous and Next are enabled before failure
  await elements.logsNextPage.listeners.click();
  assert.strictEqual(logsModule.requestLogState.page, 2);
  assert.strictEqual(elements.logsPreviousPage.disabled, false);
  assert.strictEqual(elements.logsNextPage.disabled, false);

  // Trigger filter refresh failure and verify buttons recover (are not stuck disabled)
  await elements.logsStatusFilter.listeners.change();
  assert.strictEqual(logsModule.requestLogState.loadingMore, false);
  assert.strictEqual(elements.logsPreviousPage.disabled, false);
  assert.strictEqual(elements.logsNextPage.disabled, false);
  assert.strictEqual(elements.logsList.children[0].dataset.state, 'error');

  // Trigger next-page cursor fetch failure and verify page does not advance and buttons recover
  await elements.logsNextPage.listeners.click();
  assert.strictEqual(logsModule.requestLogState.page, 2);
  assert.strictEqual(logsModule.requestLogState.loadingMore, false);
  assert.strictEqual(elements.logsPreviousPage.disabled, false);
  assert.strictEqual(elements.logsNextPage.disabled, false);
  assert.strictEqual(elements.logsList.children[0].dataset.state, 'error');
});
