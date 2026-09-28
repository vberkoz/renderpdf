/**
 * RenderPDF AI Support Chat Widget
 * Lightweight (~6 KB), zero external dependencies vanilla JavaScript client.
 */
(function() {
  'use strict';

  // Prevent multiple initializations
  if (window.__RENDERPDF_CHAT_INITIALIZED__) return;
  window.__RENDERPDF_CHAT_INITIALIZED__ = true;

  const SESSION_KEY = 'renderpdf_chat_session_id';
  const HISTORY_KEY = 'renderpdf_chat_history';
  const EMAIL_KEY = 'renderpdf_chat_email';

  // Determine API endpoint
  const apiOrigin = window.location.protocol === 'file:'
    ? 'https://renderpdf.vberkoz.com'
    : (window.location.origin || '');
  const API_ENDPOINT = window.RENDERPDF_CHAT_ENDPOINT || (apiOrigin + '/api/v1/chat');

  // Session Management
  function getOrCreateSessionId() {
    try {
      let sessionId = sessionStorage.getItem(SESSION_KEY);
      if (!sessionId) {
        sessionId = 'cs_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
        sessionStorage.setItem(SESSION_KEY, sessionId);
      }
      return sessionId;
    } catch {
      return 'cs_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
    }
  }

  // Identity & Visitor Context Extraction
  function getVisitorContext() {
    const isDashboard = window.location.pathname.startsWith('/app');
    const context = {
      url: window.location.href,
      source: isDashboard ? 'dashboard' : 'landing'
    };

    // Extract Cognito JWT credentials if on dashboard or previously signed in
    try {
      const idToken = localStorage.getItem('id_token');
      if (idToken) {
        const parts = idToken.split('.');
        if (parts.length === 3) {
          const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
          const payload = JSON.parse(decodeURIComponent(atob(base64).split('').map(function(c) {
            return '%' + c.charCodeAt(0).toString(16).padStart(2, '0');
          }).join('')));
          if (payload.email) context.email = payload.email;
          if (payload.sub) context.userId = payload.sub;
        }
      }
    } catch {
      // Continue without token payload
    }

    // Fallback to email collected in chat if unauthenticated
    if (!context.email) {
      try {
        const savedEmail = sessionStorage.getItem(EMAIL_KEY);
        if (savedEmail) context.email = savedEmail;
      } catch {
        // continue
      }
    }

    // Determine subscription tier
    try {
      if (window.currentBilling && (window.currentBilling.tier || window.currentBilling.plan)) {
        context.plan = window.currentBilling.tier || window.currentBilling.plan;
      } else if (context.email) {
        context.plan = 'free';
      } else {
        context.plan = 'anonymous';
      }
    } catch {
      context.plan = 'anonymous';
    }

    return context;
  }

  // Safe HTML Escaping & Markdown Parser
  function escapeHTML(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function renderMarkdown(text) {
    if (!text) return '';
    const safeText = escapeHTML(text);

    // Placeholder storage for code blocks to protect them from inline parsing
    const codeBlocks = [];
    let formatted = safeText.replace(/```(?:[a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g, function(_, code) {
      const id = '___CODEBLOCK_' + codeBlocks.length + '___';
      codeBlocks.push('<pre><code>' + code.trim() + '</code></pre>');
      return id;
    });

    // Inline code
    formatted = formatted.replace(/`([^`\n]+)`/g, '<code>$1</code>');

    // Bold text (**text**)
    formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Links [text](https://...)
    formatted = formatted.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // Bullet lists
    formatted = formatted.replace(/(?:^|\n)[*-]\s+(.+)/g, '<br>&bull; $1');

    // Newlines to <br>
    formatted = formatted.replace(/\n/g, '<br>');

    // Restore code blocks
    codeBlocks.forEach(function(block, index) {
      formatted = formatted.replace('___CODEBLOCK_' + index + '___', block);
    });

    return formatted;
  }

  function formatTime(date) {
    const d = date ? new Date(date) : new Date();
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Widget DOM Construction
  function buildWidget() {
    // 1. Floating Trigger Button
    const trigger = document.createElement('button');
    trigger.id = 'rpdf-chat-trigger';
    trigger.type = 'button';
    trigger.setAttribute('aria-label', 'Open support chat');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.innerHTML = `
      <span class="rpdf-pulse-dot" aria-hidden="true"></span>
      <span class="rpdf-trigger-tooltip">Chat with AI Support</span>
      <span class="rpdf-trigger-icon rpdf-icon-chat" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
      </span>
      <span class="rpdf-trigger-icon rpdf-icon-close" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </span>
    `;

    // 2. Chat Window Container
    const win = document.createElement('div');
    win.id = 'rpdf-chat-window';
    win.setAttribute('role', 'dialog');
    win.setAttribute('aria-label', 'Support Chat');
    win.innerHTML = `
      <header class="rpdf-chat-header">
        <div class="rpdf-header-info">
          <div class="rpdf-header-avatar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="4"></rect>
              <path d="M7 8h10M7 12h10M7 16h6"></path>
            </svg>
            <span class="rpdf-avatar-status" aria-hidden="true"></span>
          </div>
          <div class="rpdf-header-text">
            <span class="rpdf-header-title">RenderPDF Support</span>
            <span id="rpdf-header-status-text" class="rpdf-header-status">AI Support &middot; Usually replies in 1s</span>
          </div>
        </div>
        <button id="rpdf-chat-close" class="rpdf-chat-close-btn" type="button" aria-label="Close support chat">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </header>

      <div id="rpdf-chat-messages" class="rpdf-chat-messages" aria-live="polite"></div>

      <div id="rpdf-email-banner" class="rpdf-email-banner" style="display: none;">
        <span class="rpdf-email-banner-text">Leave your email so our engineering team can follow up with you:</span>
        <form id="rpdf-email-form" class="rpdf-email-form">
          <input id="rpdf-email-input" class="rpdf-email-input" type="email" placeholder="you@company.com" required>
          <button class="rpdf-email-submit" type="submit">Submit</button>
        </form>
      </div>

      <div class="rpdf-suggestions" aria-label="Suggested quick questions">
        <button class="rpdf-chip" type="button" data-question="What are your starter plan limits and pricing?">Pricing</button>
        <button class="rpdf-chip" type="button" data-question="How do I authenticate with the API?">API Docs</button>
        <button class="rpdf-chip" type="button" data-question="Can you give me a curl code example to render a PDF?">Code Example</button>
        <button class="rpdf-chip" type="button" data-question="How do I configure page headers, footers, and margins?">Custom Margins</button>
      </div>

      <footer class="rpdf-chat-composer">
        <div class="rpdf-composer-row">
          <textarea id="rpdf-chat-input" class="rpdf-composer-input" rows="1" placeholder="Ask about API, pricing, formats..." aria-label="Your message"></textarea>
          <button id="rpdf-chat-send" class="rpdf-send-btn" type="button" aria-label="Send message" disabled>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
          </button>
        </div>
        <div class="rpdf-composer-footer">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path>
          </svg>
          <span>Powered by AWS Bedrock AI</span>
        </div>
      </footer>
    `;

    document.body.appendChild(trigger);
    document.body.appendChild(win);

    return { trigger, win };
  }

  // Controller
  function initChat() {
    const { trigger, win } = buildWidget();
    const messagesEl = document.getElementById('rpdf-chat-messages');
    const inputEl = document.getElementById('rpdf-chat-input');
    const sendBtn = document.getElementById('rpdf-chat-send');
    const closeBtn = document.getElementById('rpdf-chat-close');
    const statusTextEl = document.getElementById('rpdf-header-status-text');
    const emailBannerEl = document.getElementById('rpdf-email-banner');
    const emailFormEl = document.getElementById('rpdf-email-form');
    const emailInputEl = document.getElementById('rpdf-email-input');

    let isSending = false;
    let messages = [];

    // Load persisted history
    try {
      const stored = sessionStorage.getItem(HISTORY_KEY);
      if (stored) {
        messages = JSON.parse(stored);
      }
    } catch {
      messages = [];
    }

    // Initial greeting if history is empty
    if (!messages.length) {
      messages.push({
        role: 'assistant',
        text: "Hi there! 👋 I'm RenderPDF's AI assistant. Ask me anything about HTML-to-PDF rendering, paper options, pricing, or API integration!",
        time: formatTime()
      });
      saveHistory();
    }

    renderAllMessages();

    // Toggle Chat Window
    function toggleChat(forceOpen) {
      const willOpen = typeof forceOpen === 'boolean' ? forceOpen : !win.classList.contains('is-open');
      if (willOpen) {
        win.classList.add('is-open');
        trigger.classList.add('is-open');
        trigger.setAttribute('aria-expanded', 'true');
        scrollToBottom();
        setTimeout(function() {
          inputEl.focus();
        }, 150);
      } else {
        win.classList.remove('is-open');
        trigger.classList.remove('is-open');
        trigger.setAttribute('aria-expanded', 'false');
      }
    }

    trigger.addEventListener('click', function() {
      toggleChat();
    });

    closeBtn.addEventListener('click', function() {
      toggleChat(false);
    });

    // Suggestion chips
    win.querySelectorAll('.rpdf-chip').forEach(function(chip) {
      chip.addEventListener('click', function() {
        const question = chip.getAttribute('data-question');
        if (question && !isSending) {
          sendMessage(question);
        }
      });
    });

    // Auto-grow textarea & button enablement
    inputEl.addEventListener('input', function() {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.max(32, Math.min(inputEl.scrollHeight, 90)) + 'px';
      sendBtn.disabled = !inputEl.value.trim() || isSending;
    });

    // Enter to submit (Shift+Enter for newline)
    inputEl.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!sendBtn.disabled) {
          sendFromInput();
        }
      }
    });

    sendBtn.addEventListener('click', function() {
      sendFromInput();
    });

    function sendFromInput() {
      const text = inputEl.value.trim();
      if (!text || isSending) return;
      inputEl.value = '';
      inputEl.style.height = '32px';
      sendBtn.disabled = true;
      sendMessage(text);
    }

    // Email Banner Submission
    if (emailFormEl) {
      emailFormEl.addEventListener('submit', function(e) {
        e.preventDefault();
        const email = emailInputEl.value.trim();
        if (!email) return;

        try {
          sessionStorage.setItem(EMAIL_KEY, email);
        } catch {}

        emailBannerEl.style.display = 'none';
        sendMessage('My email is ' + email);
      });
    }

    function saveHistory() {
      try {
        sessionStorage.setItem(HISTORY_KEY, JSON.stringify(messages.slice(-30)));
      } catch {}
    }

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function appendMessageDOM(msg) {
      const isBot = msg.role === 'assistant';
      const msgDiv = document.createElement('div');
      msgDiv.className = 'rpdf-message ' + (isBot ? 'rpdf-message-bot' : 'rpdf-message-user');

      const bubbleDiv = document.createElement('div');
      bubbleDiv.className = 'rpdf-bubble';

      if (isBot) {
        bubbleDiv.innerHTML = renderMarkdown(msg.text);
      } else {
        bubbleDiv.textContent = msg.text;
      }

      const timeDiv = document.createElement('div');
      timeDiv.className = 'rpdf-message-time';
      timeDiv.textContent = msg.time || formatTime();

      msgDiv.appendChild(bubbleDiv);
      msgDiv.appendChild(timeDiv);
      messagesEl.appendChild(msgDiv);
    }

    function renderAllMessages() {
      messagesEl.innerHTML = '';
      messages.forEach(function(msg) {
        appendMessageDOM(msg);
      });
      scrollToBottom();
    }

    function showTypingIndicator() {
      const existing = document.getElementById('rpdf-typing-indicator');
      if (existing) return;

      const ind = document.createElement('div');
      ind.id = 'rpdf-typing-indicator';
      ind.className = 'rpdf-typing-indicator';
      ind.setAttribute('aria-label', 'AI is typing');
      ind.innerHTML = `
        <span class="rpdf-typing-dot"></span>
        <span class="rpdf-typing-dot"></span>
        <span class="rpdf-typing-dot"></span>
      `;
      messagesEl.appendChild(ind);
      scrollToBottom();
    }

    function hideTypingIndicator() {
      const ind = document.getElementById('rpdf-typing-indicator');
      if (ind) ind.remove();
    }

    // Core Send Message
    async function sendMessage(text) {
      if (isSending) return;
      isSending = true;
      sendBtn.disabled = true;

      // Append user message
      const userMsg = {
        role: 'user',
        text: text,
        time: formatTime()
      };
      messages.push(userMsg);
      saveHistory();
      appendMessageDOM(userMsg);
      scrollToBottom();
      showTypingIndicator();

      const sessionId = getOrCreateSessionId();
      const visitorContext = getVisitorContext();

      try {
        const response = await fetch(API_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            sessionId: sessionId,
            message: text,
            visitorContext: visitorContext
          })
        });

        hideTypingIndicator();

        if (!response.ok) {
          throw new Error('Server responded with HTTP ' + response.status);
        }

        const data = await response.json();
        const replyText = data.reply || 'Thanks for reaching out! A team member will follow up shortly.';

        const botMsg = {
          role: 'assistant',
          text: replyText,
          time: formatTime()
        };
        messages.push(botMsg);
        saveHistory();
        appendMessageDOM(botMsg);

        // Escalation handling
        if (data.escalated) {
          statusTextEl.textContent = 'Operator Alerted · Engineering team standby';
          statusTextEl.style.color = '#34d399';
        }

        // Email collection banner handling
        if (data.requiresEmail && !visitorContext.email) {
          emailBannerEl.style.display = 'flex';
          emailInputEl.focus();
        }

      } catch (err) {
        hideTypingIndicator();
        const errorMsg = {
          role: 'assistant',
          text: "I couldn't reach the support service right now. Please check your connection or email our team at **support@renderpdf.com**.",
          time: formatTime()
        };
        messages.push(errorMsg);
        saveHistory();
        appendMessageDOM(errorMsg);
      } finally {
        isSending = false;
        sendBtn.disabled = !inputEl.value.trim();
        scrollToBottom();
      }
    }

    // Expose programmatic API on window
    window.RenderPDFChat = {
      open: function() { toggleChat(true); },
      close: function() { toggleChat(false); },
      toggle: function() { toggleChat(); },
      sendMessage: function(msg) {
        toggleChat(true);
        sendMessage(msg);
      },
      getSessionId: getOrCreateSessionId,
      getContext: getVisitorContext
    };
  }

  // Initialize once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChat);
  } else {
    initChat();
  }
})();
