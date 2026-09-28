/**
 * Plans & Quotas Management Module (FEAT-ADMIN-PLANS)
 * Provides interactive modals for manual plan tier overrides,
 * automated API Gateway usage plan synchronization, and emergency credit grants.
 */

import { adminFetch } from '../../shared/api.js';
import { openModal, closeModal, showToast } from '../../shared/ui.js';

let isInitialized = false;

/**
 * Normalizes input arguments for Change Plan modal.
 */
function parseChangePlanArgs(arg1, arg2, arg3, arg4) {
  if (typeof arg1 === 'object' && arg1 !== null) {
    return {
      userId: arg1.userId,
      userEmail: arg1.userEmail || arg1.email || '',
      currentTier: arg1.currentTier || arg1.tier || 'free',
      manualOverride: Boolean(arg1.manualOverride),
    };
  }
  return {
    userId: arg1,
    currentTier: arg2 || 'free',
    manualOverride: Boolean(arg3),
    userEmail: arg4 || '',
  };
}

/**
 * Normalizes input arguments for Grant Credits modal.
 */
function parseGrantCreditsArgs(arg1, arg2, arg3) {
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
 * Retrieves or builds the Change Plan modal element in DOM.
 * @returns {HTMLElement}
 */
export function getOrCreateChangePlanModal() {
  let modalEl = document.getElementById('admin-change-plan-modal');
  if (modalEl) return modalEl;

  modalEl = document.createElement('div');
  modalEl.id = 'admin-change-plan-modal';
  modalEl.className = 'admin-modal-backdrop';
  modalEl.setAttribute('hidden', '');
  modalEl.setAttribute('role', 'dialog');
  modalEl.setAttribute('aria-modal', 'true');
  modalEl.setAttribute('aria-labelledby', 'change-plan-modal-title');

  modalEl.innerHTML = `
    <div class="admin-modal-dialog" tabindex="-1">
      <header class="admin-modal-header">
        <div class="admin-modal-title-group">
          <h2 id="change-plan-modal-title" class="admin-modal-title">Change Plan Tier</h2>
          <span id="change-plan-modal-subtitle" class="admin-modal-subtitle"></span>
        </div>
        <button type="button" id="change-plan-modal-close-btn" class="admin-modal-close" aria-label="Close dialog"><svg class="lucide lucide-x" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
      </header>

      <form id="change-plan-form" class="admin-modal-body">
        <div id="change-plan-error" class="admin-modal-error" hidden role="alert"></div>

        <fieldset class="admin-form-group">
          <legend class="admin-form-label">Select Plan Tier</legend>
          <div class="admin-plan-radio-group">
            <label class="admin-plan-radio-card" data-tier="free">
              <input type="radio" name="plan-tier" value="free">
              <div class="admin-plan-card-info">
                <span class="admin-plan-card-name">Free</span>
                <span class="admin-plan-card-desc">25 renders / month</span>
              </div>
            </label>

            <label class="admin-plan-radio-card" data-tier="starter">
              <input type="radio" name="plan-tier" value="starter">
              <div class="admin-plan-card-info">
                <span class="admin-plan-card-name">Starter</span>
                <span class="admin-plan-card-desc">5,000 renders / month</span>
              </div>
            </label>

            <label class="admin-plan-radio-card" data-tier="pro">
              <input type="radio" name="plan-tier" value="pro">
              <div class="admin-plan-card-info">
                <span class="admin-plan-card-name">Pro</span>
                <span class="admin-plan-card-desc">20,000 renders / month</span>
              </div>
            </label>

            <label class="admin-plan-radio-card" data-tier="enterprise">
              <input type="radio" name="plan-tier" value="enterprise">
              <div class="admin-plan-card-info">
                <span class="admin-plan-card-name">Enterprise</span>
                <span class="admin-plan-card-desc">100,000 renders / month</span>
              </div>
            </label>
          </div>
        </fieldset>

        <div class="admin-form-group">
          <label class="admin-checkbox-label">
            <input type="checkbox" id="change-plan-lock-override" checked>
            <span>
              <strong>Lock Plan (Prevent Paddle Webhook Overwrite)</strong>
              <small class="admin-form-hint">Prevents automated cancellation or downgrade webhooks from Paddle from altering this entitlement.</small>
            </span>
          </label>
        </div>

        <div class="admin-form-group">
          <label for="change-plan-custom-quota" class="admin-form-label">Custom Monthly Quota (optional)</label>
          <input type="number" id="change-plan-custom-quota" class="admin-input" min="1" step="1" placeholder="Leave empty for plan default limit">
        </div>

        <div class="admin-form-group">
          <label for="change-plan-reason" class="admin-form-label">
            Reason for Change <span class="admin-required-star">*</span>
          </label>
          <textarea id="change-plan-reason" class="admin-input admin-textarea" rows="2" placeholder="e.g. VIP contract Q4 upgrade / customer goodwill exception" required></textarea>
          <div class="admin-form-hint">Required for compliance audit trail. Logged to immutable security log.</div>
        </div>

        <footer class="admin-modal-footer">
          <button type="button" id="change-plan-cancel-btn" class="admin-btn-secondary">Cancel</button>
          <button type="submit" id="change-plan-submit-btn" class="admin-btn admin-btn-primary">Update Plan</button>
        </footer>
      </form>
    </div>
  `;

  const container = document.getElementById('admin-modal-container') || document.body;
  container.appendChild(modalEl);

  // Close handlers
  const closeBtn = modalEl.querySelector('#change-plan-modal-close-btn');
  const cancelBtn = modalEl.querySelector('#change-plan-cancel-btn');
  closeBtn?.addEventListener('click', () => closeModal(modalEl));
  cancelBtn?.addEventListener('click', () => closeModal(modalEl));

  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) {
      closeModal(modalEl);
    }
  });

  return modalEl;
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
      if (submitBtn) submitBtn.textContent = val === 'set_limit' ? 'Set Monthly Limit' : 'Grant Credits';
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
 * Opens the Change Plan Modal for a given customer.
 */
