import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mockToken,
  createMockElement,
  sampleDossierResponse,
} from './test-dom-mock.js';
import { openUserDossier, getOrCreateDrawerElement } from './users-dossier.js';

test('openUserDossier fetches user dossier from API and renders all 6 sub-panels', async () => {
  const fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      json: async () => sampleDossierResponse,
    };
  };

  const userId = 'c1f7b76e-3c2e-4b21-8273-df3e18a992bc';
  await openUserDossier(userId);

  assert.strictEqual(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].url.includes(`/users/${userId}`));
  assert.strictEqual(fetchCalls[0].opts.headers.Authorization, `Bearer ${mockToken}`);

  const drawer = global.document.getElementById('admin-user-dossier-drawer');
  assert.ok(drawer, 'Drawer element exists in document');
  assert.strictEqual(drawer.hasAttribute('hidden'), false, 'Drawer is visible (not hidden)');
  assert.strictEqual(drawer.getAttribute('role'), 'dialog');
  assert.strictEqual(drawer.getAttribute('aria-modal'), 'true');

  const html = drawer.innerHTML;

  // Card A: Identity
  assert.ok(html.includes('Customer Identity'), 'Card A title rendered');
  assert.ok(html.includes('c1f7b76e-3c2e-4b21-8273-df3e18a992bc'), 'Full Cognito sub rendered');
  assert.ok(html.includes('customer@acme.com'), 'Email rendered');
  assert.ok(html.includes('Verified'), 'Email verified badge rendered');
  assert.ok(html.includes('Enabled'), 'Account status rendered');
  assert.ok(html.includes('2026'), 'Created date rendered');

  // Card B: Plan & Billing
  assert.ok(
    html.includes('Plan &amp; Billing') || html.includes('Plan & Billing'),
    'Card B title rendered'
  );
  assert.ok(html.includes('RenderPDF Starter'), 'Plan name rendered');
  assert.ok(html.includes('badge-starter'), 'Starter tier badge rendered');
  assert.ok(html.includes('Paddle Billing'), 'Provider rendered');
  assert.ok(html.includes('sub_01h6t8z1234567890abcdef'), 'Subscription ID rendered');
  assert.ok(html.includes('id="admin-dossier-change-plan-btn"'), 'Change Plan button rendered');

  // Card C: Quota
  assert.ok(html.includes('Monthly Render Quota'), 'Card C title rendered');
  assert.ok(html.includes('412'), 'Used quota rendered');
  assert.ok(html.includes('5,000'), 'Limit quota rendered');
  assert.ok(html.includes('8%'), 'Quota percentage rendered');
  assert.ok(html.includes('id="admin-dossier-grant-credits-btn"'), 'Grant Credits button rendered');

  // Card D: API Keys
  assert.ok(html.includes('Active API Keys (2)'), 'Card D title rendered');
  assert.ok(html.includes('Production Backend'), 'Key 1 name rendered');
  assert.ok(
    html.includes('key_9f82d1c3a4…') || html.includes('key_9f82d1c3a4'),
    'Key 1 masked ID rendered'
  );
  assert.ok(html.includes('Legacy Staging Key'), 'Key 2 name rendered');
  assert.ok(html.includes('Revoke'), 'Revoke button rendered for active key');

  // Card E: Recent Telemetry
  assert.ok(html.includes('Recent Render Telemetry (2)'), 'Card E title rendered');
  assert.ok(html.includes('200 OK'), 'Success status rendered');
  assert.ok(html.includes('482 ms'), 'Duration rendered');
  assert.ok(
    html.includes('180.6 KB') || html.includes('184.9 KB') || html.includes('KB'),
    'Size rendered'
  );
  assert.ok(html.includes('NavigationTimeout'), 'Error type rendered for failed request');

  // Card F: Danger Zone
  assert.ok(html.includes('Danger Zone'), 'Card F title rendered');
  assert.ok(
    html.includes('id="admin-dossier-suspend-user-btn"'),
    'Suspend Account button rendered'
  );
});

