import test from 'node:test';
import assert from 'node:assert/strict';

// ─── Mock DOM Environment (mirrors plans.test.js harness) ────────────────────

const mockStorage = new Map();
global.localStorage = {
  getItem: (key) => mockStorage.get(key) || null,
  setItem: (key, val) => mockStorage.set(key, String(val)),
  removeItem: (key) => mockStorage.delete(key),
  clear: () => mockStorage.clear(),
};

function createMockElement(tagName = 'div') {
  const attributes = new Map();
  const classListSet = new Set();
  const listeners = new Map();
  const children = [];

  const el = {
    tagName: tagName.toUpperCase(),
    attributes,
    style: {},
    dataset: {},
    value: '',
    checked: false,
    disabled: false,
    _parent: null,
    children,

    getAttribute(name) {
      if (name === 'class') return Array.from(classListSet).join(' ');
      return attributes.get(name) || null;
    },
    setAttribute(name, val) {
      attributes.set(name, String(val));
      if (name === 'class') {
        classListSet.clear();
        String(val).split(/\s+/).filter(Boolean).forEach((c) => classListSet.add(c));
      }
      if (name === 'hidden') el.hidden = true;
    },
    removeAttribute(name) {
      attributes.delete(name);
      if (name === 'class') classListSet.clear();
      if (name === 'hidden') el.hidden = false;
    },
    hasAttribute(name) {
      return attributes.has(name);
    },

    classList: {
      add(...classes) { classes.forEach((c) => classListSet.add(c)); },
      remove(...classes) { classes.forEach((c) => classListSet.delete(c)); },
      toggle(c, force) {
        if (force === undefined) {
          if (classListSet.has(c)) classListSet.delete(c); else classListSet.add(c);
        } else if (force) {
          classListSet.add(c);
        } else {
          classListSet.delete(c);
        }
      },
      contains(c) { return classListSet.has(c); },
    },

    addEventListener(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    removeEventListener(event, fn) {
      if (!listeners.has(event)) return;
      listeners.set(event, listeners.get(event).filter((f) => f !== fn));
    },
    dispatchEvent(event) {
      const fns = listeners.get(event.type) || [];
      fns.forEach((fn) => fn(event));
      if (event.type === 'submit' && typeof el.onsubmit === 'function') el.onsubmit(event);
      if (event.type === 'click' && typeof el.onclick === 'function') el.onclick(event);
      return true;
    },

    appendChild(child) {
      children.push(child);
      child._parent = el;
      return child;
    },
    removeChild(child) {
      const idx = children.indexOf(child);
      if (idx !== -1) children.splice(idx, 1);
      return child;
    },
    replaceChild(newChild, oldChild) {
      const idx = children.indexOf(oldChild);
      if (idx !== -1) {
        children[idx] = newChild;
        newChild._parent = el;
        oldChild._parent = null;
      }
      return oldChild;
    },

    focus() { global.document.activeElement = el; },

    querySelector(selector) { return findSelector(el, selector); },
    querySelectorAll(selector) { return findAllSelectors(el, selector); },
    closest(selector) {
      let cur = el;
      while (cur) {
        if (matchesSelector(cur, selector)) return cur;
        cur = cur._parent;
      }
      return null;
    },

    get textContent() {
      if (children.length > 0) return children.map((c) => c.textContent || '').join('');
      return el._textContent || '';
    },
    set textContent(val) {
      el._textContent = String(val);
      children.length = 0;
    },

    get innerHTML() { return el._innerHTML || ''; },
    set innerHTML(html) {
      el._innerHTML = html;
      el.children.length = 0;
      parseSimpleHtml(html, el);
    },

    get parentNode() { return el._parent || null; },
    cloneNode(deep) {
      const clone = createMockElement(tagName);
      clone._innerHTML = el._innerHTML;
      if (deep && el._innerHTML) clone.innerHTML = el._innerHTML;
      return clone;
    },
  };

  return el;
}

function parseSimpleHtml(html, parent) {
  const tagRegex = /<([a-zA-Z0-9-]+)([^>]*)>(?:([\s\S]*?)<\/\1>)?/g;
  let match;
  while ((match = tagRegex.exec(html)) !== null) {
    const tagName = match[1];
    const rawAttrs = match[2];
    const inner = match[3];
    const child = createMockElement(tagName);
    const attrRegex = /([a-zA-Z0-9-]+)(?:="([^"]*)")?/g;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(rawAttrs)) !== null) {
      const attrName = attrMatch[1];
      const attrVal = attrMatch[2] !== undefined ? attrMatch[2] : '';
      child.setAttribute(attrName, attrVal);
      if (attrName === 'id') child.id = attrVal;
      if (attrName === 'type') child.type = attrVal;
      if (attrName === 'value') child.value = attrVal;
    }
    if (inner) child.innerHTML = inner;
    parent.appendChild(child);
  }
}

