import test from 'node:test';
import assert from 'node:assert/strict';
import billingModule from './features/billing.js';

test('startCheckout, openBillingPortal, and changePlan call apiRequest with expected parameters', async () => {
  const calls = [];
  global.apiRequest = async (path, options) => {
    calls.push({ path, options });
    return { ok: true, url: 'https://billing.example.com/portal' };
  };
  global.authHeaders = () => ({
    Authorization: 'Bearer test_token',
    'Content-Type': 'application/json',
  });

  await billingModule.startCheckout('starter_annual');
  assert.strictEqual(calls[0].path, '/billing/checkout');
  assert.strictEqual(calls[0].options.method, 'POST');
  assert.strictEqual(calls[0].options.headers.Authorization, 'Bearer test_token');
  assert.deepStrictEqual(JSON.parse(calls[0].options.body), { plan: 'starter_annual' });

  await billingModule.openBillingPortal();
  assert.strictEqual(calls[1].path, '/billing/portal');
  assert.strictEqual(calls[1].options.method, 'POST');
  assert.strictEqual(calls[1].options.headers.Authorization, 'Bearer test_token');

  await billingModule.changePlan('pro_monthly');
  assert.strictEqual(calls[2].path, '/billing/change-plan');
  assert.strictEqual(calls[2].options.method, 'POST');
  assert.strictEqual(calls[2].options.headers.Authorization, 'Bearer test_token');
  assert.deepStrictEqual(JSON.parse(calls[2].options.body), { plan: 'pro_monthly' });
});

test('loadPaddleScript resolves Paddle from global/window when already loaded', async () => {
  const mockPaddle = { Environment: { set: () => {} }, Initialize: () => {}, Checkout: { open: () => {} } };
  global.Paddle = mockPaddle;
  global.window = { Paddle: mockPaddle };

  const loaded = await billingModule.loadPaddleScript();
  assert.strictEqual(loaded, mockPaddle);
});

test('openPaddleCheckout initializes and opens checkout with proper config', async () => {
  billingModule._resetPaddleInitialized();

  let initializedWith = null;
  let openedWith = null;
  let envSet = null;

  global.Paddle = {
    Environment: {
      set: (env) => {
        envSet = env;
      },
    },
    Initialize: (cfg) => {
      initializedWith = cfg;
    },
    Checkout: {
      open: (opts) => {
        openedWith = opts;
      },
    },
  };
  global.window = { Paddle: global.Paddle };

  await billingModule.openPaddleCheckout({
    clientToken: 'live_ptxn_123',
    transactionId: 'txn_98765',
    environment: 'sandbox',
  });

  assert.strictEqual(envSet, 'sandbox');
  assert.strictEqual(initializedWith.token, 'live_ptxn_123');
  assert.strictEqual(typeof initializedWith.eventCallback, 'function');
  assert.strictEqual(openedWith.transactionId, 'txn_98765');
  assert.strictEqual(openedWith.settings.displayMode, 'overlay');
  assert.strictEqual(billingModule.isPaddleInitialized(), true);

  // Second open should reuse initialization without re-initializing
  initializedWith = null;
  await billingModule.openPaddleCheckout({
    clientToken: 'live_ptxn_123',
    transactionId: 'txn_second',
  });
  assert.strictEqual(initializedWith, null);
  assert.strictEqual(openedWith.transactionId, 'txn_second');
});

test('openPaddleCheckout throws error if clientToken or transactionId is missing', async () => {
  await assert.rejects(
    async () => {
      await billingModule.openPaddleCheckout({ clientToken: 'token_only' });
    },
    { message: 'Paddle Checkout is unavailable' }
  );

  await assert.rejects(
    async () => {
      await billingModule.openPaddleCheckout({ transactionId: 'txn_only' });
    },
    { message: 'Paddle Checkout is unavailable' }
  );
});