export function openChangePlanModal(arg1, arg2, arg3, arg4) {
  const { userId, userEmail, currentTier, manualOverride } = parseChangePlanArgs(arg1, arg2, arg3, arg4);
  if (!userId) {
    showToast('Cannot change plan: missing user ID', 'error');
    return;
  }

  const modalEl = getOrCreateChangePlanModal();
  const subtitleEl = modalEl.querySelector('#change-plan-modal-subtitle');
  const errorEl = modalEl.querySelector('#change-plan-error');
  const formEl = modalEl.querySelector('#change-plan-form');
  const overrideCheckbox = modalEl.querySelector('#change-plan-lock-override');
  const customQuotaInput = modalEl.querySelector('#change-plan-custom-quota');
  const reasonInput = modalEl.querySelector('#change-plan-reason');
  const submitBtn = modalEl.querySelector('#change-plan-submit-btn');

  if (subtitleEl) {
    subtitleEl.textContent = userEmail ? `${userEmail} (${userId.slice(0, 8)}...)` : userId;
  }
  if (errorEl) {
    errorEl.setAttribute('hidden', '');
    errorEl.textContent = '';
  }
  if (overrideCheckbox) {
    overrideCheckbox.checked = manualOverride || currentTier === 'enterprise' || currentTier === 'pro';
  }
  if (customQuotaInput) {
    customQuotaInput.value = '';
  }
  if (reasonInput) {
    reasonInput.value = '';
  }
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Update Plan';
  }

  // Pre-select current tier radio
  const normalizedTier = (currentTier || 'free').toLowerCase();
  const radios = modalEl.querySelectorAll('input[name="plan-tier"]');
  radios.forEach((radio) => {
    radio.checked = radio.value === normalizedTier;
    const card = radio.closest('.admin-plan-radio-card');
    if (card) {
      card.classList.toggle('selected', radio.checked);
    }
  });

  radios.forEach((radio) => {
    radio.onchange = () => {
      radios.forEach((r) => {
        r.checked = (r === radio);
        const c = r.closest('.admin-plan-radio-card');
        if (c) c.classList.toggle('selected', r.checked);
      });
    };

    const card = radio.closest('.admin-plan-radio-card');
    if (card) {
      card.onclick = () => {
        radio.checked = true;
        if (typeof radio.onchange === 'function') {
          radio.onchange();
        }
      };
    }
  });

  // Handle form submission
  formEl.onsubmit = async (e) => {
    e.preventDefault();

    const selectedRadio = modalEl.querySelector('input[name="plan-tier"]:checked');
    const targetTier = selectedRadio ? selectedRadio.value : 'free';
    const reason = (reasonInput?.value || '').trim();

    if (!reason) {
      if (errorEl) {
        errorEl.removeAttribute('hidden');
        errorEl.textContent = 'Reason for change is required for compliance audit logging.';
      }
      reasonInput?.focus();
      return;
    }

    if (errorEl) {
      errorEl.setAttribute('hidden', '');
      errorEl.textContent = '';
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Updating Plan...';
    }

    try {
      const payload = {
        tier: targetTier,
        manualOverride: Boolean(overrideCheckbox?.checked),
        reason,
      };

      const customQuotaVal = parseInt(customQuotaInput?.value, 10);
      if (!isNaN(customQuotaVal) && customQuotaVal > 0) {
        payload.customMonthlyQuota = customQuotaVal;
      }

      await adminFetch(`/admin/users/${encodeURIComponent(userId)}/plan`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      closeModal(modalEl);
      showToast(`Plan updated to ${targetTier.toUpperCase()} for ${userEmail || userId}`, 'success');

      // Dispatch user-updated event to reload open dossier drawer
      const updateEvt = new CustomEvent('user-updated', {
        bubbles: true,
        composed: true,
        detail: { userId, tier: targetTier },
      });
      window.dispatchEvent(updateEvt);
    } catch (err) {
      console.error('Plan update failed:', err);
      if (errorEl) {
        errorEl.removeAttribute('hidden');
        errorEl.textContent = err.message || 'Failed to update user plan. Please try again.';
      }
      showToast(err.message || 'Failed to update plan', 'error');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Update Plan';
      }
    }
  };

  openModal(modalEl);
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
      submitBtn.textContent = 'Applying adjustment...';
    }

    try {
      await adminFetch(`/admin/users/${encodeURIComponent(userId)}/quota`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      closeModal(modalEl);

      const successMsg = action === 'add_credits'
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
        submitBtn.textContent = 'Grant Credits';
      }
    }
  };

  openModal(modalEl);
  window.customSelect?.init();
}

/**
 * Initializes listeners for plan and quota modals.
 */
export function initPlanQuotaModals() {
  if (isInitialized) return;
  isInitialized = true;

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('open-change-plan', (e) => {
      openChangePlanModal(e.detail);
    });
    window.addEventListener('admin-open-change-plan', (e) => {
      openChangePlanModal(e.detail);
    });

    window.addEventListener('open-grant-credits', (e) => {
      openGrantCreditsModal(e.detail);
    });
    window.addEventListener('admin-open-grant-credits', (e) => {
      openGrantCreditsModal(e.detail);
    });
  }
}
