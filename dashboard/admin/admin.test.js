import test from 'node:test';
import assert from 'node:assert/strict';

// Set up mock window and document
const mockStorage = new Map();
global.localStorage = {
  getItem: (key) => mockStorage.get(key) || null,
  setItem: (key, val) => mockStorage.set(key, String(val)),
  removeItem: (key) => mockStorage.delete(key),
  clear: () => mockStorage.clear(),
};

test('admin.js guards non-admin accounts and reveals forbidden state', async () => {
  mockStorage.clear();
  // Valid token for non-admin user
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: 'user-regular-456',
    email: 'regular-user@example.com',
    'cognito:groups': ['Users'],
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  mockStorage.set('id_token', `${header}.${payload}.sig`);

  const elements = new Map();
  function getOrCreate(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        hidden: false,
        textContent: '',
        setAttribute(name) { if (name === 'hidden') this.hidden = true; },
        removeAttribute(name) { if (name === 'hidden') this.hidden = false; },
        addEventListener() {},
        querySelectorAll() { return []; },
        classList: { toggle() {}, add() {}, remove() {} },
      });
    }
    return elements.get(id);
  }

  global.document = {
    readyState: 'complete',
    getElementById: (id) => getOrCreate(id),
    addEventListener: () => {},
  };

  global.window = {
    location: { hash: '#analytics', replace: () => {}, assign: () => {} },
    addEventListener: () => {},
    history: { replaceState: () => {} },
  };

  const { initAdminConsole } = await import('./admin.js');
  await initAdminConsole();

  // Forbidden card should be visible
  const forbiddenState = getOrCreate('admin-forbidden-state');
  const forbiddenEmail = getOrCreate('forbidden-user-email');
  const tabNav = getOrCreate('admin-tab-nav');

  assert.strictEqual(forbiddenState.hidden, false);
  assert.strictEqual(tabNav.hidden, true);
  assert.strictEqual(forbiddenEmail.textContent, 'regular-user@example.com');
});

test('admin.js allows admin account and populates operator info', async () => {
  mockStorage.clear();
  // Valid token for admin user
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: 'admin-789',
    email: 'vberkoz@gmail.com',
    'cognito:groups': ['Admins'],
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  mockStorage.set('id_token', `${header}.${payload}.sig`);

  const elements = new Map();
  function getOrCreate(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        hidden: false,
        textContent: '',
        setAttribute(name) { if (name === 'hidden') this.hidden = true; },
        removeAttribute(name) { if (name === 'hidden') this.hidden = false; },
        addEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        classList: { toggle() {}, add() {}, remove() {} },
      });
    }
    return elements.get(id);
  }

  global.document = {
    readyState: 'complete',
    getElementById: (id) => getOrCreate(id),
    addEventListener: () => {},
  };

  global.window = {
    location: { hash: '#analytics', replace: () => {}, assign: () => {} },
    addEventListener: () => {},
    history: { replaceState: () => {} },
  };

  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      summary: { mrrUsd: 1000, grossMarginPercent: 90, costPerThousandPdfsUsd: 0.2, activeSubscriptions: 10 },
      funnel: {},
      rendering: {},
      dailyRollups: [],
    }),
  });

  const { initAdminConsole } = await import('./admin.js');
  await initAdminConsole();

  const operatorEmail = getOrCreate('admin-operator-email');
  assert.strictEqual(operatorEmail.textContent, 'vberkoz@gmail.com');
});
