/**
 * Governance Danger Zone Modals
 * Provides confirmation dialogs and API mutations for:
 *   - Suspend / Activate User Account
 *   - Revoke API Key
 */

import { adminFetch } from '../../shared/api.js';
import { openModal, closeModal, showToast } from '../../shared/ui.js';

let suspendModalEl = null;
let revokeModalEl = null;
let isGovernanceInitialized = false;

// ─── Suspend User Modal ───────────────────────────────────────────────────────

/**
 * Opens the Suspend / Activate User Account danger modal.
 * @param {string} userId       - Cognito sub UUID
 * @param {string} userEmail    - Customer email shown in confirmation prompt
 * @param {'disable'|'enable'}  [actionType='disable'] - Whether to suspend or re-enable
 */
export function openSuspendUserModal(userId, userEmail, actionType = 'disable') {
  const modal = getOrCreateSuspendModal();
  const isSuspend = actionType === 'disable';

  const heading = modal.querySelector('#suspend-modal-heading');
  const warning = modal.querySelector('#suspend-modal-warning');
  const confirmPrompt = modal.querySelector('#suspend-confirm-prompt');
  const submitBtn = modal.querySelector('#suspend-submit-btn');
  const confirmInput = modal.querySelector('#suspend-confirm-input');
  const reasonInput = modal.querySelector('#suspend-reason-input');
  const errorEl = modal.querySelector('#suspend-modal-error');

  if (heading) heading.textContent = isSuspend ? '⛔ Suspend Account' : '✅ Activate Account';
  if (warning) {
    warning.textContent = isSuspend
      ? "This will immediately disable the user's Cognito login and deactivate all API keys. Active integrations will fail with 401."
      : "This will re-enable the user's Cognito login. API keys remain deactivated and must be manually re-enabled.";
  }
  if (confirmPrompt) {
    confirmPrompt.textContent = isSuspend
      ? `Type the customer's email address "${userEmail}" or SUSPEND to confirm:`
      : `Type "${userEmail}" or ACTIVATE to confirm:`;
  }
  if (submitBtn) {
    submitBtn.textContent = isSuspend ? 'Suspend Account' : 'Activate Account';
    submitBtn.className = `admin-btn ${isSuspend ? 'admin-btn-danger' : 'admin-btn-success'}`;
  }
  if (confirmInput) confirmInput.value = '';
  if (reasonInput) reasonInput.value = '';
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.setAttribute('hidden', '');
  }

  const form = modal.querySelector('#suspend-modal-form');
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const confirmVal = (modal.querySelector('#suspend-confirm-input')?.value || '').trim();
      const reason = (modal.querySelector('#suspend-reason-input')?.value || '').trim();
      const errEl = modal.querySelector('#suspend-modal-error');
      const expectedTokens = isSuspend ? [userEmail, 'SUSPEND'] : [userEmail, 'ACTIVATE'];

      if (!expectedTokens.includes(confirmVal)) {
        if (errEl) {
          errEl.textContent = `Confirmation text does not match. Type "${userEmail}" or ${isSuspend ? 'SUSPEND' : 'ACTIVATE'}.`;
          errEl.removeAttribute('hidden');
        }
        return;
      }
      if (!reason) {
        if (errEl) {
          errEl.textContent = 'A reason is required for the audit trail.';
          errEl.removeAttribute('hidden');
        }
        return;
      }

      const submitBtnEl = modal.querySelector('#suspend-submit-btn');
      if (submitBtnEl) {
        submitBtnEl.disabled = true;
        submitBtnEl.setAttribute('aria-busy', 'true');
        submitBtnEl.classList.add('is-processing');
        submitBtnEl.textContent = 'Processing…';
      }
      if (errEl) {
        errEl.textContent = '';
        errEl.setAttribute('hidden', '');
      }

      try {
        await adminFetch(`/admin/users/${userId}/status`, {
          method: 'POST',
          body: JSON.stringify({ action: actionType, reason }),
        });
        closeModal(modal);
        showToast(
          isSuspend ? `Account suspended for ${userEmail}.` : `Account activated for ${userEmail}.`,
          isSuspend ? 'warning' : 'success'
        );
        document.dispatchEvent(new CustomEvent('user-updated', { detail: { userId } }));
      } catch (err) {
        if (errEl) {
          errEl.textContent = err.message || 'Request failed. Please try again.';
          errEl.removeAttribute('hidden');
        }
        if (submitBtnEl) {
          submitBtnEl.disabled = false;
          submitBtnEl.removeAttribute('aria-busy');
          submitBtnEl.classList.remove('is-processing');
          submitBtnEl.textContent = isSuspend ? 'Suspend Account' : 'Activate Account';
        }
      }
    };
  }

  const cancelBtn = modal.querySelector('#suspend-cancel-btn');
  if (cancelBtn) {
    cancelBtn.onclick = () => closeModal(modal);
  }
  const backdrop = modal.querySelector('.admin-modal-backdrop');
  if (backdrop) {
    backdrop.onclick = (e) => {
      if (e.target === backdrop) closeModal(modal);
    };
  }

  openModal(modal);
}