test('formatBillingDetail formats details accurately for different billing states', () => {
  assert.strictEqual(
    billingModule.formatBillingDetail({ status: 'free' }),
    'Upgrade for more monthly PDF capacity.'
  );

  const activeBilling = {
    status: 'active',
    renewsAt: '2026-11-01T00:00:00Z',
  };
  const activeFormatted = billingModule.formatBillingDetail(activeBilling);
  assert.ok(activeFormatted.startsWith('active · renews'));

  const scheduledCancelBilling = {
    status: 'active',
    scheduledChange: {
      action: 'cancel',
      effectiveAt: '2026-12-01T00:00:00Z',
    },
  };
  const cancelFormatted = billingModule.formatBillingDetail(scheduledCancelBilling);
  assert.ok(cancelFormatted.includes('active · cancels'));
});

test('renderBillingView updates DOM elements based on tier and status', () => {
  const elements = {
    billingPlan: { textContent: '' },
    billingDetail: { textContent: '' },
    billingUsageDetail: { textContent: '' },
    upgradePlanBtn: { textContent: '', hidden: false },
    buyOverageBtn: { hidden: false, classList: new Set(), classes: new Set() },
    manageBillingBtn: { hidden: false },
    overviewPlanAction: {
      strong: { textContent: '' },
      span: { textContent: '' },
      querySelector(sel) {
        if (sel === 'strong') return this.strong;
        if (sel === 'span') return this.span;
        return null;
      },
    },
  };

  const planButtons = [
    { dataset: { plan: 'starter' }, hidden: false },
    { dataset: { plan: 'pro' }, hidden: false },
  ];

  elements.buyOverageBtn.classList = {
    remove(cls) { elements.buyOverageBtn.classes.delete(cls); },
    add(cls) { elements.buyOverageBtn.classes.add(cls); },
  };

  global.document = {
    getElementById(id) {
      return elements[id] || null;
    },
    querySelectorAll(sel) {
      if (sel === '[data-plan]') return planButtons;
      return [];
    },
  };

  billingModule.renderBillingView(
    { status: 'active', tier: 'starter', plan: 'Starter' },
    { usedThisMonth: 120, quota: 5000, remaining: 4880 }
  );

  assert.strictEqual(elements.billingPlan.textContent, 'Starter');
  assert.strictEqual(elements.upgradePlanBtn.textContent, 'Change plan');
  assert.strictEqual(elements.manageBillingBtn.hidden, false);
  assert.strictEqual(planButtons[0].hidden, true); // Starter plan button is hidden
  assert.strictEqual(planButtons[1].hidden, false); // Pro plan button is visible
  assert.strictEqual(elements.overviewPlanAction.strong.textContent, 'Manage plan');
});

test('switchBillingInterval toggles button states and options panels', () => {
  const monthlyBtn = {
    dataset: { dialogInterval: 'monthly' },
    classes: new Set(['is-active']),
    attributes: { 'aria-pressed': 'true' },
    classList: {
      toggle(cls, force) {
        if (force) monthlyBtn.classes.add(cls);
        else monthlyBtn.classes.delete(cls);
      },
    },
    setAttribute(k, v) { monthlyBtn.attributes[k] = v; },
  };

  const annualBtn = {
    dataset: { dialogInterval: 'annual' },
    classes: new Set(),
    attributes: { 'aria-pressed': 'false' },
    classList: {
      toggle(cls, force) {
        if (force) annualBtn.classes.add(cls);
        else annualBtn.classes.delete(cls);
      },
    },
    setAttribute(k, v) { annualBtn.attributes[k] = v; },
  };

  const monthlyOptions = { hidden: false };
  const annualOptions = { hidden: true };

  global.document = {
    getElementById(id) {
      if (id === 'monthlyPlanOptions') return monthlyOptions;
      if (id === 'annualPlanOptions') return annualOptions;
      return null;
    },
    querySelectorAll(sel) {
      if (sel.includes('dashboard-interval-btn')) return [monthlyBtn, annualBtn];
      return [];
    },
  };

  billingModule.switchBillingInterval('annual');

  assert.strictEqual(monthlyBtn.classes.has('is-active'), false);
  assert.strictEqual(monthlyBtn.attributes['aria-pressed'], 'false');
  assert.strictEqual(annualBtn.classes.has('is-active'), true);
  assert.strictEqual(annualBtn.attributes['aria-pressed'], 'true');
  assert.strictEqual(monthlyOptions.hidden, true);
  assert.strictEqual(annualOptions.hidden, false);
});

