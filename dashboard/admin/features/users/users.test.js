import test from 'node:test';
import assert from 'node:assert/strict';

// Set up mock DOM and localStorage in Node environment
const mockStorage = new Map();
global.localStorage = {
  getItem: (key) => mockStorage.get(key) || null,
  setItem: (key, val) => mockStorage.set(key, String(val)),
  removeItem: (key) => mockStorage.delete(key),
  clear: () => mockStorage.clear(),
};

// Create a valid unexpired admin JWT
const mockHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const mockPayload = Buffer.from(JSON.stringify({
  sub: 'admin-123',
  email: 'vberkoz@gmail.com',
  'cognito:groups': ['Admins'],
  exp: Math.floor(Date.now() / 1000) + 3600,
})).toString('base64url');
const mockToken = `${mockHeader}.${mockPayload}.mockSignature`;
mockStorage.set('id_token', mockToken);

if (typeof global.CustomEvent === 'undefined') {
  global.CustomEvent = class CustomEvent {
    constructor(type, eventInitDict = {}) {
      this.type = type;
      this.detail = eventInitDict.detail || null;
      this.bubbles = Boolean(eventInitDict.bubbles);
      this.composed = Boolean(eventInitDict.composed);
    }
  };
}

let windowEvents = [];
const windowListeners = new Map();
global.window = {
  dispatchEvent: (event) => {
    windowEvents.push(event);
    const type = typeof event === 'string' ? event : event.type;
    const cbs = windowListeners.get(type) || [];
    for (const cb of cbs) cb(event);
  },
  addEventListener: (type, cb) => {
    if (!windowListeners.has(type)) windowListeners.set(type, []);
    windowListeners.get(type).push(cb);
  },
  removeEventListener: (type, cb) => {
    if (!windowListeners.has(type)) return;
    windowListeners.set(type, windowListeners.get(type).filter((fn) => fn !== cb));
  },
  setTimeout: global.setTimeout,
  clearTimeout: global.clearTimeout,
};

const documentListeners = new Map();
const elementsRegistry = new Map();

function createMockElement(tagName = 'div') {
  const listeners = new Map();
  const attributes = new Map();
  let innerHtml = '';
  let children = [];

  const el = {
    tagName: tagName.toUpperCase(),
    attributes,
    dataset: {},
    value: '',
    disabled: false,
    _children: children,
    focus() {
      if (typeof global.document !== 'undefined') {
        global.document.activeElement = this;
      }
    },
    hasAttribute(name) {
      return attributes.has(name);
    },
    appendChild(child) {
      if (!this._children.includes(child)) {
        this._children.push(child);
      }
      child._parent = this;
      return child;
    },
    get id() {
      return attributes.get('id') || '';
    },
    set id(val) {
      this.setAttribute('id', val);
    },
    classList: {
      _classes: new Set(),
      add(cls) { this._classes.add(cls); },
      remove(cls) { this._classes.delete(cls); },
      toggle(cls, force) {
        if (force === true) this._classes.add(cls);
        else if (force === false) this._classes.delete(cls);
        else if (this._classes.has(cls)) this._classes.delete(cls);
        else this._classes.add(cls);
      },
      contains(cls) { return this._classes.has(cls); },
    },
    getAttribute(name) { return attributes.get(name) ?? null; },
    setAttribute(name, val) {
      attributes.set(name, String(val));
      if (name.startsWith('data-')) {
        const prop = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        this.dataset[prop] = String(val);
      }
      if (name === 'value') this.value = String(val);
      if (name === 'disabled') this.disabled = true;
      if (name === 'id') elementsRegistry.set(String(val), this);
    },
    removeAttribute(name) {
      if (name === 'id') {
        const id = attributes.get('id');
        if (id) elementsRegistry.delete(id);
      }
      attributes.delete(name);
      if (name.startsWith('data-')) {
        const prop = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        delete this.dataset[prop];
      }
      if (name === 'disabled') this.disabled = false;
    },
    addEventListener(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
    },
    removeEventListener(event, cb) {
      if (!listeners.has(event)) return;
      listeners.set(event, listeners.get(event).filter((fn) => fn !== cb));
    },
    dispatchEvent(event) {
      const type = typeof event === 'string' ? event : event.type;
      const cbs = listeners.get(type) || [];
      for (const cb of cbs) cb(event);
    },
    closest(selector) {
      if (selector.startsWith('.')) {
        const cls = selector.slice(1);
        if (this.classList.contains(cls)) return this;
      } else if (selector.startsWith('#')) {
        const id = selector.slice(1);
        if (this.getAttribute('id') === id) return this;
      } else if (this.tagName.toLowerCase() === selector.toLowerCase()) {
        return this;
      }
      return this._parent && this._parent.closest ? this._parent.closest(selector) : null;
    },
    get innerHTML() {
      if (this._children && this._children.length > 0) {
        return this._children.map((child) => serializeNode(child)).join('');
      }
      return innerHtml;
    },
    set innerHTML(val) {
      innerHtml = val;
      this._children = parseMockElements(val);
      for (const child of this._children) {
        child._parent = this;
      }
    },
    get textContent() {
      if (this._children && this._children.length > 0) {
        return this._children.map((c) => c.isText ? c.text : (c.textContent || '')).join('');
      }
      return innerHtml;
    },
    set textContent(val) {
      innerHtml = String(val);
      this._children = [{ isText: true, text: String(val) }];
    },
    querySelector(selector) {
      return findSelector(this, selector);
    },
    querySelectorAll(selector) {
      return findAllSelectors(this, selector);
    },
  };

  return el;
}

