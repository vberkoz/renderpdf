import test from 'node:test';
import assert from 'node:assert/strict';
import appModule from './app.js';

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
