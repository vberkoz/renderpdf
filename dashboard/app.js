const API_URL = '/api/v1';
const IS_LOCAL_PREVIEW = window.location.protocol === 'file:' ||
    ['localhost', '127.0.0.1'].includes(window.location.hostname);

function decodeTokenPayload(token) {
    try {
        const encodedPayload = token.split('.')[1];
        const base64 = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(decodeURIComponent(atob(base64).split('').map((character) =>
            `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`
        ).join('')));
    } catch (error) {
        return null;
    }
}

function clearSession() {
    localStorage.removeItem('id_token');
    localStorage.removeItem('access_token');
}

function checkAuth() {
    if (IS_LOCAL_PREVIEW) return true;

    const idToken = localStorage.getItem('id_token');
    const payload = idToken ? decodeTokenPayload(idToken) : null;

    if (!payload || (payload.exp && payload.exp * 1000 <= Date.now())) {
        clearSession();
        window.location.href = '/app/login';
        return false;
    }

    return true;
}

async function apiRequest(path, options = {}) {
    const response = await fetch(`${API_URL}${path}`, options);

    if (response.status === 401) {
        clearSession();
        window.location.href = '/app/login';
        throw new Error('Your session has expired');
    }

    if (!response.ok) {
        let message = `Request failed (${response.status})`;
        try {
            const payload = await response.json();
            message = payload.error || payload.message || message;
            if (payload.code) message = `${message} [${payload.code}]`;
        } catch (error) {
            // Keep the status-based message when the response is not JSON.
        }
        throw new Error(message);
    }

    if (response.status === 204) return null;
    return response.json();
}

function authHeaders() {
    return {
        'Authorization': `Bearer ${localStorage.getItem('id_token')}`,
        'Content-Type': 'application/json'
    };
}

function generateKey() {
    return apiRequest('/api-keys', { method: 'POST', headers: authHeaders() });
}

function listKeys() {
    return apiRequest('/api-keys', { headers: authHeaders() });
}

function deleteKey(keyId) {
    return apiRequest(`/api-keys/${encodeURIComponent(keyId)}`, {
        method: 'DELETE',
        headers: authHeaders()
    });
}

function loadDashboard() {
    return apiRequest('/dashboard', { headers: authHeaders() });
}

function startCheckout(plan) {
    return apiRequest('/billing/checkout', {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ plan })
    });
}

function openBillingPortal() {
    return apiRequest('/billing/portal', { method: 'POST', headers: authHeaders() });
}

let paddleInitialized = false;

function loadPaddleScript() {
    if (window.Paddle) return Promise.resolve(window.Paddle);
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
        script.async = true;
        script.onload = () => resolve(window.Paddle);
        script.onerror = () => reject(new Error('Could not load Paddle Checkout'));
        document.head.appendChild(script);
    });
}

async function openPaddleCheckout(checkout) {
    const Paddle = await loadPaddleScript();
    if (!Paddle || !checkout.clientToken || !checkout.transactionId) throw new Error('Paddle Checkout is unavailable');
    if (!paddleInitialized) {
        if (checkout.environment === 'sandbox') Paddle.Environment.set('sandbox');
        Paddle.Initialize({
            token: checkout.clientToken,
            eventCallback(event) {
                if (event?.name === 'checkout.completed') {
                    window.setTimeout(refreshDashboard, 1500);
                    window.setTimeout(refreshDashboard, 5000);
                }
            }
        });
        paddleInitialized = true;
    }
    Paddle.Checkout.open({ transactionId: checkout.transactionId, settings: { displayMode: 'overlay', theme: 'light' } });
}

function dashboardTemplateRequest(path, options = {}) {
    return apiRequest(path, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } });
}

function listTemplates() { return dashboardTemplateRequest('/dashboard/templates'); }
function createTemplate(template) { return dashboardTemplateRequest('/dashboard/templates', { method: 'POST', body: JSON.stringify(template) }); }
function getStoredTemplate(templateId) { return dashboardTemplateRequest(`/dashboard/templates/${encodeURIComponent(templateId)}`); }
function updateTemplate(templateId, template) { return dashboardTemplateRequest(`/dashboard/templates/${encodeURIComponent(templateId)}`, { method: 'PUT', body: JSON.stringify(template) }); }
function removeTemplate(templateId) { return dashboardTemplateRequest(`/dashboard/templates/${encodeURIComponent(templateId)}`, { method: 'DELETE' }); }
function renderStoredTemplate(templateId, variables) { return dashboardTemplateRequest('/dashboard/render-template', { method: 'POST', body: JSON.stringify({ templateId, variables }) }); }
function renderInlineDocument(documentRequest) { return dashboardTemplateRequest('/dashboard/render-document', { method: 'POST', body: JSON.stringify(documentRequest) }); }

const sampleDocumentRequest = {
    version: '1',
    html: '<main class="report"><p class="eyebrow">{{report.period}}</p><h1>{{report.title}}</h1><p>{{report.summary}}</p><dl><div><dt>Prepared for</dt><dd>{{customer.name}}</dd></div><div><dt>Status</dt><dd>{{report.status}}</dd></div></dl></main>',
    css: 'body { margin: 0; color: #17202a; font-family: Arial, sans-serif; } .report { padding: 8mm; border-top: 4px solid #123456; } .eyebrow { color: #64748b; font-size: 11px; font-weight: bold; letter-spacing: 0.12em; text-transform: uppercase; } h1 { margin: 8px 0 24px; color: #123456; font-size: 32px; } p { line-height: 1.55; } dl { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 32px; } dl div { padding: 14px; background: #f3f6f9; } dt { color: #64748b; font-size: 10px; text-transform: uppercase; } dd { margin: 6px 0 0; font-weight: bold; }',
    data: {
        report: {
            period: 'August 2026',
            title: 'Monthly report',
            summary: 'A concise overview generated from a versioned JSON document.',
            status: 'Ready for review'
        },
        customer: { name: 'Ada & Sons.' }
    },
    options: { format: 'A4', margin: '18mm' }
};