function serializeNode(node) {
  if (node.isText) {
    return node.text;
  }
  const tag = node.tagName.toLowerCase();
  const voidTags = new Set(['input', 'img', 'br', 'hr', 'meta', 'link']);
  let attrStr = '';
  for (const [k, v] of node.attributes.entries()) {
    if (k === 'disabled' && (v === '' || v === 'true')) {
      attrStr += ' disabled';
    } else {
      attrStr += ` ${k}="${v}"`;
    }
  }
  if (node.disabled && !node.attributes.has('disabled')) {
    attrStr += ' disabled';
  }

  if (voidTags.has(tag)) {
    return `<${tag}${attrStr}>`;
  }

  return `<${tag}${attrStr}>${node.innerHTML}</${tag}>`;
}

function parseMockElements(html) {
  const root = createMockElement('root');
  const stack = [root];
  const voidTags = new Set(['input', 'img', 'br', 'hr', 'meta', 'link']);
  const tokenRegex = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z0-9-]+)([^>]*)>|([^<]+)/g;

  let match;
  while ((match = tokenRegex.exec(html)) !== null) {
    if (match[0].startsWith('<!--')) {
      continue;
    }
    const isClose = Boolean(match[1]);
    const tagName = match[2];
    const rawAttrs = match[3];
    const text = match[4];

    if (text) {
      const parent = stack[stack.length - 1];
      if (parent) {
        parent._children.push({ isText: true, text });
      }
      continue;
    }

    if (isClose) {
      if (stack.length > 1) {
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].tagName && stack[i].tagName.toLowerCase() === tagName.toLowerCase()) {
            stack.length = i;
            break;
          }
        }
      }
    } else {
      const el = createMockElement(tagName);
      const isSelfClosing = (rawAttrs || '').endsWith('/') || voidTags.has(tagName.toLowerCase());

      const attrRegex = /([a-zA-Z0-9-]+)(?:="([^"]*)")?/g;
      let attrMatch;
      while ((attrMatch = attrRegex.exec(rawAttrs || '')) !== null) {
        const attrName = attrMatch[1];
        const attrVal = attrMatch[2] ?? '';
        el.setAttribute(attrName, attrVal);
        if (attrName === 'class') {
          attrVal.split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
        }
        if (attrName === 'value') {
          el.value = attrVal;
        }
        if (attrName === 'disabled') {
          el.disabled = true;
        }
      }

      const parent = stack[stack.length - 1];
      if (parent) {
        parent._children.push(el);
        el._parent = parent;
      }

      if (!isSelfClosing) {
        stack.push(el);
      }
    }
  }

  return root._children;
}

function findSelector(parent, selector) {
  const all = findAllSelectors(parent, selector);
  return all.length > 0 ? all[0] : null;
}

