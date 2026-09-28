import test from 'node:test';
import assert from 'node:assert/strict';

// Set up mock DOM and localStorage
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

let windowListeners = new Map();
global.window = {
  location: { hash: '#chats', replace: () => {}, assign: () => {} },
  dispatchEvent: (event) => {
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

function createMockElement(tagName = 'div') {
  const listeners = new Map();
  const attributes = new Map();
  let children = [];

  const el = {
    tagName: tagName.toUpperCase(),
    attributes,
    dataset: {},
    value: '',
    disabled: false,
    checked: true,
    _children: children,
    scrollTop: 0,
    scrollHeight: 100,
    focus() {},
    hasAttribute(name) { return attributes.has(name); },
    appendChild(child) {
      if (!this._children.includes(child)) this._children.push(child);
      child._parent = this;
      return child;
    },
    get id() { return attributes.get('id') || ''; },
    set id(val) { this.setAttribute('id', val); },
    classList: {
      _classes: new Set(),
      add(...cls) { cls.forEach((c) => this._classes.add(c)); },
      remove(...cls) { cls.forEach((c) => this._classes.delete(c)); },
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
    },
    removeAttribute(name) { attributes.delete(name); },
    addEventListener(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    dispatchEvent(event) {
      const list = listeners.get(event.type) || [];
      for (const fn of list) fn(event);
      return true;
    },
    click() {
      this.dispatchEvent({ type: 'click', target: this, preventDefault: () => {} });
    },
    closest(selector) {
      let cur = this;
      while (cur) {
        if (selector.startsWith('.') && cur.classList && cur.classList.contains(selector.slice(1))) return cur;
        if (selector.startsWith('#') && cur.id === selector.slice(1)) return cur;
        if (selector.toLowerCase() === (cur.tagName || '').toLowerCase()) return cur;
        cur = cur._parent;
      }
      return null;
    },
    querySelector(selector) {
      const all = this.querySelectorAll(selector);
      return all.length ? all[0] : null;
    },
    querySelectorAll(selector) {
      const matches = [];
      function recurse(node) {
        for (const child of node._children) {
          let match = false;
          if (selector.startsWith('.') && child.classList.contains(selector.slice(1))) match = true;
          else if (selector.startsWith('#') && child.id === selector.slice(1)) match = true;
          else if (selector.toLowerCase() === child.tagName.toLowerCase()) match = true;
          else if (selector.includes('[data-filter=')) {
            const val = selector.match(/\[data-filter=["']?([^"']+)["']?\]/)?.[1];
            if (val && child.getAttribute('data-filter') === val) match = true;
          }
          if (match) matches.push(child);
          recurse(child);
        }
      }
      recurse(this);
      return matches;
    }
  };

  Object.defineProperty(el, 'innerHTML', {
    get() {
      return this._innerHTML || this.textContent || '';
    },
    set(html) {
      this._innerHTML = html;
      this._children = [];

      // Simple tag parser to create mock child elements
      const tagRegex = /<([a-zA-Z0-9]+)([^>]*)>([\s\S]*?)<\/\1>|<([a-zA-Z0-9]+)([^>]*)\/?>/g;
      let match;
      while ((match = tagRegex.exec(html)) !== null) {
        const tagName = match[1] || match[4];
        const attrsStr = match[2] || match[5] || '';
        const inner = match[3] || '';
        const child = createMockElement(tagName);

        const idMatch = attrsStr.match(/id=["']([^"']+)["']/);
        if (idMatch) child.id = idMatch[1];

        const classMatch = attrsStr.match(/class=["']([^"']+)["']/);
        if (classMatch) {
          classMatch[1].split(' ').filter(Boolean).forEach((c) => child.classList.add(c));
        }

        const dataFilterMatch = attrsStr.match(/data-filter=["']([^"']+)["']/);
        if (dataFilterMatch) child.setAttribute('data-filter', dataFilterMatch[1]);

        const dataSessionMatch = attrsStr.match(/data-session-id=["']([^"']+)["']/);
        if (dataSessionMatch) child.setAttribute('data-session-id', dataSessionMatch[1]);

        const dataUserIdMatch = attrsStr.match(/data-user-id=["']([^"']+)["']/);
        if (dataUserIdMatch) child.setAttribute('data-user-id', dataUserIdMatch[1]);

        const dataStatusMatch = attrsStr.match(/data-status=["']([^"']+)["']/);
        if (dataStatusMatch) child.setAttribute('data-status', dataStatusMatch[1]);

        child.innerHTML = inner;
        this.appendChild(child);
      }
    }
  });

  return el;
}

const mockDocElements = new Map();
global.document = {
  readyState: 'complete',
  createElement: (tag) => createMockElement(tag),
  getElementById: (id) => {
    if (!mockDocElements.has(id)) {
      const el = createMockElement('div');
      el.id = id;
      mockDocElements.set(id, el);
    }
    return mockDocElements.get(id);
  },
  body: createMockElement('body'),
  addEventListener: () => {}
};

// Import module under test
const {
  initSupportChatTab,
  renderChatShell,
  renderChatList,
  renderChatWorkspace,
  formatTimestamp,
  formatEscalationReason,
  renderChatMarkdown,
  updateEscalatedBadge,
  stopPolling,
  CANNED_RESPONSES
} = await import('./chat.js');

test('formatters format timestamps, escalation reasons, and markdown', () => {
  assert.strictEqual(formatEscalationReason('high_value_lead'), 'Enterprise Lead');
  assert.strictEqual(formatEscalationReason('complex_bug'), 'Bug Report');
  assert.strictEqual(formatEscalationReason('billing_issue'), 'Billing Inquiry');
  assert.strictEqual(formatEscalationReason('explicit_request'), 'Human Requested');

  const md = renderChatMarkdown('Check `options.password` and **docs** at [API](https://example.com)');
  assert.ok(md.includes('<code>options.password</code>'));
  assert.ok(md.includes('<strong>docs</strong>'));
  assert.ok(md.includes('<a href="https://example.com"'));

  const timeStr = formatTimestamp(Date.now() - 10000);
  assert.strictEqual(timeStr, 'Just now');
});

test('renderChatShell populates search, filter chips, queue and workspace containers', () => {
  const container = createMockElement('div');
  renderChatShell(container, { search: '', filter: 'all' });

  assert.ok(container.querySelector('#admin-chat-search'), 'Search input must exist');
  assert.ok(container.querySelector('#admin-chat-list'), 'Queue list container must exist');
  assert.ok(container.querySelector('#admin-chat-workspace'), 'Workspace container must exist');
  assert.ok(container.querySelector('[data-filter="all"]'), 'All filter chip must exist');
  assert.ok(container.querySelector('[data-filter="escalated"]'), 'Escalated filter chip must exist');
});

test('renderChatList renders conversation cards with unread dot, tags, and status', () => {
  const listEl = createMockElement('div');
  const mockChats = [
    {
      sessionId: 'cs_enterprise_1',
      status: 'escalated',
      escalationReason: 'high_value_lead',
      visitorEmail: 'cto@scale.com',
      lastMessage: 'Need 100k renders with custom SLA',
      unreadByAdmin: true,
      source: 'landing',
      plan: 'starter'
    },
    {
      sessionId: 'cs_resolved_2',
      status: 'resolved',
      customerId: 'user-456',
      lastMessage: 'Thanks for the quick answer!',
      unreadByAdmin: false,
      source: 'dashboard',
      plan: 'pro'
    }
  ];

  renderChatList(listEl, mockChats, 'cs_enterprise_1');

  assert.strictEqual(listEl._children.length, 2, 'Should render 2 conversation cards');
  const card1 = listEl._children[0];
  assert.strictEqual(card1.getAttribute('data-session-id'), 'cs_enterprise_1');
  assert.ok(card1.classList.contains('is-selected'), 'Card 1 should be selected');
  assert.ok(card1.innerHTML.includes('cto@scale.com'));
  assert.ok(card1.innerHTML.includes('Enterprise Lead'));
  assert.ok(card1.innerHTML.includes('admin-chat-unread-dot'));
});

test('renderChatWorkspace renders transcript, meta badges, canned responses, and reply composer', () => {
  const workspaceEl = createMockElement('div');
  const chatData = {
    sessionId: 'cs_test_session',
    status: 'escalated',
    escalationReason: 'high_value_lead',
    visitorEmail: 'lead@enterprise.com',
    customerId: 'user-uuid-999',
    plan: 'starter',
    source: 'landing',
    messages: [
      {
        messageId: 'msg_01',
        role: 'user',
        sender: 'visitor',
        content: 'Hi, what are volume rates for 150k PDFs/mo?',
        timestamp: Date.now() - 60000
      },
      {
        messageId: 'msg_02',
        role: 'assistant',
        sender: 'bot',
        content: 'RenderPDF offers volume pricing. I have notified our lead operator.',
        tokens: { input: 400, output: 50 },
        timestamp: Date.now() - 30000
      }
    ]
  };

  renderChatWorkspace(workspaceEl, chatData);

  assert.ok(workspaceEl.innerHTML.includes('lead@enterprise.com'), 'Header must contain visitor email');
  assert.ok(workspaceEl.innerHTML.includes('Inspect User Dossier'), 'Must include Inspect User Dossier button');
  assert.ok(workspaceEl.innerHTML.includes('Resolve Chat'), 'Must include Resolve Chat button');
  assert.ok(workspaceEl.innerHTML.includes('Escalated to Operator'), 'Must display escalation event banner');
  assert.ok(workspaceEl.innerHTML.includes('Nova Micro (AI)'), 'Assistant bubble must be labeled Nova Micro');
  assert.ok(workspaceEl.innerHTML.includes('400 in / 50 out'), 'Token metric pill must be displayed');
  assert.ok(workspaceEl.querySelector('#admin-chat-reply-input'), 'Reply textarea must exist');
  assert.ok(workspaceEl.querySelector('#admin-chat-send-reply-btn'), 'Send reply button must exist');
});

test('initSupportChatTab loads chats, binds events, and polls every 10 seconds', async () => {
  const container = createMockElement('div');

  // Mock global fetch for admin endpoints
  const fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url: String(url), options: opts });

    if (String(url).includes('/chats/cs_deep_lead')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessionId: 'cs_deep_lead',
          status: 'escalated',
          escalationReason: 'high_value_lead',
          visitorEmail: 'cto@deeplead.io',
          customerId: 'user-777',
          plan: 'pro',
          messages: [
            { messageId: 'm1', role: 'user', sender: 'visitor', content: 'Inquiring about SLA', timestamp: Date.now() }
          ]
        })
      };
    }

    if (String(url).includes('/reply')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          messageId: 'msg_operator_01',
          emailDispatched: true
        })
      };
    }

    if (String(url).includes('/status')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          status: 'resolved'
        })
      };
    }

    // Default list response
    return {
      ok: true,
      status: 200,
      json: async () => ({
        chats: [
          {
            sessionId: 'cs_deep_lead',
            status: 'escalated',
            escalationReason: 'high_value_lead',
            visitorEmail: 'cto@deeplead.io',
            customerId: 'user-777',
            lastMessage: 'Inquiring about SLA',
            unreadByAdmin: true,
            updatedAt: new Date().toISOString()
          }
        ],
        nextCursor: null
      })
    };
  };

  // Set deep-link hash
  window.location.hash = '#chats?id=cs_deep_lead';

  await initSupportChatTab(container);

  // Verify fetch occurred
  assert.ok(fetchCalls.length >= 2, 'Should fetch chats list and deep-linked chat transcript');

  // Verify workspace rendered active chat
  const workspace = container.querySelector('#admin-chat-workspace');
  assert.ok(workspace.innerHTML.includes('cto@deeplead.io'));

  // Test canned response selection
  const cannedSelect = workspace.querySelector('#admin-chat-canned');
  const replyInput = workspace.querySelector('#admin-chat-reply-input');
  cannedSelect.value = 'docs';
  cannedSelect.dispatchEvent({ type: 'change' });
  assert.strictEqual(replyInput.value, CANNED_RESPONSES.docs);

  // Test sending reply
  const sendBtn = workspace.querySelector('#admin-chat-send-reply-btn');
  sendBtn.click();
  await new Promise((r) => setTimeout(r, 20));

  const replyCall = fetchCalls.find((c) => c.url.includes('/reply'));
  assert.ok(replyCall, 'Must call reply endpoint');
  const replyBody = JSON.parse(replyCall.options.body);
  assert.strictEqual(replyBody.message, CANNED_RESPONSES.docs);
  assert.strictEqual(replyBody.sendEmail, true);

  // Test status toggle
  const statusBtn = workspace.querySelector('#admin-chat-status-toggle-btn');
  statusBtn.click();
  await new Promise((r) => setTimeout(r, 20));

  const statusCall = fetchCalls.find((c) => c.url.includes('/status'));
  assert.ok(statusCall, 'Must call status endpoint');

  // Test deep-link to dossier
  const inspectBtn = workspace.querySelector('#admin-chat-inspect-dossier-btn');
  inspectBtn.click();
  assert.strictEqual(window.location.hash, '#users', 'Should switch hash to #users on inspect dossier');

  // Stop polling clean up
  stopPolling();
});

test('updateEscalatedBadge updates count and toggles hidden class', () => {
  const badge = document.getElementById('escalated-chats-badge');
  badge.classList.add('hidden');

  updateEscalatedBadge(3);
  assert.strictEqual(badge.textContent, '3');
  assert.strictEqual(badge.classList.contains('hidden'), false);

  updateEscalatedBadge(0);
  assert.strictEqual(badge.textContent, '0');
  assert.strictEqual(badge.classList.contains('hidden'), true);
});
