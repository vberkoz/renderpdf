(function (global) {
  'use strict';

  const dashboardViewNames = new Set([
    'overview',
    'create-render',
    'merge',
    'keys',
    'billing',
    'sources',
    'files',
    'batches',
    'logs',
  ]);

  const requestedDashboardView =
    typeof window !== 'undefined' && window.location?.search
      ? new URLSearchParams(window.location.search).get('view')
      : null;

  let activeDashboardView = dashboardViewNames.has(requestedDashboardView)
    ? requestedDashboardView
    : 'overview';

  const dashboardPageContexts = {
    overview: {
      kicker: 'Developer dashboard',
      title: 'Home',
      description: 'Your PDF activity, capacity, and next steps.',
    },
    'create-render': {
      kicker: 'Create and render',
      title: 'Create a PDF',
      description: 'Start with a template, saved source, or inline document, then render a PDF.',
    },
    merge: {
      kicker: 'Combine documents',
      title: 'Merge PDFs',
      description: 'Concatenate multiple rendered PDFs into a single unified document with continuous page numbers.',
    },
    keys: {
      kicker: 'Account',
      title: 'API Keys',
      description:
        'Create credentials for trusted server-side use, then store each key securely and revoke keys you no longer need.',
    },
    sources: {
      kicker: 'Reusable content',
      title: 'Saved sources',
      description:
        'Choose and manage templates alongside reusable document definitions for future renders and batches.',
    },
    files: {
      kicker: 'Files',
      title: 'Files',
      description: '',
    },
    batches: {
      kicker: 'Batches',
      title: 'Batch jobs',
      description: '',
    },
    logs: {
      kicker: 'Activity',
      title: 'Activity',
      description: '',
    },
    billing: {
      kicker: 'Billing',
      title: 'Plan and billing',
      description: 'Review your current PDF capacity and manage your subscription.',
    },
  };

  function setDashboardPageContext(view) {
    const context = dashboardPageContexts[view] || dashboardPageContexts.overview;
    const kicker = document.getElementById('dashboardPageKicker');
    const title = document.getElementById('dashboardPageTitle');
    const description = document.getElementById('dashboardPageDescription');
    if (kicker) {
      kicker.textContent = context.kicker;
      kicker.hidden = !context.kicker;
    }
    if (title) title.textContent = context.title;
    if (description) {
      description.textContent = context.description;
      description.hidden = !context.description;
    }
    const mobileCurrent = document.getElementById('dashboardMobileCurrentView');
    if (mobileCurrent) mobileCurrent.textContent = context.title;
  }

  function setDashboardView(view, { history = 'none', focus = false } = {}) {
    const nextView = dashboardViewNames.has(view) ? view : 'overview';
    activeDashboardView = nextView;
    global.activeDashboardView = nextView;
    if (document.documentElement) document.documentElement.dataset.dashboardCurrentView = nextView;
    if (document.body) document.body.dataset.dashboardCurrentView = nextView;

    document.querySelectorAll('[data-dashboard-view]').forEach((panel) => {
      panel.hidden = panel.dataset.dashboardView !== nextView;
    });
    document.querySelectorAll('[data-dashboard-nav]').forEach((item) => {
      const isActive = item.dataset.dashboardNav === nextView;
      item.classList.toggle('is-active', isActive);
      item.toggleAttribute('aria-current', isActive);
      if (isActive) item.setAttribute('aria-current', 'page');
    });
    setDashboardPageContext(nextView);
    if (dashboardPageContexts[nextView]) {
      document.title = `RenderPDF | ${dashboardPageContexts[nextView].title}`;
    }

    if (history !== 'none' && typeof window !== 'undefined' && window.location) {
      const url = new URL(window.location.href);
      url.searchParams.set('view', nextView);
      url.hash = '';
      window.history[history === 'replace' ? 'replaceState' : 'pushState']({}, '', url);
    }
    if (focus && typeof window !== 'undefined') {
      document.querySelector('.dashboard-mobile-navigation')?.removeAttribute('open');
      document.getElementById('main-content')?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function initializeDashboardNavigation() {
    setDashboardView(activeDashboardView);
    document.querySelectorAll('.dashboard-mobile-navigation > summary').forEach((summary) => {
      summary.addEventListener('keydown', (event) => {
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        const navigation = summary.parentElement;
        if (navigation instanceof HTMLDetailsElement) navigation.open = !navigation.open;
      });
    });
    document.querySelectorAll('[data-dashboard-nav], [data-dashboard-view-link]').forEach((item) => {
      item.addEventListener('click', (event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        const url = new URL(item.href, window.location.href);
        if (url.origin !== window.location.origin || url.pathname !== window.location.pathname)
          return;
        const view = item.dataset.dashboardViewLink || url.searchParams.get('view');
        if (!dashboardViewNames.has(view)) return;
        event.preventDefault();
        setDashboardView(view, { history: 'push', focus: true });
        document.dispatchEvent(new CustomEvent('dashboardviewchange', { detail: { view } }));
      });
    });
    window.addEventListener('popstate', () => {
      setDashboardView(new URLSearchParams(window.location.search).get('view') || 'overview', {
        focus: true,
      });
      document.dispatchEvent(
        new CustomEvent('dashboardviewchange', { detail: { view: activeDashboardView } })
      );
    });
  }

  const moduleExports = {
    dashboardViewNames,
    requestedDashboardView,
    activeDashboardView,
    dashboardPageContexts,
    setDashboardPageContext,
    setDashboardView,
    initializeDashboardNavigation,
  };

  global.setDashboardView = setDashboardView;
  global.initializeDashboardNavigation = initializeDashboardNavigation;
  global.dashboardViewNames = dashboardViewNames;

  Object.assign(global, moduleExports);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = moduleExports;
  }
})(typeof window === 'undefined' ? globalThis : window);
