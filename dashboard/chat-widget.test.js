import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const widgetCode = fs.readFileSync(path.join(__dirname, 'chat-widget.js'), 'utf8');

class MockElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.id = '';
    this.className = '';
    this.attributes = new Map();
    this.style = {};
    this.children = [];
    this.parentNode = null;
    this._textContent = '';
    this._value = '';
    this.disabled = false;
    this.listeners = new Map();
  }

  get classList() {
    const self = this;
    return {
      add: (...classes) => {
        const set = new Set(self.className.split(' ').filter(Boolean));
        classes.forEach((c) => set.add(c));
        self.className = Array.from(set).join(' ');
      },
      remove: (...classes) => {
        const set = new Set(self.className.split(' ').filter(Boolean));
        classes.forEach((c) => set.delete(c));
        self.className = Array.from(set).join(' ');
      },
      contains: (c) => self.className.split(' ').filter(Boolean).includes(c),
      toggle: (c, force) => {
        if (force === true) {
          self.classList.add(c);
        } else if (force === false) {
          self.classList.remove(c);
        } else {
          if (self.classList.contains(c)) self.classList.remove(c);
          else self.classList.add(c);
        }
      }
    };
  }

  get textContent() {
    if (this.children.length > 0) {
      return this.children.map((c) => c.textContent).join('');
    }
    return this._textContent;
  }

  set textContent(val) {
    this.children = [];
    this._textContent = String(val);
  }

  get value() {
    return this._value;
  }

  set value(val) {
    this._value = String(val);
  }

  get innerHTML() {
    return this._innerHTML || this.textContent;
  }

  set innerHTML(html) {
    this._innerHTML = html;
    this.children = [];
    // Basic parser for child elements with id or class or tags
    const tagRegex = /<([a-zA-Z0-9]+)([^>]*)>([\s\S]*?)<\/\1>|<([a-zA-Z0-9]+)([^>]*)\/?>/g;
    let match;
    while ((match = tagRegex.exec(html)) !== null) {
      const tagName = match[1] || match[4];
      const attrsStr = match[2] || match[5] || '';
      const inner = match[3] || '';
      const child = new MockElement(tagName);

      const idMatch = attrsStr.match(/id=["']([^"']+)["']/);
      if (idMatch) child.id = idMatch[1];

      const classMatch = attrsStr.match(/class=["']([^"']+)["']/);
      if (classMatch) child.className = classMatch[1];

      const roleMatch = attrsStr.match(/role=["']([^"']+)["']/);
      if (roleMatch) child.setAttribute('role', roleMatch[1]);

      const questionMatch = attrsStr.match(/data-question=["']([^"']+)["']/);
      if (questionMatch) child.setAttribute('data-question', questionMatch[1]);

      if (/\bdisabled\b/.test(attrsStr)) {
        child.disabled = true;
        child.setAttribute('disabled', '');
      }

      child.innerHTML = inner;
      this.appendChild(child);
    }
  }

  setAttribute(name, val) {
    this.attributes.set(name, String(val));
    if (name === 'id') this.id = String(val);
    if (name === 'class') this.className = String(val);
  }

  getAttribute(name) {
    if (name === 'id') return this.id || null;
    if (name === 'class') return this.className || null;
    return this.attributes.get(name) || null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) {
        this.parentNode.children.splice(idx, 1);
      }
      this.parentNode = null;
    }
  }

  addEventListener(event, fn) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(fn);
  }

  dispatchEvent(event) {
    const list = this.listeners.get(event.type) || [];
    for (const fn of list) {
      fn(event);
    }
    return true;
  }

  click() {
    this.dispatchEvent({ type: 'click', preventDefault: () => {} });
  }

  focus() {}

  querySelectorAll(selector) {
    const results = [];
    function search(node) {
      for (const child of node.children) {
        let match = false;
        if (selector.startsWith('#') && child.id === selector.substring(1)) match = true;
        if (selector.startsWith('.') && child.classList.contains(selector.substring(1))) match = true;
        if (!selector.startsWith('#') && !selector.startsWith('.') && child.tagName.toLowerCase() === selector.toLowerCase()) match = true;
        if (match) results.push(child);
        search(child);
      }
    }
    search(this);
    return results;
  }

  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all.length ? all[0] : null;
  }
}