function matchesSelector(el, selector) {
  if (selector.startsWith('#')) return el.id === selector.slice(1);
  if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
  if (selector.includes('[') && selector.includes(']')) {
    const match = selector.match(/\[([a-zA-Z0-9-]+)(?:="?([^"\]]*)["']?)?\]/);
    if (match) {
      const attr = match[1];
      const val = match[2];
      if (val === undefined) return el.hasAttribute(attr);
      return el.getAttribute(attr) === val || el[attr] === val;
    }
  }
  return el.tagName && el.tagName.toLowerCase() === selector.toLowerCase();
}

function findSelector(root, selector) {
  for (const child of root.children || []) {
    if (matchesSelector(child, selector)) return child;
    const found = findSelector(child, selector);
    if (found) return found;
  }
  return null;
}

function findAllSelectors(root, selector) {
  const results = [];
  function search(node) {
    for (const child of node.children || []) {
      if (matchesSelector(child, selector)) results.push(child);
      search(child);
    }
  }
  search(root);
  return results;
}

// ─── Global window / document ─────────────────────────────────────────────────

const windowListeners = new Map();
const docListeners = new Map();

global.document = {
  readyState: 'complete',
  activeElement: null,
  body: createMockElement('body'),
  getElementById(id) {
    if (id === 'admin-modal-container') {
      let container = findSelector(global.document.body, '#admin-modal-container');
      if (!container) {
        container = createMockElement('div');
        container.id = 'admin-modal-container';
        global.document.body.appendChild(container);
      }
      return container;
    }
    return findSelector(global.document.body, `#${id}`) || null;
  },
  createElement(tag) { return createMockElement(tag); },
  addEventListener(event, fn) {
    if (!docListeners.has(event)) docListeners.set(event, []);
    docListeners.get(event).push(fn);
  },
  removeEventListener(event, fn) {
    if (!docListeners.has(event)) return;
    docListeners.set(event, docListeners.get(event).filter((f) => f !== fn));
  },
  dispatchEvent(event) {
    const fns = docListeners.get(event.type) || [];
    fns.forEach((fn) => fn(event));
    return true;
  },
};

global.window = {
  addEventListener(event, fn) {
    if (!windowListeners.has(event)) windowListeners.set(event, []);
    windowListeners.get(event).push(fn);
  },
  removeEventListener(event, fn) {
    if (!windowListeners.has(event)) return;
    windowListeners.set(event, windowListeners.get(event).filter((f) => f !== fn));
  },
  dispatchEvent(event) {
    const fns = windowListeners.get(event.type) || [];
    fns.forEach((fn) => fn(event));
    return true;
  },
  setTimeout(fn) { fn(); return 1; },
};

global.CustomEvent = class CustomEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail || {};
  }
};

// ─── Setup helper ─────────────────────────────────────────────────────────────

function setupAdminToken() {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: 'admin-user-123',
    email: 'admin@renderpdf.com',
    'cognito:groups': ['Admins'],
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  mockStorage.set('id_token', `${header}.${payload}.sig`);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('initGovernanceTab fetches /admin/audit-logs and renders a table via adminFetch', async () => {
  setupAdminToken();

  const fetchCalls = [];
  const fakeLogs = [
    {
      requestId: 'ADMIN_AUDIT#2026-09-28',
      timestamp: Date.now() - 5000,
      auditId: 'a1',
      adminEmail: 'admin@test.com',
      targetUserId: 'user-abc',
      action: 'USER_SUSPEND',
      reason: 'Fraud',
      details: { cognitoAction: 'disable' },
    },
    {
      requestId: 'ADMIN_AUDIT#2026-09-28',
      timestamp: Date.now() - 60000,
      auditId: 'a2',
      adminEmail: 'admin@test.com',
      targetUserId: 'user-xyz',
      action: 'KEY_REVOKE',
      reason: 'Compromised',
      details: {},
    },
  ];

  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      json: async () => ({ logs: fakeLogs, count: 2 }),
    };
  };

  const { initGovernanceTab } = await import('./governance.js');

  const container = createMockElement('section');
  container.id = 'audit-logs';

  await initGovernanceTab(container);

  // Acceptance criterion 1: fetch was called with /audit-logs route
  assert.ok(fetchCalls.length >= 1, 'adminFetch should have been called');
  const auditFetch = fetchCalls.find((c) => c.url && c.url.includes('audit-logs'));
  assert.ok(auditFetch, 'Fetch URL should include audit-logs');

  // Table region should contain rendered rows
  const tableRegion = findSelector(container, '#audit-table-region');
  assert.ok(tableRegion, '#audit-table-region should exist');
  const tableHtml = tableRegion.innerHTML || '';
  assert.ok(tableHtml.includes('USER_SUSPEND'), 'Table should contain USER_SUSPEND action');
  assert.ok(tableHtml.includes('KEY_REVOKE'), 'Table should contain KEY_REVOKE action');
  assert.ok(tableHtml.includes('user-abc'), 'Table should contain target user ID');
});

