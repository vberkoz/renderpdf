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
              function fitPreviewToWidth() {
                document.body.style.zoom = '1';
                const availableWidth = document.documentElement.clientWidth;
                const documentWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
                if (availableWidth && documentWidth > availableWidth) {
                  document.body.style.zoom = String(Math.max(0.2, availableWidth / documentWidth));
                }
              }
              window.addEventListener('load', () => {
                fitPreviewToWidth();
                window.setTimeout(fitPreviewToWidth, 120);
              });
              window.addEventListener('resize', fitPreviewToWidth);
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
                    fetch(new URL('/api/v1/public-stats?event=trial_render_submitted', API_ORIGIN).toString(), { cache: 'no-store' }).catch(() => {});
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
                        const payload = await response.json();
                        throw new Error(payload.error || payload.message || 'Failed to generate PDF');
                    }

                    const data = await response.json();
                    fetch(new URL('/api/v1/public-stats?event=trial_render_succeeded', API_ORIGIN).toString(), { cache: 'no-store' }).catch(() => {});
                    result.innerHTML = `
                        <div>
                            <strong>PDF ready</strong>
                            <span>${(data.size / 1024).toFixed(1)} KB</span>
                        </div>
                        <a href="${data.url}" target="_blank" rel="noopener">Download PDF</a>
                    `;
                    result.classList.remove('hidden');
                } catch (err) {
                    error.innerHTML = `<strong>Could not generate PDF</strong><span>${err.message}</span>`;
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

        const loadLiveTelemetry = async () => {
            try {
                const res = await fetch(new URL('/api/v1/public-stats?event=page_viewed', API_ORIGIN).toString(), { cache: 'no-store' });
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
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initLanding);
    } else {
        initLanding();
    }
})();
