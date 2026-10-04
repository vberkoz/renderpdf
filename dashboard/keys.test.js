import test from 'node:test';
import assert from 'node:assert/strict';
import keysModule from './features/keys.js';

test('generateQuickstartSnippets generates snippets with custom API key', () => {
  const snippets = keysModule.generateQuickstartSnippets('test_api_key_123');
  assert.ok(snippets.curl.includes('Bearer test_api_key_123'));
  assert.ok(snippets.node.includes('Bearer test_api_key_123'));
  assert.ok(snippets.python.includes('Bearer test_api_key_123'));
  assert.ok(snippets.go.includes('Bearer test_api_key_123'));
  assert.ok(snippets.curl.includes('https://renderpdf.vberkoz.com/api/v1/render'));
});

test('generateQuickstartSnippets falls back to placeholder when key is empty', () => {
  const snippets = keysModule.generateQuickstartSnippets('');
  assert.ok(snippets.curl.includes('Bearer YOUR_API_KEY'));
  assert.ok(snippets.node.includes('Bearer YOUR_API_KEY'));
});

test('API key actions: listKeys, generateKey, and deleteKey call apiRequest', async () => {
  const calls = [];
  global.apiRequest = async (path, options) => {
    calls.push({ path, options });
    return { success: true };
  };
  global.authHeaders = () => ({
    Authorization: 'Bearer test_token',
    'Content-Type': 'application/json',
  });

  await keysModule.listKeys();
  assert.strictEqual(calls[0].path, '/api-keys');
  assert.strictEqual(calls[0].options.headers.Authorization, 'Bearer test_token');

  await keysModule.generateKey({ name: 'Production Key' });
  assert.strictEqual(calls[1].path, '/api-keys');
  assert.strictEqual(calls[1].options.method, 'POST');
  assert.deepStrictEqual(JSON.parse(calls[1].options.body), { name: 'Production Key' });

  await keysModule.generateKey('String Key');
  assert.strictEqual(calls[2].path, '/api-keys');
  assert.deepStrictEqual(JSON.parse(calls[2].options.body), { name: 'String Key' });

  await keysModule.deleteKey('key-xyz');
  assert.strictEqual(calls[3].path, '/api-keys/key-xyz');
  assert.strictEqual(calls[3].options.method, 'DELETE');
});

test('switchQuickstartTab updates aria and hidden attributes', () => {
  const tabs = {};
  const panels = {};

  keysModule.quickstartLanguages.forEach((lang) => {
    tabs[lang.tabId] = {
      attributes: {},
      classes: new Set(),
      setAttribute(k, v) { this.attributes[k] = v; },
      classList: {
        toggle(cls, force) {
          if (force) tabs[lang.tabId].classes.add(cls);
          else tabs[lang.tabId].classes.delete(cls);
        },
      },
    };
    panels[lang.panelId] = { hidden: true };
  });

  global.document = {
    getElementById(id) {
      return tabs[id] || panels[id] || null;
    },
  };

  keysModule.switchQuickstartTab('node');

  assert.strictEqual(tabs.quickstartTabNode.attributes['aria-selected'], 'true');
  assert.strictEqual(tabs.quickstartTabNode.attributes.tabindex, '0');
  assert.ok(tabs.quickstartTabNode.classes.has('is-active'));
  assert.strictEqual(panels.quickstartPanelNode.hidden, false);

  assert.strictEqual(tabs.quickstartTabCurl.attributes['aria-selected'], 'false');
  assert.strictEqual(tabs.quickstartTabCurl.attributes.tabindex, '-1');
  assert.ok(!tabs.quickstartTabCurl.classes.has('is-active'));
  assert.strictEqual(panels.quickstartPanelCurl.hidden, true);
});

test('copyToClipboard copies using navigator.clipboard when available', async () => {
  let written = '';
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: {
      writeText: async (text) => {
        written = text;
      },
    },
    configurable: true,
  });
  global.window = { isSecureContext: true, setTimeout: () => {} };

  const button = {
    textContent: 'Copy Key',
    classList: {
      add: (c) => {},
      remove: (c) => {},
    },
  };

  await keysModule.copyToClipboard('secret-api-key', button);
  assert.strictEqual(written, 'secret-api-key');
  assert.strictEqual(button.textContent, 'Copied!');
});
