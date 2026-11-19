/**
 * Grant Render Credits Modal (FEAT-ADMIN-PLANS)
 * Handles interactive modal for quota adjustments, credit grants, and usage resets.
 */

import { adminFetch } from '../../shared/api.js';
import { openModal, closeModal, showToast } from '../../shared/ui.js';

/**
 * Normalizes input arguments for Grant Credits modal.
 */
export function parseGrantCreditsArgs(arg1, arg2, arg3) {
  if (typeof arg1 === 'object' && arg1 !== null) {
    return {
      userId: arg1.userId,
      userEmail: arg1.userEmail || arg1.email || '',
      currentQuota: arg1.currentQuota || arg1.quota || {},
    };
  }
  return {
    userId: arg1,
    currentQuota: arg2 || {},
    userEmail: arg3 || '',
  };
}

/**
 * Retrieves or builds the Grant Credits modal element in DOM.
 * @returns {HTMLElement}
 */
export function getOrCreateGrantCreditsModal() {
  let modalEl = document.getElementById('admin-grant-credits-modal');
  if (modalEl) return modalEl;

  modalEl = document.createElement('div');
  modalEl.id = 'admin-grant-credits-modal';
  modalEl.className = 'admin-modal-backdrop';
  modalEl.setAttribute('hidden', '');
  modalEl.setAttribute('role', 'dialog');
  modalEl.setAttribute('aria-modal', 'true');
  modalEl.setAttribute('aria-labelledby', 'grant-credits-modal-title');

  modalEl.innerHTML = `
    <div class="admin-modal-dialog" tabindex="-1">
      <header class="admin-modal-header">
        <div class="admin-modal-title-group">
          <h2 id="grant-credits-modal-title" class="admin-modal-title">Grant Render Credits</h2>
          <span id="grant-credits-modal-subtitle" class="admin-modal-subtitle"></span>
        </div>
        <button type="button" id="grant-credits-modal-close-btn" class="admin-modal-close" aria-label="Close dialog"><svg class="lucide lucide-x" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
      </header>

      <form id="grant-credits-form" class="admin-modal-body">
        <div id="grant-credits-error" class="admin-modal-error" hidden role="alert"></div>

        <div class="admin-quota-summary-card">
          <div class="admin-quota-stat">
            <span class="admin-quota-stat-label">Current Usage</span>
            <span id="grant-quota-used" class="admin-quota-stat-val">0</span>
          </div>
          <div class="admin-quota-stat">
            <span class="admin-quota-stat-label">Monthly Limit</span>
            <span id="grant-quota-limit" class="admin-quota-stat-val">0</span>
          </div>
          <div class="admin-quota-stat">
            <span class="admin-quota-stat-label">Remaining</span>
            <span id="grant-quota-remaining" class="admin-quota-stat-val">0</span>
          </div>
        </div>

        <div class="admin-form-group">
          <label class="admin-form-label">Adjustment Action</label>
          <div class="custom-select" data-custom-select style="width: 100%;">
            <label for="grant-credits-action" class="custom-select-label visually-hidden">Adjustment Action</label>
            <input id="grant-credits-action" type="hidden" value="add_credits">
            <button class="custom-select-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="grant-credits-action-menu" style="width: 100%;">
              <span class="custom-select-value">Add Bonus Credits (Increases monthly limit)</span>
              <span class="custom-select-icon" aria-hidden="true"><svg class="lucide lucide-chevron-down" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></span>
            </button>
            <div id="grant-credits-action-menu" class="custom-select-menu" role="listbox" hidden style="width: 100%;">
              <button class="custom-select-option is-active" type="button" role="option" aria-selected="true" data-custom-select-option data-value="add_credits">Add Bonus Credits (Increases monthly limit)</button>
              <button class="custom-select-option" type="button" role="option" aria-selected="false" data-custom-select-option data-value="set_limit">Set Exact Monthly Limit</button>
              <button class="custom-select-option" type="button" role="option" aria-selected="false" data-custom-select-option data-value="reset_usage">Reset Current Usage to 0</button>
            </div>
          </div>
        </div>

        <div id="grant-amount-group" class="admin-form-group">
          <label for="grant-credits-amount" class="admin-form-label">Amount</label>
          <div class="admin-preset-row">
            <button type="button" class="admin-preset-btn" data-amount="500">+500</button>
            <button type="button" class="admin-preset-btn active" data-amount="1000">+1,000</button>
            <button type="button" class="admin-preset-btn" data-amount="5000">+5,000</button>
          </div>
          <input type="number" id="grant-credits-amount" class="admin-input" min="1" step="1" value="1000" required>
        </div>

        <div class="admin-form-group">
          <label for="grant-credits-reason" class="admin-form-label">
            Reason for Adjustment <span class="admin-required-star">*</span>
          </label>
          <textarea id="grant-credits-reason" class="admin-input admin-textarea" rows="2" placeholder="e.g. Goodwill credit for customer support inquiry #4812" required></textarea>
          <div class="admin-form-hint">Required for compliance audit trail. Logged to immutable security log.</div>
        </div>

        <footer class="admin-modal-footer">
          <button type="button" id="grant-credits-cancel-btn" class="admin-btn-secondary">Cancel</button>
          <button type="submit" id="grant-credits-submit-btn" class="admin-btn admin-btn-primary">Grant Credits</button>
        </footer>
      </form>
    </div>
  `;

  const container = document.getElementById('admin-modal-container') || document.body;
  container.appendChild(modalEl);

  // Close handlers
  const closeBtn = modalEl.querySelector('#grant-credits-modal-close-btn');
  const cancelBtn = modalEl.querySelector('#grant-credits-cancel-btn');
  closeBtn?.addEventListener('click', () => closeModal(modalEl));
  cancelBtn?.addEventListener('click', () => closeModal(modalEl));

  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) {
      closeModal(modalEl);
    }
  });

  // Action switcher
  const actionSelect = modalEl.querySelector('#grant-credits-action');
  const amountGroup = modalEl.querySelector('#grant-amount-group');
  const amountInput = modalEl.querySelector('#grant-credits-amount');
  const submitBtn = modalEl.querySelector('#grant-credits-submit-btn');

  actionSelect?.addEventListener('change', () => {
    const val = actionSelect.value;
    if (val === 'reset_usage') {
      if (amountGroup) amountGroup.style.display = 'none';
      if (amountInput) amountInput.removeAttribute('required');
      if (submitBtn) submitBtn.textContent = 'Reset Usage to 0';
    } else {
      if (amountGroup) amountGroup.style.display = 'block';
      if (amountInput) amountInput.setAttribute('required', '');
      if (submitBtn)
        submitBtn.textContent = val === 'set_limit' ? 'Set Monthly Limit' : 'Grant Credits';
    }
  });

  // Preset buttons
  const presetBtns = modalEl.querySelectorAll('.admin-preset-btn');
  presetBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      presetBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const amt = btn.dataset.amount || btn.getAttribute('data-amount');
      if (amountInput && amt) {
        amountInput.value = amt;
      }
    });
  });

  return modalEl;
}

