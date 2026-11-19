/**
 * RenderPDF Admin Support Chat & Live Inbox Module (Route: /admin#chats)
 * Zero-dependency client interface for reviewing visitor conversations,
 * inspecting customer dossiers, and sending operator replies with SES dispatch.
 */

import { adminFetch } from '../../shared/api.js';
import { showToast } from '../../shared/ui.js';
import {
  CANNED_RESPONSES,
  escapeHtml,
  renderChatMarkdown,
  formatTimestamp,
  formatEscalationReason,
} from './chat-format.js';
import {
  updateEscalatedBadge,
  renderChatShell,
  renderChatList,
  renderTranscriptContent,
  renderChatWorkspace,
} from './chat-ui.js';

export {
  CANNED_RESPONSES,
  escapeHtml,
  renderChatMarkdown,
  formatTimestamp,
  formatEscalationReason,
  updateEscalatedBadge,
  renderChatShell,
  renderChatList,
  renderTranscriptContent,
  renderChatWorkspace,
};

let activePollTimer = null;

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
    body: JSON.stringify({ message, sendEmail }),
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
    body: JSON.stringify({ status }),
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
    isSending: false,
    lastListFingerprint: null,
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
        const match =
          email.includes(q) || id.includes(q) || customerId.includes(q) || msg.includes(q);
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

    // Check if conversation list changed before replacing innerHTML to eliminate flicker
    const listFingerprint = `${state.filter}:${state.search}:${state.selectedSessionId}:` +
      state.filteredChats
        .map((c) => `${c.sessionId}:${c.status}:${Boolean(c.unreadByAdmin)}:${c.lastMessage || ''}:${c.updatedAt || ''}`)
        .join('|');

    if (listFingerprint === state.lastListFingerprint) {
      return;
    }
    state.lastListFingerprint = listFingerprint;

    const prevScroll = listEl.scrollTop;
    renderChatList(listEl, state.filteredChats, state.selectedSessionId);
    if (typeof listEl.scrollTop === 'number') {
      listEl.scrollTop = prevScroll;
    }
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
    const isSameSessionAlreadyMounted =
      state.selectedSessionId === sessionId &&
      state.selectedChat &&
      workspaceEl.querySelector('#admin-chat-transcript') !== null;

    state.selectedSessionId = sessionId;
    if (!background && !isSameSessionAlreadyMounted) {
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
      if (state.selectedSessionId !== sessionId) {
        return;
      }

      if (isSameSessionAlreadyMounted) {
        // In-place non-destructive update
        const oldMessages = state.selectedChat?.messages || [];
        const newMessages = chatData?.messages || [];
        const oldStatus = state.selectedChat?.status;
        const newStatus = chatData?.status;

        const messagesChanged =
          oldMessages.length !== newMessages.length ||
          (newMessages.length > 0 &&
            (newMessages[newMessages.length - 1].content !==
              oldMessages[oldMessages.length - 1]?.content ||
              newMessages[newMessages.length - 1].timestamp !==
                oldMessages[oldMessages.length - 1]?.timestamp));

        const statusChanged = oldStatus !== newStatus;

        if (messagesChanged || statusChanged) {
          const transcriptEl = workspaceEl.querySelector('#admin-chat-transcript');
          if (transcriptEl) {
            const isNearBottom =
              transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 120;
            transcriptEl.innerHTML = renderTranscriptContent(chatData);
            if (isNearBottom) {
              transcriptEl.scrollTop = transcriptEl.scrollHeight;
            }
          }
        }

        if (statusChanged) {
          const statusBtn = workspaceEl.querySelector('#admin-chat-status-toggle-btn');
          if (statusBtn) {
            const isResolved = newStatus === 'resolved';
            statusBtn.setAttribute('data-status', isResolved ? 'active' : 'resolved');
            statusBtn.className = `admin-btn ${isResolved ? 'admin-btn-secondary' : 'admin-btn-resolve'}`;
            statusBtn.textContent = isResolved ? 'Reopen Chat' : 'Resolve Chat';
          }
        }

        state.selectedChat = chatData;
      } else {
        state.selectedChat = chatData;
        renderChatWorkspace(workspaceEl, chatData);
        bindWorkspaceEvents();
      }

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
        statusBtn.setAttribute('aria-busy', 'true');
        statusBtn.classList.add('is-processing');
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
          statusBtn.removeAttribute('aria-busy');
          statusBtn.classList.remove('is-processing');
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
        sendBtn.setAttribute('aria-busy', 'true');
        sendBtn.classList.add('is-processing');
        sendBtn.textContent = 'Sending...';
      }

      const shouldSendEmail = Boolean(sendEmailCheckbox && sendEmailCheckbox.checked);

      try {
        const res = await sendOperatorReply(state.selectedSessionId, {
          message: text,
          sendEmail: shouldSendEmail,
        });

        // Append operator message to workspace transcript
        const newMsg = {
          messageId: res.messageId || `op_${Date.now()}`,
          role: 'assistant',
          sender: 'operator',
          content: text,
          timestamp: Date.now(),
        };

        if (state.selectedChat) {
          if (!state.selectedChat.messages) state.selectedChat.messages = [];
          state.selectedChat.messages.push(newMsg);
          const transcriptEl = workspaceEl.querySelector('#admin-chat-transcript');
          if (transcriptEl) {
            transcriptEl.innerHTML = renderTranscriptContent(state.selectedChat);
            transcriptEl.scrollTop = transcriptEl.scrollHeight;
          } else {
            renderChatWorkspace(workspaceEl, state.selectedChat);
            bindWorkspaceEvents();
          }
          if (replyInput) {
            replyInput.value = '';
          }
        }

        // Update list snippet
        const chatInList = state.rawChats.find((c) => c.sessionId === state.selectedSessionId);
        if (chatInList) {
          chatInList.lastMessage = text;
          chatInList.updatedAt = new Date().toISOString();
          applyFilters();
        }

        showToast(
          res.emailDispatched
            ? 'Reply sent & email copy dispatched'
            : 'Reply posted to conversation'
        );
      } catch (err) {
        showToast(`Failed to send reply: ${err.message}`, 'error');
      } finally {
        state.isSending = false;
        if (sendBtn) {
          sendBtn.disabled = false;
          sendBtn.removeAttribute('aria-busy');
          sendBtn.classList.remove('is-processing');
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

  let isPolling = false;
  // Real-time polling every 10 seconds
  activePollTimer = setInterval(async () => {
    if (isPolling) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    isPolling = true;
    try {
      await loadChats(true);
    } finally {
      isPolling = false;
    }
  }, 10000);
}
