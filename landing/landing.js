(() => {
    function initLanding() {
        const API_ORIGIN = window.location.protocol === 'file:'
            ? 'https://renderpdf.vberkoz.com'
            : window.location.origin;
        const TRIAL_RENDER_URL = new URL('/api/v1/trial/render', API_ORIGIN).toString();
        const form = document.getElementById('pdfForm');
        const btn = document.getElementById('generateBtn');
        const btnLabel = document.getElementById('generateBtnLabel');
        const result = document.getElementById('result');
        const error = document.getElementById('error');
        const htmlInput = document.getElementById('htmlInput');

        if (!htmlInput) return;

        const TEMPLATES = window.PLAYGROUND_TEMPLATES || {};

        if (!htmlInput.value && TEMPLATES.agreement) {
            htmlInput.value = TEMPLATES.agreement;
        }

        let htmlEditor = null;
        if (window.CodeMirror) {
            htmlEditor = window.CodeMirror.fromTextArea(htmlInput, {
                mode: 'htmlmixed',
                lineNumbers: true,
                lineWrapping: false,
                indentUnit: 2,
                tabSize: 2
            });
            htmlEditor.on('change', () => {
                htmlEditor.save();
                htmlInput.dispatchEvent(new Event('input', { bubbles: true }));
            });
        }
        const playgroundHTML = () => htmlEditor ? htmlEditor.getValue() : htmlInput.value;
        const htmlPreview = document.getElementById('htmlPreview');
        const quotaStatus = document.getElementById('quotaStatus');
        const quotaRemaining = document.getElementById('quotaRemaining');
        const quotaLabel = document.getElementById('quotaLabel');
        const QUOTA_URL = new URL('/api/v1/trial/quota', API_ORIGIN).toString();

        const displayQuota = (remaining) => {
            if (!quotaRemaining || !quotaLabel || !quotaStatus) return;
            const value = Math.max(0, Number.parseInt(remaining, 10) || 0);
            quotaRemaining.textContent = value;
            quotaLabel.textContent = value === 1
                ? 'free PDF left today'
                : 'free PDFs left today';
            quotaStatus.classList.toggle('quota-empty', value === 0);
        };

        const loadQuota = async () => {
            try {
                const response = await fetch(QUOTA_URL, { cache: 'no-store' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const quota = await response.json();
                displayQuota(quota.remaining);
            } catch (err) {
                if (quotaLabel) {
                    quotaLabel.textContent = 'free PDFs left today';
                }
            }
        };

        loadQuota();

        const previewHead = `
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https:; font-src data: https:; script-src 'unsafe-inline'">
            <style>html { overflow-x: hidden; overflow-y: auto; } body { margin: 0; transform-origin: top left; }</style>
            <script>
              function parsePageDimensions() {
                var css = '';
                document.querySelectorAll('style').forEach(function(s) { css += ' ' + s.textContent; });
                for (var i = 0; i < document.styleSheets.length; i++) {
                  try {
                    var rules = document.styleSheets[i].cssRules;
                    for (var j = 0; j < rules.length; j++) css += ' ' + rules[j].cssText;
                  } catch (_) {}
                }
                var match = css.match(/@page[^{]*\\{[^}]*\\bsize\\s*:\\s*([^;}]+)/i);
                var val = (match ? match[1] : '').trim().toLowerCase();
                var tokens = val.split(/\\s+/).filter(Boolean);

                var MM_PER_INCH = 25.4;
                var STANDARD_SIZES = {
                  a4: { w: 210, h: 297 },
                  letter: { w: 8.5 * MM_PER_INCH, h: 11 * MM_PER_INCH },
                  legal: { w: 8.5 * MM_PER_INCH, h: 14 * MM_PER_INCH },
                  a3: { w: 297, h: 420 },
                  a5: { w: 148, h: 210 },
                  ledger: { w: 11 * MM_PER_INCH, h: 17 * MM_PER_INCH }
                };

                var isLandscape = tokens.indexOf('landscape') !== -1;
                var isPortrait = tokens.indexOf('portrait') !== -1;
                var widthMm = 210;
                var heightMm = 297;
                var hasExplicitSize = false;

                for (var i = 0; i < tokens.length; i++) {
                  if (STANDARD_SIZES[tokens[i]]) {
                    widthMm = STANDARD_SIZES[tokens[i]].w;
                    heightMm = STANDARD_SIZES[tokens[i]].h;
                    hasExplicitSize = true;
                    break;
                  }
                }

                if (!hasExplicitSize) {
                  var lengths = tokens.filter(function(t) { return /^[\\d.]+(mm|in|cm|px|pt)$/.test(t); });
                  if (lengths.length >= 2) {
                    function toMm(str) {
                      var num = parseFloat(str);
                      if (str.indexOf('in') !== -1) return num * MM_PER_INCH;
                      if (str.indexOf('cm') !== -1) return num * 10;
                      if (str.indexOf('px') !== -1) return num * (MM_PER_INCH / 96);
                      if (str.indexOf('pt') !== -1) return num * (MM_PER_INCH / 72);
                      return num;
                    }
                    widthMm = toMm(lengths[0]);
                    heightMm = toMm(lengths[1]);
                    hasExplicitSize = true;
                  }
                }

                if (isLandscape && widthMm < heightMm) {
                  var tmp = widthMm;
                  widthMm = heightMm;
                  heightMm = tmp;
                } else if (isPortrait && widthMm > heightMm) {
                  var tmp2 = widthMm;
                  widthMm = heightMm;
                  heightMm = tmp2;
                }

                return {
                  w: widthMm,
                  h: heightMm,
                  isLandscape: isLandscape || (widthMm > heightMm),
                  hasExplicitSize: hasExplicitSize || isLandscape || isPortrait
                };
              }

              function fitPreview() {
                var page = parsePageDimensions();
                if (page && page.w) {
                  document.body.style.width = page.w + 'mm';
                }
                document.body.style.zoom = '1';
                var availableWidth = document.documentElement.clientWidth;
                var availableHeight = window.innerHeight || document.documentElement.clientHeight;
                var docWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
                var docHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
                if (availableWidth > 0 && docWidth > 0) {
                  var scaleW = availableWidth / docWidth;
                  var scale = scaleW;
                  if (page && page.isLandscape && availableHeight > 0 && docHeight > 0) {
                    var scaleH = availableHeight / docHeight;
                    scale = Math.min(scaleW, scaleH);
                  }
                  scale = Math.min(1, Math.max(0.1, scale));
                  document.body.style.zoom = String(scale);
                }
              }

              window.addEventListener('DOMContentLoaded', fitPreview);
              window.addEventListener('load', () => {
                fitPreview();
                window.setTimeout(fitPreview, 120);
              });
              window.addEventListener('resize', fitPreview);
              if (document.fonts && document.fonts.ready) {
                document.fonts.ready.then(fitPreview);
              }
            <\/script>`;

        const previewHTML = (html) => {
            if (!htmlPreview) return;
            const fallback = '<main>Start typing HTML to preview your document.</main>';
            const documentPreview = new DOMParser().parseFromString(html.trim() || fallback, 'text/html');
            documentPreview.querySelectorAll('script, iframe, object, embed, base').forEach((element) => element.remove());
            documentPreview.querySelectorAll('*').forEach((element) => {
                element.getAttributeNames().forEach((name) => {
                    const value = element.getAttribute(name)?.trim().toLowerCase() || '';
                    if (name.toLowerCase().startsWith('on') || value.startsWith('javascript:')) {
                        element.removeAttribute(name);
                    }
                });
            });
            documentPreview.head.insertAdjacentHTML('afterbegin', previewHead);
            htmlPreview.srcdoc = `<!doctype html>${documentPreview.documentElement.outerHTML}`;
        };

        let previewFrame;
        const schedulePreview = () => {
            cancelAnimationFrame(previewFrame);
            previewFrame = requestAnimationFrame(() => previewHTML(playgroundHTML()));
        };
        htmlInput.addEventListener('input', schedulePreview);
        previewHTML(playgroundHTML());

        const templateSelect = document.getElementById('templateSelect');

        if (templateSelect) {
            templateSelect.addEventListener('change', () => {
                const selected = templateSelect.value;
                const tmpl = TEMPLATES[selected];
                if (tmpl) {
                    if (htmlEditor) {
                        htmlEditor.setValue(tmpl);
                    } else {
                        htmlInput.value = tmpl;
                    }
                    schedulePreview();
                }
            });
            window.customSelect?.init();
        }

        // Real-time speed and uptime counter animation
        (() => {
            const speedEl = document.getElementById('renderSpeedVal');
            const uptimeEl = document.getElementById('uptimeVal');
            if (!speedEl || !uptimeEl) return;
            if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                speedEl.textContent = '420ms';
                uptimeEl.textContent = '99.98%';
                return;
            }
            let startSpeed = 380;
            const targetSpeed = 420;
            const duration = 600;
            const start = performance.now();
            const tick = (now) => {
                const elapsed = now - start;
                const progress = Math.min(elapsed / duration, 1);
                const current = Math.round(startSpeed + (targetSpeed - startSpeed) * progress);
                speedEl.textContent = `${current}ms`;
                if (progress < 1) {
                    requestAnimationFrame(tick);
                } else {
                    speedEl.textContent = '420ms';
                    uptimeEl.textContent = '99.98%';
                }
            };
            requestAnimationFrame(tick);
        })();

        if (form && btn && btnLabel && result && error) {
            form.addEventListener('submit', async (event) => {
                event.preventDefault();

                btn.disabled = true;
                btn.setAttribute('aria-busy', 'true');
                btn.classList.add('is-processing');
                btnLabel.textContent = 'Rendering PDF';
                result.classList.add('hidden');
                error.classList.add('hidden');

                try {
                    if (window.RenderPdfCookieConsent?.hasConsented?.()) {
                        fetch(new URL('/api/v1/public-stats?event=trial_render_submitted', API_ORIGIN).toString(), { cache: 'no-store' }).catch(() => {});
                    }
                    const response = await fetch(TRIAL_RENDER_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ html: playgroundHTML() })
                    });

                    const remaining = response.headers.get('X-Trial-Remaining');
                    if (remaining !== null) {
                        displayQuota(remaining);
                    }

                    if (!response.ok) {
                        let payload = {};
                        try {
                            payload = await response.json();
                        } catch (_) {}
                        const err = new Error(payload.error || payload.message || 'Failed to generate PDF');
                        err.status = response.status;
                        err.code = payload.code;
                        throw err;
                    }

                    const data = await response.json();
                    if (window.RenderPdfCookieConsent?.hasConsented?.()) {
                        fetch(new URL('/api/v1/public-stats?event=trial_render_succeeded', API_ORIGIN).toString(), { cache: 'no-store' }).catch(() => {});
                    }
                    result.innerHTML = `
                        <div>
                            <strong>PDF ready</strong>
                            <span>${(data.size / 1024).toFixed(1)} KB</span>
                        </div>
                        <a href="${data.url}" target="_blank" rel="noopener">Download PDF</a>
                    `;
                    result.classList.remove('hidden');
                } catch (err) {
                    const isLimitReached = err.status === 429 ||
                        err.code === 'rate_limited' ||
                        (err.message && err.message.toLowerCase().includes('trial limit')) ||
                        (err.message && err.message.toLowerCase().includes('limit reached'));

                    if (isLimitReached) {
                        displayQuota(0);
                        error.innerHTML = `
                            <div>
                                <strong>Daily trial limit reached</strong>
                                <span>You have reached the limit of 3 free trial renders for today. Register or log in to continue rendering PDFs with 25 free documents every month.</span>
                            </div>
                            <div class="notice-actions">
                                <a href="/app/" class="button button-primary">Register or log in</a>
                            </div>
                        `;
                    } else {
                        error.innerHTML = `<strong>Could not generate PDF</strong><span>${err.message}</span>`;
                    }
                    error.classList.remove('hidden');
                } finally {
                    btn.disabled = false;
                    btn.setAttribute('aria-busy', 'false');
                    btn.classList.remove('is-processing');
                    btnLabel.textContent = 'Render PDF';
                }
            });
        }

        const pricingToggleBtns = document.querySelectorAll('.pricing-billing-toggle-btn');
        const starterCard = document.querySelector('.pricing-card[data-tier="starter"]');
        const proCard = document.querySelector('.pricing-card[data-tier="pro"]');

        pricingToggleBtns.forEach((toggleBtn) => {
            toggleBtn.addEventListener('click', () => {
                const billing = toggleBtn.dataset.billing;
                pricingToggleBtns.forEach((b) => {
                    const isActive = b === toggleBtn;
                    b.classList.toggle('is-active', isActive);
                    b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
                });

                if (starterCard) {
                    const amount = starterCard.querySelector('.pricing-amount');
                    const period = starterCard.querySelector('.pricing-period');
                    const status = starterCard.querySelector('.pricing-status');
                    const savings = starterCard.querySelector('.pricing-savings');
                    if (billing === 'annual') {
                        amount.textContent = '$190 USD';
                        period.textContent = '/ year';
                        status.textContent = 'Billed annually ($190/yr) · Cancel anytime';
                        if (savings) savings.hidden = false;
                    } else {
                        amount.textContent = '$19 USD';
                        period.textContent = '/ month';
                        status.textContent = 'Billed monthly · Cancel anytime';
                        if (savings) savings.hidden = true;
                    }
                }

                if (proCard) {
                    const amount = proCard.querySelector('.pricing-amount');
                    const period = proCard.querySelector('.pricing-period');
                    const status = proCard.querySelector('.pricing-status');
                    const savings = proCard.querySelector('.pricing-savings');
                    if (billing === 'annual') {
                        amount.textContent = '$490 USD';
                        period.textContent = '/ year';
                        status.textContent = 'Billed annually ($490/yr) · Cancel anytime';
                        if (savings) savings.hidden = false;
                    } else {
                        amount.textContent = '$49 USD';
                        period.textContent = '/ month';
                        status.textContent = 'Billed monthly · Cancel anytime';
                        if (savings) savings.hidden = true;
                    }
                }
            });
        });

        const initCodeTabs = () => {
            const tabs = document.querySelectorAll('.code-tab');
            if (!tabs.length) return;
            const panels = {
                'tab-curl': { panel: document.getElementById('panel-curl'), label: 'cURL / bash' },
                'tab-node': { panel: document.getElementById('panel-node'), label: 'Node.js 18+ (Fetch)' },
                'tab-python': { panel: document.getElementById('panel-python'), label: 'Python 3 (Requests)' }
            };
            const labelEl = document.getElementById('codeLangLabel');
            const copyBtn = document.getElementById('codeCopyBtn');

            tabs.forEach((tab) => {
                tab.addEventListener('click', () => {
                    tabs.forEach((t) => {
                        t.classList.remove('is-active');
                        t.setAttribute('aria-selected', 'false');
                        t.setAttribute('tabindex', '-1');
                    });
                    Object.values(panels).forEach((p) => {
                        if (p.panel) p.panel.hidden = true;
                    });

                    tab.classList.add('is-active');
                    tab.setAttribute('aria-selected', 'true');
                    tab.removeAttribute('tabindex');

                    const target = panels[tab.id];
                    if (target && target.panel) {
                        target.panel.hidden = false;
                        if (labelEl) labelEl.textContent = target.label;
                    }
                });
            });

            if (copyBtn) {
                copyBtn.addEventListener('click', async () => {
                    const activeTab = document.querySelector('.code-tab.is-active');
                    const activePanel = activeTab && panels[activeTab.id] ? panels[activeTab.id].panel : null;
                    if (!activePanel) return;
                    const code = activePanel.querySelector('pre')?.textContent || '';
                    try {
                        if (navigator.clipboard && navigator.clipboard.writeText) {
                            await navigator.clipboard.writeText(code);
                        }
                        const span = copyBtn.querySelector('span');
                        if (span) {
                            const prev = span.textContent;
                            span.textContent = 'Copied!';
                            setTimeout(() => { span.textContent = prev; }, 2000);
                        }
                    } catch (_) {}
                });
            }
        };
        initCodeTabs();

        const loadLiveTelemetry = async () => {
            try {
                const hasConsent = Boolean(window.RenderPdfCookieConsent?.hasConsented?.());
                const telemetryEvent = hasConsent ? 'page_viewed' : 'none';
                const res = await fetch(new URL(`/api/v1/public-stats?event=${telemetryEvent}`, API_ORIGIN).toString(), { cache: 'no-store' });
                if (!res.ok) return;
                const stats = await res.json();
                const speedEl = document.getElementById('renderSpeedVal');
                const uptimeEl = document.getElementById('uptimeVal');
                if (speedEl && stats.averageRenderMs) {
                    speedEl.textContent = `${Math.round(stats.averageRenderMs)}ms`;
                }
                if (uptimeEl && stats.successRate) {
                    uptimeEl.textContent = `${Number(stats.successRate).toFixed(1)}%`;
                }
            } catch {
                // Silently keep default values
            }
        };
        loadLiveTelemetry();

        window.addEventListener('renderpdf:consent', (event) => {
            if (event.detail?.status === 'accepted') {
                fetch(new URL('/api/v1/public-stats?event=page_viewed', API_ORIGIN).toString(), { cache: 'no-store' }).catch(() => {});
            }
        });
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initLanding);
        } else {
            initLanding();
        }
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { initLanding };
    }
})();