test('openSuspendUserModal requires email confirmation and reason before submitting (Task 4.3)', async () => {
  setupAdminToken();

  const fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts, body: JSON.parse(opts?.body || '{}') });
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    };
  };

  const dispatchedDocEvents = [];
  docListeners.set('user-updated', [(e) => dispatchedDocEvents.push(e)]);

  const { openSuspendUserModal } = await import('./governance.js');
  openSuspendUserModal('user-123', 'cust@example.com', 'disable');

  // Modal should be visible (hidden attribute removed)
  const modal = findSelector(global.document.body, '#admin-suspend-modal');
  assert.ok(modal, '#admin-suspend-modal should exist in DOM');
  assert.strictEqual(modal.hasAttribute('hidden'), false, 'Modal should not be hidden after open');

  // Search inputs directly on modal subtree; form may have been swapped by a clone
  const confirmInput = findSelector(modal, '#suspend-confirm-input');
  const reasonInput = findSelector(modal, '#suspend-reason-input');
  const errorEl = findSelector(modal, '#suspend-modal-error');

  assert.ok(confirmInput, '#suspend-confirm-input should exist');
  assert.ok(reasonInput, '#suspend-reason-input should exist');

  // Acceptance criterion: wrong confirmation text → blocked
  if (confirmInput) confirmInput.value = 'wrong-text';
  if (reasonInput) reasonInput.value = 'Fraudulent usage';
  // Dispatch submit on the current live form (re-query after clone swap)
  const liveForm = findSelector(modal, '#suspend-modal-form') || modal;
  liveForm.dispatchEvent({ type: 'submit', preventDefault: () => {} });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(fetchCalls.length, 0, 'No API call with wrong confirmation text');

  // Correct confirmation text but no reason → blocked
  if (confirmInput) confirmInput.value = 'SUSPEND';
  if (reasonInput) reasonInput.value = '   ';
  liveForm.dispatchEvent({ type: 'submit', preventDefault: () => {} });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(fetchCalls.length, 0, 'No API call with empty reason');

  // Acceptance criterion: correct confirmation + reason → API call dispatched
  if (confirmInput) confirmInput.value = 'SUSPEND';
  if (reasonInput) reasonInput.value = 'Confirmed fraudulent pattern';
  liveForm.dispatchEvent({ type: 'submit', preventDefault: () => {} });
  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(fetchCalls.length, 1, 'API call dispatched with valid confirmation and reason');
  assert.ok(fetchCalls[0].url.includes('/users/user-123/status'), 'Correct status endpoint');
  assert.strictEqual(fetchCalls[0].body.action, 'disable');
  assert.strictEqual(fetchCalls[0].body.reason, 'Confirmed fraudulent pattern');

  // Acceptance criterion: user-updated event dispatched on document
  const updateEvt = dispatchedDocEvents.find((e) => e.type === 'user-updated');
  assert.ok(updateEvt, 'user-updated event dispatched on document');
});

test('openRevokeKeyModal requires reason, calls revoke endpoint, dispatches user-updated (Task 4.3)', async () => {
  setupAdminToken();

  const fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts, body: JSON.parse(opts?.body || '{}') });
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    };
  };

  const dispatchedDocEvents = [];
  docListeners.set('user-updated', [(e) => dispatchedDocEvents.push(e)]);

  const { openRevokeKeyModal } = await import('./governance.js');
  openRevokeKeyModal('user-456', 'key-789', 'rp_live_abc…');

  const modal = findSelector(global.document.body, '#admin-revoke-modal');
  assert.ok(modal, '#admin-revoke-modal should exist in DOM');
  assert.strictEqual(modal.hasAttribute('hidden'), false, 'Modal should be visible after open');

  const reasonInput = findSelector(modal, '#revoke-reason-input');
  assert.ok(reasonInput, '#revoke-reason-input should exist');

  const liveForm = findSelector(modal, '#revoke-modal-form') || modal;

  // Acceptance criterion: empty reason → blocked
  if (reasonInput) reasonInput.value = '';
  liveForm.dispatchEvent({ type: 'submit', preventDefault: () => {} });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(fetchCalls.length, 0, 'No API call without reason');

  // Acceptance criterion: valid reason → API call dispatched
  if (reasonInput) reasonInput.value = 'Key found in public GitHub repo';
  liveForm.dispatchEvent({ type: 'submit', preventDefault: () => {} });
  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(fetchCalls.length, 1, 'API call dispatched with valid reason');
  assert.ok(fetchCalls[0].url.includes('/users/user-456/keys/key-789/revoke'), 'Correct revoke endpoint');
  assert.strictEqual(fetchCalls[0].body.reason, 'Key found in public GitHub repo');

  // user-updated event dispatched on document
  const updateEvt = dispatchedDocEvents.find((e) => e.type === 'user-updated');
  assert.ok(updateEvt, 'user-updated event dispatched on document');
});

