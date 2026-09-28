import test from 'node:test';
import assert from 'node:assert/strict';

// Set up mock DOM environment
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
      if (event.type === 'submit' && typeof el.onsubmit === 'function') {
        el.onsubmit(event);
      }
      if (event.type === 'click' && typeof el.onclick === 'function') {
        el.onclick(event);
      }
      if (event.type === 'change' && typeof el.onchange === 'function') {
        el.onchange(event);
      }
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

    focus() {
      global.document.activeElement = el;
    },

    querySelector(selector) {
      return findSelector(el, selector);
    },
    querySelectorAll(selector) {
      return findAllSelectors(el, selector);
    },

    closest(selector) {
      let cur = el;
      while (cur) {
        if (matchesSelector(cur, selector)) return cur;
        cur = cur._parent;
      }
      return null;
    },

    get textContent() {
      if (children.length > 0) {
        return children.map((c) => c.textContent || '').join('');
      }
      return el._textContent || '';
    },
    set textContent(val) {
      el._textContent = String(val);
      children.length = 0;
    },

    get innerHTML() {
      return el._innerHTML || '';
    },
    set innerHTML(html) {
      el._innerHTML = html;
      el.children.length = 0;
      parseSimpleHtml(html, el);
    },
  };

  return el;
}

function parseSimpleHtml(html, parent) {
  // Simple regex parser for test mock elements
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
      if (attrName === 'name') child.name = attrVal;
      if (attrName === 'value') child.value = attrVal;
      if (attrName.startsWith('data-')) {
        const dataKey = attrName.slice(5).replace(/-([a-z])/g, (_, l) => l.toUpperCase());
        child.dataset[dataKey] = attrVal;
      }
      if (attrName === 'checked') child.checked = true;
      if (attrName === 'required') child.required = true;
    }

    if (inner) {
      child.innerHTML = inner;
    }
    parent.appendChild(child);
  }
}

function matchesSelector(el, selector) {
  if (selector.startsWith('#')) return el.id === selector.slice(1);
  if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
  if (selector.includes('[') && selector.includes(']')) {
    const match = selector.match(/\[([a-zA-Z0-9-]+)(?:="?([^"\]]*)"?)?\]/);
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
  if (selector.includes(':checked')) {
    const base = selector.replace(':checked', '');
    const found = findAllSelectors(root, base);
    return found.find((el) => el.checked) || null;
  }
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

// Global window and document setup
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
    return findSelector(global.document.body, `#${id}`);
  },
  createElement(tag) {
    return createMockElement(tag);
  },
  addEventListener(event, fn) {
    if (!docListeners.has(event)) docListeners.set(event, []);
    docListeners.get(event).push(fn);
  },
  removeEventListener(event, fn) {
    if (!docListeners.has(event)) return;
    docListeners.set(event, docListeners.get(event).filter((f) => f !== fn));
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

test('initPlanQuotaModals registers window event listeners and handles open-change-plan', async () => {
  setupAdminToken();
  const { initPlanQuotaModals, getOrCreateChangePlanModal } = await import('./plans.js');
  initPlanQuotaModals();

  assert.ok(windowListeners.has('open-change-plan'), 'open-change-plan listener registered');
  assert.ok(windowListeners.has('open-grant-credits'), 'open-grant-credits listener registered');

  // Dispatch open-change-plan
  global.window.dispatchEvent({
    type: 'open-change-plan',
    detail: {
      userId: 'user_cust_1',
      userEmail: 'cust1@acme.com',
      currentTier: 'starter',
      manualOverride: true,
    },
  });

  const modal = getOrCreateChangePlanModal();
  assert.strictEqual(modal.hasAttribute('hidden'), false, 'Modal should be visible (hidden attribute removed)');

  const subtitle = modal.querySelector('#change-plan-modal-subtitle');
  assert.ok(subtitle.textContent.includes('cust1@acme.com'), 'Subtitle contains customer email');

  const starterRadio = modal.querySelector('input[value="starter"]');
  assert.strictEqual(starterRadio.checked, true, 'Starter tier radio is pre-selected');

  const lockCheckbox = modal.querySelector('#change-plan-lock-override');
  assert.strictEqual(lockCheckbox.checked, true, 'Lock override checkbox is checked');
});

test('openChangePlanModal blocks submission without reason and dispatches user-updated on success', async () => {
  setupAdminToken();
  const { openChangePlanModal, getOrCreateChangePlanModal } = await import('./plans.js');

  const fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts, body: JSON.parse(opts.body || '{}') });
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, tier: 'pro', quotaLimit: 20000 }),
    };
  };

  const dispatchedWindowEvents = [];
  const captureEvt = (e) => dispatchedWindowEvents.push(e);
  global.window.addEventListener('user-updated', captureEvt);

  openChangePlanModal({
    userId: 'user_cust_2',
    userEmail: 'cust2@corp.com',
    currentTier: 'free',
  });

  const modal = getOrCreateChangePlanModal();
  const form = modal.querySelector('#change-plan-form');
  const proRadio = modal.querySelector('input[value="pro"]');
  const reasonInput = modal.querySelector('#change-plan-reason');
  const errorEl = modal.querySelector('#change-plan-error');

  // Select Pro
  proRadio.checked = true;
  proRadio.dispatchEvent({ type: 'change' });

  // 1. Submit without reason -> blocked
  reasonInput.value = '   ';
  let prevented = false;
  form.dispatchEvent({ type: 'submit', preventDefault: () => { prevented = true; } });
  assert.strictEqual(prevented, true);
  assert.strictEqual(fetchCalls.length, 0, 'No API call when reason is empty');
  assert.strictEqual(errorEl.hasAttribute('hidden'), false, 'Validation error displayed');

  // 2. Submit with valid reason
  reasonInput.value = 'Special enterprise promotional contract';
  form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

  // Wait a microtask
  await new Promise((r) => setTimeout(r, 10));

  assert.strictEqual(fetchCalls.length, 1, 'API call dispatched');
  assert.ok(fetchCalls[0].url.includes('/admin/users/user_cust_2/plan'), 'Correct plan endpoint target');
  assert.strictEqual(fetchCalls[0].body.tier, 'pro');
  assert.strictEqual(fetchCalls[0].body.reason, 'Special enterprise promotional contract');
  assert.strictEqual(modal.hasAttribute('hidden'), true, 'Modal closed after successful submission');

  // Verify user-updated event was dispatched to auto-refresh the customer dossier
  const updateEvt = dispatchedWindowEvents.find((e) => e.type === 'user-updated');
  assert.ok(updateEvt, 'user-updated event dispatched on window');
  assert.strictEqual(updateEvt.detail.userId, 'user_cust_2');
  assert.strictEqual(updateEvt.detail.tier, 'pro');
});