const sampleMarkdownDocumentRequest = {
    version: '1',
    source: {
        type: 'markdown',
        content: '# {{report.title}}\n\n{{report.summary}}\n\n| Prepared for | Status |\n| --- | --- |\n| {{customer.name}} | {{report.status}} |\n\n- [x] Ready for review'
    },
    css: 'body { margin: 0; padding: 8mm; color: #17202a; font-family: Arial, sans-serif; } h1 { color: #123456; font-size: 32px; } table { width: 100%; margin-top: 28px; border-collapse: collapse; } th, td { padding: 12px; border: 1px solid #d7dde4; text-align: left; } th { color: #64748b; font-size: 11px; text-transform: uppercase; }',
    data: {
        report: {
            title: 'Monthly report',
            summary: 'A concise overview generated from a Markdown document.',
            status: 'Ready for review'
        },
        customer: { name: 'Ada & Sons.' }
    },
    options: { format: 'A4', margin: '18mm' }
};

const documentPlaceholderPattern = /{{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*}}/g;
const documentTopLevelFields = new Set(['version', 'html', 'source', 'css', 'data', 'options', 'webhookUrl', 'webhookSecret']);

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function documentByteLength(value) {
    return new TextEncoder().encode(value).length;
}

function flattenDocumentData(value, prefix = '', depth = 1, output = new Map()) {
    if (depth > 10) throw new Error('data must not exceed 10 nested levels.');
    Object.entries(value).forEach(([key, child]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid data variable name "${key}".`);
        const path = prefix ? `${prefix}.${key}` : key;
        if (isPlainObject(child)) {
            flattenDocumentData(child, path, depth + 1, output);
        } else {
            if (child === null) throw new Error(`Missing required data variable "${path}".`);
            output.set(path, child);
        }
    });
    return output;
}

function validateDocumentCSSForPreview(css) {
    if (/@page\b/i.test(css)) throw new Error('@page settings must be supplied through options.');
    if (/@import\b/i.test(css)) throw new Error('CSS @import rules are not allowed.');
    if (/url\s*\(/i.test(css)) throw new Error('CSS url() assets are not allowed.');
    if (/(expression\s*\(|-moz-binding\b|behavior\s*:)/i.test(css)) throw new Error('Unsafe CSS is not allowed.');
}

function validateDocumentMarkupForPreview(html) {
    if (/@page\b/i.test(html)) throw new Error('@page settings must be supplied through options.');
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const forbidden = parsed.querySelector('script, iframe, embed, object, applet, base, link, meta[http-equiv="refresh" i]');
    if (forbidden) throw new Error(`HTML <${forbidden.tagName.toLowerCase()}> elements are not allowed.`);
    parsed.querySelectorAll('*').forEach((element) => {
        element.getAttributeNames().forEach((attributeName) => {
            const name = attributeName.toLowerCase();
            const value = (element.getAttribute(attributeName) || '').trim();
            if (name.startsWith('on')) throw new Error('HTML event-handler attributes are not allowed.');
            if (name === 'style') validateDocumentCSSForPreview(value);
            if (['src', 'srcset', 'poster', 'data', 'background'].includes(name) && value) throw new Error('Document assets are not allowed.');
            if (['href', 'action', 'formaction', 'xlink:href'].includes(name) && value && !value.startsWith('#') && !/^(https?|mailto):/i.test(value)) {
                throw new Error('Document URLs must use http, https, or mailto.');
            }
        });
    });
}

function parseDocumentSettingsEditor() {
    const source = templateEditorValue('documentMarkdownSettingsInput');
    let settings;
    try {
        settings = JSON.parse(source);
    } catch (error) {
        throw new Error(`Data, CSS, and options JSON is invalid. ${error.message}`);
    }
    if (!isPlainObject(settings)) throw new Error('Data, CSS, and options must be a JSON object.');
    const unknownField = Object.keys(settings).find((field) => !['css', 'data', 'options', 'webhookUrl', 'webhookSecret'].includes(field));
    if (unknownField) throw new Error(`Unknown Markdown settings field "${unknownField}".`);
    return settings;
}

function documentRequestFromEditor() {
    if (document.getElementById('documentSourceTypeInput').value === 'markdown') {
        const content = templateEditorValue('documentMarkdownInput');
        const settings = parseDocumentSettingsEditor();
        return { version: '1', source: { type: 'markdown', content }, ...settings };
    }
    const source = templateEditorValue('documentJsonInput');
    if (documentByteLength(source) > 1024 * 1024) throw new Error('Document request must not exceed 1 MB.');
    let request;
    try {
        request = JSON.parse(source);
    } catch (error) {
        throw new Error(`Invalid JSON. ${error.message}`);
    }
    return request;
}

function parseDocumentEditor() {
    const request = documentRequestFromEditor();
    if (documentByteLength(JSON.stringify(request)) > 1024 * 1024) throw new Error('Document request must not exceed 1 MB.');
    if (!isPlainObject(request)) throw new Error('The request must be a JSON object.');
    const unknownField = Object.keys(request).find((field) => !documentTopLevelFields.has(field));
    if (unknownField) throw new Error(`Unknown top-level field "${unknownField}".`);
    if (request.version !== '1') throw new Error('version must be "1".');
    const usesMarkdown = request.source !== undefined;
    if (usesMarkdown && request.html !== undefined) throw new Error('source and html cannot be used together.');
    if (usesMarkdown) {
        const unknownSourceField = isPlainObject(request.source) && Object.keys(request.source).find((field) => !['type', 'content'].includes(field));
        if (unknownSourceField) throw new Error(`Unknown source field "${unknownSourceField}".`);
        if (!isPlainObject(request.source) || request.source.type !== 'markdown' || typeof request.source.content !== 'string' || !request.source.content.trim()) {
            throw new Error('source must contain type "markdown" and non-empty content.');
        }
        if (documentByteLength(request.source.content) > 768 * 1024) throw new Error('source.content must not exceed 768 KB.');
    } else if (typeof request.html !== 'string' || !request.html.trim()) {
        throw new Error('html is required and must be a string.');
    }
    if (request.css !== undefined && typeof request.css !== 'string') throw new Error('css must be a string.');
    if (!isPlainObject(request.data)) throw new Error('data is required and must be an object.');
    if (request.options !== undefined && !isPlainObject(request.options)) throw new Error('options must be an object.');
    if (!usesMarkdown && documentByteLength(request.html) > 768 * 1024) throw new Error('html must not exceed 768 KB.');
    if (documentByteLength(request.css || '') > 128 * 1024) throw new Error('css must not exceed 128 KB.');
    if (documentByteLength(JSON.stringify(request.data)) > 256 * 1024) throw new Error('data must not exceed 256 KB.');

    const options = { format: 'A4', margin: '18mm', ...(request.options || {}) };
    const unknownOption = Object.keys(options).find((field) => !['format', 'margin'].includes(field));
    if (unknownOption) throw new Error(`Unknown options field "${unknownOption}".`);
    if (!['A4', 'Letter', 'Legal'].includes(options.format)) throw new Error('options.format must be one of A4, Letter, or Legal.');
    const marginMatch = typeof options.margin === 'string' && options.margin.match(/^([0-9]+(?:\.[0-9]+)?)(mm|in)$/);
    if (!marginMatch || Number(marginMatch[1]) > (marginMatch[2] === 'in' ? 2 : 50)) throw new Error('options.margin must be a value from 0mm to 50mm or 0in to 2in.');

    const css = request.css || '';
    validateDocumentCSSForPreview(css);
    const content = usesMarkdown ? request.source.content : request.html;
    if (/@page\b/i.test(content)) throw new Error('@page settings must be supplied through options.');
    if (!usesMarkdown) validateDocumentMarkupForPreview(content);
    const values = flattenDocumentData(request.data);
    const placeholders = [...content.matchAll(documentPlaceholderPattern)];
    const unmatched = content.replace(documentPlaceholderPattern, '');
    if (unmatched.includes('{{') || unmatched.includes('}}')) throw new Error('HTML contains an invalid placeholder; use {{path.to.value}}.');
    const expected = new Set(placeholders.map((match) => match[1]));
    const missing = [...expected].find((path) => !values.has(path));
    if (missing) throw new Error(`Missing required data variable "${missing}".`);
    const unused = [...values.keys()].find((path) => !expected.has(path));
    if (unused) throw new Error(`Unknown data variable "${unused}"; every supplied value must be used.`);
    return { request: { ...request, css, options }, values, usesMarkdown };
}

function escapeMarkdownBindingValue(value) {
    return escapeTemplatePreviewHTML(value).replace(/[\\`*_{}\[\]()<>#+\-.!|~]/g, '\\$&');
}

function renderMarkdownPreviewFragment(markdown) {
    if (!window.marked?.parse || !window.marked.Renderer) throw new Error('Markdown preview is unavailable. Reload the dashboard and try again.');
    const renderer = new window.marked.Renderer();
    renderer.html = () => '';
    return window.marked.parse(markdown, { gfm: true, renderer });
}

function buildDocumentJsonPreview(request, values, usesMarkdown) {
    let resolvedHTML;
    if (usesMarkdown) {
        const resolvedMarkdown = request.source.content.replace(documentPlaceholderPattern, (_, path) => escapeMarkdownBindingValue(values.get(path)));
        resolvedHTML = renderMarkdownPreviewFragment(resolvedMarkdown);
        validateDocumentMarkupForPreview(resolvedHTML);
    } else {
        resolvedHTML = request.html.replace(documentPlaceholderPattern, (_, path) => escapeTemplatePreviewHTML(values.get(path)));
    }
    const parsed = new DOMParser().parseFromString(resolvedHTML, 'text/html');
    parsed.querySelectorAll('*').forEach((element) => {
        ['href', 'action', 'formaction', 'xlink:href'].forEach((attribute) => element.removeAttribute(attribute));
    });
    const contentSecurityPolicy = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}"><style>${request.css}\n@page { size: ${request.options.format}; margin: ${request.options.margin}; }</style></head><body>${parsed.body.innerHTML}</body></html>`;
}

function previewDocumentJson() {
    const parsed = parseDocumentEditor();
    document.getElementById('documentJsonPreview').srcdoc = buildDocumentJsonPreview(parsed.request, parsed.values, parsed.usesMarkdown);
    return parsed.request;
}

function loadDocumentEditorSample(type) {
    if (type === 'markdown') {
        setTemplateEditorValue('documentMarkdownInput', sampleMarkdownDocumentRequest.source.content);
        setTemplateEditorValue('documentMarkdownSettingsInput', JSON.stringify({
            css: sampleMarkdownDocumentRequest.css,
            data: sampleMarkdownDocumentRequest.data,
            options: sampleMarkdownDocumentRequest.options
        }, null, 2));
        return;
    }
    setTemplateEditorValue('documentJsonInput', JSON.stringify(sampleDocumentRequest, null, 2));
}

function setDocumentEditorMode(type, loadSample = false) {
    const isMarkdown = type === 'markdown';
    document.getElementById('documentSourceTypeInput').value = isMarkdown ? 'markdown' : 'html';
    window.customSelect?.setValue('documentSourceTypeInput', isMarkdown ? 'markdown' : 'html');
    document.getElementById('documentJsonField').hidden = isMarkdown;
    document.getElementById('documentMarkdownFields').hidden = !isMarkdown;
    if (loadSample) loadDocumentEditorSample(isMarkdown ? 'markdown' : 'html');
    ['documentJsonInput', 'documentMarkdownInput', 'documentMarkdownSettingsInput'].forEach((id) => {
        window.setTimeout(() => templateCodeEditors[id]?.refresh(), 0);
    });
}

function setNotice(element, message = '', state = '') {
    element.textContent = message;
    element.dataset.state = state;
    element.hidden = !message;
}

function setButtonPending(button, pending, pendingLabel) {
    if (!button.dataset.label) button.dataset.label = button.innerHTML;
    button.disabled = pending;
    button.setAttribute('aria-busy', String(pending));
    button.classList.toggle('is-processing', pending);
    button.innerHTML = pending ? pendingLabel : button.dataset.label;
}

const templateCodeEditors = {};

function initializeTemplateCodeEditor(id, mode) {
    const textarea = document.getElementById(id);
    if (!textarea || !window.CodeMirror) return null;

    const editor = window.CodeMirror.fromTextArea(textarea, {
        mode,
        lineNumbers: true,
        lineWrapping: true,
        indentUnit: 2,
        tabSize: 2
    });
    editor.on('change', () => {
        editor.save();
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    templateCodeEditors[id] = editor;
    return editor;
}

function templateEditorValue(id) {
    return templateCodeEditors[id]?.getValue() ?? document.getElementById(id).value;
}

function setTemplateEditorValue(id, value) {
    const textarea = document.getElementById(id);
    const nextValue = String(value ?? '');
    if (templateCodeEditors[id]) {
        templateCodeEditors[id].setValue(nextValue);
    } else {
        textarea.value = nextValue;
    }
}

function templatePayloadFromForm() {
    return {
        name: document.getElementById('templateNameInput').value.trim(),
        type: document.getElementById('templateTypeInput').value,
        html: templateEditorValue('templateHtmlInput').trim(),
        variables: templateVariablesFromEditor()
    };
}

function templateVariablesFromEditor() {
    const variables = JSON.parse(templateEditorValue('templateVariablesInput'));
    if (!variables || Array.isArray(variables) || typeof variables !== 'object') throw new Error('Variables must be an object');
    return variables;
}

const pagedPreviewHead = `
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https:; font-src data: https:; script-src 'unsafe-inline' https://unpkg.com; connect-src https:">
<style>
  html, body { overflow-x: hidden !important; background: #eef1f3 !important; }
  /* The template's @page rule owns printable margins. Padding here would be
     copied into every Paged.js sheet and create a different page height. */
  body { margin: 0 !important; padding: 0 !important; }
  /* Templates often define a screen A4 canvas. Paged.js supplies the paper,
     so that canvas must not consume a second A4 height or apply screen zoom. */
  .a4-page { height: auto !important; min-height: 0 !important; width: auto !important; margin: 0 !important; overflow: visible !important; padding: 0 !important; zoom: 1 !important; }
  /* Templates may opt in when their final signature block belongs at the
     bottom of a single A4 sheet, rather than immediately after the clauses. */
  .a4-page.pin-signatures { display: flex !important; flex-direction: column !important; min-height: 279mm !important; }
  .a4-page.pin-signatures .signatures { margin-top: auto !important; }
  .pagedjs_pages { box-sizing: border-box; display: grid; justify-content: center; gap: 18px; width: 100%; margin: 0 !important; padding: 0; transform-origin: top center; }
  .pagedjs_page { margin: 0 !important; box-shadow: 0 8px 24px rgba(23, 32, 42, .16); transform-origin: top center; }
  .pagedjs_sheet { background: #fff; }
  /* Paged.js cannot continue the template's 14mm + 6mm grid across a sheet:
     the continuation inherits only the narrow first column. Use an equivalent
     20mm inset in previews so the continued text keeps its full width. */
  .pagedjs_page .clauses li { display: block !important; position: relative !important; padding-left: 20mm !important; }
  .pagedjs_page .clauses li::before { position: absolute !important; top: 4mm; left: 0; }
  .pagedjs_page .scope { -webkit-box-decoration-break: clone; box-decoration-break: clone; }
</style>
<script>
  function collectPrintRules(rules, output, insidePrintMedia = false) {
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule) {
        if (/(^|\\W)print(\\W|$)/i.test(rule.conditionText)) collectPrintRules(rule.cssRules, output, true);
        continue;
      }
      if (rule.cssRules) {
        collectPrintRules(rule.cssRules, output, insidePrintMedia);
        continue;
      }
      if (insidePrintMedia) output.push(rule.cssText);
    }
  }

  function applyTemplatePrintRules() {
    const printRules = [];
    for (const sheet of document.styleSheets) {
      try { collectPrintRules(sheet.cssRules, printRules); } catch (_) { /* Ignore unreadable cross-origin font stylesheets. */ }
    }
    if (!printRules.length) return;
    const style = document.createElement('style');
    style.textContent = printRules.join('\\n');
    document.head.appendChild(style);
  }

  function reducePagedPreviewMargins() {
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (!/^@page\\b/i.test(rule.cssText)) continue;
          const match = rule.cssText.match(/\\bmargin\\s*:\s*([^;}]+)/i);
          if (!match) continue;
          const values = match[1].trim().split(/\\s+/);
          if (!values.every((value) => /^-?\\d*\\.?\\d+mm$/i.test(value))) continue;
          const reduced = values.map((value) => (parseFloat(value) * 0.96).toFixed(4) + 'mm');
          const style = document.createElement('style');
          style.textContent = '@page { margin: ' + reduced.join(' ') + '; }';
          document.head.appendChild(style);
          return;
        }
      } catch (_) { /* Ignore unreadable cross-origin font stylesheets. */ }
    }
  }

  function fitPagedPreviewPages() {
    const pages = document.querySelector('.pagedjs_pages');
    const page = document.querySelector('.pagedjs_page');
    if (!pages || !page) return;
    pages.style.zoom = '1';
    const pagePadding = getComputedStyle(pages);
    const availableWidth = Math.max(1, pages.clientWidth - parseFloat(pagePadding.paddingLeft) - parseFloat(pagePadding.paddingRight));
    pages.style.zoom = String(Math.min(1, availableWidth / page.getBoundingClientRect().width));
  }

  window.PagedConfig = { auto: false };
  window.addEventListener('load', () => {
    applyTemplatePrintRules();
    reducePagedPreviewMargins();
    if (!window.PagedPolyfill) return;
    const render = window.PagedPolyfill.preview();
    if (render && typeof render.then === 'function') render.then(fitPagedPreviewPages);
    else requestAnimationFrame(fitPagedPreviewPages);
  });
  window.addEventListener('resize', fitPagedPreviewPages);
</script>
<script src="https://unpkg.com/pagedjs@0.4.3/dist/paged.polyfill.js"></script>`;

function previewTemplateHTML(html) {
    const fallback = '<main style="font-family:\'IBM Plex Sans\',Arial,sans-serif;padding:24px;color:#586473">Your template preview appears here.</main>';
    const documentPreview = new DOMParser().parseFromString(html || fallback, 'text/html');
    documentPreview.querySelectorAll('script, iframe, object, embed').forEach((element) => element.remove());
    documentPreview.querySelectorAll('*').forEach((element) => {
        element.getAttributeNames().forEach((name) => {
            const value = element.getAttribute(name)?.trim().toLowerCase() || '';
            if (name.toLowerCase().startsWith('on') || value.startsWith('javascript:')) element.removeAttribute(name);
        });
    });
    documentPreview.head.insertAdjacentHTML('afterbegin', pagedPreviewHead);
    document.getElementById('templatePreview').srcdoc = `<!doctype html>${documentPreview.documentElement.outerHTML}`;
}

function escapeTemplatePreviewHTML(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function previewTemplateWithVariables() {
    const templateHTML = templateEditorValue('templateHtmlInput');
    let variables;
    try { variables = templateVariablesFromEditor(); } catch (_) { previewTemplateHTML(templateHTML); return; }
    const renderedHTML = templateHTML.replace(/{{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*}}/g, (placeholder, path) => {
        const value = path.split('.').reduce((current, key) => current && current[key], variables);
        return value === undefined || value === null || typeof value === 'object' ? placeholder : escapeTemplatePreviewHTML(value);
    });
    previewTemplateHTML(renderedHTML);
}

function resetTemplateEditor() {
    document.getElementById('templateForm').reset();
    document.getElementById('templateId').value = '';
    document.getElementById('templateVersion').textContent = 'New template';
    document.getElementById('deleteTemplateBtn').hidden = true;
    document.getElementById('saveTemplateBtn').disabled = false;
    ['templateNameInput', 'templateTypeInput', 'templateHtmlInput'].forEach((id) => { document.getElementById(id).disabled = false; });
    document.getElementById('templateTypeInput').value = 'custom';
    setTemplateEditorValue('templateHtmlInput', '');
    setTemplateEditorValue('templateVariablesInput', '{}');
    window.customSelect?.setValue('templatePickerInput', 'new');
    previewTemplateHTML('');
}

function populateTemplateEditor(template, pickerValue) {
    document.getElementById('templateId').value = template.id || '';
    document.getElementById('templateNameInput').value = template.name || '';
    document.getElementById('templateTypeInput').value = template.type || 'custom';
    if (pickerValue) window.customSelect?.setValue('templatePickerInput', pickerValue);
    setTemplateEditorValue('templateHtmlInput', template.html || '');
    setTemplateEditorValue('templateVariablesInput', JSON.stringify(template.variables || template.exampleVariables || {}, null, 2));
    document.getElementById('templateVersion').textContent = template.id ? `Version ${template.version || 1}` : 'Starter template — save to customize';
    document.getElementById('deleteTemplateBtn').hidden = !template.id;
    document.getElementById('saveTemplateBtn').disabled = false;
    ['templateNameInput', 'templateTypeInput', 'templateHtmlInput'].forEach((id) => { document.getElementById(id).disabled = false; });
    previewTemplateWithVariables();
}

function formatDate(timestamp) {
    if (!timestamp) return 'Not used yet';
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short'
    }).format(new Date(timestamp * 1000));
}

function renderKeys(keys) {
    const container = document.getElementById('keysList');
    const keyCount = document.getElementById('keyCount');
    const activeKeys = (keys || []).filter((key) => key.isActive);
    keyCount.textContent = String(activeKeys.length);
    container.replaceChildren();

    if (!keys || keys.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.innerHTML = '<strong>No API keys yet</strong><span>Create your first key to use the production endpoint.</span>';
        container.appendChild(empty);
        return;
    }

    keys.forEach((key) => {
        const item = document.createElement('div');
        item.className = 'key-item';

        const identity = document.createElement('div');
        identity.className = 'key-identity';
        const keyLabel = document.createElement('code');
        keyLabel.textContent = key.keyId;
        const created = document.createElement('span');
        created.textContent = `Created ${formatDate(key.createdAt)}`;
        identity.append(keyLabel, created);

        const activity = document.createElement('div');
        activity.className = 'key-activity';
        const activityLabel = document.createElement('span');
        activityLabel.textContent = key.lastUsed ? 'Last used' : 'Usage';
        const activityValue = document.createElement('strong');
        activityValue.textContent = formatDate(key.lastUsed);
        activity.append(activityLabel, activityValue);

        const controls = document.createElement('div');
        controls.className = 'key-controls';
        const state = document.createElement('span');
        state.className = key.isActive ? 'key-state is-active' : 'key-state';
        state.textContent = key.isActive ? 'Active' : 'Revoked';
        controls.appendChild(state);

        if (key.isActive) {
            const revokeButton = document.createElement('button');
            revokeButton.className = 'revoke-button';
            revokeButton.type = 'button';
            revokeButton.innerHTML = '<i data-lucide="ban" aria-hidden="true"></i>Revoke';
            revokeButton.dataset.keyId = key.keyId;
            controls.appendChild(revokeButton);
        }

        item.append(identity, activity, controls);
        container.appendChild(item);
    });
    window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } });
}