function findAllSelectors(parent, selector) {
  if (selector.includes(',')) {
    const parts = selector.split(',').map((s) => s.trim()).filter(Boolean);
    const set = new Set();
    for (const part of parts) {
      for (const el of findAllSelectors(parent, part)) {
        set.add(el);
      }
    }
    return Array.from(set);
  }

  const results = [];
  function walk(nodes) {
    for (const node of nodes) {
      if (!node || node.isText || typeof node.getAttribute !== 'function') continue;
      let matched = false;
      if (selector.startsWith('#')) {
        if (node.getAttribute('id') === selector.slice(1)) matched = true;
      } else if (selector.startsWith('.')) {
        if (node.classList && node.classList.contains(selector.slice(1))) matched = true;
      } else if (selector.startsWith('[') && selector.endsWith(']')) {
        const attr = selector.slice(1, -1);
        if (node.hasAttribute(attr)) matched = true;
      } else if (node.tagName && node.tagName.toLowerCase() === selector.toLowerCase()) {
        matched = true;
      }
      if (matched) results.push(node);
      if (node._children && node._children.length > 0) {
        walk(node._children);
      }
    }
  }
  walk(parent._children || []);
  return results;
}

global.document = {
  activeElement: null,
  getElementById: (id) => elementsRegistry.get(id) || null,
  createElement: (tagName) => createMockElement(tagName),
  addEventListener: (type, cb) => {
    if (!documentListeners.has(type)) documentListeners.set(type, []);
    documentListeners.get(type).push(cb);
  },
  removeEventListener: (type, cb) => {
    if (!documentListeners.has(type)) return;
    documentListeners.set(type, documentListeners.get(type).filter((fn) => fn !== cb));
  },
  dispatchEvent: (event) => {
    const type = typeof event === 'string' ? event : event.type;
    const cbs = documentListeners.get(type) || [];
    for (const cb of cbs) cb(event);
  },
  body: createMockElement('body'),
};

const sampleDossierResponse = {
  user: {
    id: 'c1f7b76e-3c2e-4b21-8273-df3e18a992bc',
    email: 'customer@acme.com',
    emailVerified: true,
    enabled: true,
    createdAt: '2026-04-12T14:22:00Z',
  },
  billing: {
    tier: 'starter',
    status: 'active',
    plan: 'RenderPDF Starter',
    provider: 'paddle',
    manualOverride: false,
    subscriptionId: 'sub_01h6t8z1234567890abcdef',
    renewsAt: '2026-10-12T14:22:00Z',
  },
  quota: {
    month: '2026-09',
    used: 412,
    limit: 5000,
    remaining: 4588,
  },
  apiKeys: [
    {
      keyId: 'key_9f82d1c3a4b5c6d7e8f90123',
      name: 'Production Backend',
      isActive: true,
      createdAt: 1712931720,
      lastUsed: 1727289120,
    },
    {
      keyId: 'key_revoked_test_998877665544',
      name: 'Legacy Staging Key',
      isActive: false,
      createdAt: 1709931720,
      lastUsed: 1715000000,
    },
  ],
  recentRequests: [
    {
      requestId: 'req_8471b0a1b2c3d4e5f6',
      timestamp: 1727289120,
      status: 'success',
      errorType: '',
      durationMs: 482,
      size: 184920,
    },
    {
      requestId: 'req_failed_998877665544',
      timestamp: 1727288000,
      status: 'error',
      errorType: 'NavigationTimeout',
      durationMs: 30000,
      size: 0,
    },
  ],
};

const sampleUsersResponse = {
  users: [
    {
      id: 'c1f7b76e-3c2e-4b21-8273-df3e18a992bc',
      email: 'customer@acme.com',
      tier: 'starter',
      status: 'active',
      provider: 'paddle',
      manualOverride: false,
      quotaUsed: 412,
      quotaLimit: 5000,
      quotaMonth: '2026-09',
      activeKeys: 2,
      createdAt: '2026-04-12T14:22:00Z',
    },
    {
      id: 'd2a8c87f-4d3f-5c32-9384-ef4f29b003cd',
      email: 'pro-override@enterprise.com',
      tier: 'pro',
      status: 'past_due',
      provider: 'manual',
      manualOverride: true,
      quotaUsed: 18450,
      quotaLimit: 20000,
      quotaMonth: '2026-09',
      activeKeys: 5,
      createdAt: '2026-02-10T10:15:00Z',
    },
    {
      id: 'e3b9d98a-5e4a-6d43-0495-fa5a30c114de',
      email: 'free-user@example.com',
      tier: 'free',
      status: 'canceled',
      provider: 'none',
      manualOverride: false,
      quotaUsed: 25,
      quotaLimit: 25,
      quotaMonth: '2026-09',
      activeKeys: 0,
      createdAt: '2026-05-01T08:00:00Z',
    },
  ],
  nextCursor: 'cursor_token_page_2',
};