// ─── Revoke Key Modal ─────────────────────────────────────────────────────────

/**
 * Opens the Revoke API Key danger modal.
 * @param {string} userId   - Owner's Cognito sub UUID
 * @param {string} keyId    - RenderPDF API key ID (without APIKEY# prefix)
 * @param {string} keyName  - Display name or truncated key prefix shown in UI
 */
export function openRevokeKeyModal(userId, keyId, keyName) {
  const modal = getOrCreateRevokeModal();

  const heading = modal.querySelector('#revoke-modal-heading');
  const keyDisplay = modal.querySelector('#revoke-key-display');
  const reasonInput = modal.querySelector('#revoke-reason-input');
  const errorEl = modal.querySelector('#revoke-modal-error');

  if (heading) heading.textContent = `🔑 Revoke API Key`;
  if (keyDisplay) keyDisplay.textContent = keyName || keyId;
  if (reasonInput) reasonInput.value = '';
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.setAttribute('hidden', '');
  }

  const form = modal.querySelector('#revoke-modal-form');
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const reason = (modal.querySelector('#revoke-reason-input')?.value || '').trim();
      const errEl = modal.querySelector('#revoke-modal-error');

      if (!reason) {
        if (errEl) {
          errEl.textContent = 'A reason is required for the audit trail.';
          errEl.removeAttribute('hidden');
        }
        return;
      }

      const submitBtnEl = modal.querySelector('#revoke-submit-btn');
      if (submitBtnEl) {
        submitBtnEl.disabled = true;
        submitBtnEl.setAttribute('aria-busy', 'true');
        submitBtnEl.classList.add('is-processing');
        submitBtnEl.textContent = 'Revoking…';
      }
      if (errEl) {
        errEl.textContent = '';
        errEl.setAttribute('hidden', '');
      }

      try {
        await adminFetch(`/admin/users/${userId}/keys/${keyId}/revoke`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
        closeModal(modal);
        showToast(`API key "${keyName || keyId}" has been revoked.`, 'warning');
        document.dispatchEvent(new CustomEvent('user-updated', { detail: { userId } }));
      } catch (err) {
        if (errEl) {
          errEl.textContent = err.message || 'Request failed. Please try again.';
          errEl.removeAttribute('hidden');
        }
        if (submitBtnEl) {
          submitBtnEl.disabled = false;
          submitBtnEl.removeAttribute('aria-busy');
          submitBtnEl.classList.remove('is-processing');
          submitBtnEl.textContent = 'Revoke Key';
        }
      }
    };
  }

  const cancelBtn = modal.querySelector('#revoke-cancel-btn');
  if (cancelBtn) {
    cancelBtn.onclick = () => closeModal(modal);
  }
  const backdrop = modal.querySelector('.admin-modal-backdrop');
  if (backdrop) {
    backdrop.onclick = (e) => {
      if (e.target === backdrop) closeModal(modal);
    };
  }

  openModal(modal);
}

// ─── Modal DOM Builders ───────────────────────────────────────────────────────

