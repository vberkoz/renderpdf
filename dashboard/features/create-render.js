(function (global) {
  'use strict';

  const markdownDocumentDefaultCSS = `
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 16px; line-height: 1.6; color: #24292e; max-width: 800px; margin: 0 auto; padding: 2rem; background-color: #ffffff; }
h1, h2, h3, h4, h5, h6 { margin-top: 1.5rem; margin-bottom: 1rem; font-weight: 600; line-height: 1.25; }
h1 { font-size: 2em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
h3 { font-size: 1.25em; }
a { color: #0366d6; text-decoration: none; }
a:hover { text-decoration: underline; }
p, blockquote, ul, ol, dl, table, pre { margin-top: 0; margin-bottom: 16px; }
ul, ol { padding-left: 2em; }
li + li { margin-top: 0.25em; }
blockquote { padding: 0 1em; color: #6a737d; border-left: 0.25em solid #dfe2e5; margin-left: 0; }
code { padding: 0.2em 0.4em; margin: 0; font-size: 85%; background-color: rgba(27, 31, 35, 0.05); border-radius: 3px; font-family: SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace; }
pre { max-width: 100%; padding: 16px; overflow: visible; font-size: 85%; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; background-color: #f6f8fa; border-radius: 3px; }
pre code { background-color: transparent; padding: 0; font-size: 100%; white-space: inherit; overflow-wrap: inherit; word-break: inherit; }
table { border-spacing: 0; border-collapse: collapse; width: 100%; }
table th, table td { padding: 6px 13px; border: 1px solid #dfe2e5; }
table tr { background-color: #fff; border-top: 1px solid #c6cbd1; }
table tr:nth-child(2n) { background-color: #f6f8fa; }
img { max-width: 100%; box-sizing: content-box; background-color: #fff; }
`;

  const sampleDocumentRequest = {
    version: '1',
    html: '<main class="report"><p class="eyebrow">{{report.period}}</p><h1>{{report.title}}</h1><p>{{report.summary}}</p><dl><div><dt>Prepared for</dt><dd>{{customer.name}}</dd></div><div><dt>Status</dt><dd>{{report.status}}</dd></div></dl></main>',
    css: 'body { margin: 0; color: #17202a; font-family: Arial, sans-serif; } .report { padding: 8mm; border-top: 4px solid #123456; } .eyebrow { color: #64748b; font-size: 11px; font-weight: bold; letter-spacing: 0.12em; text-transform: uppercase; } h1 { margin: 8px 0 24px; color: #123456; font-size: 32px; } p { line-height: 1.55; } dl { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 32px; } dl div { padding: 14px; background: #f3f6f9; } dt { color: #64748b; font-size: 10px; text-transform: uppercase; } dd { margin: 6px 0 0; font-weight: bold; }',
    data: {
      report: {
        period: 'August 2026',
        title: 'Monthly report',
        summary: 'A concise overview generated from a versioned JSON document.',
        status: 'Ready for review',
      },
      customer: { name: 'Ada & Sons.' },
    },
    options: { format: 'A4', margin: '18mm' },
  };

  const sampleMarkdownDocumentRequest = {
    version: '1',
    source: {
      type: 'markdown',
      content:
        '# {{report.title}}\n\n{{report.summary}}\n\n| Prepared for | Status |\n| --- | --- |\n| {{customer.name}} | {{report.status}} |\n\n- [x] Ready for review',
    },
    css: 'body { margin: 0; padding: 8mm; color: #17202a; font-family: Arial, sans-serif; } h1 { color: #123456; font-size: 32px; } table { width: 100%; margin-top: 28px; border-collapse: collapse; } th, td { padding: 12px; border: 1px solid #d7dde4; text-align: left; } th { color: #64748b; font-size: 11px; text-transform: uppercase; }',
    data: {
      report: {
        title: 'Monthly report',
        summary: 'A concise overview generated from a Markdown document.',
        status: 'Ready for review',
      },
      customer: { name: 'Ada & Sons.' },
    },
    options: { format: 'A4', margin: '18mm' },
  };

  const documentPlaceholderPattern =
    /{{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*}}/g;
  const documentTopLevelFields = new Set([
    'version',
    'html',
    'source',
    'css',
    'data',
    'options',
    'webhookUrl',
    'webhookSecret',
  ]);

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function documentByteLength(value) {
    return new TextEncoder().encode(value).length;
  }

  function validateArrayDepth(arr, depth) {
    if (depth > 10) throw new Error('data must not exceed 10 nested levels.');
    arr.forEach((item) => {
      if (Array.isArray(item)) {
        validateArrayDepth(item, depth + 1);
      } else if (isPlainObject(item)) {
        flattenDocumentData(item, '', depth + 1, new Map(), true);
      }
    });
  }

  function flattenDocumentData(
    value,
    prefix = '',
    depth = 1,
    output = new Map(),
    allowNull = false
  ) {
    if (depth > 10) throw new Error('data must not exceed 10 nested levels.');
    Object.entries(value).forEach(([key, child]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        throw new Error(`Invalid data variable name "${key}".`);
      const path = prefix ? `${prefix}.${key}` : key;
      if (isPlainObject(child)) {
        flattenDocumentData(child, path, depth + 1, output, allowNull);
      } else if (Array.isArray(child)) {
        validateArrayDepth(child, depth + 1);
        output.set(path, child);
      } else {
        if (child === null && !allowNull)
          throw new Error(`Missing required data variable "${path}".`);
        if (child !== null) output.set(path, child);
      }
    });
    return output;
  }

  function renderInlineDocument(documentRequest) {
    const isSpecialSource =
      documentRequest.source && ['url', 'upload'].includes(documentRequest.source.type);
    const endpoint = isSpecialSource ? '/render' : '/dashboard/render-document';
    if (typeof global.dashboardTemplateRequest === 'function') {
      return global.dashboardTemplateRequest(endpoint, {
        method: 'POST',
        body: JSON.stringify(documentRequest),
      });
    }
    if (typeof dashboardTemplateRequest === 'function') {
      return dashboardTemplateRequest(endpoint, {
        method: 'POST',
        body: JSON.stringify(documentRequest),
      });
    }
    throw new Error('dashboardTemplateRequest is not available');
  }

  function validateDocumentCSSForPreview(css) {
    if (/@page\b/i.test(css)) throw new Error('@page settings must be supplied through options.');
    if (/@import\b/i.test(css)) throw new Error('CSS @import rules are not allowed.');
    if (/url\s*\(/i.test(css)) throw new Error('CSS url() assets are not allowed.');
    if (/(expression\s*\(|-moz-binding\b|behavior\s*:)/i.test(css))
      throw new Error('Unsafe CSS is not allowed.');
  }

  function validateDocumentMarkupForPreview(html) {
    if (/@page\b/i.test(html)) throw new Error('@page settings must be supplied through options.');
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const forbidden = parsed.querySelector(
      'script, iframe, embed, object, applet, base, link, meta[http-equiv="refresh" i]'
    );
    if (forbidden)
      throw new Error(`HTML <${forbidden.tagName.toLowerCase()}> elements are not allowed.`);
    parsed.querySelectorAll('*').forEach((element) => {
      element.getAttributeNames().forEach((attributeName) => {
        const name = attributeName.toLowerCase();
        const value = (element.getAttribute(attributeName) || '').trim();
        if (name.startsWith('on')) throw new Error('HTML event-handler attributes are not allowed.');
        if (name === 'style') validateDocumentCSSForPreview(value);
        if (['src', 'srcset', 'poster', 'data', 'background'].includes(name) && value)
          throw new Error('Document assets are not allowed.');
        if (
          ['href', 'action', 'formaction', 'xlink:href'].includes(name) &&
          value &&
          !value.startsWith('#') &&
          !/^(https?|mailto):/i.test(value)
        ) {
          throw new Error('Document URLs must use http, https, or mailto.');
        }
      });
    });
  }

  function getEditorValue(id) {
    if (typeof global.templateEditorValue === 'function') {
      return global.templateEditorValue(id);
    }
    if (typeof templateEditorValue === 'function') {
      return templateEditorValue(id);
    }
    return document.getElementById(id)?.value ?? '';
  }

  function setEditorValue(id, value) {
    if (typeof global.setTemplateEditorValue === 'function') {
      global.setTemplateEditorValue(id, value);
    } else if (typeof setTemplateEditorValue === 'function') {
      setTemplateEditorValue(id, value);
    } else {
      const el = document.getElementById(id);
      if (el) el.value = String(value ?? '');
    }
  }

  function getCodeEditors() {
    return global.templateCodeEditors || (typeof templateCodeEditors !== 'undefined' ? templateCodeEditors : {});
  }

  function parseDocumentSettingsEditor() {
    const source = getEditorValue('documentMarkdownSettingsInput');
    let settings;
    try {
      settings = JSON.parse(source);
    } catch (error) {
      throw new Error(`Data, CSS, and options JSON is invalid. ${error.message}`);
    }
    if (!isPlainObject(settings)) throw new Error('Data, CSS, and options must be a JSON object.');
    const unknownField = Object.keys(settings).find(
      (field) => !['css', 'data', 'options', 'webhookUrl', 'webhookSecret'].includes(field)
    );
    if (unknownField) throw new Error(`Unknown Markdown settings field "${unknownField}".`);
    return settings;
  }

  function documentRequestFromEditor() {
    let request;
    if (document.getElementById('documentSourceTypeInput')?.value === 'markdown') {
      const content = getEditorValue('documentMarkdownInput');
      const settings = parseDocumentSettingsEditor();
      request = { version: '1', source: { type: 'markdown', content }, ...settings };
    } else {
      const source = getEditorValue('documentJsonInput');
      if (!source || !source.trim()) {
        throw new Error('Document request JSON is empty.');
      }
      if (documentByteLength(source) > 1024 * 1024)
        throw new Error('Document request must not exceed 1 MB.');
      try {
        request = JSON.parse(source);
      } catch (error) {
        throw new Error(`Invalid JSON. ${error.message}`);
      }
    }

    if (typeof document !== 'undefined' && isPlainObject(request)) {
      const wm = document.getElementById('optionWatermarkText')?.value?.trim();
      const pw = document.getElementById('optionPassword')?.value;
      const pnf = document.getElementById('optionPageNumberFormat')?.value?.trim();
      const compProfile = document.getElementById('optionComplianceProfile')?.value?.trim();
      const zeroRetention = Boolean(document.getElementById('optionZeroRetention')?.checked);
      if (wm || pw || pnf || compProfile || zeroRetention) {
        request.options = { ...(request.options || {}) };
        if (wm && !request.options.watermark) request.options.watermark = { text: wm };
        if (pw && !request.options.password) request.options.password = pw;
        if (pnf && !request.options.pageNumbers) request.options.pageNumbers = { format: pnf };
        if (compProfile && !request.options.compliance) {
          request.options.compliance = { profile: compProfile };
        }
        if (zeroRetention && request.options.zeroRetention === undefined) {
          request.options.zeroRetention = true;
        }
      }
    }
    return request;
  }

  function parseDocumentEditor() {
    const request = documentRequestFromEditor();
    if (documentByteLength(JSON.stringify(request)) > 1024 * 1024)
      throw new Error('Document request must not exceed 1 MB.');
    if (!isPlainObject(request)) throw new Error('The request must be a JSON object.');
    const unknownField = Object.keys(request).find((field) => !documentTopLevelFields.has(field));
    if (unknownField) throw new Error(`Unknown top-level field "${unknownField}".`);
    if (request.version !== '1') throw new Error('version must be "1".');
    const usesSource = request.source !== undefined;
    const usesMarkdown = usesSource && request.source?.type === 'markdown';
    if (usesSource && request.html !== undefined)
      throw new Error('source and html cannot be used together.');
    if (usesSource) {
      if (!isPlainObject(request.source) || typeof request.source.type !== 'string') {
        throw new Error('source must be an object with a type property.');
      }
      const allowedSourceTypes = ['markdown', 'url', 'upload', 'html', 'template', 'stored'];
      if (!allowedSourceTypes.includes(request.source.type)) {
        throw new Error(`Unsupported source type "${request.source.type}".`);
      }
      if (request.source.type !== 'url' && (request.source.headers !== undefined || request.source.cookies !== undefined)) {
        throw new Error('source.headers and source.cookies are only supported when source.type is "url".');
      }
      if (request.source.type === 'markdown') {
        const unknownSourceField = Object.keys(request.source).find(
          (field) => !['type', 'content'].includes(field)
        );
        if (unknownSourceField) throw new Error(`Unknown source field "${unknownSourceField}".`);
        if (typeof request.source.content !== 'string' || !request.source.content.trim()) {
          throw new Error('source must contain type "markdown" and non-empty content.');
        }
        if (documentByteLength(request.source.content) > 768 * 1024)
          throw new Error('source.content must not exceed 768 KB.');
      } else if (request.source.type === 'url') {
        const unknownUrlField = Object.keys(request.source).find(
          (field) => !['type', 'url', 'headers', 'cookies'].includes(field)
        );
        if (unknownUrlField) throw new Error(`Unknown source field "${unknownUrlField}".`);
        if (typeof request.source.url !== 'string' || !/^https?:\/\//i.test(request.source.url)) {
          throw new Error('source.url must be a valid HTTP or HTTPS URL.');
        }
        if (request.source.headers !== undefined) {
          if (!isPlainObject(request.source.headers)) {
            throw new Error('source.headers must be a JSON object of header names and string values.');
          }
          const disallowedHeaders = new Set([
            'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
            'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
            'expect', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port',
            'x-real-ip', 'x-original-url', 'x-rewrite-url', 'cf-connecting-ip', 'true-client-ip',
            'forwarded', 'via',
          ]);
          const entries = Object.entries(request.source.headers);
          if (entries.length > 32) {
            throw new Error('source.headers must not exceed 32 entries.');
          }
          for (const [k, v] of entries) {
            if (typeof v !== 'string' || /[\r\n\0]/.test(k) || /[\r\n\0]/.test(v) || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(k)) {
              throw new Error(`Invalid URL header "${k}".`);
            }
            const lower = k.toLowerCase();
            if (disallowedHeaders.has(lower) || lower.startsWith('proxy-') || lower.startsWith('sec-')) {
              throw new Error(`Header "${k}" is not permitted on URL renders.`);
            }
          }
        }
        if (request.source.cookies !== undefined) {
          if (!Array.isArray(request.source.cookies)) {
            throw new Error('source.cookies must be an array of cookie objects.');
          }
          if (request.source.cookies.length > 32) {
            throw new Error('source.cookies must not exceed 32 entries.');
          }
          for (const cookie of request.source.cookies) {
            if (!isPlainObject(cookie) || typeof cookie.name !== 'string' || !cookie.name.trim() || typeof cookie.value !== 'string') {
              throw new Error('Each cookie in source.cookies must have a string name and value.');
            }
            if (/[;,\r\n\0 \t]/.test(cookie.name) || /[;\r\n\0]/.test(cookie.value)) {
              throw new Error(`Invalid cookie "${cookie.name}".`);
            }
          }
        }
      } else if (request.source.type === 'upload') {
        if (typeof request.source.uploadId !== 'string' || !request.source.uploadId.trim()) {
          throw new Error('source.uploadId is required.');
        }
      }
    } else if (typeof request.html !== 'string' || !request.html.trim()) {
      throw new Error('html is required and must be a string.');
    }
    if (request.css !== undefined && typeof request.css !== 'string')
      throw new Error('css must be a string.');

    const isUrlOrUpload = usesSource && ['url', 'upload'].includes(request.source.type);
    if (!isUrlOrUpload) {
      if (!isPlainObject(request.data)) throw new Error('data is required and must be an object.');
      if (documentByteLength(JSON.stringify(request.data)) > 256 * 1024)
        throw new Error('data must not exceed 256 KB.');
    } else if (request.data !== undefined && !isPlainObject(request.data)) {
      throw new Error('data must be an object.');
    }

    if (request.options !== undefined && !isPlainObject(request.options))
      throw new Error('options must be an object.');
    if (!usesSource && documentByteLength(request.html) > 768 * 1024)
      throw new Error('html must not exceed 768 KB.');
    if (documentByteLength(request.css || '') > 128 * 1024)
      throw new Error('css must not exceed 128 KB.');

    const options = { format: 'A4', margin: '18mm', ...(request.options || {}) };
    const allowedOptions = [
      'format',
      'margin',
      'landscape',
      'headerTemplate',
      'footerTemplate',
      'displayHeaderFooter',
      'password',
      'ownerPassword',
      'permissions',
      'watermark',
      'pageNumbers',
      'waitFor',
      'compliance',
      'zeroRetention',
      'responseFormat',
      'strictVariables',
      'allowExtraVariables',
    ];
    const unknownOption = Object.keys(options).find((field) => !allowedOptions.includes(field));
    if (unknownOption) throw new Error(`Unknown options field "${unknownOption}".`);
    if (options.zeroRetention !== undefined && typeof options.zeroRetention !== 'boolean') {
      throw new Error('options.zeroRetention must be a boolean.');
    }
    if (
      options.responseFormat !== undefined &&
      !['json', 'binary', 'pdf'].includes(String(options.responseFormat).trim().toLowerCase())
    ) {
      throw new Error('options.responseFormat must be one of json, binary, or pdf.');
    }
    if (options.strictVariables !== undefined && typeof options.strictVariables !== 'boolean') {
      throw new Error('options.strictVariables must be a boolean.');
    }
    if (
      options.allowExtraVariables !== undefined &&
      typeof options.allowExtraVariables !== 'boolean'
    ) {
      throw new Error('options.allowExtraVariables must be a boolean.');
    }
    if (!['A4', 'Letter', 'Legal'].includes(options.format))
      throw new Error('options.format must be one of A4, Letter, or Legal.');
    const marginMatch =
      typeof options.margin === 'string' && options.margin.match(/^([0-9]+(?:\.[0-9]+)?)(mm|in)$/);
    if (!marginMatch || Number(marginMatch[1]) > (marginMatch[2] === 'in' ? 2 : 50))
      throw new Error('options.margin must be a value from 0mm to 50mm or 0in to 2in.');
    if (
      options.headerTemplate !== undefined &&
      (typeof options.headerTemplate !== 'string' ||
        documentByteLength(options.headerTemplate) > 64 * 1024)
    ) {
      throw new Error('options.headerTemplate must be a string up to 64 KB.');
    }
    if (
      options.footerTemplate !== undefined &&
      (typeof options.footerTemplate !== 'string' ||
        documentByteLength(options.footerTemplate) > 64 * 1024)
    ) {
      throw new Error('options.footerTemplate must be a string up to 64 KB.');
    }
    if (
      options.displayHeaderFooter !== undefined &&
      typeof options.displayHeaderFooter !== 'boolean'
    ) {
      throw new Error('options.displayHeaderFooter must be a boolean.');
    }
    if (
      options.password !== undefined &&
      (typeof options.password !== 'string' || options.password.length > 128)
    ) {
      throw new Error('options.password must be a string up to 128 characters.');
    }
    if (
      options.ownerPassword !== undefined &&
      (typeof options.ownerPassword !== 'string' || options.ownerPassword.length > 128)
    ) {
      throw new Error('options.ownerPassword must be a string up to 128 characters.');
    }
    if (
      options.permissions !== undefined &&
      !['all', 'print', 'none'].includes(String(options.permissions).trim().toLowerCase())
    ) {
      throw new Error('options.permissions must be one of all, print, or none.');
    }
    if (
      options.watermark !== undefined &&
      !isPlainObject(options.watermark) &&
      typeof options.watermark !== 'string'
    ) {
      throw new Error('options.watermark must be a string or object.');
    }
    if (
      options.pageNumbers !== undefined &&
      !isPlainObject(options.pageNumbers) &&
      typeof options.pageNumbers !== 'boolean'
    ) {
      throw new Error('options.pageNumbers must be a boolean or object.');
    }

    const css = request.css || '';
    validateDocumentCSSForPreview(css);

    if (isUrlOrUpload) {
      return { request: { ...request, css, options }, values: new Map(), usesMarkdown: false };
    }

    const content = usesMarkdown ? request.source.content : request.html;
    if (/@page\b/i.test(content)) throw new Error('@page settings must be supplied through options.');
    if (!usesMarkdown) validateDocumentMarkupForPreview(content);
    const hasControlBlocks = /{{\s*(?:#each|#if|#unless)\b/.test(content);
    const allowExtra =
      hasControlBlocks ||
      options.allowExtraVariables === true ||
      options.strictVariables === false;
    const values = flattenDocumentData(request.data, '', 1, new Map(), allowExtra);
    if (!hasControlBlocks) {
      const placeholders = [...content.matchAll(documentPlaceholderPattern)];
      const unmatched = content.replace(documentPlaceholderPattern, '');
      if (unmatched.includes('{{') || unmatched.includes('}}'))
        throw new Error('HTML contains an invalid placeholder; use {{path.to.value}}.');
      const expected = new Set(placeholders.map((match) => match[1]));
      const missing = [...expected].find((path) => !values.has(path));
      if (missing) throw new Error(`Missing required data variable "${missing}".`);
      if (!allowExtra) {
        const unused = [...values.keys()].find((path) => !expected.has(path));
        if (unused)
          throw new Error(`Unknown data variable "${unused}"; every supplied value must be used.`);
      }
    }
    return { request: { ...request, css, options }, values, usesMarkdown };
  }

  function escapeMarkdownBindingValue(value) {
    const escHtml =
      typeof global.escapeTemplatePreviewHTML === 'function'
        ? global.escapeTemplatePreviewHTML
        : typeof escapeTemplatePreviewHTML === 'function'
          ? escapeTemplatePreviewHTML
          : (val) =>
              String(val)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
    return escHtml(value).replace(/[\\`*_{}\[\]()<>#+\-.!|~]/g, '\\$&');
  }

  function renderPdfDownloadResult(container, result, { title = 'PDF ready', linkLabel = 'Download PDF →', showSummary = true } = {}) {
    if (!container) return;
    container.dataset.state = 'success';
    container.replaceChildren();
    if (showSummary) {
      const summary = document.createElement('div');
      const heading = document.createElement('strong');
      heading.textContent = title;
      const detail = document.createElement('span');
      const sizeText = `${((result?.size || 0) / 1024).toFixed(1)} KB`;
      detail.textContent = result?.requestId ? `${sizeText} · request ${result.requestId}` : sizeText;
      summary.append(heading, detail);
      container.append(summary);
    }
    const link = document.createElement('a');
    if (!result?.url && result?.data) {
      link.href = `data:application/pdf;base64,${result.data}`;
      link.download = 'document.pdf';
    } else {
      link.href = result?.url || '#';
      link.download = '';
    }
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = linkLabel;
    container.append(link);
    container.hidden = false;
  }

  function closeSecondaryActions(element) {
    const details = element?.closest?.('.workflow-secondary-actions');
    if (details) details.open = false;
  }

  function initCreateRenderHandlers(deps = {}) {
    if (typeof document === 'undefined') return null;

    const fn = (name, fallback) =>
      typeof deps[name] === 'function'
        ? deps[name]
        : typeof global[name] === 'function'
          ? global[name]
          : fallback;

    const setNoticeFn = fn('setNotice', (el, msg = '', state = '') => {
      if (!el) return;
      el.textContent = msg;
      if (el.dataset) el.dataset.state = state;
      el.hidden = !msg;
    });
    const setPendingFn = fn('setButtonPending', (btn, pending, label) => {
      if (!btn) return;
      if (pending) {
        if (btn.dataset) btn.dataset.originalText = btn.textContent;
        btn.textContent = label || 'Working...';
        btn.disabled = true;
      } else {
        btn.textContent = btn.dataset?.originalText || btn.textContent;
        btn.disabled = false;
      }
    });
    const isLocal = () => Boolean(deps.isLocalPreview ?? global.IS_LOCAL_PREVIEW);

    const templatesStatus = document.getElementById('templatesStatus');
    const templateForm = document.getElementById('templateForm');
    const templateRenderResult = document.getElementById('templateRenderResult');
    const saveTemplateBtn = document.getElementById('saveTemplateBtn');
    const previewTemplateBtn = document.getElementById('previewTemplateBtn');
    const renderTemplateBtn = document.getElementById('renderTemplateBtn');
    const deleteTemplateBtn = document.getElementById('deleteTemplateBtn');

    // 1. Template mode (#templateWorkspace)
    const onTemplateInput = () => {
      const previewVars = fn('previewTemplateWithVariables');
      if (previewVars) previewVars();
    };
    document.getElementById('templateHtmlInput')?.addEventListener('input', onTemplateInput);
    document.getElementById('templateVariablesInput')?.addEventListener('input', onTemplateInput);

    previewTemplateBtn?.addEventListener('click', () => {
      const parseVars = fn('templateVariablesFromEditor');
      const previewVars = fn('previewTemplateWithVariables');
      const previewHtml = fn('previewTemplateHTML');
      const getVal = fn('templateEditorValue', getEditorValue);
      const reveal = fn('revealWorkflowPreview');
      try {
        if (parseVars) parseVars();
        if (previewVars) previewVars();
        if (reveal) reveal('templatePreviewDetails');
        setNoticeFn(
          templatesStatus,
          'Preview updated with the current template and variable data.',
          'success'
        );
      } catch (error) {
        if (previewHtml) previewHtml(getVal('templateHtmlInput'));
        if (reveal) reveal('templatePreviewDetails');
        setNoticeFn(
          templatesStatus,
          `Preview uses template HTML only: Variable JSON is invalid. ${error.message}`,
          'error'
        );
      }
    });

    templateForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (saveTemplateBtn?.disabled) return;
      setNoticeFn(templatesStatus);
      const buildPayload = fn('templatePayloadFromForm');
      let template;
      try {
        template = buildPayload ? buildPayload() : null;
      } catch (error) {
        setNoticeFn(templatesStatus, `Variable JSON is invalid. ${error.message}`, 'error');
        return;
      }
      if (!template?.name || !template?.html) {
        setNoticeFn(templatesStatus, 'Template name and HTML are required.', 'error');
        return;
      }
      setPendingFn(saveTemplateBtn, true, 'Saving...');
      try {
        const templateId = document.getElementById('templateId')?.value;
        const saveFn = templateId ? fn('updateTemplate') : fn('createTemplate');
        const saved = templateId ? await saveFn(templateId, template) : await saveFn(template);
        const populate = fn('populateTemplateEditor');
        if (populate && saved) populate(saved, `saved:${saved.id}`);
        const reload = fn('loadTemplates');
        if (reload && saved) await reload(`saved:${saved.id}`);
        setNoticeFn(templatesStatus, 'Template saved.', 'success');
      } catch (error) {
        setNoticeFn(templatesStatus, `Could not save template. ${error.message}`, 'error');
      } finally {
        setPendingFn(saveTemplateBtn, false);
      }
    });

    deleteTemplateBtn?.addEventListener('click', async () => {
      const templateId = document.getElementById('templateId')?.value;
      if (!templateId || deleteTemplateBtn.disabled) return;
      const confirmAction = fn('confirmDashboardAction');
      if (
        confirmAction &&
        !(await confirmAction({
          kicker: 'Template',
          title: 'Delete this template?',
          description: 'This cannot be undone.',
          confirmLabel: 'Delete template',
        }))
      ) {
        return;
      }
      setNoticeFn(templatesStatus);
      setNoticeFn(templateRenderResult);
      setPendingFn(deleteTemplateBtn, true, 'Deleting...');
      try {
        const removeFn = fn('removeTemplate');
        if (removeFn) await removeFn(templateId);
        const resetFn = fn('resetTemplateEditor');
        if (resetFn) resetFn();
        const reload = fn('loadTemplates');
        if (reload) await reload();
        setNoticeFn(templatesStatus, 'Template deleted.', 'success');
      } catch (error) {
        setNoticeFn(templatesStatus, `Could not delete template. ${error.message}`, 'error');
      } finally {
        setPendingFn(deleteTemplateBtn, false);
      }
    });

    renderTemplateBtn?.addEventListener('click', async () => {
      if (renderTemplateBtn.disabled) return;
      setNoticeFn(templatesStatus);
      const templateId = document.getElementById('templateId')?.value;
      if (!templateId) {
        setNoticeFn(templateRenderResult, 'Save this template before rendering a test PDF.', 'error');
        return;
      }
      const parseVars = fn('templateVariablesFromEditor');
      let variables = {};
      try {
        variables = parseVars ? parseVars() : {};
      } catch (error) {
        setNoticeFn(templateRenderResult, `Variable JSON is invalid. ${error.message}`, 'error');
        return;
      }
      if (isLocal()) {
        setNoticeFn(templateRenderResult, 'PDF rendering requires a signed-in dashboard session.', 'error');
        return;
      }
      setPendingFn(renderTemplateBtn, true, 'Rendering PDF...');
      setNoticeFn(templateRenderResult, 'Resolving template variables and rendering PDF...', 'pending');
      try {
        const renderStored = fn('renderStoredTemplate');
        const result = await renderStored(templateId, variables);
        renderPdfDownloadResult(templateRenderResult, result, {
          linkLabel: `Download test PDF (${((result?.size || 0) / 1024).toFixed(1)} KB) →`,
          showSummary: false,
        });
      } catch (error) {
        setNoticeFn(templateRenderResult, `Could not render template. ${error.message}`, 'error');
      } finally {
        setPendingFn(renderTemplateBtn, false);
      }
    });

    // 2. Saved source mode (#storedSourceWorkspace)
    document.getElementById('continueSavedSourceBtn')?.addEventListener('click', () => {
      const getSources = fn('getSavedSources');
      const sourceMap = getSources ? getSources() : new Map();
      const selectedId = document.getElementById('storedSourcePickerInput')?.value;
      const source = sourceMap?.get?.(selectedId);
      const statusEl = document.getElementById('storedSourceStatus');
      if (!source) {
        setNoticeFn(statusEl, 'Choose a saved source first.', 'error');
        return;
      }
      if (typeof window !== 'undefined' && window.customSelect?.replaceOptions) {
        window.customSelect.replaceOptions(
          'batchSourceSelect',
          [
            {
              label: 'Saved sources',
              options: [...sourceMap.values()].map((savedSource) => ({
                value: savedSource.id,
                label: savedSource.name,
              })),
            },
          ],
          source.id
        );
      } else {
        const batchSelect = document.getElementById('batchSourceSelect');
        if (batchSelect) batchSelect.value = source.id;
      }
      const updateBatch = fn('updateBatchReview');
      if (updateBatch) updateBatch();
      const switchView = fn('setDashboardView');
      if (switchView) switchView('batches', { history: 'push', focus: true });
      if (typeof CustomEvent === 'function') {
        document.dispatchEvent?.(new CustomEvent('dashboardviewchange', { detail: { view: 'batches' } }));
      }
      const composer = document.querySelector?.('.batch-composer');
      if (composer) composer.open = true;
      const focusBatchData = () => document.getElementById('batchItemsInput')?.focus?.();
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(focusBatchData);
      } else {
        focusBatchData();
      }
    });

    // 3. Public URL mode (#urlWorkspace)
    const urlForm = document.getElementById('urlForm');
    const renderUrlBtn = document.getElementById('renderUrlBtn');
    const urlStatus = document.getElementById('urlStatus');
    const urlRenderResult = document.getElementById('urlRenderResult');

    async function handleUrlRender(event) {
      event?.preventDefault?.();
      if (renderUrlBtn?.disabled) return;
      setNoticeFn(urlStatus);
      setNoticeFn(urlRenderResult);

      const urlInput = document.getElementById('urlInput');
      const rawUrl = (urlInput?.value || '').trim();
      let parsedUrl;
      try {
        if (!/^https?:\/\//i.test(rawUrl)) throw new Error('missing protocol');
        parsedUrl = new URL(rawUrl);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('invalid protocol');
      } catch (_) {
        setNoticeFn(urlStatus, 'Enter a valid public URL starting with http:// or https://.', 'error');
        urlInput?.focus?.();
        return;
      }

      const format = document.getElementById('urlFormatSelect')?.value || 'A4';
      const marginInput = document.getElementById('urlMarginInput');
      const margin = (marginInput?.value || '').trim() || '18mm';
      const marginMatch = margin.match(/^([0-9]+(?:\.[0-9]+)?)(mm|in)$/);
      if (!marginMatch || Number(marginMatch[1]) > (marginMatch[2] === 'in' ? 2 : 50)) {
        setNoticeFn(urlStatus, 'Margin must be a value from 0mm to 50mm or 0in to 2in.', 'error');
        marginInput?.focus?.();
        return;
      }

      if (isLocal()) {
        setNoticeFn(urlRenderResult, 'PDF rendering requires a signed-in dashboard session.', 'error');
        return;
      }

      setPendingFn(renderUrlBtn, true, 'Rendering PDF...');
      setNoticeFn(urlRenderResult, 'Loading webpage and rendering PDF...', 'pending');
      try {
        const renderDoc = fn('renderDocumentRequest', renderInlineDocument);
        const result = await renderDoc({
          version: '1',
          source: { type: 'url', url: rawUrl },
          options: { format, margin },
        });
        renderPdfDownloadResult(urlRenderResult, result);
      } catch (error) {
        setNoticeFn(urlRenderResult, `Could not render URL. ${error.message}`, 'error');
      } finally {
        setPendingFn(renderUrlBtn, false);
      }
    }

    urlForm?.addEventListener('submit', handleUrlRender);
    renderUrlBtn?.addEventListener('click', handleUrlRender);

    // 4. Inline HTML/CSS & Markdown mode (#documentWorkspace)
    const documentJsonStatus = document.getElementById('documentJsonStatus');
    const documentJsonResult = document.getElementById('documentJsonResult');
    const previewDocumentJsonBtn = document.getElementById('previewDocumentJsonBtn');
    const renderDocumentJsonBtn = document.getElementById('renderDocumentJsonBtn');
    const saveDocumentSourceBtn = document.getElementById('saveDocumentSourceBtn');
    const resetDocumentJsonBtn = document.getElementById('resetDocumentJsonBtn');

    ['documentJsonInput', 'documentMarkdownInput', 'documentMarkdownSettingsInput'].forEach((id) => {
      document.getElementById(id)?.addEventListener('input', () => {
        const parseDoc = fn('parseDocumentEditor', parseDocumentEditor);
        try {
          parseDoc();
          setNoticeFn(documentJsonStatus);
        } catch (error) {
          setNoticeFn(documentJsonStatus, error.message, 'error');
        }
        setNoticeFn(documentJsonResult);
      });
    });

    previewDocumentJsonBtn?.addEventListener('click', () => {
      const previewDoc = fn('previewDocumentJson');
      const reveal = fn('revealWorkflowPreview');
      try {
        if (previewDoc) previewDoc();
        if (reveal) reveal('documentPreviewDetails');
        setNoticeFn(
          documentJsonStatus,
          'Preview updated. Values are HTML-escaped and network access is disabled.',
          'success'
        );
      } catch (error) {
        setNoticeFn(documentJsonStatus, error.message, 'error');
      }
    });

    renderDocumentJsonBtn?.addEventListener('click', async () => {
      if (renderDocumentJsonBtn.disabled) return;
      setNoticeFn(documentJsonStatus);
      setNoticeFn(documentJsonResult);
      const previewDoc = fn('previewDocumentJson');
      const parseDoc = fn('parseDocumentEditor', parseDocumentEditor);
      let request;
      try {
        request = previewDoc ? previewDoc() : parseDoc().request;
      } catch (error) {
        setNoticeFn(documentJsonStatus, error.message, 'error');
        return;
      }
      if (isLocal()) {
        setNoticeFn(documentJsonResult, 'PDF rendering requires a signed-in dashboard session.', 'error');
        return;
      }
      setPendingFn(renderDocumentJsonBtn, true, 'Rendering PDF...');
      setNoticeFn(documentJsonResult, 'Validating the document and rendering its PDF...', 'pending');
      try {
        const renderDoc = fn('renderDocumentRequest', renderInlineDocument);
        const result = await renderDoc(request);
        renderPdfDownloadResult(documentJsonResult, result);
      } catch (error) {
        setNoticeFn(documentJsonResult, `Could not render document. ${error.message}`, 'error');
      } finally {
        setPendingFn(renderDocumentJsonBtn, false);
      }
    });

    saveDocumentSourceBtn?.addEventListener('click', async () => {
      if (saveDocumentSourceBtn.disabled) return;
      setNoticeFn(documentJsonStatus);
      const previewDoc = fn('previewDocumentJson');
      const parseDoc = fn('parseDocumentEditor', parseDocumentEditor);
      let definition;
      try {
        definition = previewDoc ? previewDoc() : parseDoc().request;
        if (definition?.html) {
          definition = { ...definition, source: { type: 'html', content: definition.html } };
          delete definition.html;
        }
      } catch (error) {
        setNoticeFn(documentJsonStatus, error.message, 'error');
        return;
      }
      const promptText = fn('promptDashboardText');
      const name = promptText
        ? await promptText({
            title: 'Name this source',
            description: 'Choose a name you will recognize when selecting it for a batch.',
            label: 'Source name',
            confirmLabel: 'Save source',
          })
        : null;
      if (!name) {
        closeSecondaryActions(saveDocumentSourceBtn);
        return;
      }
      setPendingFn(saveDocumentSourceBtn, true, 'Saving source…');
      try {
        const req = fn('dashboardTemplateRequest');
        const saved = await req('/dashboard/sources', {
          method: 'POST',
          body: JSON.stringify({ name, definition }),
        });
        const reloadSources = fn('loadSavedSources');
        if (reloadSources) await reloadSources(saved?.id);
        setNoticeFn(
          documentJsonStatus,
          'Source saved. It is ready to use from Saved sources or batch rendering.',
          'success'
        );
      } catch (error) {
        setNoticeFn(documentJsonStatus, `Could not save source. ${error.message}`, 'error');
      } finally {
        setPendingFn(saveDocumentSourceBtn, false);
        closeSecondaryActions(saveDocumentSourceBtn);
      }
    });

    resetDocumentJsonBtn?.addEventListener('click', () => {
      const type = document.getElementById('documentSourceTypeInput')?.value || 'html';
      const loadSample = fn('loadDocumentEditorSample');
      const previewDoc = fn('previewDocumentJson');
      if (loadSample) loadSample(type);
      if (previewDoc) previewDoc();
      setNoticeFn(
        documentJsonStatus,
        `${type === 'markdown' ? 'Markdown' : 'HTML/CSS JSON'} sample restored.`,
        'success'
      );
      setNoticeFn(documentJsonResult);
      closeSecondaryActions(resetDocumentJsonBtn);
    });

    return { handleUrlRender };
  }

  const moduleExports = {
    markdownDocumentDefaultCSS,
    sampleDocumentRequest,
    sampleMarkdownDocumentRequest,
    documentPlaceholderPattern,
    documentTopLevelFields,
    isPlainObject,
    documentByteLength,
    flattenDocumentData,
    renderInlineDocument,
    renderDocumentRequest: renderInlineDocument,
    renderPdfDownloadResult,
    initCreateRenderHandlers,
    parseDocumentEditor,
    documentRequestFromEditor,
    parseDocumentSettingsEditor,
    validateDocumentCSSForPreview,
    validateDocumentMarkupForPreview,
    escapeMarkdownBindingValue,
    getEditorValue,
    setEditorValue,
    get renderMarkdownPreviewFragment() { return global.renderMarkdownPreviewFragment; },
    get syncDocumentPreviewStageHeight() { return global.syncDocumentPreviewStageHeight; },
    get buildDocumentJsonPreview() { return global.buildDocumentJsonPreview; },
    get previewDocumentJson() { return global.previewDocumentJson; },
    get loadDocumentEditorSample() { return global.loadDocumentEditorSample; },
    get setDocumentEditorMode() { return global.setDocumentEditorMode; },
    get setCreateRenderMode() { return global.setCreateRenderMode; },
  };

  // Expose on global window object for browser scripts
  Object.assign(global, moduleExports);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = moduleExports;
  }
})(typeof window === 'undefined' ? globalThis : window);