test('initUserDirectoryTab renders toolbar, table, badges, and progress bar', async () => {
  const fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      json: async () => sampleUsersResponse,
    };
  };

  const { initUserDirectoryTab } = await import('./users.js');
  const container = createMockElement('div');

  await initUserDirectoryTab(container);

  // 1. Initial API call
  assert.strictEqual(fetchCalls.length, 1);
  assert.strictEqual(fetchCalls[0].url, '/api/v1/admin/users');
  assert.strictEqual(fetchCalls[0].opts.headers.Authorization, `Bearer ${mockToken}`);

  const html = container.innerHTML;

  // 2. Toolbar elements
  assert.ok(html.includes('id="admin-users-search"'), 'Search input exists');
  assert.ok(html.includes('id="admin-filter-tier"'), 'Tier filter dropdown exists');
  assert.ok(html.includes('id="admin-filter-status"'), 'Status filter dropdown exists');

  // 3. User rows rendered
  assert.ok(html.includes('customer@acme.com'), 'Customer email rendered');
  assert.ok(html.includes('c1f7b76e…') || html.includes('c1f7b76e'), 'ID snippet rendered');

  // 4. Tier badges
  assert.ok(html.includes('badge-starter'), 'Starter tier badge rendered');
  assert.ok(html.includes('badge-pro'), 'Pro tier badge rendered');
  assert.ok(html.includes('badge-free'), 'Free tier badge rendered');
  assert.ok(html.includes('admin-tier-override'), 'Manual override asterisk rendered for overridden user');

  // 5. Status badges
  assert.ok(html.includes('badge-status-active'), 'Active status badge rendered');
  assert.ok(html.includes('badge-status-past-due') || html.includes('badge-status-past_due'), 'Past Due badge rendered');
  assert.ok(html.includes('badge-status-canceled'), 'Canceled badge rendered');

  // 6. Quota progress bar
  assert.ok(html.includes('412 / 5,000'), 'Quota text 412 / 5,000 rendered');
  assert.ok(html.includes('8%'), 'Quota percentage 8% rendered');
  assert.ok(html.includes('role="progressbar"'), 'Progress bar role exists');

  // 7. Active keys count
  assert.ok(html.includes('2'), 'Active keys count rendered');
  assert.ok(html.includes('5'), 'Active keys count rendered');

  // 8. Inspect action buttons
  assert.ok(html.includes('admin-btn-inspect'), 'Inspect action button rendered');
  assert.ok(html.includes('data-user-id="c1f7b76e-3c2e-4b21-8273-df3e18a992bc"'), 'data-user-id attribute set on Inspect button');

  // 9. Pagination controls
  assert.ok(html.includes('Showing <strong>3</strong> users'), 'Shows 3 users count');
  assert.ok(html.includes('id="admin-pagination-prev"'), 'Previous page button exists');
  assert.ok(html.includes('id="admin-pagination-next"'), 'Next page button exists');
});

test('typing in search bar triggers API request after 300ms debounce', async () => {
  const fetchCalls = [];
  global.fetch = async (url) => {
    fetchCalls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => sampleUsersResponse,
    };
  };

  const { initUserDirectoryTab } = await import('./users.js');
  const container = createMockElement('div');

  await initUserDirectoryTab(container);
  assert.strictEqual(fetchCalls.length, 1);

  const searchInput = container.querySelector('#admin-users-search');
  assert.ok(searchInput, 'Search input exists');

  // Simulate typing: fire input event
  searchInput.value = 'alice@example.com';
  searchInput.dispatchEvent({ type: 'input', target: { value: 'alice@example.com' } });

  // Immediately after input, no new API request should have been dispatched (debounce pending)
  assert.strictEqual(fetchCalls.length, 1);

  // Wait 350ms to allow debounce timer to fire
  await new Promise((resolve) => setTimeout(resolve, 350));

  // Now the debounced search request must have been dispatched
  assert.strictEqual(fetchCalls.length, 2);
  assert.ok(fetchCalls[1].includes('q=alice%40example.com') || fetchCalls[1].includes('q=alice@example.com'));
});