function getOrCreateSuspendModal() {
  if (suspendModalEl) return suspendModalEl;

  const container = document.getElementById('admin-modal-container') || document.body;
  const modal = document.createElement('div');
  modal.id = 'admin-suspend-modal';
  modal.className = 'admin-modal-backdrop admin-modal-danger';
  modal.setAttribute('hidden', '');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'suspend-modal-heading');
  modal.innerHTML = `
    <div class="admin-modal admin-modal-danger-content" role="document" style="max-width:480px;">
      <header class="admin-modal-header admin-modal-danger-header">
        <h2 id="suspend-modal-heading" class="admin-modal-title">⛔ Suspend Account</h2>
        <button type="button" id="suspend-cancel-btn" class="admin-modal-close" aria-label="Cancel and close"><svg class="lucide lucide-x" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
      </header>
      <div class="admin-modal-body">
        <p id="suspend-modal-warning" class="admin-danger-notice" style="color:var(--admin-danger,#e53e3e);font-weight:500;margin-bottom:16px;"></p>
        <form id="suspend-modal-form" novalidate>
          <p id="suspend-confirm-prompt" class="admin-label" style="margin-bottom:8px;"></p>
          <input
            id="suspend-confirm-input"
            type="text"
            class="admin-input"
            autocomplete="off"
            spellcheck="false"
            aria-required="true"
            placeholder="Type to confirm"
            style="margin-bottom:16px;width:100%;"
          />
          <label for="suspend-reason-input" class="admin-label">Reason (required for audit trail)</label>
          <textarea
            id="suspend-reason-input"
            class="admin-input"
            rows="3"
            aria-required="true"
            placeholder="e.g. Fraudulent usage pattern detected"
            style="width:100%;margin-top:4px;"
          ></textarea>
          <p id="suspend-modal-error" class="admin-field-error" role="alert" hidden style="color:var(--admin-danger,#e53e3e);margin-top:8px;"></p>
          <div class="admin-modal-actions" style="margin-top:20px;display:flex;gap:10px;justify-content:flex-end;">
            <button type="button" id="suspend-cancel-btn-form" class="admin-btn admin-btn-secondary">Cancel</button>
            <button type="submit" id="suspend-submit-btn" class="admin-btn admin-btn-danger">Suspend Account</button>
          </div>
        </form>
      </div>
    </div>
  `;

  const cancelFooter = modal.querySelector('#suspend-cancel-btn-form');
  if (cancelFooter) cancelFooter.addEventListener('click', () => closeModal(modal));

  container.appendChild(modal);
  suspendModalEl = modal;
  return modal;
}

function getOrCreateRevokeModal() {
  if (revokeModalEl) return revokeModalEl;

  const container = document.getElementById('admin-modal-container') || document.body;
  const modal = document.createElement('div');
  modal.id = 'admin-revoke-modal';
  modal.className = 'admin-modal-backdrop admin-modal-danger';
  modal.setAttribute('hidden', '');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'revoke-modal-heading');
  modal.innerHTML = `
    <div class="admin-modal admin-modal-danger-content" role="document" style="max-width:440px;">
      <header class="admin-modal-header admin-modal-danger-header">
        <h2 id="revoke-modal-heading" class="admin-modal-title">🔑 Revoke API Key</h2>
        <button type="button" id="revoke-cancel-btn" class="admin-modal-close" aria-label="Cancel and close"><svg class="lucide lucide-x" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
      </header>
      <div class="admin-modal-body">
        <p class="admin-danger-notice" style="color:var(--admin-danger,#e53e3e);font-weight:500;margin-bottom:12px;">
          <svg class="lucide lucide-alert-triangle" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;margin-right:4px;"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>Active client integrations using key
          <strong id="revoke-key-display" style="font-family:monospace;"></strong>
          will immediately fail with <code>401 Unauthorized</code>.
        </p>
        <form id="revoke-modal-form" novalidate>
          <label for="revoke-reason-input" class="admin-label">Reason (required for audit trail)</label>
          <textarea
            id="revoke-reason-input"
            class="admin-input"
            rows="3"
            aria-required="true"
            placeholder="e.g. API key exposed in public repository"
            style="width:100%;margin-top:4px;"
          ></textarea>
          <p id="revoke-modal-error" class="admin-field-error" role="alert" hidden style="color:var(--admin-danger,#e53e3e);margin-top:8px;"></p>
          <div class="admin-modal-actions" style="margin-top:20px;display:flex;gap:10px;justify-content:flex-end;">
            <button type="button" id="revoke-cancel-btn-form" class="admin-btn admin-btn-secondary">Cancel</button>
            <button type="submit" id="revoke-submit-btn" class="admin-btn admin-btn-danger">Revoke Key</button>
          </div>
        </form>
      </div>
    </div>
  `;

  const cancelFooter = modal.querySelector('#revoke-cancel-btn-form');
  if (cancelFooter) cancelFooter.addEventListener('click', () => closeModal(modal));

  container.appendChild(modal);
  revokeModalEl = modal;
  return modal;
}

/**
 * Initializes window event listeners for governance danger-zone modals.
 */
export function initGovernanceModals() {
  if (isGovernanceInitialized) return;
  isGovernanceInitialized = true;

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const handleSuspend = (e) => {
      const detail = e.detail || {};
      const actionType = detail.enabled === false ? 'enable' : 'disable';
      openSuspendUserModal(detail.userId, detail.userEmail, actionType);
    };
    window.addEventListener('open-suspend-user', handleSuspend);
    window.addEventListener('admin-open-suspend-user', handleSuspend);

    const handleRevoke = (e) => {
      const detail = e.detail || {};
      openRevokeKeyModal(detail.userId, detail.keyId, detail.keyName);
    };
    window.addEventListener('open-revoke-key', handleRevoke);
    window.addEventListener('admin-open-revoke-key', handleRevoke);
  }
}