test('drawer keyboard focus trap and Escape key closes drawer and restores focus', async () => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => sampleDossierResponse,
  });

  const drawer = getOrCreateDrawerElement();

  // Simulate an Inspect button being focused
  const mockInspectBtn = createMockElement('button');
  mockInspectBtn.focus();
  assert.strictEqual(global.document.activeElement, mockInspectBtn);

  // Open drawer
  await openUserDossier('c1f7b76e-3c2e-4b21-8273-df3e18a992bc');
  assert.strictEqual(drawer.hasAttribute('hidden'), false);

  // Close button inside drawer should now have focus
  const closeBtn = drawer.querySelector('#admin-dossier-close-btn');
  assert.ok(closeBtn, 'Close button exists');
  assert.strictEqual(global.document.activeElement, closeBtn, 'Focus trapped to close button');

  // Press Escape
  global.document.dispatchEvent({ type: 'keydown', key: 'Escape' });

  // Drawer should be hidden
  assert.strictEqual(drawer.hasAttribute('hidden'), true, 'Drawer closed after Escape');

  // Focus should be restored to Inspect button
  assert.strictEqual(
    global.document.activeElement,
    mockInspectBtn,
    'Focus restored to Inspect button'
  );
});

test('backdrop click and close button close the drawer', async () => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => sampleDossierResponse,
  });

  const drawer = getOrCreateDrawerElement();

  // 1. Close via close button
  await openUserDossier('c1f7b76e-3c2e-4b21-8273-df3e18a992bc');
  assert.strictEqual(drawer.hasAttribute('hidden'), false);

  const closeBtn = drawer.querySelector('#admin-dossier-close-btn');
  closeBtn.dispatchEvent({ type: 'click', target: closeBtn });
  assert.strictEqual(drawer.hasAttribute('hidden'), true);

  // 2. Close via backdrop click
  await openUserDossier('c1f7b76e-3c2e-4b21-8273-df3e18a992bc');
  assert.strictEqual(drawer.hasAttribute('hidden'), false);

  drawer.dispatchEvent({ type: 'click', target: drawer });
  assert.strictEqual(drawer.hasAttribute('hidden'), true);
});

test('action buttons dispatch custom events for Plans and Governance features', async () => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => sampleDossierResponse,
  });

  const drawer = getOrCreateDrawerElement();
  const dispatchedEvents = [];
  const captureEvent = (e) => dispatchedEvents.push(e);

  global.window.addEventListener('open-change-plan', captureEvent);
  global.window.addEventListener('open-grant-credits', captureEvent);
  global.window.addEventListener('open-revoke-key', captureEvent);
  global.window.addEventListener('open-suspend-user', captureEvent);

  await openUserDossier('c1f7b76e-3c2e-4b21-8273-df3e18a992bc');

  // 1. Click Change Plan
  const changePlanBtn = drawer.querySelector('#admin-dossier-change-plan-btn');
  assert.ok(changePlanBtn, 'Change Plan button exists');
  changePlanBtn.dispatchEvent({ type: 'click', target: changePlanBtn });

  const planEvt = dispatchedEvents.find((e) => e.type === 'open-change-plan');
  assert.ok(planEvt, 'open-change-plan event dispatched');
  assert.strictEqual(planEvt.detail.userId, 'c1f7b76e-3c2e-4b21-8273-df3e18a992bc');
  assert.strictEqual(planEvt.detail.userEmail, 'customer@acme.com');
  assert.strictEqual(planEvt.detail.currentTier, 'starter');

  // 2. Click Grant Credits
  const grantCreditsBtn = drawer.querySelector('#admin-dossier-grant-credits-btn');
  assert.ok(grantCreditsBtn, 'Grant Credits button exists');
  grantCreditsBtn.dispatchEvent({ type: 'click', target: grantCreditsBtn });

  const creditsEvt = dispatchedEvents.find((e) => e.type === 'open-grant-credits');
  assert.ok(creditsEvt, 'open-grant-credits event dispatched');
  assert.strictEqual(creditsEvt.detail.userId, 'c1f7b76e-3c2e-4b21-8273-df3e18a992bc');
  assert.strictEqual(creditsEvt.detail.currentQuota.used, 412);
  assert.strictEqual(creditsEvt.detail.currentQuota.limit, 5000);

  // 3. Click Revoke Key
  const revokeBtn = drawer.querySelector('.admin-btn-revoke-key');
  assert.ok(revokeBtn, 'Revoke Key button exists');
  revokeBtn.dispatchEvent({ type: 'click', target: revokeBtn });

  const revokeEvt = dispatchedEvents.find((e) => e.type === 'open-revoke-key');
  assert.ok(revokeEvt, 'open-revoke-key event dispatched');
  assert.strictEqual(revokeEvt.detail.userId, 'c1f7b76e-3c2e-4b21-8273-df3e18a992bc');
  assert.strictEqual(revokeEvt.detail.keyId, 'key_9f82d1c3a4b5c6d7e8f90123');

  // 4. Click Suspend User
  const suspendBtn = drawer.querySelector('#admin-dossier-suspend-user-btn');
  assert.ok(suspendBtn, 'Suspend User button exists');
  suspendBtn.dispatchEvent({ type: 'click', target: suspendBtn });

  const suspendEvt = dispatchedEvents.find((e) => e.type === 'open-suspend-user');
  assert.ok(suspendEvt, 'open-suspend-user event dispatched');
  assert.strictEqual(suspendEvt.detail.userId, 'c1f7b76e-3c2e-4b21-8273-df3e18a992bc');
  assert.strictEqual(suspendEvt.detail.enabled, true);
});

