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

// Lightweight mock container
function createMockElement(tagName = 'div') {
  const listeners = new Map();
  const attributes = new Map();
  let innerHtml = '';

  const el = {
    tagName: tagName.toUpperCase(),
    attributes,
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
      contains(cls) { return this._classes.has(cls); }
    },
    getAttribute(name) { return attributes.get(name) ?? null; },
    setAttribute(name, val) { attributes.set(name, String(val)); },
    removeAttribute(name) { attributes.delete(name); },
    addEventListener(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
    },
    dispatchEvent(event) {
      const type = typeof event === 'string' ? event : event.type;
      const cbs = listeners.get(type) || [];
      for (const cb of cbs) cb(event);
    },
    get innerHTML() { return innerHtml; },
    set innerHTML(val) {
      innerHtml = val;
    },
    querySelector(selector) {
      return findSelector(this, selector);
    },
    querySelectorAll(selector) {
      return findAllSelectors(this, selector);
    }
  };

  return el;
}

// Minimal HTML parser to search elements in mock container
function parseMockElements(html) {
  const elements = [];
  const tagRegex = /<([a-zA-Z0-9-]+)([^>]*)>([\s\S]*?)<\/\1>|<([a-zA-Z0-9-]+)([^>]*)\/?>/g;
  let match;
  while ((match = tagRegex.exec(html)) !== null) {
    const tagName = match[1] || match[4];
    const rawAttrs = match[2] || match[5] || '';
    const content = match[3] || '';
    const el = createMockElement(tagName);
    el.innerHTML = content;

    const attrRegex = /([a-zA-Z0-9-]+)(?:="([^"]*)")?/g;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(rawAttrs)) !== null) {
      el.setAttribute(attrMatch[1], attrMatch[2] ?? '');
      if (attrMatch[1] === 'class') {
        (attrMatch[2] || '').split(/\s+/).filter(Boolean).forEach(c => el.classList.add(c));
      }
    }
    elements.push(el);
  }
  return elements;
}

function findSelector(parent, selector) {
  const all = findAllSelectors(parent, selector);
  return all.length > 0 ? all[0] : null;
}

function findAllSelectors(parent, selector) {
  const parsed = parseMockElements(parent.innerHTML);
  if (selector.startsWith('#')) {
    const id = selector.slice(1);
    return parsed.filter(e => e.getAttribute('id') === id);
  }
  if (selector.startsWith('.')) {
    const cls = selector.slice(1);
    return parsed.filter(e => e.classList.contains(cls));
  }
  return parsed.filter(e => e.tagName.toLowerCase() === selector.toLowerCase());
}

const sampleAnalyticsResponse = {
  summary: {
    totalUsers: 1420,
    activeSubscriptions: 84,
    mrrUsd: 3456.00,
    grossMarginPercent: 89.4,
    costPerThousandPdfsUsd: 0.26,
  },
  funnel: {
    pageViews: 73500,
    playgroundSubmits: 12600,
    playgroundActivationRate: 17.1,
    signupsCompleted: 840,
    trialToSignupRate: 6.7,
    apiKeysCreated: 580,
    signupToKeyRate: 69.0,
    firstApiCalls: 410,
    ttfcMedianMinutes: 4.2,
  },
  rendering: {
    totalRenders: 426000,
    successRate: 99.87,
    averageRenderMs: 480,
    p95RenderMs: 720,
    latencyHistogram: {
      under_400ms: 294000,
      '400ms_to_800ms': 114000,
      '800ms_to_1500ms': 16500,
      over_1500ms: 1500,
    },
  },
  dailyRollups: [
    {
      date: '2026-09-27',
      renders: 14200,
      errors: 18,
      revenueUsd: 115.20,
      estimatedAwsCostUsd: 3.69,
      marginPercent: 96.8,
      p95Ms: 690,
    },
    {
      date: '2026-09-26',
      renders: 13900,
      errors: 0,
      revenueUsd: 110.00,
      estimatedAwsCostUsd: 3.55,
      marginPercent: 96.7,
      p95Ms: 675,
    },
  ],
};

