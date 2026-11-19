const { test } = require('node:test');
const assert = require('node:assert/strict');

// Setup mock browser environment for testing
function createMockEnvironment(initialConsent = null) {
  const storage = new Map();
  if (initialConsent) {
    storage.set('renderpdf_cookie_consent', initialConsent);
  }

  let cookieString = initialConsent ? `renderpdf_cookie_consent=${initialConsent}` : '';

  const listeners = {};
  const elements = new Map();

  function createMockElement(tag, id = '') {
    const classList = new Set();
    const el = {
      tagName: tag.toUpperCase(),
      id,
      className: '',
      attributes: {},
      innerHTML: '',
      classList: {
        add: (...names) => names.forEach((n) => classList.add(n)),
        remove: (...names) => names.forEach((n) => classList.delete(n)),
        contains: (n) => classList.has(n),
      },
      setAttribute: (k, v) => {
        el.attributes[k] = String(v);
      },
      getAttribute: (k) => el.attributes[k] || null,
      removeAttribute: (k) => delete el.attributes[k],
      addEventListener: (evt, fn) => {
        if (!el.listeners[evt]) el.listeners[evt] = [];
        el.listeners[evt].push(fn);
      },
      click: () => {
        const fns = el.listeners['click'] || [];
        fns.forEach((fn) => fn({ type: 'click', preventDefault: () => {} }));
      },
      listeners: {},
    };
    if (id) elements.set(id, el);
    return el;
  }

  const document = {
    readyState: 'complete',
    body: {
      appendChild: (child) => {
        if (child.id) elements.set(child.id, child);
        return child;
      },
    },
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: () => [],
    createElement: (tag) => createMockElement(tag),
    addEventListener: (evt, fn) => {
      if (!listeners[evt]) listeners[evt] = [];
      listeners[evt].push(fn);
    },
    get cookie() {
      return cookieString;
    },
    set cookie(val) {
      cookieString = val;
    },
  };

  const window = {
    document,
    localStorage: {
      getItem: (k) => storage.get(k) || null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    dispatchEvent: (event) => {
      const fns = listeners[event.type] || [];
      fns.forEach((fn) => fn(event));
    },
    addEventListener: (evt, fn) => {
      if (!listeners[evt]) listeners[evt] = [];
      listeners[evt].push(fn);
    },
  };

  global.CustomEvent = class {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail || {};
    }
  };

  return { window, document, storage, listeners, elements };
}

test('cookie consent defaults to unset and hasConsented() is false', () => {
  const env = createMockEnvironment();
  global.window = env.window;
  global.document = env.document;
  global.localStorage = env.window.localStorage;

  // Clear require cache to re-run module with fresh env
  delete require.cache[require.resolve('./cookie-consent.js')];
  const consent = require('./cookie-consent.js');

  assert.strictEqual(consent.getStatus(), 'unset');
  assert.strictEqual(consent.hasConsented(), false, 'Data collection must be disabled when consent is unset');
});

test('accepting cookies stores accepted status, sets hasConsented to true, and dispatches event', () => {
  const env = createMockEnvironment();
  global.window = env.window;
  global.document = env.document;
  global.localStorage = env.window.localStorage;

  delete require.cache[require.resolve('./cookie-consent.js')];
  const consent = require('./cookie-consent.js');

  let dispatchedEvent = null;
  env.window.addEventListener('renderpdf:consent', (e) => {
    dispatchedEvent = e.detail;
  });

  consent.accept();

  assert.strictEqual(consent.getStatus(), 'accepted');
  assert.strictEqual(consent.hasConsented(), true);
  assert.strictEqual(env.storage.get('renderpdf_cookie_consent'), 'accepted');
  assert.ok(env.document.cookie.includes('renderpdf_cookie_consent=accepted'));
  assert.deepStrictEqual(dispatchedEvent, { status: 'accepted' });
});

test('declining cookies stores declined status and hasConsented remains false', () => {
  const env = createMockEnvironment();
  global.window = env.window;
  global.document = env.document;
  global.localStorage = env.window.localStorage;

  delete require.cache[require.resolve('./cookie-consent.js')];
  const consent = require('./cookie-consent.js');

  let dispatchedEvent = null;
  env.window.addEventListener('renderpdf:consent', (e) => {
    dispatchedEvent = e.detail;
  });

  consent.decline();

  assert.strictEqual(consent.getStatus(), 'declined');
  assert.strictEqual(consent.hasConsented(), false, 'Data collection must remain disabled when declined');
  assert.strictEqual(env.storage.get('renderpdf_cookie_consent'), 'declined');
  assert.ok(env.document.cookie.includes('renderpdf_cookie_consent=declined'));
  assert.deepStrictEqual(dispatchedEvent, { status: 'declined' });
});

test('createDialog produces accessible dialog markup with Decline and Accept buttons', () => {
  const env = createMockEnvironment();
  global.window = env.window;
  global.document = env.document;
  global.localStorage = env.window.localStorage;

  delete require.cache[require.resolve('./cookie-consent.js')];
  const consent = require('./cookie-consent.js');

  const dialog = consent.createDialog();
  assert.ok(dialog);
  assert.strictEqual(dialog.getAttribute('role'), 'dialog');
  assert.strictEqual(dialog.getAttribute('aria-modal'), 'false');
  assert.strictEqual(dialog.getAttribute('aria-labelledby'), 'cookieConsentTitle');
  assert.strictEqual(dialog.getAttribute('aria-describedby'), 'cookieConsentDesc');

  assert.ok(dialog.innerHTML.includes('id="cookieConsentTitle"'));
  assert.ok(dialog.innerHTML.includes('id="cookieConsentDesc"'));
  assert.ok(dialog.innerHTML.includes('id="cookieConsentAcceptBtn"'));
  assert.ok(dialog.innerHTML.includes('id="cookieConsentDeclineBtn"'));
});

test('reset clears consent status and re-opens dialog', () => {
  const env = createMockEnvironment('accepted');
  global.window = env.window;
  global.document = env.document;
  global.localStorage = env.window.localStorage;

  delete require.cache[require.resolve('./cookie-consent.js')];
  const consent = require('./cookie-consent.js');

  assert.strictEqual(consent.getStatus(), 'accepted');
  assert.strictEqual(consent.hasConsented(), true);

  consent.reset();

  assert.strictEqual(consent.getStatus(), 'unset');
  assert.strictEqual(consent.hasConsented(), false);
  assert.strictEqual(env.storage.get('renderpdf_cookie_consent'), undefined);
});