function createTestEnvironment(options = {}) {
  const elementsById = new Map();
  const allElements = [];

  const body = new MockElement('body');
  allElements.push(body);

  const document = {
    readyState: 'complete',
    body,
    createElement: (tag) => {
      const el = new MockElement(tag);
      allElements.push(el);
      return el;
    },
    getElementById: (id) => {
      function find(node) {
        if (node.id === id) return node;
        for (const child of node.children) {
          const res = find(child);
          if (res) return res;
        }
        return null;
      }
      return find(body);
    },
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    querySelector: (selector) => body.querySelector(selector),
    addEventListener: () => {}
  };

  const storage = new Map();
  const sessionStorage = {
    getItem: (k) => storage.get(k) || null,
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear()
  };

  const localStore = new Map();
  const localStorage = {
    getItem: (k) => localStore.get(k) || null,
    setItem: (k, v) => localStore.set(k, String(v)),
    removeItem: (k) => localStore.delete(k),
    clear: () => localStore.clear()
  };

  if (options.idToken) {
    localStorage.setItem('id_token', options.idToken);
  }

  const fetchCalls = [];
  const fetch = async (url, opts) => {
    fetchCalls.push({ url, options: opts });
    if (options.fetchHandler) {
      return options.fetchHandler(url, opts);
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        sessionId: 'test_session',
        reply: 'Hello from RenderPDF AI!',
        escalated: false,
        requiresEmail: false
      })
    };
  };

  const window = {
    document,
    location: {
      href: options.url || 'https://renderpdf.vberkoz.com/app/?view=overview',
      pathname: options.pathname || '/app/',
      protocol: 'https:',
      origin: 'https://renderpdf.vberkoz.com'
    },
    sessionStorage,
    localStorage,
    fetch,
    atob: (str) => Buffer.from(str, 'base64').toString('binary'),
    Event: class MockEvent {
      constructor(type) {
        this.type = type;
        this.defaultPrevented = false;
      }
      preventDefault() {
        this.defaultPrevented = true;
      }
    },
    currentBilling: options.currentBilling || null,
    setTimeout: (fn) => fn()
  };
  window.window = window;
  window.globalThis = window;

  const context = vm.createContext(window);
  vm.runInContext(widgetCode, context);

  return { window, document, fetchCalls, sessionStorage, localStorage };
}

test('chat-widget renders launcher button, trigger, and chat dialog window', () => {
  const { document } = createTestEnvironment();

  const trigger = document.getElementById('rpdf-chat-trigger');
  assert.ok(trigger, '#rpdf-chat-trigger must be attached to DOM');
  assert.strictEqual(trigger.getAttribute('aria-label'), 'Open support chat');
  assert.strictEqual(trigger.getAttribute('aria-expanded'), 'false');

  const win = document.getElementById('rpdf-chat-window');
  assert.ok(win, '#rpdf-chat-window must be attached to DOM');
  assert.strictEqual(win.getAttribute('role'), 'dialog');

  const messages = document.getElementById('rpdf-chat-messages');
  assert.ok(messages, '#rpdf-chat-messages container must exist');

  const input = document.getElementById('rpdf-chat-input');
  assert.ok(input, '#rpdf-chat-input textarea must exist');

  const sendBtn = document.getElementById('rpdf-chat-send');
  assert.ok(sendBtn, '#rpdf-chat-send button must exist');
  assert.strictEqual(sendBtn.disabled, true, 'Send button is disabled by default');
});

test('toggleChat opens and closes window via trigger, close button, and window API', () => {
  const { document, window } = createTestEnvironment();

  const trigger = document.getElementById('rpdf-chat-trigger');
  const win = document.getElementById('rpdf-chat-window');
  const closeBtn = document.getElementById('rpdf-chat-close');

  assert.strictEqual(win.classList.contains('is-open'), false);
  assert.strictEqual(trigger.getAttribute('aria-expanded'), 'false');

  // Open via trigger click
  trigger.click();
  assert.strictEqual(win.classList.contains('is-open'), true);
  assert.strictEqual(trigger.getAttribute('aria-expanded'), 'true');

  // Close via closeBtn
  closeBtn.click();
  assert.strictEqual(win.classList.contains('is-open'), false);
  assert.strictEqual(trigger.getAttribute('aria-expanded'), 'false');

  // Programmatic API
  window.RenderPDFChat.open();
  assert.strictEqual(win.classList.contains('is-open'), true);

  window.RenderPDFChat.close();
  assert.strictEqual(win.classList.contains('is-open'), false);

  window.RenderPDFChat.toggle();
  assert.strictEqual(win.classList.contains('is-open'), true);
});

