/**
 * RenderPDF Cookie Consent & Privacy Manager
 * Lightweight, accessible, zero-dependency GDPR & CCPA compliant consent manager.
 * Ensures no analytics or tracking telemetry is collected before explicit user consent.
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'renderpdf_cookie_consent';
  const COOKIE_NAME = 'renderpdf_cookie_consent';

  function getCookie(name) {
    if (typeof document === 'undefined') return null;
    try {
      const match = document.cookie ? document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)')) : null;
      return match ? decodeURIComponent(match[1]) : null;
    } catch {
      return null;
    }
  }

  function setCookie(name, value, days = 365) {
    if (typeof document === 'undefined') return;
    try {
      const maxAge = days * 24 * 60 * 60;
      document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; SameSite=Lax`;
    } catch {}
  }

  function getStatus() {
    try {
      if (typeof localStorage !== 'undefined') {
        const local = localStorage.getItem(STORAGE_KEY);
        if (local === 'accepted' || local === 'declined') return local;
      }
    } catch {}
    const cookie = getCookie(COOKIE_NAME);
    if (cookie === 'accepted' || cookie === 'declined') return cookie;
    return 'unset';
  }

  function hasConsented() {
    return getStatus() === 'accepted';
  }

  function setConsent(status) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, status);
      }
    } catch {}
    setCookie(COOKIE_NAME, status);

    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent('renderpdf:consent', { detail: { status } })
      );
    }
  }

  function createDialog() {
    if (typeof document === 'undefined') return null;
    if (document.getElementById('renderpdfCookieConsent')) {
      return document.getElementById('renderpdfCookieConsent');
    }

    const aside = document.createElement('aside');
    aside.id = 'renderpdfCookieConsent';
    aside.className = 'cookie-consent-banner';
    aside.setAttribute('role', 'dialog');
    aside.setAttribute('aria-modal', 'false');
    aside.setAttribute('aria-labelledby', 'cookieConsentTitle');
    aside.setAttribute('aria-describedby', 'cookieConsentDesc');

    aside.innerHTML = `
      <div class="cookie-consent-inner">
        <div class="cookie-consent-body">
          <div class="cookie-consent-icon-wrap" aria-hidden="true">
            <svg class="cookie-consent-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"></path>
              <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"></circle>
              <circle cx="16" cy="15.5" r="1" fill="currentColor"></circle>
              <circle cx="12" cy="12" r="1" fill="currentColor"></circle>
              <circle cx="11" cy="17" r="1" fill="currentColor"></circle>
              <circle cx="7" cy="13" r="1" fill="currentColor"></circle>
            </svg>
          </div>
          <div class="cookie-consent-content">
            <h2 id="cookieConsentTitle" class="cookie-consent-title">Cookie &amp; Privacy Preferences</h2>
            <p id="cookieConsentDesc" class="cookie-consent-desc">
              We use strictly necessary cookies to ensure site security and core functionality. With your permission, we also collect privacy-preserving analytics and performance telemetry to improve our PDF engine. Read our <a href="/privacy/" class="cookie-consent-link">Privacy Policy</a>.
            </p>
          </div>
        </div>
        <div class="cookie-consent-actions">
          <button type="button" id="cookieConsentDeclineBtn" class="cookie-consent-btn cookie-consent-btn-secondary">Decline</button>
          <button type="button" id="cookieConsentAcceptBtn" class="cookie-consent-btn cookie-consent-btn-primary">Accept cookies</button>
        </div>
      </div>
    `;

    document.body.appendChild(aside);

    const acceptBtn = document.getElementById('cookieConsentAcceptBtn');
    const declineBtn = document.getElementById('cookieConsentDeclineBtn');

    if (acceptBtn) {
      acceptBtn.addEventListener('click', () => {
        setConsent('accepted');
        hideDialog();
      });
    }

    if (declineBtn) {
      declineBtn.addEventListener('click', () => {
        setConsent('declined');
        hideDialog();
      });
    }

    return aside;
  }

  function showDialog() {
    if (typeof document === 'undefined') return;
    let dialog = document.getElementById('renderpdfCookieConsent');
    if (!dialog) {
      dialog = createDialog();
    }
    if (dialog) {
      dialog.classList.add('is-visible');
      dialog.removeAttribute('hidden');
    }
  }

  function hideDialog() {
    if (typeof document === 'undefined') return;
    const dialog = document.getElementById('renderpdfCookieConsent');
    if (dialog) {
      dialog.classList.remove('is-visible');
      dialog.setAttribute('hidden', '');
    }
  }

  const api = {
    hasConsented,
    getStatus,
    accept: () => {
      setConsent('accepted');
      hideDialog();
    },
    decline: () => {
      setConsent('declined');
      hideDialog();
    },
    show: showDialog,
    hide: hideDialog,
    reset: () => {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(STORAGE_KEY);
        }
      } catch {}
      try {
        if (typeof document !== 'undefined') {
          document.cookie = `${COOKIE_NAME}=; path=/; max-age=0; SameSite=Lax`;
        }
      } catch {}
      showDialog();
    },
    createDialog,
  };

  global.RenderPdfCookieConsent = api;

  function init() {
    if (typeof document === 'undefined') return;
    if (getStatus() === 'unset') {
      showDialog();
    }

    document.querySelectorAll('[data-open-cookie-settings], #openCookieSettingsBtn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        showDialog();
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const dialog = document.getElementById('renderpdfCookieConsent');
        if (dialog && dialog.classList.contains('is-visible') && getStatus() !== 'unset') {
          hideDialog();
        }
      }
    });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window === 'undefined' ? globalThis : window);
