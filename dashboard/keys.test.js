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

  await keysModule.listKeys({ limit: 25, cursor: 'abc' });
  assert.strictEqual(calls[1].path, '/api-keys?limit=25&cursor=abc');

  await keysModule.generateKey({ name: 'Production Key' });
  assert.strictEqual(calls[2].path, '/api-keys');
  assert.strictEqual(calls[2].options.method, 'POST');
  assert.deepStrictEqual(JSON.parse(calls[2].options.body), { name: 'Production Key' });

  await keysModule.generateKey('String Key');
  assert.strictEqual(calls[3].path, '/api-keys');
  assert.deepStrictEqual(JSON.parse(calls[3].options.body), { name: 'String Key' });

  await keysModule.deleteKey('key-xyz');
  assert.strictEqual(calls[4].path, '/api-keys/key-xyz');
  assert.strictEqual(calls[4].options.method, 'DELETE');
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

function stripHighlightHtml(html) {
  return html
    .replace(/<\/?span[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

test('highlightQuickstartCode highlights curl, node, python, and go tokens safely', () => {
  const snippets = keysModule.generateQuickstartSnippets('sk_live_test_123');

  const curlHtml = keysModule.highlightQuickstartCode(snippets.curl, 'curl');
  assert.ok(curlHtml.includes('<span class="hljs-title">curl</span>'));
  assert.ok(curlHtml.includes('<span class="hljs-attr">-X</span>'));
  assert.ok(curlHtml.includes('<span class="hljs-keyword">POST</span>'));
  assert.ok(curlHtml.includes('<span class="hljs-number">https://renderpdf.vberkoz.com/api/v1/render</span>'));
  assert.ok(curlHtml.includes('<span class="hljs-string">"Content-Type: application/json"</span>'));
  assert.ok(curlHtml.includes('<span class="hljs-comment">\\</span>'));
  assert.ok(curlHtml.includes('&lt;h1&gt;Hello from RenderPDF&lt;/h1&gt;'));
  assert.ok(!curlHtml.includes('<h1>'));
  assert.strictEqual(stripHighlightHtml(curlHtml), snippets.curl);

  const nodeHtml = keysModule.highlightQuickstartCode(snippets.node, 'node');
  assert.ok(nodeHtml.includes('<span class="hljs-comment">// Node.js 18+ (using native fetch)</span>'));
  assert.ok(nodeHtml.includes('<span class="hljs-keyword">const</span>'));
  assert.ok(nodeHtml.includes('<span class="hljs-keyword">await</span>'));
  assert.ok(nodeHtml.includes('<span class="hljs-title">fetch</span>'));
  assert.ok(nodeHtml.includes('<span class="hljs-title">json</span>'));
  assert.ok(nodeHtml.includes('<span class="hljs-attr">method</span>'));
  assert.ok(nodeHtml.includes('<span class="hljs-built_in">JSON</span>'));
  assert.ok(nodeHtml.includes('<span class="hljs-built_in">Error</span>'));
  assert.ok(nodeHtml.includes('<span class="hljs-built_in">console</span>'));
  assert.ok(nodeHtml.includes('<span class="hljs-string">`RenderPDF request failed: ${response.status}`</span>'));
  assert.ok(nodeHtml.includes('&lt;h1&gt;Hello from RenderPDF&lt;/h1&gt;'));
  assert.ok(!nodeHtml.includes('<h1>'));
  assert.strictEqual(stripHighlightHtml(nodeHtml), snippets.node);

  const pythonHtml = keysModule.highlightQuickstartCode(snippets.python, 'python');
  assert.ok(pythonHtml.includes('<span class="hljs-comment"># Python 3 with requests</span>'));
  assert.ok(pythonHtml.includes('<span class="hljs-keyword">import</span>'));
  assert.ok(pythonHtml.includes('<span class="hljs-keyword">f</span><span class="hljs-string">"RenderPDF request failed: {response.status_code}"</span>'));
  assert.ok(pythonHtml.includes('<span class="hljs-built_in">RuntimeError</span>'));
  assert.ok(pythonHtml.includes('<span class="hljs-built_in">print</span>'));
  assert.ok(pythonHtml.includes('<span class="hljs-title">post</span>'));
  assert.ok(pythonHtml.includes('&lt;h1&gt;Hello from RenderPDF&lt;/h1&gt;'));
  assert.ok(!pythonHtml.includes('<h1>'));
  assert.strictEqual(stripHighlightHtml(pythonHtml), snippets.python);

  const goHtml = keysModule.highlightQuickstartCode(snippets.go, 'go');
  assert.ok(goHtml.includes('<span class="hljs-keyword">package</span>'));
  assert.ok(goHtml.includes('<span class="hljs-built_in">main</span>'));
  assert.ok(goHtml.includes('<span class="hljs-keyword">map</span>[<span class="hljs-keyword">string</span>]<span class="hljs-keyword">any</span>'));
  assert.ok(goHtml.includes('<span class="hljs-built_in">http</span>'));
  assert.ok(goHtml.includes('<span class="hljs-title">NewRequest</span>'));
  assert.ok(goHtml.includes('<span class="hljs-number">200</span>'));
  assert.ok(goHtml.includes('<span class="hljs-number">300</span>'));
  assert.ok(goHtml.includes('&lt; <span class="hljs-number">200</span>'));
  assert.ok(goHtml.includes('&lt;h1&gt;Hello from RenderPDF&lt;/h1&gt;'));
  assert.ok(!goHtml.includes('<h1>'));
  assert.strictEqual(stripHighlightHtml(goHtml), snippets.go);
});

test('updateQuickstartCode preserves raw textContent and sets highlighted innerHTML', () => {
  const elements = {
    quickstartKeyValue: { textContent: '' },
    quickstartCodeCurl: { textContent: '', innerHTML: '' },
    quickstartCodeNode: { textContent: '', innerHTML: '' },
    quickstartCodePython: { textContent: '', innerHTML: '' },
    quickstartCodeGo: { textContent: '', innerHTML: '' },
  };
  global.document = {
    getElementById(id) {
      return elements[id] || null;
    },
  };

  keysModule.updateQuickstartCode('sk_live_demo_999');
  const snippets = keysModule.generateQuickstartSnippets('sk_live_demo_999');

  assert.strictEqual(elements.quickstartKeyValue.textContent, 'sk_live_demo_999');
  keysModule.quickstartLanguages.forEach(({ id, codeId }) => {
    assert.strictEqual(elements[codeId].textContent, snippets[id]);
    assert.strictEqual(
      elements[codeId].innerHTML,
      keysModule.highlightQuickstartCode(snippets[id], id)
    );
    assert.ok(elements[codeId].innerHTML.includes('<span class="hljs-'));
  });
});