test('clicking dropdown filter immediately refilters the table', async () => {
  const fetchCalls = [];
  global.fetch = async (url) => {
    fetchCalls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => sampleUsersResponse,
    };
  };

  const { initUserDirectoryTab } = await import('./users.js');
  const container = createMockElement('div');

  await initUserDirectoryTab(container);
  assert.strictEqual(fetchCalls.length, 1);

  const tierSelect = container.querySelector('#admin-filter-tier');
  assert.ok(tierSelect, 'Tier select exists');

  // Change tier filter
  tierSelect.value = 'starter';
  tierSelect.dispatchEvent({ type: 'change', target: { value: 'starter' } });

  // Filter should immediately trigger API request without 300ms debounce delay
  assert.strictEqual(fetchCalls.length, 2);
  assert.ok(fetchCalls[1].includes('tier=starter'));

  const statusSelect = container.querySelector('#admin-filter-status');
  statusSelect.value = 'past_due';
  statusSelect.dispatchEvent({ type: 'change', target: { value: 'past_due' } });

  assert.strictEqual(fetchCalls.length, 3);
  assert.ok(fetchCalls[2].includes('status=past_due'));
});

test('clicking Inspect triggers open-user-dossier custom event with userId', async () => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => sampleUsersResponse,
  });

  const { initUserDirectoryTab } = await import('./users.js');
  const container = createMockElement('div');

  const containerEvents = [];
  container.addEventListener('open-user-dossier', (e) => {
    containerEvents.push(e);
  });
  windowEvents = [];

  await initUserDirectoryTab(container);

  const tbody = container.querySelector('#admin-users-tbody');
  const inspectBtn = tbody.querySelector('.admin-btn-inspect');
  assert.ok(inspectBtn, 'Inspect button exists');

  // Click Inspect
  tbody.dispatchEvent({
    type: 'click',
    target: inspectBtn,
  });

  // Verify container event
  assert.strictEqual(containerEvents.length, 1);
  assert.strictEqual(containerEvents[0].detail.userId, 'c1f7b76e-3c2e-4b21-8273-df3e18a992bc');

  // Verify window event
  assert.strictEqual(windowEvents.length, 1);
  assert.strictEqual(windowEvents[0].detail.userId, 'c1f7b76e-3c2e-4b21-8273-df3e18a992bc');
});

test('pagination Next and Previous navigate pages via cursor tokens', async () => {
  const fetchCalls = [];
  global.fetch = async (url) => {
    fetchCalls.push(url);
    if (url.includes('cursor=')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          users: [
            {
              id: 'page2-user-1',
              email: 'page2@acme.com',
              tier: 'starter',
              status: 'active',
              quotaUsed: 10,
              quotaLimit: 5000,
            },
          ],
          nextCursor: null,
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => sampleUsersResponse,
    };
  };

  const { initUserDirectoryTab } = await import('./users.js');
  const container = createMockElement('div');

  await initUserDirectoryTab(container);
  assert.strictEqual(fetchCalls.length, 1);

  const paginationEl = container.querySelector('#admin-users-pagination');
  const nextBtn = paginationEl.querySelector('#admin-pagination-next');
  const prevBtn = paginationEl.querySelector('#admin-pagination-prev');

  assert.strictEqual(prevBtn.disabled, true);
  assert.strictEqual(nextBtn.disabled, false);

  // Click Next
  paginationEl.dispatchEvent({ type: 'click', target: nextBtn });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.strictEqual(fetchCalls.length, 2);
  assert.ok(fetchCalls[1].includes('cursor=cursor_token_page_2'));

  // On page 2, prevBtn should be enabled, nextBtn disabled
  const prevBtnP2 = paginationEl.querySelector('#admin-pagination-prev');
  const nextBtnP2 = paginationEl.querySelector('#admin-pagination-next');
  assert.strictEqual(prevBtnP2.disabled, false);
  assert.strictEqual(nextBtnP2.disabled, true);

  // Click Previous to return to page 1
  paginationEl.dispatchEvent({ type: 'click', target: prevBtnP2 });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.strictEqual(fetchCalls.length, 3);
  assert.ok(!fetchCalls[2].includes('cursor='));
});

