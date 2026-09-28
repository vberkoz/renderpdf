/**
 * RenderPDF Admin Support Chat & Live Inbox Module (Route: /admin#chats)
 * Zero-dependency client interface for reviewing visitor conversations,
 * inspecting customer dossiers, and sending operator replies with SES dispatch.
 */

import { adminFetch } from '../../shared/api.js';
import { showToast } from '../../shared/ui.js';

let activePollTimer = null;

// Canned response snippets for quick operator replies
export const CANNED_RESPONSES = {
  docs: 'You can explore our full API documentation, parameter references, and language examples at https://renderpdf.vberkoz.com/docs/api/.',
  enterprise: 'RenderPDF offers dedicated enterprise concurrency, 99.99% custom SLA terms, and tailored volume pricing for scale exceeding 50,000 PDFs/month. Would you like to schedule a quick call, or should I email our enterprise agreement details?',
  margins: 'You can configure page margins and formats in your render request payload:\n```json\n{\n  "source": { "type": "html", "html": "..." },\n  "options": {\n    "format": "A4",\n    "margin": { "top": "20mm", "bottom": "20mm", "left": "15mm", "right": "15mm" },\n    "printBackground": true\n  }\n}\n```',
  security: 'RenderPDF supports AES-256 PDF encryption. You can set `options.password` for the open password, `options.ownerPassword` for administrative access, and `options.permissions` to "print", "all", or "none" to restrict printing and copying.',
  investigating: 'Thank you for reporting this issue. Our engineering team has received the transcript and is investigating the rendering logs. We will follow up shortly.'
};

/**
 * Escapes HTML characters to prevent XSS.
 * @param {string|number} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Lightweight safe markdown parser for transcript display.
 * @param {string} text
 * @returns {string}
 */
