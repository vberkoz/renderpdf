/**
 * RenderPDF API Documentation Client Scripts
 * Handles syntax highlighting, copy-to-clipboard, sidebar accordion,
 * and mobile navigation drawer toggle.
 */

(function initDocs() {
    'use strict';

    // 1. Initialize syntax highlighting if highlight.js is loaded
    if (window.hljs) {
        window.hljs.highlightAll();
    }

    // 2. Hash routing compatibility for legacy /docs/api/#anchors
    const hashRoutes = {
        '#quick-start': '/docs/api/',
        '#trial': '/docs/api/trial/',
        '#request-basics': '/docs/api/request-basics/',
        '#authentication': '/docs/api/authentication/',
        '#render': '/docs/api/render/',
        '#render-document': '/docs/api/render-document/',
        '#pdf-security': '/docs/api/pdf-security/',
        '#markdown': '/docs/api/markdown/',
        '#render-url': '/docs/api/render-url/',
        '#render-upload': '/docs/api/render-upload/',
        '#templates': '/docs/api/templates/',
        '#render-template': '/docs/api/render-template/',
        '#sources': '/docs/api/sources/',
        '#files': '/docs/api/files/',
        '#batches': '/docs/api/batches/',
        '#webhooks': '/docs/api/webhooks/',
        '#examples': '/docs/api/examples/',
        '#response': '/docs/api/response/',
        '#errors': '/docs/api/errors/',
        '#api-keys': '/docs/api/api-keys/'
    };
    if (window.location.hash && hashRoutes[window.location.hash]) {
        window.location.replace(hashRoutes[window.location.hash]);
    }

    // 3. Copy-to-clipboard functionality
    async function copyCode(button) {
        const targetId = button.dataset.copyTarget;
        const target = targetId ? document.getElementById(targetId) : null;
        if (!target) return;

        const originalText = button.textContent;
        const codeText = target.textContent;
        button.disabled = true;
        button.classList.remove('is-copied', 'is-copy-error');

        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(codeText);
            } else {
                const selection = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(target);
                selection.removeAllRanges();
                selection.addRange(range);
                document.execCommand('copy');
                selection.removeAllRanges();
            }
            button.textContent = 'Copied';
            button.classList.add('is-copied');
        } catch {
            button.textContent = 'Select text';
            button.classList.add('is-copy-error');
        } finally {
            window.setTimeout(() => {
                button.textContent = originalText;
                button.classList.remove('is-copied', 'is-copy-error');
                button.disabled = false;
            }, 1600);
        }
    }

    document.querySelectorAll('.copy-button').forEach((button) => {
        button.addEventListener('click', () => copyCode(button));
    });

    // 4. Sidebar accordion: only one group open at a time
    const sidebarGroups = [...document.querySelectorAll('.sidebar-group')];
    sidebarGroups.forEach((group) => {
        group.addEventListener('toggle', () => {
            if (!group.open) return;
            sidebarGroups.forEach((otherGroup) => {
                if (otherGroup !== group) otherGroup.open = false;
            });
        });
    });

    // 5. Mobile documentation navigation drawer toggle
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'sidebar-mobile-toggle';
        
        const activeLink = sidebar.querySelector('a.is-active, a[aria-current="page"]');
        const pageTitle = activeLink ? activeLink.textContent.trim() : 'Overview';
        
        toggle.innerHTML = `<span class="sidebar-toggle-label"><svg class="sidebar-toggle-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/></svg> Docs Menu: <strong class="sidebar-toggle-active">${pageTitle}</strong></span><span class="sidebar-toggle-chevron" aria-hidden="true">&#9662;</span>`;
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-controls', 'docs-sidebar-nav');
        
        const nav = sidebar.querySelector('nav');
        if (nav) nav.id = 'docs-sidebar-nav';
        
        toggle.addEventListener('click', () => {
            const isExpanded = sidebar.classList.toggle('is-expanded');
            toggle.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
        });
        
        sidebar.classList.add('has-mobile-toggle');
        sidebar.insertBefore(toggle, sidebar.firstChild);
    }
})();