test('handles empty results and network error retry', async () => {
  let attempt = 0;
  global.fetch = async () => {
    attempt++;
    if (attempt === 1) {
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: 'Users service timeout' }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ users: [], nextCursor: null }),
    };
  };

  const { initUserDirectoryTab } = await import('./users.js');
  const container = createMockElement('div');

  await initUserDirectoryTab(container);

  // 1. Error state banner
  assert.ok(container.innerHTML.includes('Failed to load users'));
  assert.ok(container.innerHTML.includes('Users service timeout'));

  const tbody = container.querySelector('#admin-users-tbody');
  const retryBtn = tbody.querySelector('#admin-users-retry-btn');
  assert.ok(retryBtn, 'Retry button exists');

  // 2. Retry click
  retryBtn.dispatchEvent({ type: 'click', target: retryBtn });

  // Wait a tick for async loadData to finish
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.strictEqual(attempt, 2);
  // 3. Empty state rendered
  assert.ok(container.innerHTML.includes('No users found matching your search criteria'));
});

test('openUserDossier fetches user dossier from API and renders all 6 sub-panels', async () => {
  const fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      json: async () => sampleDossierResponse,
    };
  };

  const { openUserDossier } = await import('./users.js');
  const userId = 'c1f7b76e-3c2e-4b21-8273-df3e18a992bc';

  await openUserDossier(userId);

  assert.strictEqual(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].url.includes(`/users/${userId}`));
  assert.strictEqual(fetchCalls[0].opts.headers.Authorization, `Bearer ${mockToken}`);

  const drawer = global.document.getElementById('admin-user-dossier-drawer');
  assert.ok(drawer, 'Drawer element exists in document');
  assert.strictEqual(drawer.hasAttribute('hidden'), false, 'Drawer is visible (not hidden)');
  assert.strictEqual(drawer.getAttribute('role'), 'dialog');
  assert.strictEqual(drawer.getAttribute('aria-modal'), 'true');

  const html = drawer.innerHTML;

  // Card A: Identity
  assert.ok(html.includes('Customer Identity'), 'Card A title rendered');
  assert.ok(html.includes('c1f7b76e-3c2e-4b21-8273-df3e18a992bc'), 'Full Cognito sub rendered');
  assert.ok(html.includes('customer@acme.com'), 'Email rendered');
  assert.ok(html.includes('Verified'), 'Email verified badge rendered');
  assert.ok(html.includes('Enabled'), 'Account status rendered');
  assert.ok(html.includes('2026'), 'Created date rendered');

  // Card B: Plan & Billing
  assert.ok(html.includes('Plan &amp; Billing') || html.includes('Plan & Billing'), 'Card B title rendered');
  assert.ok(html.includes('RenderPDF Starter'), 'Plan name rendered');
  assert.ok(html.includes('badge-starter'), 'Starter tier badge rendered');
  assert.ok(html.includes('Paddle Billing'), 'Provider rendered');
  assert.ok(html.includes('sub_01h6t8z1234567890abcdef'), 'Subscription ID rendered');
  assert.ok(html.includes('id="admin-dossier-change-plan-btn"'), 'Change Plan button rendered');

  // Card C: Quota
  assert.ok(html.includes('Monthly Render Quota'), 'Card C title rendered');
  assert.ok(html.includes('412'), 'Used quota rendered');
  assert.ok(html.includes('5,000'), 'Limit quota rendered');
  assert.ok(html.includes('8%'), 'Quota percentage rendered');
  assert.ok(html.includes('id="admin-dossier-grant-credits-btn"'), 'Grant Credits button rendered');

  // Card D: API Keys
  assert.ok(html.includes('Active API Keys (2)'), 'Card D title rendered');
  assert.ok(html.includes('Production Backend'), 'Key 1 name rendered');
  assert.ok(html.includes('key_9f82d1c3a4…') || html.includes('key_9f82d1c3a4'), 'Key 1 masked ID rendered');
  assert.ok(html.includes('Legacy Staging Key'), 'Key 2 name rendered');
  assert.ok(html.includes('Revoke'), 'Revoke button rendered for active key');

  // Card E: Recent Telemetry
  assert.ok(html.includes('Recent Render Telemetry (2)'), 'Card E title rendered');
  assert.ok(html.includes('200 OK'), 'Success status rendered');
  assert.ok(html.includes('482 ms'), 'Duration rendered');
  assert.ok(html.includes('180.6 KB') || html.includes('184.9 KB') || html.includes('KB'), 'Size rendered');
  assert.ok(html.includes('NavigationTimeout'), 'Error type rendered for failed request');

  // Card F: Danger Zone
  assert.ok(html.includes('Danger Zone'), 'Card F title rendered');
  assert.ok(html.includes('id="admin-dossier-suspend-user-btn"'), 'Suspend Account button rendered');
});