export function renderChatMarkdown(text) {
  if (!text) return '';
  const safeText = escapeHtml(text);

  const codeBlocks = [];
  let formatted = safeText.replace(/```(?:[a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g, function(_, code) {
    const id = '___CODEBLOCK_' + codeBlocks.length + '___';
    codeBlocks.push('<pre><code>' + code.trim() + '</code></pre>');
    return id;
  });

  formatted = formatted.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  formatted = formatted.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  formatted = formatted.replace(/(?:^|\n)[*-]\s+(.+)/g, '<br>&bull; $1');
  formatted = formatted.replace(/\n/g, '<br>');

  codeBlocks.forEach(function(block, index) {
    formatted = formatted.replace('___CODEBLOCK_' + index + '___', block);
  });

  return formatted;
}

/**
 * Formats a timestamp into human-readable relative time or short date.
 * @param {string|number} val
 * @returns {string}
 */
export function formatTimestamp(val) {
  if (!val) return '—';
  try {
    const d = typeof val === 'number' ? new Date(val > 1e11 ? val : val * 1000) : new Date(val);
    if (isNaN(d.getTime())) return String(val);

    const now = Date.now();
    const diffMs = now - d.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHours = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSec < 60) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch {
    return String(val);
  }
}

/**
 * Formats escalation reason key into a human-friendly label.
 * @param {string} reason
 * @returns {string}
 */
export function formatEscalationReason(reason) {
  switch (reason) {
    case 'high_value_lead': return 'Enterprise Lead';
    case 'complex_bug': return 'Bug Report';
    case 'billing_issue': return 'Billing Inquiry';
    case 'explicit_request': return 'Human Requested';
    default: return reason ? reason.replace(/_/g, ' ') : 'Escalated';
  }
}

/**
 * Fetches chats list from the admin backend API.
 * @param {object} params
 * @returns {Promise<{ chats: Array, nextCursor: string|null }>}
 */
export async function fetchChats({ status = 'all', limit = 50, cursor = null } = {}) {
  const params = new URLSearchParams();
  if (status && status !== 'all') params.set('status', status);
  if (limit) params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);

  const qs = params.toString();
  const endpoint = qs ? `/admin/chats?${qs}` : '/admin/chats';
  return await adminFetch(endpoint);
}

/**
 * Fetches transcript and metadata for a specific chat session.
 * @param {string} sessionId
 * @returns {Promise<object>}
 */
export async function fetchChatTranscript(sessionId) {
  return await adminFetch(`/admin/chats/${encodeURIComponent(sessionId)}`);
}

/**
 * Posts an operator reply to the conversation.
 * @param {string} sessionId
 * @param {object} param1
 * @returns {Promise<object>}
 */
export async function sendOperatorReply(sessionId, { message, sendEmail = true }) {
  return await adminFetch(`/admin/chats/${encodeURIComponent(sessionId)}/reply`, {
    method: 'POST',
    body: JSON.stringify({ message, sendEmail })
  });
}

/**
 * Updates the chat session status (e.g. 'resolved' or 'active').
 * @param {string} sessionId
 * @param {string} status
 * @returns {Promise<object>}
 */
export async function updateChatStatus(sessionId, status) {
  return await adminFetch(`/admin/chats/${encodeURIComponent(sessionId)}/status`, {
    method: 'POST',
    body: JSON.stringify({ status })
  });
}

/**
 * Stops any active polling timers.
 */
export function stopPolling() {
  if (activePollTimer) {
    clearInterval(activePollTimer);
    activePollTimer = null;
  }
}

/**
 * Updates the escalated chats count badge in the navigation tab.
 * @param {number} count
 */
export function updateEscalatedBadge(count) {
  const badge = document.getElementById('escalated-chats-badge');
  if (!badge) return;

  if (count > 0) {
    badge.textContent = String(count);
    badge.classList.remove('hidden');
  } else {
    badge.textContent = '0';
    badge.classList.add('hidden');
  }
}

/**
 * Renders the primary Tab 5 shell container into the provided DOM node.
 * @param {HTMLElement} container
 * @param {object} state
 */
export function renderChatShell(container, state) {
  container.innerHTML = `
    <div class="admin-view-header">
      <div class="admin-view-title-group">
        <h2>Live Support Chat &amp; Operator Inbox</h2>
        <p class="admin-subtitle">Monitor customer inquiries, triage automated Bedrock escalations, and reply directly with optional SES email delivery.</p>
      </div>
    </div>

    <div class="admin-chat-inbox">
      <!-- Left Column: Conversation Queue -->
      <section class="admin-chat-queue" aria-label="Conversation list">
        <header class="admin-chat-queue-header">
          <div class="admin-chat-queue-title-row">
            <h3 class="admin-chat-queue-title">
              <span>Conversations</span>
              <span id="admin-chat-total-count" class="admin-audit-stat-pill">0</span>
            </h3>
          </div>
          <input
            type="search"
            id="admin-chat-search"
            class="admin-chat-search-input"
            placeholder="Search email, ID, message..."
            aria-label="Search conversations"
            value="${escapeHtml(state.search)}"
          >
          <div class="admin-chat-filters" role="group" aria-label="Filter conversations by status">
            <button type="button" class="admin-chat-filter-chip ${state.filter === 'all' ? 'is-active' : ''}" data-filter="all">All</button>
            <button type="button" class="admin-chat-filter-chip ${state.filter === 'escalated' ? 'is-active' : ''}" data-filter="escalated">
              Escalated <span id="admin-chat-filter-escalated-count" class="admin-badge-count hidden">0</span>
            </button>
            <button type="button" class="admin-chat-filter-chip ${state.filter === 'active' ? 'is-active' : ''}" data-filter="active">Active</button>
            <button type="button" class="admin-chat-filter-chip ${state.filter === 'resolved' ? 'is-active' : ''}" data-filter="resolved">Resolved</button>
          </div>
        </header>

        <div id="admin-chat-list" class="admin-chat-list" role="list" aria-live="polite">
          <div class="admin-loading-spinner-small" style="margin: 30px auto;">Loading chats...</div>
        </div>
      </section>

      <!-- Right Column: Conversation Workspace -->
      <section id="admin-chat-workspace" class="admin-chat-workspace" aria-label="Active conversation workspace">
        <div class="admin-chat-empty-state">
          <span class="admin-chat-empty-icon" aria-hidden="true"><svg class="lucide lucide-message-square" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>
          <p>Select a conversation from the left to view transcript and respond.</p>
        </div>
      </section>
    </div>
  `;
}

/**
 * Renders the conversation cards in the left column.
 * @param {HTMLElement} listEl
 * @param {Array} chats
 * @param {string|null} selectedSessionId
 */
export function renderChatList(listEl, chats, selectedSessionId) {
  if (!listEl) return;

  if (!chats || chats.length === 0) {
    listEl.innerHTML = `
      <div class="admin-empty-state" style="padding: 30px 16px; text-align: center; color: var(--admin-dim);">
        <p style="margin: 0; font-size: 13px;">No conversations found matching criteria.</p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = chats.map((chat) => {
    const isSelected = chat.sessionId === selectedSessionId;
    const isUnread = Boolean(chat.unreadByAdmin);
    const isEscalated = chat.status === 'escalated';
    const displayUser = chat.visitorEmail || chat.customerId || `#${chat.sessionId.substring(0, 10)}`;
    const timeAgo = formatTimestamp(chat.updatedAt || chat.createdAt);

    return `
      <article
        class="admin-chat-card ${isSelected ? 'is-selected' : ''}"
        role="listitem"
        data-session-id="${escapeHtml(chat.sessionId)}"
        tabindex="0"
      >
        <div class="admin-chat-card-top">
          <span class="admin-chat-card-user">
            ${isUnread ? '<span class="admin-chat-unread-dot" title="Unread by admin" aria-label="Unread"></span>' : ''}
            <span>${escapeHtml(displayUser)}</span>
          </span>
          <span class="admin-chat-time">${escapeHtml(timeAgo)}</span>
        </div>

        <div class="admin-chat-card-snippet">
          ${escapeHtml(chat.lastMessage || chat.summary || 'No messages yet')}
        </div>

        <div class="admin-chat-card-footer">
          <div class="admin-chat-tags">
            ${isEscalated ? `<span class="admin-chat-escalation-tag" title="Escalated: ${escapeHtml(chat.escalationReason || 'reason unspecified')}"><svg class="lucide lucide-alert-triangle" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-1px;margin-right:3px;"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>${escapeHtml(formatEscalationReason(chat.escalationReason))}</span>` : ''}
            <span class="admin-chat-source-tag">${escapeHtml(chat.source || 'landing')}</span>
            ${chat.plan && chat.plan !== 'anonymous' ? `<span class="admin-badge-plan admin-badge-${escapeHtml(chat.plan)}">${escapeHtml(chat.plan)}</span>` : ''}
          </div>
          <span class="admin-badge-status admin-badge-${chat.status === 'resolved' ? 'active' : (isEscalated ? 'canceled' : 'trialing')}">
            ${escapeHtml(chat.status || 'active')}
          </span>
        </div>
      </article>
    `;
  }).join('');
}

/**
 * Renders the active conversation workspace in the right column.
 * @param {HTMLElement} workspaceEl
 * @param {object} chat
 */
export function renderChatWorkspace(workspaceEl, chat) {
  if (!workspaceEl) return;
  if (!chat) {
    workspaceEl.innerHTML = `
      <div class="admin-chat-empty-state">
        <span class="admin-chat-empty-icon" aria-hidden="true"><svg class="lucide lucide-message-square" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>
        <p>Select a conversation from the left to view transcript and respond.</p>
      </div>
    `;
    return;
  }

  const isResolved = chat.status === 'resolved';
  const isEscalated = chat.status === 'escalated';
  const displayUser = chat.visitorEmail || chat.customerId || `#${chat.sessionId}`;
  const userInitial = displayUser.charAt(0).toUpperCase();
  const messages = chat.messages || [];

  workspaceEl.innerHTML = `
    <!-- Header -->
    <header class="admin-chat-workspace-header">
      <div class="admin-chat-workspace-meta">
        <div class="admin-chat-workspace-avatar" aria-hidden="true">${escapeHtml(userInitial)}</div>
        <div class="admin-chat-workspace-title-box">
          <span class="admin-chat-workspace-title">${escapeHtml(displayUser)}</span>
          <span class="admin-chat-workspace-sub">
            <span>Session: <code>${escapeHtml(chat.sessionId)}</code></span>
            ${chat.plan ? `&middot; <span class="admin-badge-plan admin-badge-${escapeHtml(chat.plan)}">${escapeHtml(chat.plan)}</span>` : ''}
            &middot; <span class="admin-chat-source-tag">${escapeHtml(chat.source || 'landing')}</span>
          </span>
        </div>
      </div>

      <div class="admin-chat-workspace-actions">
        ${chat.customerId || chat.visitorEmail ? `
          <button
            type="button"
            id="admin-chat-inspect-dossier-btn"
            class="admin-btn admin-btn-secondary"
            data-user-id="${escapeHtml(chat.customerId || '')}"
            data-user-email="${escapeHtml(chat.visitorEmail || '')}"
          >
            Inspect User Dossier
          </button>
        ` : ''}
        <button
          type="button"
          id="admin-chat-status-toggle-btn"
          class="admin-btn ${isResolved ? 'admin-btn-secondary' : 'admin-btn-resolve'}"
          data-status="${isResolved ? 'active' : 'resolved'}"
        >
          ${isResolved ? 'Reopen Chat' : 'Resolve Chat'}
        </button>
      </div>
    </header>

    <!-- Transcript Stream -->
    <div id="admin-chat-transcript" class="admin-chat-transcript" role="log" aria-live="polite">
      ${isEscalated ? `
        <div class="admin-transcript-system-event">
          <span><svg class="lucide lucide-alert-triangle" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>
          <span>Escalated to Operator &middot; Reason: <strong>${escapeHtml(formatEscalationReason(chat.escalationReason))}</strong></span>
        </div>
      ` : ''}

      ${messages.map((m) => {
        const isOperator = m.sender === 'operator';
        const isAssistant = m.sender === 'bot' || m.role === 'assistant';
        const roleClass = isOperator ? 'is-operator' : (isAssistant ? 'is-assistant' : 'is-visitor');
        const roleLabel = isOperator ? 'Operator (Human)' : (isAssistant ? 'Nova Micro (AI)' : 'Visitor');
        const timeStr = formatTimestamp(m.timestamp);

        return `
          <div class="admin-transcript-bubble-row ${roleClass}">
            <div class="admin-transcript-sender-info">
              <strong>${escapeHtml(roleLabel)}</strong>
              ${m.tokens ? `<span class="admin-audit-stat-pill" style="font-size: 10px; padding: 1px 5px;">${m.tokens.input || 0} in / ${m.tokens.output || 0} out</span>` : ''}
              <span>&middot; ${escapeHtml(timeStr)}</span>
            </div>
            <div class="admin-transcript-bubble">
              ${isAssistant ? renderChatMarkdown(m.content) : escapeHtml(m.content).replace(/\n/g, '<br>')}
            </div>
          </div>
        `;
      }).join('')}
    </div>

    <!-- Operator Reply Bar -->
    <footer class="admin-chat-reply-bar">
      <textarea
        id="admin-chat-reply-input"
        class="admin-chat-reply-textarea"
        placeholder="Type an operator reply to this customer..."
        rows="2"
      ></textarea>

      <div class="admin-chat-reply-actions">
        <div class="admin-chat-reply-actions-left">
          <div class="custom-select admin-chat-canned-custom-select" data-custom-select>
            <label for="admin-chat-canned" class="custom-select-label visually-hidden">Insert canned response</label>
            <input id="admin-chat-canned" type="hidden" value="">
            <button class="custom-select-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="admin-chat-canned-menu">
              <span class="custom-select-value">Insert canned response...</span>
              <span class="custom-select-icon" aria-hidden="true"><svg class="lucide lucide-chevron-down" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></span>
            </button>
            <div id="admin-chat-canned-menu" class="custom-select-menu" role="listbox" hidden>
              <button class="custom-select-option is-active" type="button" role="option" aria-selected="true" data-custom-select-option data-value="">Insert canned response...</button>
              <button class="custom-select-option" type="button" role="option" aria-selected="false" data-custom-select-option data-value="docs">API Docs &amp; Authentication Guide</button>
              <button class="custom-select-option" type="button" role="option" aria-selected="false" data-custom-select-option data-value="enterprise">Enterprise Volume Pricing &amp; SLA Scheduler</button>
              <button class="custom-select-option" type="button" role="option" aria-selected="false" data-custom-select-option data-value="margins">Custom Margins &amp; Paper Format Snippet</button>
              <button class="custom-select-option" type="button" role="option" aria-selected="false" data-custom-select-option data-value="security">PDF Encryption &amp; Permissions Snippet</button>
              <button class="custom-select-option" type="button" role="option" aria-selected="false" data-custom-select-option data-value="investigating">Bug Investigation Underway</button>
            </div>
          </div>
          <label class="admin-chat-email-copy-label">
            <input
              type="checkbox"
              id="admin-chat-send-email-checkbox"
              ${chat.visitorEmail ? 'checked' : 'disabled'}
            >
            <span>Email copy via SES (${escapeHtml(chat.visitorEmail || 'none')})</span>
          </label>
        </div>

        <div class="admin-chat-btn-group">
          <span style="font-size: 11px; color: var(--admin-dim); margin-right: 4px;">Press <strong>Cmd+Enter</strong></span>
          <button type="button" id="admin-chat-send-reply-btn" class="admin-btn admin-btn-primary">
            Send Reply
          </button>
        </div>
      </div>
    </footer>
  `;

  // Auto-scroll transcript to bottom
  const transcriptEl = workspaceEl.querySelector('#admin-chat-transcript');
  if (transcriptEl) {
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }
  window.customSelect?.init();
}

/**
 * Initializes the Tab 5 Live Chat & Support Inbox.
 * @param {HTMLElement} containerElement
 */
export async function initSupportChatTab(containerElement) {
  stopPolling();

  const state = {
    filter: 'all',
    search: '',
    rawChats: [],
    filteredChats: [],
    selectedSessionId: null,
    selectedChat: null,
    isSending: false
  };

  // Check URL query parameters for deep-linked session ID (e.g. from SES email link: #chats?id=cs_...)
  const hashParts = (window.location.hash || '').split('?');
  if (hashParts.length > 1) {
    const qParams = new URLSearchParams(hashParts[1]);
    const deepSessionId = qParams.get('id');
    if (deepSessionId) {
      state.selectedSessionId = deepSessionId;
    }
  }

  // 1. Render initial shell
  renderChatShell(containerElement, state);

  const listEl = containerElement.querySelector('#admin-chat-list');
  const workspaceEl = containerElement.querySelector('#admin-chat-workspace');
  const searchInput = containerElement.querySelector('#admin-chat-search');
  const totalCountEl = containerElement.querySelector('#admin-chat-total-count');
  const escalatedCountEl = containerElement.querySelector('#admin-chat-filter-escalated-count');

  function applyFilters() {
    const q = state.search.toLowerCase().trim();
    state.filteredChats = state.rawChats.filter((chat) => {
      // Filter tab
      if (state.filter === 'escalated' && chat.status !== 'escalated') return false;
      if (state.filter === 'active' && chat.status !== 'active') return false;
      if (state.filter === 'resolved' && chat.status !== 'resolved') return false;

      // Search query
      if (q) {
        const email = (chat.visitorEmail || '').toLowerCase();
        const id = (chat.sessionId || '').toLowerCase();
        const customerId = (chat.customerId || '').toLowerCase();
        const msg = (chat.lastMessage || chat.summary || '').toLowerCase();
        const match = email.includes(q) || id.includes(q) || customerId.includes(q) || msg.includes(q);
        if (!match) return false;
      }
      return true;
    });

    // Update count pills
    const escalatedTotal = state.rawChats.filter((c) => c.status === 'escalated').length;
    if (escalatedCountEl) {
      escalatedCountEl.textContent = String(escalatedTotal);
      escalatedCountEl.classList.toggle('hidden', escalatedTotal === 0);
    }
    updateEscalatedBadge(escalatedTotal);

    if (totalCountEl) {
      totalCountEl.textContent = String(state.filteredChats.length);
    }

    renderChatList(listEl, state.filteredChats, state.selectedSessionId);
  }

  async function loadChats(background = false) {
    try {
      const data = await fetchChats({ status: state.filter === 'escalated' ? 'escalated' : 'all' });
      state.rawChats = data.chats || [];
      applyFilters();

      // If a session was deep-linked or we have a selected chat, load or refresh it
      if (state.selectedSessionId) {
        await loadTranscript(state.selectedSessionId, background);
      } else if (!background && state.filteredChats.length > 0) {
        // Automatically select first conversation if none selected
        await loadTranscript(state.filteredChats[0].sessionId, false);
      }
    } catch (err) {
      if (!background) {
        listEl.innerHTML = `
          <div class="admin-error-banner" style="margin: 20px 10px;">
            <p style="margin: 0; font-size: 13px;">Failed to load conversations: ${escapeHtml(err.message)}</p>
          </div>
        `;
      }
    }
  }

  async function loadTranscript(sessionId, background = false) {
    state.selectedSessionId = sessionId;
    if (!background) {
      workspaceEl.innerHTML = `
        <div class="admin-chat-empty-state">
          <span class="admin-loading-spinner-small"></span>
          <p>Loading conversation transcript...</p>
        </div>
      `;
    }

    // Update active highlight in list
    listEl.querySelectorAll('.admin-chat-card').forEach((card) => {
      const cardSessionId = card.getAttribute('data-session-id');
      card.classList.toggle('is-selected', cardSessionId === sessionId);
    });

    try {
      const chatData = await fetchChatTranscript(sessionId);
      state.selectedChat = chatData;
      renderChatWorkspace(workspaceEl, chatData);
      bindWorkspaceEvents();

      // Mark unread as read in memory
      const chatInList = state.rawChats.find((c) => c.sessionId === sessionId);
      if (chatInList && chatInList.unreadByAdmin) {
        chatInList.unreadByAdmin = false;
        applyFilters();
      }
    } catch (err) {
      if (!background) {
        workspaceEl.innerHTML = `
          <div class="admin-error-banner" style="margin: 30px 20px;">
            <p style="margin: 0; font-size: 13px;">Could not load transcript: ${escapeHtml(err.message)}</p>
          </div>
        `;
      }
    }
  }

  function bindWorkspaceEvents() {
    const cannedSelect = workspaceEl.querySelector('#admin-chat-canned');
    const replyInput = workspaceEl.querySelector('#admin-chat-reply-input');
    const sendBtn = workspaceEl.querySelector('#admin-chat-send-reply-btn');
    const sendEmailCheckbox = workspaceEl.querySelector('#admin-chat-send-email-checkbox');
    const statusBtn = workspaceEl.querySelector('#admin-chat-status-toggle-btn');
    const inspectBtn = workspaceEl.querySelector('#admin-chat-inspect-dossier-btn');

    // Canned response selection
    if (cannedSelect && replyInput) {
      cannedSelect.addEventListener('change', () => {
        const key = cannedSelect.value;
        if (key && CANNED_RESPONSES[key]) {
          replyInput.value = CANNED_RESPONSES[key];
          replyInput.focus();
          window.customSelect?.setValue('admin-chat-canned', '');
        }
      });
    }

    // Keyboard shortcut (Cmd+Enter or Ctrl+Enter)
    if (replyInput) {
      replyInput.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          triggerSendReply();
        }
      });
    }

    // Send button click
    if (sendBtn) {
      sendBtn.addEventListener('click', triggerSendReply);
    }

    // Status toggle click
    if (statusBtn) {
      statusBtn.addEventListener('click', async () => {
        if (!state.selectedSessionId) return;
        const newStatus = statusBtn.getAttribute('data-status') || 'resolved';
        statusBtn.disabled = true;
        statusBtn.textContent = 'Updating...';

        try {
          await updateChatStatus(state.selectedSessionId, newStatus);
          showToast(`Conversation marked as ${newStatus}`);

          // Update local state
          if (state.selectedChat) state.selectedChat.status = newStatus;
          const chatInList = state.rawChats.find((c) => c.sessionId === state.selectedSessionId);
          if (chatInList) chatInList.status = newStatus;

          applyFilters();
          renderChatWorkspace(workspaceEl, state.selectedChat);
          bindWorkspaceEvents();
        } catch (err) {
          showToast(`Failed to update status: ${err.message}`, 'error');
          statusBtn.disabled = false;
        }
      });
    }

    // Inspect user dossier deep link
    if (inspectBtn) {
      inspectBtn.addEventListener('click', async () => {
        const userId = inspectBtn.getAttribute('data-user-id');
        const userEmail = inspectBtn.getAttribute('data-user-email');
        const targetId = userId || userEmail;
        if (!targetId) return;

        try {
          // Switch to Users tab
          window.location.hash = '#users';
          const { openUserDossier } = await import('../users/users.js');
          await openUserDossier(targetId);
        } catch (err) {
          console.error('Failed to open customer dossier:', err);
          showToast('Could not open user dossier', 'error');
        }
      });
    }

    async function triggerSendReply() {
      if (!replyInput || state.isSending || !state.selectedSessionId) return;
      const text = replyInput.value.trim();
      if (!text) {
        replyInput.focus();
        return;
      }

      state.isSending = true;
      if (sendBtn) {
        sendBtn.disabled = true;
        sendBtn.textContent = 'Sending...';
      }

      const shouldSendEmail = Boolean(sendEmailCheckbox && sendEmailCheckbox.checked);

      try {
        const res = await sendOperatorReply(state.selectedSessionId, {
          message: text,
          sendEmail: shouldSendEmail
        });

        // Append operator message to workspace transcript
        const newMsg = {
          messageId: res.messageId || `op_${Date.now()}`,
          role: 'assistant',
          sender: 'operator',
          content: text,
          timestamp: Date.now()
        };

        if (state.selectedChat) {
          if (!state.selectedChat.messages) state.selectedChat.messages = [];
          state.selectedChat.messages.push(newMsg);
          renderChatWorkspace(workspaceEl, state.selectedChat);
          bindWorkspaceEvents();
        }

        // Update list snippet
        const chatInList = state.rawChats.find((c) => c.sessionId === state.selectedSessionId);
        if (chatInList) {
          chatInList.lastMessage = text;
          chatInList.updatedAt = new Date().toISOString();
          applyFilters();
        }

        showToast(res.emailDispatched ? 'Reply sent & email copy dispatched' : 'Reply posted to conversation');
      } catch (err) {
        showToast(`Failed to send reply: ${err.message}`, 'error');
      } finally {
        state.isSending = false;
        if (sendBtn) {
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send Reply';
        }
      }
    }
  }

  // Search input event
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      state.search = searchInput.value;
      applyFilters();
    });
  }

  // Filter chips click
  const filterChips = containerElement.querySelectorAll('.admin-chat-filter-chip');
  filterChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      const filter = chip.getAttribute('data-filter') || 'all';
      state.filter = filter;
      filterChips.forEach((c) => c.classList.toggle('is-active', c === chip));
      applyFilters();
    });
  });

  // Conversation card click (event delegation)
  if (listEl) {
    listEl.addEventListener('click', (e) => {
      const card = e.target.closest('.admin-chat-card');
      if (!card) return;
      const sessionId = card.getAttribute('data-session-id');
      if (sessionId && sessionId !== state.selectedSessionId) {
        loadTranscript(sessionId);
      }
    });

    listEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        const card = e.target.closest('.admin-chat-card');
        if (card) {
          e.preventDefault();
          const sessionId = card.getAttribute('data-session-id');
          if (sessionId && sessionId !== state.selectedSessionId) {
            loadTranscript(sessionId);
          }
        }
      }
    });
  }

  // Initial load
  await loadChats(false);

  // Real-time polling every 10 seconds
  activePollTimer = setInterval(() => {
    loadChats(true);
  }, 10000);
}
