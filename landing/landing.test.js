const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const landingCode = fs.readFileSync(path.join(__dirname, 'landing.js'), 'utf8');

function createMockElement(tagName = 'div') {
  const element = {
    tagName: tagName.toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    attributes: {},
    classList: {
      _classes: new Set(),
      add(...classes) {
        classes.forEach((c) => this._classes.add(c));
      },
      remove(...classes) {
        classes.forEach((c) => this._classes.delete(c));
      },
      contains(c) {
        return this._classes.has(c);
      },
      toggle(c, force) {
        if (force === true) this._classes.add(c);
        else if (force === false) this._classes.delete(c);
        else if (this._classes.has(c)) this._classes.delete(c);
        else this._classes.add(c);
      },
    },
    setAttribute(name, val) {
      element.attributes[name] = String(val);
    },
    getAttribute(name) {
      return element.attributes[name] || null;
    },
    removeAttribute(name) {
      delete element.attributes[name];
    },
    listeners: {},
    addEventListener(event, fn) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(fn);
    },
    dispatchEvent(event) {
      const fns = this.listeners[event.type] || [];
      fns.forEach((fn) => fn(event));
    },
  };
  return element;
}

test('attempting 4th render displays informative limit-reached message and CTA to register/log in', async () => {
  const elements = {
    pdfForm: createMockElement('form'),
    generateBtn: createMockElement('button'),
    generateBtnLabel: createMockElement('span'),
    result: createMockElement('div'),
    error: createMockElement('div'),
    htmlInput: createMockElement('textarea'),
    htmlPreview: createMockElement('iframe'),
    quotaStatus: createMockElement('p'),
    quotaRemaining: createMockElement('span'),
    quotaLabel: createMockElement('span'),
    renderSpeedVal: createMockElement('strong'),
    uptimeVal: createMockElement('strong'),
  };

  elements.htmlInput.value = '<h1>Test Invoice</h1>';
  elements.quotaRemaining.textContent = '0';
  elements.result.classList.add('hidden');
  elements.error.classList.add('hidden');

  let fetchCalledWith = null;

  const mockFetch = async (url, options = {}) => {
    const urlStr = String(url);
    if (urlStr.includes('/api/v1/trial/quota')) {
      return {
        ok: true,
        json: async () => ({ limit: 3, remaining: 0 }),
      };
    }
    if (urlStr.includes('/api/v1/public-stats')) {
      return {
        ok: true,
        json: async () => ({ averageRenderMs: 420, successRate: 99.9 }),
      };
    }
    if (urlStr.includes('/api/v1/trial/render')) {
      fetchCalledWith = { url: urlStr, options };
      // 4th render is blocked by the backend with HTTP 429
      return {
        ok: false,
        status: 429,
        headers: {
          get(name) {
            if (name.toLowerCase() === 'x-trial-remaining') return '0';
            if (name.toLowerCase() === 'x-trial-limit') return '3';
            return null;
          },
        },
        json: async () => ({
          code: 'rate_limited',
          error: 'Daily trial limit reached',
          requestId: 'req-trial-limit-4th',
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  const sandbox = {
    window: {
      location: { protocol: 'https:', origin: 'https://renderpdf.vberkoz.com' },
      matchMedia: () => ({ matches: true }),
      addEventListener: () => {},
    },
    document: {
      readyState: 'complete',
      getElementById: (id) => elements[id] || null,
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener: () => {},
    },
    fetch: mockFetch,
    URL,
    DOMParser: class {
      parseFromString() {
        return {
          querySelectorAll: () => [],
          head: { insertAdjacentHTML: () => {} },
          documentElement: { outerHTML: '<html></html>' },
        };
      }
    },
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    module: { exports: {} },
  };

  vm.createContext(sandbox);
  vm.runInContext(landingCode, sandbox);

  // Trigger form submit to attempt the 4th render
  const submitListeners = elements.pdfForm.listeners['submit'] || [];
  assert.ok(submitListeners.length > 0, 'Form should have submit listener registered');

  let defaultPrevented = false;
  const event = {
    preventDefault: () => {
      defaultPrevented = true;
    },
  };

  await submitListeners[0](event);

  assert.ok(defaultPrevented, 'Form submit default should be prevented');
  assert.ok(fetchCalledWith, 'Trial render fetch should be called');

  // Verify the system blocked the render
  assert.ok(elements.result.classList.contains('hidden'), 'Result container must remain hidden on blocked render');
  assert.strictEqual(elements.error.classList.contains('hidden'), false, 'Error container must be visible');

  // Verify informative limit-reached message
  assert.ok(
    elements.error.innerHTML.includes('Daily trial limit reached'),
    'Error message should indicate daily trial limit reached'
  );
  assert.ok(
    elements.error.innerHTML.includes('free trial renders') || elements.error.innerHTML.includes('free trial'),
    'Error message should explain trial limit'
  );

  // Verify call-to-action to register/log in
  assert.ok(
    elements.error.innerHTML.includes('/app/'),
    'Error banner must link to /app/'
  );
  assert.ok(
    elements.error.innerHTML.includes('Register or log in') || elements.error.innerHTML.includes('register/log in') || elements.error.innerHTML.includes('Sign in'),
    'Error banner must provide a call-to-action to register/log in'
  );

  // Verify quota status reflects 0
  assert.strictEqual(String(elements.quotaRemaining.textContent), '0');
  assert.ok(elements.quotaStatus.classList.contains('quota-empty'));
});