test('drawer keyboard focus trap and Escape key closes drawer and restores focus', async () => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => sampleDossierResponse,
  });

  const { openUserDossier, getOrCreateDrawerElement } = await import('./users.js');
  const drawer = getOrCreateDrawerElement();

  // Simulate an Inspect button being focused
  const mockInspectBtn = createMockElement('button');
  mockInspectBtn.focus();
  assert.strictEqual(global.document.activeElement, mockInspectBtn);

  // Open drawer
  await openUserDossier('c1f7b76e-3c2e-4b21-8273-df3e18a992bc');
  assert.strictEqual(drawer.hasAttribute('hidden'), false);

  // Close button inside drawer should now have focus
  const closeBtn = drawer.querySelector('#admin-dossier-close-btn');
  assert.ok(closeBtn, 'Close button exists');
  assert.strictEqual(global.document.activeElement, closeBtn, 'Focus trapped to close button');

  // Press Escape
  global.document.dispatchEvent({ type: 'keydown', key: 'Escape' });

  // Drawer should be hidden
  assert.strictEqual(drawer.hasAttribute('hidden'), true, 'Drawer closed after Escape');

  // Focus should be restored to Inspect button
  assert.strictEqual(global.document.activeElement, mockInspectBtn, 'Focus restored to Inspect button');
});

test('backdrop click and close button close the drawer', async () => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => sampleDossierResponse,
  });

  const { openUserDossier, getOrCreateDrawerElement } = await import('./users.js');
  const drawer = getOrCreateDrawerElement();

  // 1. Close via close button
  await openUserDossier('c1f7b76e-3c2e-4b21-8273-df3e18a992bc');
  assert.strictEqual(drawer.hasAttribute('hidden'), false);

  const closeBtn = drawer.querySelector('#admin-dossier-close-btn');
  closeBtn.dispatchEvent({ type: 'click', target: closeBtn });
  assert.strictEqual(drawer.hasAttribute('hidden'), true);

  // 2. Close via backdrop click
  await openUserDossier('c1f7b76e-3c2e-4b21-8273-df3e18a992bc');
  assert.strictEqual(drawer.hasAttribute('hidden'), false);

  drawer.dispatchEvent({ type: 'click', target: drawer });
  assert.strictEqual(drawer.hasAttribute('hidden'), true);
});

test('action buttons dispatch custom events for Plans and Governance features', async () => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => sampleDossierResponse,
  });

  const { openUserDossier, getOrCreateDrawerElement } = await import('./users.js');
  const drawer = getOrCreateDrawerElement();

  const dispatchedEvents = [];
  const captureEvent = (e) => dispatchedEvents.push(e);

  global.window.addEventListener('open-change-plan', captureEvent);
  global.window.addEventListener('open-grant-credits', captureEvent);
  global.window.addEventListener('open-revoke-key', captureEvent);
  global.window.addEventListener('open-suspend-user', captureEvent);

  await openUserDossier('c1f7b76e-3c2e-4b21-8273-df3e18a992bc');

  // 1. Click Change Plan
  const changePlanBtn = drawer.querySelector('#admin-dossier-change-plan-btn');
  assert.ok(changePlanBtn, 'Change Plan button exists');
  changePlanBtn.dispatchEvent({ type: 'click', target: changePlanBtn });

  const planEvt = dispatchedEvents.find((e) => e.type === 'open-change-plan');
  assert.ok(planEvt, 'open-change-plan event dispatched');
  assert.strictEqual(planEvt.detail.userId, 'c1f7b76e-3c2e-4b21-8273-df3e18a992bc');
  assert.strictEqual(planEvt.detail.userEmail, 'customer@acme.com');
  assert.strictEqual(planEvt.detail.currentTier, 'starter');

  // 2. Click Grant Credits
  const grantCreditsBtn = drawer.querySelector('#admin-dossier-grant-credits-btn');
  assert.ok(grantCreditsBtn, 'Grant Credits button exists');
  grantCreditsBtn.dispatchEvent({ type: 'click', target: grantCreditsBtn });

  const creditsEvt = dispatchedEvents.find((e) => e.type === 'open-grant-credits');
  assert.ok(creditsEvt, 'open-grant-credits event dispatched');
  assert.strictEqual(creditsEvt.detail.userId, 'c1f7b76e-3c2e-4b21-8273-df3e18a992bc');
  assert.strictEqual(creditsEvt.detail.currentQuota.used, 412);
  assert.strictEqual(creditsEvt.detail.currentQuota.limit, 5000);

  // 3. Click Revoke Key
  const revokeBtn = drawer.querySelector('.admin-btn-revoke-key');
  assert.ok(revokeBtn, 'Revoke Key button exists');
  revokeBtn.dispatchEvent({ type: 'click', target: revokeBtn });

  const revokeEvt = dispatchedEvents.find((e) => e.type === 'open-revoke-key');
  assert.ok(revokeEvt, 'open-revoke-key event dispatched');
  assert.strictEqual(revokeEvt.detail.userId, 'c1f7b76e-3c2e-4b21-8273-df3e18a992bc');
  assert.strictEqual(revokeEvt.detail.keyId, 'key_9f82d1c3a4b5c6d7e8f90123');

  // 4. Click Suspend User
  const suspendBtn = drawer.querySelector('#admin-dossier-suspend-user-btn');
  assert.ok(suspendBtn, 'Suspend User button exists');
  suspendBtn.dispatchEvent({ type: 'click', target: suspendBtn });

  const suspendEvt = dispatchedEvents.find((e) => e.type === 'open-suspend-user');
  assert.ok(suspendEvt, 'open-suspend-user event dispatched');
  assert.strictEqual(suspendEvt.detail.userId, 'c1f7b76e-3c2e-4b21-8273-df3e18a992bc');
  assert.strictEqual(suspendEvt.detail.enabled, true);
});