async function loadKeys() {
    const status = document.getElementById('keysStatus');
    try {
        const data = await listKeys();
        renderKeys(data.keys);
        setNotice(status);
    } catch (error) {
        setNotice(status, `Could not load API keys. ${error.message}`, 'error');
    }
}

function renderAccount() {
    const payload = decodeTokenPayload(localStorage.getItem('id_token'));
    const accountLabel = document.getElementById('accountLabel');
    accountLabel.textContent = payload?.email || 'RenderPDF developer';
    document.getElementById('statsNav').hidden = payload?.email?.toLowerCase() !== 'vberkoz@gmail.com';
}

function formatLogDate(timestamp) {
    if (!timestamp) return 'Unknown time';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp * 1000));
}

function renderLogs(logs) {
    const container = document.getElementById('logsList');
    container.replaceChildren();
    if (!logs?.length) {
        container.innerHTML = '<p class="empty-state">No authenticated PDF requests yet.</p>';
        return;
    }
    logs.forEach((log) => {
        const item = document.createElement('div');
        item.className = `log-item ${log.status === 'success' ? 'is-success' : 'is-error'}`;
        const main = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = log.status === 'success' ? 'PDF generated' : 'PDF failed';
        const details = document.createElement('span');
        details.textContent = `${formatLogDate(log.timestamp)} · ${log.apiKeyId ? `key ${log.apiKeyId.slice(0, 8)}` : 'account request'}`;
        main.append(title, details);
        const meta = document.createElement('span');
        meta.textContent = log.status === 'success' ? `${(log.size / 1024).toFixed(1)} KB` : (log.errorType || log.status);
        item.append(main, meta);
        container.appendChild(item);
    });
}