test('handles network error in openUserDossier and supports retry', async () => {
  let attempt = 0;
  global.fetch = async () => {
    attempt++;
    if (attempt === 1) {
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: 'Cognito service unavailable' }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => sampleDossierResponse,
    };
  };

  const drawer = getOrCreateDrawerElement();

  try {
    await openUserDossier('c1f7b76e-3c2e-4b21-8273-df3e18a992bc');
  } catch (_) {}

  // 1. Error state banner rendered
  assert.ok(drawer.innerHTML.includes('Failed to load customer dossier'));
  assert.ok(drawer.innerHTML.includes('Cognito service unavailable'));

  const retryBtn = drawer.querySelector('#admin-dossier-retry-btn');
  assert.ok(retryBtn, 'Retry button exists');

  // 2. Click retry
  retryBtn.dispatchEvent({ type: 'click', target: retryBtn });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.strictEqual(attempt, 2);
  // 3. Dossier successfully rendered on retry
  assert.ok(drawer.innerHTML.includes('Customer Identity'));
  assert.ok(drawer.innerHTML.includes('customer@acme.com'));
});

test('adminFetch seamlessly falls back from /api/v1/admin/users to /api/v1/analytics?route=... on AWS unmapped 403', async () => {
  const urlsAttempted = [];
  global.fetch = async (url) => {
    urlsAttempted.push(url);
    if (url.startsWith('/api/v1/admin/users')) {
      return {
        ok: false,
        status: 403,
        json: async () => ({
          message:
            "Invalid key=value pair (missing equal-sign) in Authorization header (hashed with SHA-256 and encoded with Base64): '...'",
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        users: [
          {
            id: 'user-fallback-1',
            email: 'fallback@example.com',
            tier: 'starter',
            status: 'active',
            provider: 'paddle',
            manualOverride: false,
            quotaUsed: 10,
            quotaLimit: 5000,
            quotaMonth: '2026-09',
            activeKeys: 1,
            createdAt: '2026-09-01T12:00:00Z',
          },
        ],
        nextCursor: null,
      }),
    };
  };

  const { adminFetch } = await import('../../shared/api.js');
  const data = await adminFetch('/admin/users?limit=25');

  assert.strictEqual(urlsAttempted.length, 2);
  assert.strictEqual(urlsAttempted[0], '/api/v1/admin/users?limit=25');
  assert.strictEqual(urlsAttempted[1], '/api/v1/analytics?route=admin%2Fusers&limit=25');
  assert.strictEqual(data.users.length, 1);
  assert.strictEqual(data.users[0].email, 'fallback@example.com');
});