test('extracts authenticated identity and billing tier into visitorContext', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: 'cognito-sub-1234',
    email: 'client@fintech.com'
  })).toString('base64url');
  const idToken = `${header}.${payload}.sig`;

  const { window } = createTestEnvironment({
    idToken,
    pathname: '/app/',
    currentBilling: { status: 'active', tier: 'starter' }
  });

  const ctx = window.RenderPDFChat.getContext();
  assert.strictEqual(ctx.email, 'client@fintech.com');
  assert.strictEqual(ctx.userId, 'cognito-sub-1234');
  assert.strictEqual(ctx.plan, 'starter');
  assert.strictEqual(ctx.source, 'dashboard');
});

test('persists session ID in sessionStorage', () => {
  const { window, sessionStorage } = createTestEnvironment();

  const sessionId = window.RenderPDFChat.getSessionId();
  assert.ok(sessionId.startsWith('cs_'), 'Session ID should have cs_ prefix');
  assert.strictEqual(sessionStorage.getItem('renderpdf_chat_session_id'), sessionId);

  const sessionId2 = window.RenderPDFChat.getSessionId();
  assert.strictEqual(sessionId, sessionId2, 'Subsequent calls preserve same session ID');
});

test('sends user message to API and handles markdown formatting in bot reply', async () => {
  let postedPayload = null;
  const { document, window, fetchCalls } = createTestEnvironment({
    fetchHandler: async (url, opts) => {
      postedPayload = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessionId: postedPayload.sessionId,
          reply: 'To set margins use `options.margin`: \n```json\n{"top": "20mm"}\n```\nSee **options** at [API](https://renderpdf.vberkoz.com/docs/api/).',
          escalated: false,
          requiresEmail: false
        })
      };
    }
  });

  const input = document.getElementById('rpdf-chat-input');
  const sendBtn = document.getElementById('rpdf-chat-send');

  input.value = 'How do I set top margin?';
  input.dispatchEvent(new window.Event('input'));
  assert.strictEqual(sendBtn.disabled, false);

  sendBtn.click();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.strictEqual(fetchCalls.length, 1);
  assert.strictEqual(postedPayload.message, 'How do I set top margin?');
  assert.strictEqual(fetchCalls[0].url, 'https://renderpdf.vberkoz.com/api/v1/chat');

  const messages = document.getElementById('rpdf-chat-messages');
  const lastBubble = messages.children[messages.children.length - 1].children[0];
  assert.ok(lastBubble.innerHTML.includes('<code>options.margin</code>'), 'Inline code must be rendered');
  assert.ok(lastBubble.innerHTML.includes('<pre><code>{&quot;top&quot;: &quot;20mm&quot;}</code></pre>'), 'Code blocks must be preserved with HTML escaping');
  assert.ok(lastBubble.innerHTML.includes('<strong>options</strong>'), 'Bold text must be rendered in strong tag');
  assert.ok(lastBubble.innerHTML.includes('<a href="https://renderpdf.vberkoz.com/docs/api/"'), 'Links must be rendered with href');
});

test('handles escalated conversation and shows inline email banner when requiresEmail is true', async () => {
  const { document, window } = createTestEnvironment({
    fetchHandler: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        sessionId: 'test_session',
        reply: 'We have escalated your inquiry to our engineering team.',
        escalated: true,
        requiresEmail: true
      })
    })
  });

  const input = document.getElementById('rpdf-chat-input');
  const sendBtn = document.getElementById('rpdf-chat-send');
  const statusText = document.getElementById('rpdf-header-status-text');
  const emailBanner = document.getElementById('rpdf-email-banner');
  const emailForm = document.getElementById('rpdf-email-form');
  const emailInput = document.getElementById('rpdf-email-input');

  input.value = 'We need a custom SLA for 100k PDFs/mo';
  input.dispatchEvent(new window.Event('input'));
  sendBtn.click();

  await new Promise((resolve) => setTimeout(resolve, 50));

  // Check header text changed to operator alert
  assert.strictEqual(statusText.textContent, 'Operator Alerted · Engineering team standby');

  // Check email banner displayed
  assert.strictEqual(emailBanner.style.display, 'flex');

  // Submit email through banner
  emailInput.value = 'cto@fintech.io';
  emailForm.dispatchEvent(new window.Event('submit'));

  assert.strictEqual(emailBanner.style.display, 'none');
  assert.strictEqual(window.sessionStorage.getItem('renderpdf_chat_email'), 'cto@fintech.io');
});