function renderDashboard(data) {
    const usage = data.usage || {};
    const billing = data.billing || { status: 'free', plan: 'Free' };
    document.getElementById('pdfsToday').textContent = String(usage.pdfsToday ?? 0);
    document.getElementById('failedToday').textContent = String(usage.failedToday ?? 0);
    document.getElementById('quotaRemaining').textContent = String(usage.remaining ?? 0);
    document.getElementById('quotaDetail').textContent = `${usage.usedThisMonth ?? 0} of ${usage.quota ?? 0} PDFs used this month`;
    document.getElementById('billingPlan').textContent = billing.plan || 'Free';
    document.getElementById('billingDetail').textContent = billing.status === 'free'
        ? 'Upgrade for more monthly PDF capacity.'
        : `${billing.status.replace(/_/g, ' ')}${billing.renewsAt ? ` · renews ${new Date(billing.renewsAt).toLocaleDateString()}` : ''}`;
    const subscribed = ['active', 'trialing', 'past_due'].includes(billing.status);
    document.querySelectorAll('[data-plan]').forEach((button) => { button.hidden = subscribed; });
    document.getElementById('manageBillingBtn').hidden = !subscribed;
    renderLogs(data.logs);
}

async function refreshDashboard() {
    const billingStatus = document.getElementById('billingStatus');
    try {
        renderDashboard(await loadDashboard());
        setNotice(billingStatus);
    } catch (error) {
        setNotice(billingStatus, `Could not load dashboard data. ${error.message}`, 'error');
    }
}

