/**
 * Master Controller for RenderPDF Admin Console
 * Manages operator authentication, RBAC authorization guards,
 * tab routing, and dynamic module loading.
 */

import { checkAdminAuth, signOut } from './shared/auth.js';
import { initPlanQuotaModals } from './features/plans/plans.js';
import { initGovernanceModals } from './features/audit-logs/governance.js';

const TABS = ['analytics', 'users', 'plans', 'audit-logs', 'chats'];
const DEFAULT_TAB = 'analytics';

/**
 * Resolves current tab from the URL hash.
 * @returns {string}
 */
function getActiveTabFromHash() {
  const hash = (window.location.hash || '').replace(/^#/, '').trim().toLowerCase();
  if (!hash || hash === 'overview') {
    return DEFAULT_TAB;
  }
  return TABS.includes(hash) ? hash : DEFAULT_TAB;
}

/**
 * Handles switching active tab and dynamically loading feature modules.
 * @param {string} tabName
 */
async function switchTab(tabName) {
  const targetTab = TABS.includes(tabName) ? tabName : DEFAULT_TAB;

  // Update URL hash if mismatched
  if (window.location.hash !== `#${targetTab}`) {
    history.replaceState(null, '', `#${targetTab}`);
  }

  // Update Tab Navigation state
  const tabNav = document.getElementById('admin-tab-nav');
  if (tabNav) {
    const navLinks = tabNav.querySelectorAll('a[role="tab"]');
    navLinks.forEach((link) => {
      const href = link.getAttribute('href') || '';
      const tabKey = href.replace(/^#/, '');
      const isActive = tabKey === targetTab;
      link.classList.toggle('active', isActive);
      link.setAttribute('aria-selected', String(isActive));
    });
  }

  // Show/Hide Tab Panes
  TABS.forEach((tab) => {
    const pane = document.getElementById(tab);
    if (!pane) return;

    if (tab === targetTab) {
      pane.removeAttribute('hidden');
    } else {
      pane.setAttribute('hidden', '');
    }
  });

  // Dynamically load feature module for active tab
  const activePane = document.getElementById(targetTab);
  if (!activePane) return;

  if (targetTab === 'analytics') {
    try {
      const { initAnalyticsTab } = await import('./features/analytics/analytics.js');
      await initAnalyticsTab(activePane);
    } catch (err) {
      console.error('Failed to load Analytics module:', err);
      activePane.innerHTML = `
        <div class="admin-error-banner" role="alert">
          <div class="admin-error-details">
            <span class="admin-error-icon"><svg class="lucide lucide-alert-triangle" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>
            <div>
              <h3 class="admin-error-title">Module Error</h3>
              <p class="admin-error-message">Could not load the Analytics tab module.</p>
            </div>
          </div>
        </div>
      `;
    }
  } else if (targetTab === 'users') {
    try {
      const { initUserDirectoryTab } = await import('./features/users/users.js');
      await initUserDirectoryTab(activePane);
    } catch (err) {
      console.error('Failed to load Users module:', err);
      activePane.innerHTML = `
        <div class="admin-error-banner" role="alert">
          <div class="admin-error-details">
            <span class="admin-error-icon"><svg class="lucide lucide-alert-triangle" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>
            <div>
              <h3 class="admin-error-title">Module Error</h3>
              <p class="admin-error-message">Could not load the User Directory tab module.</p>
            </div>
          </div>
        </div>
      `;
    }
  } else if (targetTab === 'audit-logs') {
    try {
      const { initGovernanceTab } = await import('./features/audit-logs/governance.js');
      await initGovernanceTab(activePane);
    } catch (err) {
      console.error('Failed to load Governance module:', err);
      activePane.innerHTML = `
        <div class="admin-error-banner" role="alert">
          <div class="admin-error-details">
            <span class="admin-error-icon"><svg class="lucide lucide-alert-triangle" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>
            <div>
              <h3 class="admin-error-title">Module Error</h3>
              <p class="admin-error-message">Could not load the Audit Trail tab module.</p>
            </div>
          </div>
        </div>
      `;
    }
  } else if (targetTab === 'chats') {
    try {
      const { initSupportChatTab } = await import('./features/support-chat/chat.js');
      await initSupportChatTab(activePane);
    } catch (err) {
      console.error('Failed to load Support Chat module:', err);
      activePane.innerHTML = `
        <div class="admin-error-banner" role="alert">
          <div class="admin-error-details">
            <span class="admin-error-icon"><svg class="lucide lucide-alert-triangle" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>
            <div>
              <h3 class="admin-error-title">Module Error</h3>
              <p class="admin-error-message">Could not load the Support Chat tab module.</p>
            </div>
          </div>
        </div>
      `;
    }
  }

  // Stop polling when navigating away from chats
  if (targetTab !== 'chats') {
    try {
      const { stopPolling } = await import('./features/support-chat/chat.js');
      stopPolling();
    } catch {}
  }

  window.customSelect?.init();
}

/**
 * Initializes the Admin Console application.
 */
export async function initAdminConsole() {
  // Enforce operator RBAC Guard
  const auth = checkAdminAuth();
  if (!auth.authorized) {
    if (auth.reason === 'forbidden') {
      const tabNav = document.getElementById('admin-tab-nav');
      const tabContainer = document.getElementById('admin-tab-container');
      const forbiddenState = document.getElementById('admin-forbidden-state');
      const forbiddenEmail = document.getElementById('forbidden-user-email');
      const forbiddenLogout = document.getElementById('forbidden-logout-btn');

      if (tabNav) tabNav.setAttribute('hidden', '');
      if (tabContainer) tabContainer.setAttribute('hidden', '');
      if (forbiddenState) forbiddenState.removeAttribute('hidden');
      if (forbiddenEmail) forbiddenEmail.textContent = auth.email || 'Current user';
      if (forbiddenLogout) forbiddenLogout.addEventListener('click', signOut);
    }
    return;
  }

  // Populate operator details
  const emailEl = document.getElementById('admin-operator-email');
  if (emailEl) {
    emailEl.textContent = auth.email;
  }

  // Wire up sign-out button
  const logoutBtn = document.getElementById('admin-logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', signOut);
  }

  // Initialize plan, quota, and governance dialog listeners
  initPlanQuotaModals();
  initGovernanceModals();

  // Handle Tab Router
  window.addEventListener('hashchange', () => {
    switchTab(getActiveTabFromHash());
  });

  // Listen to tab click events
  const tabNav = document.getElementById('admin-tab-nav');
  if (tabNav) {
    tabNav.addEventListener('click', (e) => {
      const link = e.target.closest('a[role="tab"]');
      if (!link) return;
      const href = link.getAttribute('href') || '';
      const tab = href.replace(/^#/, '');
      if (TABS.includes(tab)) {
        switchTab(tab);
      }
    });
  }

  // Initial tab render
  await switchTab(getActiveTabFromHash());
}

// Auto-run if loaded in a browser document
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initAdminConsole());
  } else {
    initAdminConsole();
  }
}