test('handleBuyOverage triggers startCheckout and openPaddleCheckout', async () => {
  const calls = [];
  global.apiRequest = async (path, options) => {
    calls.push({ path, options });
    return { clientToken: 'token_123', transactionId: 'txn_123' };
  };
  global.authHeaders = () => ({ Authorization: 'Bearer token' });

  let openedCheckout = null;
  global.Paddle = {
    Environment: { set: () => {} },
    Initialize: () => {},
    Checkout: {
      open: (opts) => {
        openedCheckout = opts;
      },
    },
  };
  global.window = { Paddle: global.Paddle };

  const button = {
    dataset: {},
    classList: { toggle: () => {} },
    setAttribute: () => {},
  };
  const billingStatus = { textContent: '', dataset: {}, hidden: true };
  global.document = {
    getElementById(id) {
      if (id === 'billingStatus') return billingStatus;
      return null;
    },
  };

  await billingModule.handleBuyOverage(button);

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].path, '/billing/checkout');
  assert.deepStrictEqual(JSON.parse(calls[0].options.body), { plan: 'overage' });
  assert.strictEqual(openedCheckout.transactionId, 'txn_123');
  assert.ok(billingStatus.textContent.includes('Complete payment to add 1,000 PDFs'));
});

test('initBillingListeners binds click events to dialog, plans, and portal', async () => {
  billingModule.renderBillingView({ status: 'free', tier: 'free', plan: 'Free' });
  let modalOpened = false;
  let modalClosed = false;
  const upgradeBtnListeners = [];
  const closeBtnListeners = [];
  const planBtnListeners = [];
  const manageBtnListeners = [];

  const dialog = {
    showModal: () => { modalOpened = true; },
    close: () => { modalClosed = true; },
  };
  const dialogTitle = { textContent: '' };
  const upgradeBtn = {
    addEventListener: (evt, fn) => { if (evt === 'click') upgradeBtnListeners.push(fn); },
  };
  const closeBtn = {
    addEventListener: (evt, fn) => { if (evt === 'click') closeBtnListeners.push(fn); },
  };
  const planBtn = {
    dataset: { plan: 'pro_annual' },
    addEventListener: (evt, fn) => { if (evt === 'click') planBtnListeners.push(fn); },
    classList: { toggle: () => {} },
    setAttribute: () => {},
  };
  const manageBtn = {
    addEventListener: (evt, fn) => { if (evt === 'click') manageBtnListeners.push(fn); },
    classList: { toggle: () => {} },
    setAttribute: () => {},
  };

  global.document = {
    getElementById(id) {
      if (id === 'upgradePlanBtn') return upgradeBtn;
      if (id === 'billingPlanDialog') return dialog;
      if (id === 'billingPlanDialogTitle') return dialogTitle;
      if (id === 'billingPlanDialogClose') return closeBtn;
      if (id === 'manageBillingBtn') return manageBtn;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '[data-plan]') return [planBtn];
      return [];
    },
  };

  billingModule.initBillingListeners();

  assert.strictEqual(upgradeBtnListeners.length, 1);
  assert.strictEqual(closeBtnListeners.length, 1);
  assert.strictEqual(planBtnListeners.length, 1);
  assert.strictEqual(manageBtnListeners.length, 1);

  // Trigger open dialog
  upgradeBtnListeners[0]();
  assert.strictEqual(modalOpened, true);
  assert.strictEqual(dialogTitle.textContent, 'Choose the capacity you need');

  // Trigger close dialog
  closeBtnListeners[0]();
  assert.strictEqual(modalClosed, true);
});