if (checkAuth()) {
    const generateButton = document.getElementById('generateKeyBtn');
    const copyButton = document.getElementById('copyKeyBtn');
    const keysList = document.getElementById('keysList');
    const keysStatus = document.getElementById('keysStatus');
    const templatesStatus = document.getElementById('templatesStatus');
    const templatePickerInput = document.getElementById('templatePickerInput');
    const templateForm = document.getElementById('templateForm');
    const templateRenderResult = document.getElementById('templateRenderResult');
    const saveTemplateButton = document.getElementById('saveTemplateBtn');
    const renderTemplateButton = document.getElementById('renderTemplateBtn');
    const documentJsonStatus = document.getElementById('documentJsonStatus');
    const documentJsonResult = document.getElementById('documentJsonResult');
    const previewDocumentJsonButton = document.getElementById('previewDocumentJsonBtn');
    const renderDocumentJsonButton = document.getElementById('renderDocumentJsonBtn');

    window.customSelect?.init();
    initializeTemplateCodeEditor('templateHtmlInput', 'htmlmixed');
    initializeTemplateCodeEditor('templateVariablesInput', 'application/json');
    initializeTemplateCodeEditor('documentJsonInput', 'application/json');
    initializeTemplateCodeEditor('documentMarkdownInput', 'markdown');
    initializeTemplateCodeEditor('documentMarkdownSettingsInput', 'application/json');
    let savedTemplates = new Map();
    let starterTemplates = new Map();

    async function openStoredTemplate(summary) {
        try {
            const template = await getStoredTemplate(summary.id);
            populateTemplateEditor(template, `saved:${template.id}`);
            setNotice(templatesStatus);
        } catch (error) {
            setNotice(templatesStatus, `Could not load template. ${error.message}`, 'error');
        }
    }

    async function loadTemplates(selectedValue = templatePickerInput.value) {
        try {
            const data = await listTemplates();
            savedTemplates = new Map((data.templates || []).map((template) => [template.id, template]));
            starterTemplates = new Map((data.starters || []).map((template) => [template.type, template]));
            window.customSelect?.replaceOptions('templatePickerInput', [
                {
                    label: 'Custom templates',
                    options: [
                        { value: 'new', label: 'Blank custom template' },
                        ...(data.templates || []).map((template) => ({ value: `saved:${template.id}`, label: template.name }))
                    ]
                },
                {
                    label: 'Starter templates',
                    options: (data.starters || []).map((template) => ({ value: `starter:${template.type}`, label: `${template.name} starter` }))
                }
            ], selectedValue);
            setNotice(templatesStatus);
        } catch (error) {
            setNotice(templatesStatus, `Could not load templates. ${error.message}`, 'error');
        }
    }

    renderAccount();
    if (IS_LOCAL_PREVIEW) {
        renderKeys([]);
    } else {
        loadKeys();
        loadTemplates();
    }
    if (!IS_LOCAL_PREVIEW) refreshDashboard();
    resetTemplateEditor();
    loadDocumentEditorSample('html');
    loadDocumentEditorSample('markdown');
    setDocumentEditorMode('html');
    previewDocumentJson();

    document.querySelectorAll('[data-plan]').forEach((button) => button.addEventListener('click', async () => {
        const billingStatus = document.getElementById('billingStatus');
        setButtonPending(button, true, 'Opening checkout...');
        try {
            const data = await startCheckout(button.dataset.plan);
            await openPaddleCheckout(data);
            setButtonPending(button, false);
        } catch (error) {
            setNotice(billingStatus, `Could not start checkout. ${error.message}`, 'error');
            setButtonPending(button, false);
        }
    }));

    document.getElementById('manageBillingBtn').addEventListener('click', async () => {
        const button = document.getElementById('manageBillingBtn');
        const billingStatus = document.getElementById('billingStatus');
        setButtonPending(button, true, 'Opening billing...');
        try {
            const data = await openBillingPortal();
            window.location.assign(data.url);
        } catch (error) {
            setNotice(billingStatus, `Could not open billing. ${error.message}`, 'error');
            setButtonPending(button, false);
        }
    });

    generateButton.addEventListener('click', async () => {
        setButtonPending(generateButton, true, 'Creating key...');
        setNotice(keysStatus);
        try {
            const data = await generateKey();
            document.getElementById('newKeyValue').textContent = data.apiKey;
            document.getElementById('newKeyCard').hidden = false;
            await loadKeys();
        } catch (error) {
            setNotice(keysStatus, `Could not create an API key. ${error.message}`, 'error');
        } finally {
            setButtonPending(generateButton, false);
        }
    });

    copyButton.addEventListener('click', async () => {
        const key = document.getElementById('newKeyValue').textContent;
        try {
            await navigator.clipboard.writeText(key);
            copyButton.textContent = 'Copied';
            window.setTimeout(() => { copyButton.textContent = 'Copy key'; }, 1600);
        } catch (error) {
            setNotice(keysStatus, 'Clipboard access is unavailable. Select and copy the key manually.', 'error');
        }
    });

    templatePickerInput.addEventListener('change', async () => {
        const [kind, value] = templatePickerInput.value.split(':', 2);
        if (kind === 'new') {
            resetTemplateEditor();
            setNotice(templatesStatus);
        } else if (kind === 'starter') {
            const starter = starterTemplates.get(value);
            if (starter) {
                populateTemplateEditor({ ...starter, id: '' }, templatePickerInput.value);
                setNotice(templatesStatus, `Loaded the ${starter.name} starter. Save it to create your editable copy.`, 'success');
            }
        } else if (kind === 'saved') {
            const template = savedTemplates.get(value);
            if (template) await openStoredTemplate(template);
        }
    });

    document.getElementById('templateHtmlInput').addEventListener('input', previewTemplateWithVariables);
    document.getElementById('templateVariablesInput').addEventListener('input', previewTemplateWithVariables);

    templateForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        let template;
        try {
            template = templatePayloadFromForm();
        } catch (error) {
            setNotice(templatesStatus, `Variable JSON is invalid. ${error.message}`, 'error');
            return;
        }
        if (!template.name || !template.html) {
            setNotice(templatesStatus, 'Template name and HTML are required.', 'error');
            return;
        }
        setButtonPending(saveTemplateButton, true, 'Saving...');
        try {
            const templateId = document.getElementById('templateId').value;
            const saved = templateId ? await updateTemplate(templateId, template) : await createTemplate(template);
            populateTemplateEditor(saved, `saved:${saved.id}`);
            await loadTemplates(`saved:${saved.id}`);
            setNotice(templatesStatus, 'Template saved.', 'success');
        } catch (error) {
            setNotice(templatesStatus, `Could not save template. ${error.message}`, 'error');
        } finally {
            setButtonPending(saveTemplateButton, false);
        }
    });

    document.getElementById('deleteTemplateBtn').addEventListener('click', async () => {
        const templateId = document.getElementById('templateId').value;
        if (!templateId) return;
        if (!window.confirm('Delete this template? This cannot be undone.')) return;
        const button = document.getElementById('deleteTemplateBtn');
        setButtonPending(button, true, 'Deleting...');
        try {
            await removeTemplate(templateId);
            resetTemplateEditor();
            await loadTemplates();
            setNotice(templatesStatus, 'Template deleted.', 'success');
        } catch (error) {
            setNotice(templatesStatus, `Could not delete template. ${error.message}`, 'error');
        } finally {
            setButtonPending(button, false);
        }
    });

    renderTemplateButton.addEventListener('click', async () => {
        const templateId = document.getElementById('templateId').value;
        if (!templateId) {
            setNotice(templateRenderResult, 'Save this template before rendering a test PDF.', 'error');
            return;
        }
        let variables;
        try {
            variables = templateVariablesFromEditor();
        } catch (error) {
            setNotice(templateRenderResult, `Variable JSON is invalid. ${error.message}`, 'error');
            return;
        }
        setButtonPending(renderTemplateButton, true, 'Rendering PDF...');
        setNotice(templateRenderResult, 'Resolving template variables and rendering PDF...', 'pending');
        try {
            const result = await renderStoredTemplate(templateId, variables);
            templateRenderResult.dataset.state = 'success';
            templateRenderResult.replaceChildren();
            const link = document.createElement('a');
            link.href = result.url;
            link.target = '_blank';
            link.rel = 'noopener';
            link.textContent = `Download test PDF (${(result.size / 1024).toFixed(1)} KB) →`;
            templateRenderResult.append(link);
            templateRenderResult.hidden = false;
        } catch (error) {
            setNotice(templateRenderResult, `Could not render template. ${error.message}`, 'error');
        } finally {
            setButtonPending(renderTemplateButton, false);
        }
    });

    ['documentJsonInput', 'documentMarkdownInput', 'documentMarkdownSettingsInput'].forEach((id) => document.getElementById(id).addEventListener('input', () => {
        try {
            parseDocumentEditor();
            setNotice(documentJsonStatus);
        } catch (error) {
            setNotice(documentJsonStatus, error.message, 'error');
        }
        setNotice(documentJsonResult);
    }));

    document.getElementById('documentSourceTypeInput').addEventListener('change', (event) => {
        setDocumentEditorMode(event.target.value, true);
        try {
            previewDocumentJson();
            setNotice(documentJsonStatus, `Loaded the ${event.target.value === 'markdown' ? 'Markdown' : 'HTML/CSS JSON'} sample.`, 'success');
        } catch (error) {
            setNotice(documentJsonStatus, error.message, 'error');
        }
    });

    previewDocumentJsonButton.addEventListener('click', () => {
        try {
            previewDocumentJson();
            setNotice(documentJsonStatus, 'Preview updated. Values are HTML-escaped and network access is disabled.', 'success');
        } catch (error) {
            setNotice(documentJsonStatus, error.message, 'error');
        }
    });

    document.getElementById('resetDocumentJsonBtn').addEventListener('click', () => {
        const type = document.getElementById('documentSourceTypeInput').value;
        loadDocumentEditorSample(type);
        previewDocumentJson();
        setNotice(documentJsonStatus, `${type === 'markdown' ? 'Markdown' : 'HTML/CSS JSON'} sample restored.`, 'success');
        setNotice(documentJsonResult);
    });

    renderDocumentJsonButton.addEventListener('click', async () => {
        let request;
        try {
            request = previewDocumentJson();
            setNotice(documentJsonStatus);
        } catch (error) {
            setNotice(documentJsonStatus, error.message, 'error');
            return;
        }
        if (IS_LOCAL_PREVIEW) {
            setNotice(documentJsonResult, 'PDF rendering requires a signed-in dashboard session.', 'error');
            return;
        }
        setButtonPending(renderDocumentJsonButton, true, 'Rendering PDF...');
        setNotice(documentJsonResult, 'Validating the document and rendering its PDF...', 'pending');
        try {
            const result = await renderInlineDocument(request);
            documentJsonResult.dataset.state = 'success';
            documentJsonResult.replaceChildren();
            const summary = document.createElement('div');
            const title = document.createElement('strong');
            title.textContent = 'PDF ready';
            const detail = document.createElement('span');
            detail.textContent = `${(result.size / 1024).toFixed(1)} KB · request ${result.requestId}`;
            summary.append(title, detail);
            const link = document.createElement('a');
            link.href = result.url;
            link.target = '_blank';
            link.rel = 'noopener';
            link.download = '';
            link.textContent = 'Download PDF →';
            documentJsonResult.append(summary, link);
            documentJsonResult.hidden = false;
        } catch (error) {
            setNotice(documentJsonResult, `Could not render document. ${error.message}`, 'error');
        } finally {
            setButtonPending(renderDocumentJsonButton, false);
        }
    });

    document.getElementById('saveDocumentSourceBtn').addEventListener('click', async () => {
        let definition;
        try {
            definition = previewDocumentJson();
            if (definition.html) {
                definition = { ...definition, source: { type: 'html', content: definition.html } };
                delete definition.html;
            }
        } catch (error) {
            setNotice(documentJsonStatus, error.message, 'error');
            return;
        }
        const name = window.prompt('Name this saved source');
        if (!name) return;
        try {
            await dashboardTemplateRequest('/dashboard/sources', { method: 'POST', body: JSON.stringify({ name, definition }) });
            setNotice(documentJsonStatus, 'Source saved. You can reuse it in a future batch.', 'success');
        } catch (error) {
            setNotice(documentJsonStatus, `Could not save source. ${error.message}`, 'error');
        }
    });

    const managedRequest = (path, options = {}) => dashboardTemplateRequest(path, options);
    async function refreshManagers() {
        try {
            const [sourceResult, fileResult] = await Promise.all([managedRequest('/dashboard/sources'), managedRequest('/dashboard/files')]);
            const sourceList = sourceResult.sources || [];
            const sourcesManager = document.getElementById('sourcesManager');
            sourcesManager.replaceChildren();
            const batchOptions = sourceList.map((source) => ({ value: source.id, label: source.name }));
            sourceList.forEach((source) => {
                const row = document.createElement('div'); row.className = 'log-row';
                row.innerHTML = `<strong></strong><span></span><button class="dashboard-button dashboard-button-secondary" type="button">Delete</button>`;
                row.querySelector('strong').textContent = source.name;
                row.querySelector('span').textContent = `${source.sourceType} · ${(source.sizeBytes / 1024).toFixed(1)} KB`;
                row.querySelector('button').onclick = async () => { await managedRequest(`/dashboard/sources/${encodeURIComponent(source.id)}`, { method: 'DELETE' }); refreshManagers(); };
                sourcesManager.append(row);
            });
            window.customSelect?.replaceOptions('batchSourceSelect', [{ label: 'Saved sources', options: batchOptions.length ? batchOptions : [{ value: '', label: 'No saved sources' }] }], batchOptions[0]?.value || '');
            const filesManager = document.getElementById('filesManager'); filesManager.replaceChildren();
            (fileResult.files || []).forEach((file) => {
                const row = document.createElement('div'); row.className = 'log-row';
                row.innerHTML = `<strong></strong><span></span><button class="dashboard-button dashboard-button-secondary" type="button">Download</button><button class="dashboard-button dashboard-button-secondary" type="button">Delete</button>`;
                row.querySelector('strong').textContent = file.kind;
                row.querySelector('span').textContent = `${(file.sizeBytes / 1024).toFixed(1)} KB`;
                const [download, remove] = row.querySelectorAll('button');
                download.onclick = async () => { const result = await managedRequest(`/dashboard/files/${encodeURIComponent(file.id)}/download`); window.open(result.url, '_blank', 'noopener'); };
                remove.onclick = async () => { await managedRequest(`/dashboard/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' }); refreshManagers(); };
                filesManager.append(row);
            });
        } catch (error) { console.error('Could not refresh storage managers', error); }
    }
    document.getElementById('refreshSourcesBtn').onclick = refreshManagers;
    document.getElementById('packageUploadInput').onchange = async (event) => {
        const file = event.target.files[0]; if (!file) return;
        const upload = await managedRequest('/dashboard/files/upload', { method: 'POST' });
        await fetch(upload.uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': 'application/zip' } });
        await refreshManagers();
    };
    document.getElementById('submitBatchBtn').onclick = async () => {
        const sourceID = document.getElementById('batchSourceSelect').value;
        const items = JSON.parse(document.getElementById('batchItemsInput').value);
        const job = await managedRequest('/dashboard/batches', { method: 'POST', body: JSON.stringify({ version: '1', source: { type: 'stored', id: sourceID }, items }) });
        document.getElementById('batchesManager').textContent = `Submitted ${job.jobId}. Refresh to view progress.`;
    };
    document.getElementById('refreshBatchesBtn').onclick = async () => { document.getElementById('batchesManager').textContent = 'Enter a job ID from a submitted batch to inspect it. Batch history listing is not available yet.'; };
    refreshManagers();

    keysList.addEventListener('click', async (event) => {
        const revokeButton = event.target.closest('[data-key-id]');
        if (!revokeButton) return;
        if (!window.confirm('Revoke this API key? Requests using it will stop working immediately.')) return;

        setButtonPending(revokeButton, true, 'Revoking...');
        try {
            await deleteKey(revokeButton.dataset.keyId);
            await loadKeys();
        } catch (error) {
            setNotice(keysStatus, `Could not revoke the API key. ${error.message}`, 'error');
            setButtonPending(revokeButton, false);
        }
    });

    document.getElementById('logoutBtn').addEventListener('click', () => {
        clearSession();
        window.location.href = '/app/login';
    });

}