test('initAnalyticsTab fetches /analytics?days=30 and renders complete UI', async () => {
  const fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      json: async () => sampleAnalyticsResponse,
    };
  };

  const { initAnalyticsTab } = await import('./analytics.js');
  const container = createMockElement('div');

  await initAnalyticsTab(container);

  // 1. Verify API endpoint and authorization header
  assert.strictEqual(fetchCalls.length, 1);
  assert.strictEqual(fetchCalls[0].url, '/api/v1/analytics?days=30');
  assert.strictEqual(fetchCalls[0].opts.headers.Authorization, `Bearer ${mockToken}`);

  const html = container.innerHTML;

  // 2. Summary bar check: MRR, Gross Margin, AWS Cost / 1k, Active Subscriptions
  assert.ok(html.includes('$3,456.00'), 'Should contain formatted MRR');
  assert.ok(html.includes('89.4%'), 'Should contain gross margin percent');
  assert.ok(html.includes('$0.26'), 'Should contain AWS cost per 1k PDFs');
  assert.ok(html.includes('84'), 'Should contain active subscriptions count');

  // 3. Growth Funnel check: all 6 steps present
  assert.ok(html.includes('Visitors'), 'Should render Visitors step');
  assert.ok(html.includes('Playground Renders'), 'Should render Playground Renders step');
  assert.ok(html.includes('Signups'), 'Should render Signups step');
  assert.ok(html.includes('API Key Created'), 'Should render API Key Created step');
  assert.ok(html.includes('First API Call'), 'Should render First API Call step');
  assert.ok(html.includes('Paid Upgrade'), 'Should render Paid Upgrade step');
  assert.ok(html.includes('73,500'), 'Should render visitors count formatted');
  assert.ok(html.includes('12,600'), 'Should render playground count formatted');
  assert.ok(html.includes('840'), 'Should render signups count');
  assert.ok(html.includes('4.2m'), 'Should render TTFC median minutes');

  // 4. Latency Distribution check: 4 buckets and KPIs
  assert.ok(html.includes('&lt; 400 ms') || html.includes('< 400 ms'), 'Should render < 400 ms bucket');
  assert.ok(html.includes('400 – 800 ms'), 'Should render 400-800ms bucket');
  assert.ok(html.includes('800 – 1500 ms'), 'Should render 800-1500ms bucket');
  assert.ok(html.includes('&gt; 1500 ms') || html.includes('> 1500 ms'), 'Should render > 1500 ms bucket');
  assert.ok(html.includes('720 ms'), 'Should render P95 latency');
  assert.ok(html.includes('480 ms'), 'Should render average render latency');
  assert.ok(html.includes('99.87%'), 'Should render success rate');

  // 5. Daily Trends table check
  assert.ok(html.includes('2026-09-27'), 'Should include 2026-09-27 date');
  assert.ok(html.includes('2026-09-26'), 'Should include 2026-09-26 date');
  assert.ok(html.includes('14,200'), 'Should format daily render count');
  assert.ok(html.includes('$115.20'), 'Should format daily revenue');
  assert.ok(html.includes('$3.69'), 'Should format daily AWS cost');
  assert.ok(html.includes('96.8%'), 'Should format daily gross margin');
});

test('initAnalyticsTab gracefully handles error state and supports retry', async () => {
  let attempt = 0;
  global.fetch = async () => {
    attempt++;
    if (attempt === 1) {
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: 'Database unavailable' }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => sampleAnalyticsResponse,
    };
  };

  const { initAnalyticsTab } = await import('./analytics.js');
  const container = createMockElement('div');

  await initAnalyticsTab(container);

  // First attempt should render error banner
  assert.strictEqual(attempt, 1);
  assert.ok(container.innerHTML.includes('Failed to load analytics'));
  assert.ok(container.innerHTML.includes('Database unavailable'));
  assert.ok(container.innerHTML.includes('admin-btn-retry'));
});

test('adminFetch seamlessly falls back from /api/v1/analytics to /api/v1/admin/analytics on unmapped API Gateway route', async () => {
  const urlsAttempted = [];
  global.fetch = async (url) => {
    urlsAttempted.push(url);
    if (url === '/api/v1/analytics?days=30') {
      return {
        ok: false,
        status: 403,
        json: async () => ({ message: 'Missing Authentication Token' }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => sampleAnalyticsResponse,
    };
  };

  const { initAnalyticsTab } = await import('./analytics.js');
  const container = createMockElement('div');

  await initAnalyticsTab(container);

  assert.deepStrictEqual(urlsAttempted, [
    '/api/v1/analytics?days=30',
    '/api/v1/admin/analytics?days=30',
  ]);
  assert.ok(container.innerHTML.includes('$3,456.00'), 'Should render data retrieved via fallback URL');
});
