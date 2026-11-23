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

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createHeaders(entries = {}) {
  const normalized = new Map(
    Object.entries(entries).map(([k, v]) => [k.toLowerCase(), String(v)])
  );
  return {
    get(name) {
      return normalized.has(name.toLowerCase()) ? normalized.get(name.toLowerCase()) : null;
    },
  };
}

function setupLanding({ includeHero = true, mockFetch } = {}) {
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

  if (includeHero) {
    elements.heroQuotaStatus = createMockElement('p');
    elements.heroQuotaRemaining = createMockElement('strong');
    elements.heroQuotaLabel = createMockElement('span');
    elements.heroQuotaRemaining.textContent = '3';
    elements.heroQuotaLabel.textContent = 'free renders left today. No account or API key required.';
  }

  elements.htmlInput.value = '<h1>Test Invoice</h1>';
  elements.quotaRemaining.textContent = '3';
  elements.quotaLabel.textContent = 'free PDFs left today';
  elements.result.classList.add('hidden');
  elements.error.classList.add('hidden');

  const windowListeners = {};
  const windowObj = {
    location: { protocol: 'https:', origin: 'https://renderpdf.vberkoz.com' },
    matchMedia: () => ({ matches: true }),
    addEventListener(type, fn) {
      if (!windowListeners[type]) windowListeners[type] = [];
      windowListeners[type].push(fn);
    },
    dispatchEvent(event) {
      (windowListeners[event.type] || []).forEach((fn) => fn(event));
    },
  };

  const sandbox = {
    window: windowObj,
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

  async function submitForm() {
    const submitListeners = elements.pdfForm.listeners['submit'] || [];
    assert.ok(submitListeners.length > 0, 'Form should have submit listener registered');
    let defaultPrevented = false;
    await submitListeners[0]({
      preventDefault: () => {
        defaultPrevented = true;
      },
    });
    return { defaultPrevented };
  }

  return { elements, windowObj, submitForm };
}

test('attempting 4th render displays informative limit-reached message and CTA to register/log in', async () => {
  let fetchCalledWith = null;

  const { elements, submitForm } = setupLanding({
    includeHero: false,
    mockFetch: async (url, options = {}) => {
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
          headers: createHeaders({
            'x-trial-remaining': '0',
            'x-trial-limit': '3',
          }),
          json: async () => ({
            code: 'rate_limited',
            error: 'Daily trial limit reached',
            requestId: 'req-trial-limit-4th',
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    },
  });

  await flushMicrotasks();

  const { defaultPrevented } = await submitForm();

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

test('initial loadQuota syncs hero and playground for plural, singular, and exhausted states', async () => {
  const cases = [
    {
      remaining: 2,
      playgroundLabel: 'free PDFs left today',
      heroLabel: 'free renders left today. No account or API key required.',
      empty: false,
    },
    {
      remaining: 1,
      playgroundLabel: 'free PDF left today',
      heroLabel: 'free render left today. No account or API key required.',
      empty: false,
    },
    {
      remaining: 0,
      playgroundLabel: 'free PDFs left today',
      heroLabel: 'free renders left today. Sign in for 25 free PDFs/month.',
      empty: true,
    },
  ];

  for (const tc of cases) {
    const { elements } = setupLanding({
      mockFetch: async (url) => {
        if (String(url).includes('/api/v1/trial/quota')) {
          return {
            ok: true,
            json: async () => ({ limit: 3, remaining: tc.remaining }),
          };
        }
        return { ok: true, json: async () => ({}) };
      },
    });

    await flushMicrotasks();

    assert.strictEqual(elements.quotaRemaining.textContent, String(tc.remaining));
    assert.strictEqual(elements.quotaLabel.textContent, tc.playgroundLabel);
    assert.strictEqual(elements.quotaStatus.classList.contains('quota-empty'), tc.empty);

    assert.strictEqual(elements.heroQuotaRemaining.textContent, String(tc.remaining));
    assert.strictEqual(elements.heroQuotaLabel.textContent, tc.heroLabel);
    assert.strictEqual(elements.heroQuotaStatus.classList.contains('quota-empty'), tc.empty);
  }
});

test('successful render updates hero and playground from X-Trial-Remaining and falls back to quota fetch when header is missing', async () => {
  // Case 1: X-Trial-Remaining header present
  {
    const { elements, submitForm } = setupLanding({
      mockFetch: async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/api/v1/trial/quota')) {
          return { ok: true, json: async () => ({ limit: 3, remaining: 3 }) };
        }
        if (urlStr.includes('/api/v1/trial/render')) {
          return {
            ok: true,
            status: 200,
            headers: createHeaders({
              'X-Trial-Remaining': '2',
              'X-Trial-Limit': '3',
            }),
            json: async () => ({ url: 'https://cdn.example.com/out.pdf', size: 2048 }),
          };
        }
        return { ok: true, json: async () => ({}) };
      },
    });

    await flushMicrotasks();
    await submitForm();

    assert.strictEqual(elements.quotaRemaining.textContent, '2');
    assert.strictEqual(elements.heroQuotaRemaining.textContent, '2');
    assert.strictEqual(elements.quotaLabel.textContent, 'free PDFs left today');
    assert.strictEqual(elements.heroQuotaLabel.textContent, 'free renders left today. No account or API key required.');
  }

  // Case 2: X-Trial-Remaining header stripped -> falls back to GET /api/v1/trial/quota
  {
    let quotaCalls = 0;
    const { elements, submitForm } = setupLanding({
      mockFetch: async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/api/v1/trial/quota')) {
          quotaCalls += 1;
          const remaining = quotaCalls === 1 ? 2 : 1;
          return { ok: true, json: async () => ({ limit: 3, remaining }) };
        }
        if (urlStr.includes('/api/v1/trial/render')) {
          return {
            ok: true,
            status: 200,
            headers: createHeaders({}),
            json: async () => ({ url: 'https://cdn.example.com/out.pdf', size: 2048 }),
          };
        }
        return { ok: true, json: async () => ({}) };
      },
    });

    await flushMicrotasks();
    assert.strictEqual(elements.heroQuotaRemaining.textContent, '2');

    await submitForm();
    await flushMicrotasks();

    assert.strictEqual(quotaCalls, 2);
    assert.strictEqual(elements.quotaRemaining.textContent, '1');
    assert.strictEqual(elements.quotaLabel.textContent, 'free PDF left today');
    assert.strictEqual(elements.heroQuotaRemaining.textContent, '1');
    assert.strictEqual(elements.heroQuotaLabel.textContent, 'free render left today. No account or API key required.');
  }
});

test('stale initial loadQuota response does not overwrite newer render X-Trial-Remaining', async () => {
  let resolveInitialQuota;
  const initialQuotaPromise = new Promise((resolve) => {
    resolveInitialQuota = resolve;
  });

  const { elements, submitForm } = setupLanding({
    mockFetch: async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/v1/trial/quota')) {
        return initialQuotaPromise;
      }
      if (urlStr.includes('/api/v1/trial/render')) {
        return {
          ok: true,
          status: 200,
          headers: createHeaders({
            'X-Trial-Remaining': '2',
            'X-Trial-Limit': '3',
          }),
          json: async () => ({ url: 'https://cdn.example.com/out.pdf', size: 1024 }),
        };
      }
      return { ok: true, json: async () => ({}) };
    },
  });

  // Render completes while initial loadQuota is still in flight
  await submitForm();
  assert.strictEqual(elements.quotaRemaining.textContent, '2');
  assert.strictEqual(elements.heroQuotaRemaining.textContent, '2');

  // Stale initial quota arrives afterwards saying remaining: 3
  resolveInitialQuota({
    ok: true,
    json: async () => ({ limit: 3, remaining: 3 }),
  });
  await flushMicrotasks();

  assert.strictEqual(elements.quotaRemaining.textContent, '2');
  assert.strictEqual(elements.heroQuotaRemaining.textContent, '2');
});

