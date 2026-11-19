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
      if (wm || pw || pnf) {
        request.options = { ...(request.options || {}) };
        if (wm && !request.options.watermark) request.options.watermark = { text: wm };
        if (pw && !request.options.password) request.options.password = pw;
        if (pnf && !request.options.pageNumbers) request.options.pageNumbers = { format: pnf };
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
        if (typeof request.source.url !== 'string' || !/^https?:\/\//i.test(request.source.url)) {
          throw new Error('source.url must be a valid HTTP or HTTPS URL.');
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
