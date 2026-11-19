/**
 * Support Chat DOM rendering components and view builders.
 */

import {
  escapeHtml,
  renderChatMarkdown,
  formatTimestamp,
  formatEscalationReason,
} from './chat-format.js';

/**
 * Updates the navigation badge count for escalated chats.
 * @param {number} count
 */
export function updateEscalatedBadge(count) {
  const badge = document.getElementById('escalated-chats-badge') || document.getElementById('admin-nav-escalated-badge');
  if (!badge) return;

  const num = Number(count) || 0;
  if (num > 0) {
    badge.textContent = String(num);
    badge.classList.remove('hidden');
    badge.setAttribute('aria-label', `${num} escalated support chats`);
  } else {
    badge.textContent = '0';
    badge.classList.add('hidden');
    badge.removeAttribute('aria-label');
  }

  const filterBadge = document.getElementById('admin-chat-filter-escalated-count');
  if (filterBadge) {
    filterBadge.textContent = String(num);
    if (num > 0) {
      filterBadge.classList.remove('hidden');
    } else {
      filterBadge.classList.add('hidden');
    }
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

  listEl.innerHTML = chats
    .map((chat) => {
      const isSelected = chat.sessionId === selectedSessionId;
      const isUnread = Boolean(chat.unreadByAdmin);
      const isEscalated = chat.status === 'escalated';
      const displayUser =
        chat.visitorEmail || chat.customerId || `#${chat.sessionId.substring(0, 10)}`;
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
          <span class="admin-badge-status admin-badge-${chat.status === 'resolved' ? 'active' : isEscalated ? 'canceled' : 'trialing'}">
            ${escapeHtml(chat.status || 'active')}
          </span>
        </div>
      </article>
    `;
    })
    .join('');
}

/**
 * Renders the transcript stream content (escalation banner and message bubbles).
 * @param {object} chat
 * @returns {string}
 */
export function renderTranscriptContent(chat) {
  if (!chat) return '';
  const isEscalated = chat.status === 'escalated';
  const messages = chat.messages || [];

  const bannerHtml = isEscalated
    ? `
        <div class="admin-transcript-system-event">
          <span><svg class="lucide lucide-alert-triangle" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>
          <span>Escalated to Operator &middot; Reason: <strong>${escapeHtml(formatEscalationReason(chat.escalationReason))}</strong></span>
        </div>
      `
    : '';

  const messagesHtml = messages
    .map((m) => {
      const isOperator = m.sender === 'operator';
      const isAssistant = m.sender === 'bot' || m.role === 'assistant';
      const roleClass = isOperator
        ? 'is-operator'
        : isAssistant
          ? 'is-assistant'
          : 'is-visitor';
      const roleLabel = isOperator
        ? 'Operator (Human)'
        : isAssistant
          ? 'Nova Micro (AI)'
          : 'Visitor';
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
    })
    .join('');

  return bannerHtml + messagesHtml;
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
  const displayUser = chat.visitorEmail || chat.customerId || `#${chat.sessionId}`;
  const userInitial = displayUser.charAt(0).toUpperCase();

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
        ${
          chat.customerId || chat.visitorEmail
            ? `
          <button
            type="button"
            id="admin-chat-inspect-dossier-btn"
            class="admin-btn admin-btn-secondary"
            data-user-id="${escapeHtml(chat.customerId || '')}"
            data-user-email="${escapeHtml(chat.visitorEmail || '')}"
          >
            Inspect User Dossier
          </button>
        `
            : ''
        }
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
      ${renderTranscriptContent(chat)}
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

  const transcriptEl = workspaceEl.querySelector('#admin-chat-transcript');
  if (transcriptEl) {
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }
  window.customSelect?.init();
}