test('malformed or failed loadQuota preserves current valid quota and singular labels', async () => {
  let quotaAttempt = 0;
  const { elements, windowObj } = setupLanding({
    mockFetch: async (url) => {
      if (String(url).includes('/api/v1/trial/quota')) {
        quotaAttempt += 1;
        if (quotaAttempt === 1) {
          return { ok: true, json: async () => ({ limit: 3, remaining: 1 }) };
        }
        if (quotaAttempt === 2) {
          return { ok: true, json: async () => ({ limit: 3, remaining: undefined }) };
        }
        throw new Error('Network unavailable');
      }
      return { ok: true, json: async () => ({}) };
    },
  });

  await flushMicrotasks();
  assert.strictEqual(elements.quotaRemaining.textContent, '1');
  assert.strictEqual(elements.quotaLabel.textContent, 'free PDF left today');
  assert.strictEqual(elements.heroQuotaRemaining.textContent, '1');
  assert.strictEqual(elements.heroQuotaLabel.textContent, 'free render left today. No account or API key required.');

  // Second quota check returns malformed remaining: undefined
  windowObj.dispatchEvent({ type: 'pageshow', persisted: true });
  await flushMicrotasks();

  assert.strictEqual(elements.quotaRemaining.textContent, '1');
  assert.strictEqual(elements.quotaLabel.textContent, 'free PDF left today');
  assert.strictEqual(elements.quotaStatus.classList.contains('quota-empty'), false);
  assert.strictEqual(elements.heroQuotaRemaining.textContent, '1');
  assert.strictEqual(elements.heroQuotaStatus.classList.contains('quota-empty'), false);

  // Third quota check fails completely
  windowObj.dispatchEvent({ type: 'pageshow', persisted: true });
  await flushMicrotasks();

  assert.strictEqual(elements.quotaRemaining.textContent, '1');
  assert.strictEqual(elements.quotaLabel.textContent, 'free PDF left today');
  assert.strictEqual(elements.heroQuotaRemaining.textContent, '1');
  assert.strictEqual(elements.heroQuotaLabel.textContent, 'free render left today. No account or API key required.');
});