/**
 * Opens the Grant Credits Modal for a given customer.
 */
export function openGrantCreditsModal(arg1, arg2, arg3) {
  const { userId, userEmail, currentQuota } = parseGrantCreditsArgs(arg1, arg2, arg3);
  if (!userId) {
    showToast('Cannot grant credits: missing user ID', 'error');
    return;
  }

  const modalEl = getOrCreateGrantCreditsModal();
  const subtitleEl = modalEl.querySelector('#grant-credits-modal-subtitle');
  const errorEl = modalEl.querySelector('#grant-credits-error');
  const formEl = modalEl.querySelector('#grant-credits-form');
  const actionSelect = modalEl.querySelector('#grant-credits-action');
  const amountInput = modalEl.querySelector('#grant-credits-amount');
  const amountGroup = modalEl.querySelector('#grant-amount-group');
  const reasonInput = modalEl.querySelector('#grant-credits-reason');
  const submitBtn = modalEl.querySelector('#grant-credits-submit-btn');

  // Stats
  const usedVal = Number(currentQuota?.used || 0);
  const limitVal = Number(currentQuota?.limit || 0);
  const remainingVal = Math.max(0, limitVal - usedVal);

  const usedEl = modalEl.querySelector('#grant-quota-used');
  const limitEl = modalEl.querySelector('#grant-quota-limit');
  const remainingEl = modalEl.querySelector('#grant-quota-remaining');

  if (usedEl) usedEl.textContent = usedVal.toLocaleString();
  if (limitEl) limitEl.textContent = limitVal.toLocaleString();
  if (remainingEl) remainingEl.textContent = remainingVal.toLocaleString();

  if (subtitleEl) {
    subtitleEl.textContent = userEmail ? `${userEmail} (${userId.slice(0, 8)}...)` : userId;
  }
  if (errorEl) {
    errorEl.setAttribute('hidden', '');
    errorEl.textContent = '';
  }
  if (actionSelect) {
    actionSelect.value = 'add_credits';
    window.customSelect?.setValue('grant-credits-action', 'add_credits');
  }
  if (amountGroup) {
    amountGroup.style.display = 'block';
  }
  if (amountInput) {
    amountInput.value = '1000';
    amountInput.setAttribute('required', '');
  }
  if (reasonInput) {
    reasonInput.value = '';
  }
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Grant Credits';
  }

  const presetBtns = modalEl.querySelectorAll('.admin-preset-btn');
  presetBtns.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.amount === '1000');
  });

  // Handle form submission
  formEl.onsubmit = async (e) => {
    e.preventDefault();

    const action = actionSelect?.value || 'add_credits';
    const reason = (reasonInput?.value || '').trim();

    if (!reason) {
      if (errorEl) {
        errorEl.removeAttribute('hidden');
        errorEl.textContent = 'Reason for adjustment is required for compliance audit logging.';
      }
      reasonInput?.focus();
      return;
    }

    const payload = { action, reason };

    if (action !== 'reset_usage') {
      const amountVal = parseInt(amountInput?.value, 10);
      if (isNaN(amountVal) || amountVal <= 0) {
        if (errorEl) {
          errorEl.removeAttribute('hidden');
          errorEl.textContent = 'Amount must be a positive number of render units.';
        }
        amountInput?.focus();
        return;
      }
      payload.amount = amountVal;
    }

    if (errorEl) {
      errorEl.setAttribute('hidden', '');
      errorEl.textContent = '';
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.setAttribute('aria-busy', 'true');
      submitBtn.classList.add('is-processing');
      submitBtn.textContent = 'Applying adjustment...';
    }

    try {
      await adminFetch(`/admin/users/${encodeURIComponent(userId)}/quota`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      closeModal(modalEl);

      const successMsg =
        action === 'add_credits'
          ? `Granted +${payload.amount?.toLocaleString()} render credits to ${userEmail || userId}`
          : action === 'set_limit'
            ? `Set monthly limit to ${payload.amount?.toLocaleString()} for ${userEmail || userId}`
            : `Reset usage to 0 for ${userEmail || userId}`;

      showToast(successMsg, 'success');

      // Dispatch user-updated event to reload open dossier drawer
      const updateEvt = new CustomEvent('user-updated', {
        bubbles: true,
        composed: true,
        detail: { userId },
      });
      window.dispatchEvent(updateEvt);
    } catch (err) {
      console.error('Quota adjustment failed:', err);
      if (errorEl) {
        errorEl.removeAttribute('hidden');
        errorEl.textContent = err.message || 'Failed to adjust quota. Please try again.';
      }
      showToast(err.message || 'Failed to adjust quota', 'error');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.removeAttribute('aria-busy');
        submitBtn.classList.remove('is-processing');
        submitBtn.textContent = 'Grant Credits';
      }
    }
  };

  openModal(modalEl);
  window.customSelect?.init();
}