test('handles network error in openUserDossier and supports retry', async () => {
  let attempt = 0;
  global.fetch = async () => {
    attempt++;
    if (attempt === 1) {
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: 'Cognito service unavailable' }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => sampleDossierResponse,
    };
  };

  const { openUserDossier, getOrCreateDrawerElement } = await import('./users.js');
  const drawer = getOrCreateDrawerElement();

  try {
    await openUserDossier('c1f7b76e-3c2e-4b21-8273-df3e18a992bc');
  } catch (_) {}

  // 1. Error state banner rendered
  assert.ok(drawer.innerHTML.includes('Failed to load customer dossier'));
  assert.ok(drawer.innerHTML.includes('Cognito service unavailable'));

  const retryBtn = drawer.querySelector('#admin-dossier-retry-btn');
  assert.ok(retryBtn, 'Retry button exists');

  // 2. Click retry
  retryBtn.dispatchEvent({ type: 'click', target: retryBtn });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.strictEqual(attempt, 2);
  // 3. Dossier successfully rendered on retry
  assert.ok(drawer.innerHTML.includes('Customer Identity'));
  assert.ok(drawer.innerHTML.includes('customer@acme.com'));
});

test('adminFetch seamlessly falls back from /api/v1/admin/users to /api/v1/analytics?route=... on AWS unmapped 403', async () => {
  const urlsAttempted = [];
  global.fetch = async (url) => {
    urlsAttempted.push(url);
    if (url.startsWith('/api/v1/admin/users')) {
      return {
        ok: false,
        status: 403,
        json: async () => ({
          message: "Invalid key=value pair (missing equal-sign) in Authorization header (hashed with SHA-256 and encoded with Base64): '...'"
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        users: [
          {
            id: 'user-fallback-1',
            email: 'fallback@example.com',
            tier: 'starter',
            status: 'active',
            provider: 'paddle',
            manualOverride: false,
            quotaUsed: 10,
            quotaLimit: 5000,
            quotaMonth: '2026-09',
            activeKeys: 1,
            createdAt: '2026-09-01T12:00:00Z',
          }
        ],
        nextCursor: null,
      }),
    };
  };

  const { adminFetch } = await import('../../shared/api.js');
  const data = await adminFetch('/admin/users?limit=25');

  assert.strictEqual(urlsAttempted.length, 2);
  assert.strictEqual(urlsAttempted[0], '/api/v1/admin/users?limit=25');
  assert.strictEqual(urlsAttempted[1], '/api/v1/analytics?route=admin%2Fusers&limit=25');
  assert.strictEqual(data.users.length, 1);
  assert.strictEqual(data.users[0].email, 'fallback@example.com');
});