test('initGovernanceModals registers window listeners and handles open-suspend-user and open-revoke-key', async () => {
  setupAdminToken();
  const { initGovernanceModals } = await import('./governance.js');
  initGovernanceModals();

  assert.ok(windowListeners.has('open-suspend-user'), 'open-suspend-user listener registered');
  assert.ok(windowListeners.has('open-revoke-key'), 'open-revoke-key listener registered');

  // Dispatch open-suspend-user
  global.window.dispatchEvent({
    type: 'open-suspend-user',
    detail: {
      userId: 'user_susp_99',
      userEmail: 'susp@example.com',
      enabled: true,
    },
  });

  const suspendModal = findSelector(global.document.body, '#admin-suspend-modal');
  assert.ok(suspendModal, 'Suspend modal should exist in DOM');
  assert.strictEqual(suspendModal.hasAttribute('hidden'), false, 'Suspend modal should be visible');

  // Dispatch open-revoke-key
  global.window.dispatchEvent({
    type: 'open-revoke-key',
    detail: {
      userId: 'user_rev_99',
      keyId: 'key_123',
      keyName: 'live-prod-key',
    },
  });

  const revokeModal = findSelector(global.document.body, '#admin-revoke-modal');
  assert.ok(revokeModal, 'Revoke modal should exist in DOM');
  assert.strictEqual(revokeModal.hasAttribute('hidden'), false, 'Revoke modal should be visible');
});

test('initGovernanceTab filters audit records via action dropdown and search input', async () => {
  setupAdminToken();

  const fakeLogs = [
    {
      requestId: 'ADMIN_AUDIT#2026-09-28',
      timestamp: Date.now() - 5000,
      auditId: 'a1',
      adminEmail: 'vberkoz@gmail.com',
      targetUserId: 'user-suspicious-1',
      action: 'USER_SUSPEND',
      reason: 'Automated scraping detected',
      details: { cognitoAction: 'disable' },
    },
    {
      requestId: 'ADMIN_AUDIT#2026-09-28',
      timestamp: Date.now() - 60000,
      auditId: 'a2',
      adminEmail: 'vberkoz@gmail.com',
      targetUserId: 'user-vip-2',
      action: 'PLAN_OVERRIDE',
      reason: 'Enterprise deal Q4',
      details: { newTier: 'pro' },
    },
  ];

  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ logs: fakeLogs, count: 2 }),
  });

  const { initGovernanceTab } = await import('./governance.js');

  const container = createMockElement('section');
  container.id = 'audit-logs-filter-test';

  await initGovernanceTab(container);

  const tableRegion = findSelector(container, '#audit-table-region');
  assert.ok(tableRegion.innerHTML.includes('user-suspicious-1'));
  assert.ok(tableRegion.innerHTML.includes('user-vip-2'));

  // Test search input filtering
  const searchInput = findSelector(container, '#audit-search-input');
  assert.ok(searchInput, 'Search input should exist');
  searchInput.value = 'scraping';
  searchInput.dispatchEvent({ type: 'input' });

  assert.ok(tableRegion.innerHTML.includes('user-suspicious-1'));
  assert.ok(!tableRegion.innerHTML.includes('user-vip-2'));

  // Clear search and test action dropdown
  searchInput.value = '';
  const actionFilter = findSelector(container, '#audit-action-filter');
  assert.ok(actionFilter, 'Action filter should exist');
  actionFilter.value = 'PLAN_OVERRIDE';
  actionFilter.dispatchEvent({ type: 'change' });

  assert.ok(!tableRegion.innerHTML.includes('user-suspicious-1'));
  assert.ok(tableRegion.innerHTML.includes('user-vip-2'));
});