test('pageshow with persisted true refreshes quota on bfcache restore', async () => {
  let quotaCalls = 0;
  const { elements, windowObj } = setupLanding({
    mockFetch: async (url) => {
      if (String(url).includes('/api/v1/trial/quota')) {
        quotaCalls += 1;
        return {
          ok: true,
          json: async () => ({ limit: 3, remaining: quotaCalls === 1 ? 2 : 0 }),
        };
      }
      return { ok: true, json: async () => ({}) };
    },
  });

  await flushMicrotasks();
  assert.strictEqual(elements.quotaRemaining.textContent, '2');
  assert.strictEqual(elements.heroQuotaRemaining.textContent, '2');

  // Non-persisted pageshow should not trigger an extra fetch
  windowObj.dispatchEvent({ type: 'pageshow', persisted: false });
  await flushMicrotasks();
  assert.strictEqual(quotaCalls, 1);

  // Persisted pageshow (bfcache restore) should refresh both indicators
  windowObj.dispatchEvent({ type: 'pageshow', persisted: true });
  await flushMicrotasks();
  assert.strictEqual(quotaCalls, 2);
  assert.strictEqual(elements.quotaRemaining.textContent, '0');
  assert.ok(elements.quotaStatus.classList.contains('quota-empty'));
  assert.strictEqual(elements.heroQuotaRemaining.textContent, '0');
  assert.ok(elements.heroQuotaStatus.classList.contains('quota-empty'));
  assert.strictEqual(
    elements.heroQuotaLabel.textContent,
    'free renders left today. Sign in for 25 free PDFs/month.'
  );
});

test('429 limit reached updates both hero and playground to 0 and uses X-Trial-Limit in error notice', async () => {
  const { elements, submitForm } = setupLanding({
    mockFetch: async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/v1/trial/quota')) {
        return { ok: true, json: async () => ({ limit: 5, remaining: 1 }) };
      }
      if (urlStr.includes('/api/v1/trial/render')) {
        return {
          ok: false,
          status: 429,
          headers: createHeaders({
            'X-Trial-Remaining': '0',
            'X-Trial-Limit': '5',
          }),
          json: async () => ({
            code: 'rate_limited',
            error: 'Daily trial limit reached',
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    },
  });

  await flushMicrotasks();
  await submitForm();

  assert.strictEqual(elements.quotaRemaining.textContent, '0');
  assert.ok(elements.quotaStatus.classList.contains('quota-empty'));
  assert.strictEqual(elements.heroQuotaRemaining.textContent, '0');
  assert.ok(elements.heroQuotaStatus.classList.contains('quota-empty'));
  assert.strictEqual(
    elements.heroQuotaLabel.textContent,
    'free renders left today. Sign in for 25 free PDFs/month.'
  );
  assert.ok(
    elements.error.innerHTML.includes('limit of 5 free trial renders for today'),
    'Error notice should reflect dynamic trial limit from X-Trial-Limit'
  );
});
