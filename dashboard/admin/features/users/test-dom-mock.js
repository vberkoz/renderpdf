/**
 * Node.js Mock DOM & Test Environment for Admin Users tests
 */

// Set up mock DOM and localStorage in Node environment
export const mockStorage = new Map();
global.localStorage = {
  getItem: (key) => mockStorage.get(key) || null,
  setItem: (key, val) => mockStorage.set(key, String(val)),
  removeItem: (key) => mockStorage.delete(key),
  clear: () => mockStorage.clear(),
};

// Create a valid unexpired admin JWT
const mockHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const mockPayload = Buffer.from(
  JSON.stringify({
    sub: 'admin-123',
    email: 'vberkoz@gmail.com',
    'cognito:groups': ['Admins'],
    exp: Math.floor(Date.now() / 1000) + 3600,
  })
).toString('base64url');
export const mockToken = `${mockHeader}.${mockPayload}.mockSignature`;
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

export let windowEvents = [];
export const windowListeners = new Map();
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
    windowListeners.set(
      type,
      windowListeners.get(type).filter((fn) => fn !== cb)
    );
  },
  setTimeout: global.setTimeout,
  clearTimeout: global.clearTimeout,
};

export const documentListeners = new Map();
export const elementsRegistry = new Map();

export function createMockElement(tagName = 'div') {
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
      add(cls) {
        this._classes.add(cls);
      },
      remove(cls) {
        this._classes.delete(cls);
      },
      toggle(cls, force) {
        if (force === true) this._classes.add(cls);
        else if (force === false) this._classes.delete(cls);
        else if (this._classes.has(cls)) this._classes.delete(cls);
        else this._classes.add(cls);
      },
      contains(cls) {
        return this._classes.has(cls);
      },
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
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
      listeners.set(
        event,
        listeners.get(event).filter((fn) => fn !== cb)
      );
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
        return this._children.map((c) => (c.isText ? c.text : c.textContent || '')).join('');
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

export function serializeNode(node) {
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

export function parseMockElements(html) {
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
          attrVal
            .split(/\s+/)
            .filter(Boolean)
            .forEach((c) => el.classList.add(c));
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

export function findSelector(parent, selector) {
  const all = findAllSelectors(parent, selector);
  return all.length > 0 ? all[0] : null;
}

export function findAllSelectors(parent, selector) {
  if (selector.includes(',')) {
    const parts = selector
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
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
    documentListeners.set(
      type,
      documentListeners.get(type).filter((fn) => fn !== cb)
    );
  },
  dispatchEvent: (event) => {
    const type = typeof event === 'string' ? event : event.type;
    const cbs = documentListeners.get(type) || [];
    for (const cb of cbs) cb(event);
  },
  body: createMockElement('body'),
};

export const sampleDossierResponse = {
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

export const sampleUsersResponse = {
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
