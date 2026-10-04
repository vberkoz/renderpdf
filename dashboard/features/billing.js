(function (global) {
  'use strict';

  let paddleInitialized = false;
  let currentBilling = { status: 'free', tier: 'free' };

  function getAuthHeaders() {
    if (typeof global.authHeaders === 'function') {
      return global.authHeaders();
    }
    if (typeof authHeaders === 'function') {
      return authHeaders();
    }
    return {};
  }

  function callApiRequest(path, options) {
    if (typeof global.apiRequest === 'function') {
      return global.apiRequest(path, options);
    }
    if (typeof apiRequest === 'function') {
      return apiRequest(path, options);
    }
    throw new Error('apiRequest is not defined');
  }

  function helperSetNotice(element, message = '', state = '') {
    if (typeof global.setNotice === 'function') {
      return global.setNotice(element, message, state);
    }
    if (typeof setNotice === 'function') {
      return setNotice(element, message, state);
    }
    if (element) {
      element.textContent = message;
      element.dataset.state = state;
      element.hidden = !message;
    }
  }

  function helperSetButtonPending(button, pending, pendingLabel) {
    if (typeof global.setButtonPending === 'function') {
      return global.setButtonPending(button, pending, pendingLabel);
    }
    if (typeof setButtonPending === 'function') {
      return setButtonPending(button, pending, pendingLabel);
    }
    if (button) {
      if (!button.dataset.label) button.dataset.label = button.innerHTML;
      button.disabled = pending;
      button.setAttribute('aria-busy', String(pending));
      button.classList.toggle('is-processing', pending);
      button.innerHTML = pending ? pendingLabel : button.dataset.label;
    }
  }

  async function triggerRefreshDashboard(preserveNotice = false) {
    if (typeof global.refreshDashboard === 'function') {
      return global.refreshDashboard(preserveNotice);
    }
    if (typeof refreshDashboard === 'function') {
      return refreshDashboard(preserveNotice);
    }
  }

  function startCheckout(plan) {
    return callApiRequest('/billing/checkout', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ plan }),
    });
  }

  function openBillingPortal() {
    return callApiRequest('/billing/portal', {
      method: 'POST',
      headers: getAuthHeaders(),
    });
  }

  function changePlan(plan) {
    return callApiRequest('/billing/change-plan', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ plan }),
    });
  }

  function loadPaddleScript() {
    if (typeof window !== 'undefined' && window.Paddle) return Promise.resolve(window.Paddle);
    if (typeof global !== 'undefined' && global.Paddle) return Promise.resolve(global.Paddle);
    if (typeof document === 'undefined') {
      return Promise.reject(new Error('document is not defined to load Paddle script'));
    }
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
      script.async = true;
      script.onload = () => resolve((typeof window !== 'undefined' && window.Paddle) || (typeof global !== 'undefined' && global.Paddle));
      script.onerror = () => reject(new Error('Could not load Paddle Checkout'));
      document.head.appendChild(script);
    });
  }

  async function openPaddleCheckout(checkout) {
    const Paddle = await loadPaddleScript();
    if (!Paddle || !checkout || !checkout.clientToken || !checkout.transactionId) {
      throw new Error('Paddle Checkout is unavailable');
    }
    if (!paddleInitialized) {
      if (checkout.environment === 'sandbox' && Paddle.Environment && typeof Paddle.Environment.set === 'function') {
        Paddle.Environment.set('sandbox');
      }
      Paddle.Initialize({
        token: checkout.clientToken,
        eventCallback(event) {
          if (event?.name === 'checkout.completed') {
            const refreshFn = typeof global.refreshDashboard === 'function'
              ? global.refreshDashboard
              : (typeof refreshDashboard === 'function' ? refreshDashboard : null);
            if (refreshFn && typeof setTimeout === 'function') {
              setTimeout(refreshFn, 1500);
              setTimeout(refreshFn, 5000);
            }
          }
        },
      });
      paddleInitialized = true;
    }
    Paddle.Checkout.open({
      transactionId: checkout.transactionId,
      settings: { displayMode: 'overlay', theme: 'light' },
    });
  }

  function isPaddleInitialized() {
    return paddleInitialized;
  }

  function _resetPaddleInitialized() {
    paddleInitialized = false;
  }

  function formatBillingDetail(billing) {
    if (!billing || billing.status === 'free') {
      return 'Upgrade for more monthly PDF capacity.';
    }
    const scheduledChange = billing.scheduledChange;
    const scheduledLabel = scheduledChange?.effectiveAt
      ? ` · ${scheduledChange.action === 'cancel' ? 'cancels' : `${scheduledChange.action}s`} ${new Date(scheduledChange.effectiveAt).toLocaleDateString()}`
      : '';
    return `${billing.status.replace(/_/g, ' ')}${scheduledLabel || (billing.renewsAt ? ` · renews ${new Date(billing.renewsAt).toLocaleDateString()}` : '')}`;
  }

  function renderBillingView(billing = { status: 'free', plan: 'Free' }, usage = {}) {
    currentBilling = billing;
    try {
      global.currentBilling = billing;
    } catch (e) {}

    if (typeof document === 'undefined') return;

    const billingPlanEl = document.getElementById('billingPlan');
    if (billingPlanEl) {
      billingPlanEl.textContent = billing.plan || 'Free';
    }

    const billingDetailEl = document.getElementById('billingDetail');
    if (billingDetailEl) {
      billingDetailEl.textContent = formatBillingDetail(billing);
    }

    const billingUsageDetailEl = document.getElementById('billingUsageDetail');
    if (billingUsageDetailEl) {
      billingUsageDetailEl.textContent =
        `Current usage: ${usage.usedThisMonth ?? 0} of ${usage.quota ?? 0} PDFs this month`;
    }

    const subscribed = ['active', 'trialing', 'past_due'].includes(billing.status);
    const canChangePlan = subscribed && ['active', 'trialing'].includes(billing.status);

    if (document.querySelectorAll) {
      document.querySelectorAll('[data-plan]').forEach((button) => {
        button.hidden = subscribed && button.dataset.plan === billing.tier;
      });
    }

    const upgradePlanBtn = document.getElementById('upgradePlanBtn');
    if (upgradePlanBtn) {
      upgradePlanBtn.textContent = subscribed ? 'Change plan' : 'Upgrade plan';
      upgradePlanBtn.hidden = subscribed && !canChangePlan;
    }

    const isExhausted = (usage.remaining ?? 0) <= 0;
    const buyOverageBtn = document.getElementById('buyOverageBtn');
    if (buyOverageBtn) {
      buyOverageBtn.hidden = false;
      if (isExhausted) {
        buyOverageBtn.classList.remove('dashboard-button-secondary');
        buyOverageBtn.classList.add('dashboard-button-primary');
      } else {
        buyOverageBtn.classList.remove('dashboard-button-primary');
        buyOverageBtn.classList.add('dashboard-button-secondary');
      }
    }

    const manageBillingBtn = document.getElementById('manageBillingBtn');
    if (manageBillingBtn) {
      manageBillingBtn.hidden = !subscribed;
    }

    const overviewPlanAction = document.getElementById('overviewPlanAction');
    if (overviewPlanAction) {
      const strong = overviewPlanAction.querySelector('strong');
      if (strong) strong.textContent = subscribed ? 'Manage plan' : 'Upgrade plan';
      const span = overviewPlanAction.querySelector('span');
      if (span) {
        span.textContent = subscribed
          ? 'Review billing and subscription details.'
          : 'Increase your monthly PDF capacity.';
      }
    }
  }

  function switchBillingInterval(interval) {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('.dashboard-interval-btn, .billing-interval-btn').forEach((b) => {
      const btnInterval = b.dataset.dialogInterval || b.dataset.billingInterval;
      const isActive = btnInterval === interval;
      b.classList.toggle('is-active', isActive);
      b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
    const monthlyOptions = document.getElementById('monthlyPlanOptions');
    const annualOptions = document.getElementById('annualPlanOptions');
    if (monthlyOptions && annualOptions) {
      monthlyOptions.hidden = interval === 'annual';
      annualOptions.hidden = interval !== 'annual';
    }
  }

  async function handleBuyOverage(button) {
    const billingStatus = typeof document !== 'undefined' ? document.getElementById('billingStatus') : null;
    helperSetButtonPending(button, true, 'Opening checkout...');
    try {
      const data = await startCheckout('overage');
      await openPaddleCheckout(data);
      helperSetNotice(billingStatus, 'Complete payment to add 1,000 PDFs to this month’s allowance.');
    } catch (error) {
      helperSetNotice(billingStatus, `Could not start overage checkout. ${error.message}`, 'error');
    } finally {
      helperSetButtonPending(button, false);
    }
  }

  function initBillingListeners() {
    if (typeof document === 'undefined') return;

    const upgradePlanBtn = document.getElementById('upgradePlanBtn');
    const billingPlanDialog = document.getElementById('billingPlanDialog');
    const billingPlanDialogTitle = document.getElementById('billingPlanDialogTitle');
    const billingPlanDialogClose = document.getElementById('billingPlanDialogClose');

    if (upgradePlanBtn && billingPlanDialog) {
      upgradePlanBtn.addEventListener('click', () => {
        if (billingPlanDialogTitle) {
          const status = (global.currentBilling || currentBilling)?.status;
          billingPlanDialogTitle.textContent =
            status === 'free' ? 'Choose the capacity you need' : 'Choose a new plan';
        }
        billingPlanDialog.showModal();
      });
    }

    if (billingPlanDialogClose && billingPlanDialog) {
      billingPlanDialogClose.addEventListener('click', () => billingPlanDialog.close());
    }

    document.querySelectorAll('.dashboard-interval-btn, .billing-interval-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const interval = btn.dataset.dialogInterval || btn.dataset.billingInterval;
        if (interval) {
          switchBillingInterval(interval);
        }
      });
    });

    document.querySelectorAll('[data-plan]').forEach((button) =>
      button.addEventListener('click', async () => {
        const billingStatus = document.getElementById('billingStatus');
        const status = (global.currentBilling || currentBilling)?.status;
        const changingPlan = ['active', 'trialing'].includes(status);
        helperSetButtonPending(button, true, changingPlan ? 'Changing plan...' : 'Opening checkout...');
        try {
          if (changingPlan) {
            await changePlan(button.dataset.plan);
            document.getElementById('billingPlanDialog')?.close();
            helperSetNotice(billingStatus, 'Plan changed successfully.');
            helperSetButtonPending(button, false);
            await triggerRefreshDashboard(true);
          } else {
            const data = await startCheckout(button.dataset.plan);
            document.getElementById('billingPlanDialog')?.close();
            await openPaddleCheckout(data);
            helperSetButtonPending(button, false);
          }
        } catch (error) {
          helperSetNotice(
            billingStatus,
            `Could not ${changingPlan ? 'change the plan' : 'start checkout'}. ${error.message}`,
            'error'
          );
          helperSetButtonPending(button, false);
        }
      })
    );

    const manageBillingBtn = document.getElementById('manageBillingBtn');
    if (manageBillingBtn) {
      manageBillingBtn.addEventListener('click', async () => {
        helperSetButtonPending(manageBillingBtn, true, 'Opening portal…');
        const billingStatus = document.getElementById('billingStatus');
        // Reserve the tab during the user gesture so browsers do not block the
        // portal after the asynchronous session request completes.
        const portalTab = (typeof window !== 'undefined' && window.open) ? window.open('about:blank', '_blank') : null;
        if (portalTab) portalTab.opener = null;
        try {
          const data = await openBillingPortal();
          if (portalTab) {
            portalTab.location.replace(data.url);
          } else if (typeof window !== 'undefined' && window.open) {
            window.open(data.url, '_blank', 'noopener,noreferrer');
          }
        } catch (error) {
          portalTab?.close();
          helperSetNotice(billingStatus, `Could not open billing. ${error.message}`, 'error');
        } finally {
          helperSetButtonPending(manageBillingBtn, false);
        }
      });
    }

    document.getElementById('buyOverageBtn')?.addEventListener('click', (event) => {
      handleBuyOverage(event.currentTarget);
    });

    document.getElementById('dialogBuyOverageBtn')?.addEventListener('click', (event) => {
      document.getElementById('billingPlanDialog')?.close();
      handleBuyOverage(event.currentTarget);
    });
  }

  const moduleExports = {
    startCheckout,
    openBillingPortal,
    changePlan,
    loadPaddleScript,
    openPaddleCheckout,
    isPaddleInitialized,
    _resetPaddleInitialized,
    formatBillingDetail,
    renderBillingView,
    switchBillingInterval,
    handleBuyOverage,
    initBillingListeners,
  };

  // Expose currentBilling getter/setter on global for compatibility
  try {
    Object.defineProperty(global, 'currentBilling', {
      get: () => currentBilling,
      set: (val) => {
        currentBilling = val;
      },
      configurable: true,
      enumerable: true,
    });
  } catch (e) {}

  // Expose on global window object for browser scripts
  Object.assign(global, moduleExports);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = moduleExports;
  }
})(typeof window === 'undefined' ? globalThis : window);