test('openGrantCreditsModal displays balance, validates amount/reason, and submits adjustment', async () => {
  setupAdminToken();
  const { openGrantCreditsModal, getOrCreateGrantCreditsModal } = await import('./plans.js');

  const fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts, body: JSON.parse(opts.body || '{}') });
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, used: 150, limit: 6000, remaining: 5850 }),
    };
  };

  const dispatchedWindowEvents = [];
  const captureEvt = (e) => dispatchedWindowEvents.push(e);
  global.window.addEventListener('user-updated', captureEvt);

  openGrantCreditsModal({
    userId: 'user_cust_3',
    userEmail: 'cust3@startup.io',
    currentQuota: { used: 150, limit: 5000 },
  });

  const modal = getOrCreateGrantCreditsModal();
  assert.strictEqual(modal.hasAttribute('hidden'), false, 'Modal opened');

  const usedEl = modal.querySelector('#grant-quota-used');
  assert.strictEqual(usedEl.textContent, '150');

  const limitEl = modal.querySelector('#grant-quota-limit');
  assert.strictEqual(limitEl.textContent, '5,000');

  const remainingEl = modal.querySelector('#grant-quota-remaining');
  assert.strictEqual(remainingEl.textContent, '4,850');

  const form = modal.querySelector('#grant-credits-form');
  const amountInput = modal.querySelector('#grant-credits-amount');
  const reasonInput = modal.querySelector('#grant-credits-reason');

  // 1. Submit without reason -> blocked
  amountInput.value = '1000';
  reasonInput.value = '';
  form.dispatchEvent({ type: 'submit', preventDefault: () => {} });
  assert.strictEqual(fetchCalls.length, 0);

  // 2. Submit with valid amount and reason
  amountInput.value = '2500';
  reasonInput.value = 'Goodwill credit for support ticket #1209';
  form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

  await new Promise((r) => setTimeout(r, 10));

  assert.strictEqual(fetchCalls.length, 1, 'API call dispatched');
  assert.ok(fetchCalls[0].url.includes('/admin/users/user_cust_3/quota'), 'Targeted quota endpoint');
  assert.strictEqual(fetchCalls[0].body.action, 'add_credits');
  assert.strictEqual(fetchCalls[0].body.amount, 2500);
  assert.strictEqual(fetchCalls[0].body.reason, 'Goodwill credit for support ticket #1209');
  assert.strictEqual(modal.hasAttribute('hidden'), true, 'Modal closed on success');

  const updateEvt = dispatchedWindowEvents.find((e) => e.type === 'user-updated');
  assert.ok(updateEvt, 'user-updated event dispatched on window');
  assert.strictEqual(updateEvt.detail.userId, 'user_cust_3');
});
