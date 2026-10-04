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

  function flattenDocumentData(value, prefix = '', depth = 1, output = new Map()) {
    if (depth > 10) throw new Error('data must not exceed 10 nested levels.');
    Object.entries(value).forEach(([key, child]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        throw new Error(`Invalid data variable name "${key}".`);
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

  function renderInlineDocument(documentRequest) {
    if (typeof global.dashboardTemplateRequest === 'function') {
      return global.dashboardTemplateRequest('/dashboard/render-document', {
        method: 'POST',
        body: JSON.stringify(documentRequest),
      });
    }
    if (typeof dashboardTemplateRequest === 'function') {
      return dashboardTemplateRequest('/dashboard/render-document', {
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
    if (document.getElementById('documentSourceTypeInput').value === 'markdown') {
      const content = getEditorValue('documentMarkdownInput');
      const settings = parseDocumentSettingsEditor();
      return { version: '1', source: { type: 'markdown', content }, ...settings };
    }
    const source = getEditorValue('documentJsonInput');
    if (documentByteLength(source) > 1024 * 1024)
      throw new Error('Document request must not exceed 1 MB.');
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
    if (documentByteLength(JSON.stringify(request)) > 1024 * 1024)
      throw new Error('Document request must not exceed 1 MB.');
    if (!isPlainObject(request)) throw new Error('The request must be a JSON object.');
    const unknownField = Object.keys(request).find((field) => !documentTopLevelFields.has(field));
    if (unknownField) throw new Error(`Unknown top-level field "${unknownField}".`);
    if (request.version !== '1') throw new Error('version must be "1".');
    const usesMarkdown = request.source !== undefined;
    if (usesMarkdown && request.html !== undefined)
      throw new Error('source and html cannot be used together.');
    if (usesMarkdown) {
      const unknownSourceField =
        isPlainObject(request.source) &&
        Object.keys(request.source).find((field) => !['type', 'content'].includes(field));
      if (unknownSourceField) throw new Error(`Unknown source field "${unknownSourceField}".`);
      if (
        !isPlainObject(request.source) ||
        request.source.type !== 'markdown' ||
        typeof request.source.content !== 'string' ||
        !request.source.content.trim()
      ) {
        throw new Error('source must contain type "markdown" and non-empty content.');
      }
      if (documentByteLength(request.source.content) > 768 * 1024)
        throw new Error('source.content must not exceed 768 KB.');
    } else if (typeof request.html !== 'string' || !request.html.trim()) {
      throw new Error('html is required and must be a string.');
    }
    if (request.css !== undefined && typeof request.css !== 'string')
      throw new Error('css must be a string.');
    if (!isPlainObject(request.data)) throw new Error('data is required and must be an object.');
    if (request.options !== undefined && !isPlainObject(request.options))
      throw new Error('options must be an object.');
    if (!usesMarkdown && documentByteLength(request.html) > 768 * 1024)
      throw new Error('html must not exceed 768 KB.');
    if (documentByteLength(request.css || '') > 128 * 1024)
      throw new Error('css must not exceed 128 KB.');
    if (documentByteLength(JSON.stringify(request.data)) > 256 * 1024)
      throw new Error('data must not exceed 256 KB.');

    const options = { format: 'A4', margin: '18mm', ...(request.options || {}) };
    const allowedOptions = [
      'format',
      'margin',
      'headerTemplate',
      'footerTemplate',
      'displayHeaderFooter',
      'password',
      'ownerPassword',
      'permissions',
    ];
    const unknownOption = Object.keys(options).find((field) => !allowedOptions.includes(field));
    if (unknownOption) throw new Error(`Unknown options field "${unknownOption}".`);
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

    const css = request.css || '';
    validateDocumentCSSForPreview(css);
    const content = usesMarkdown ? request.source.content : request.html;
    if (/@page\b/i.test(content)) throw new Error('@page settings must be supplied through options.');
    if (!usesMarkdown) validateDocumentMarkupForPreview(content);
    const values = flattenDocumentData(request.data);
    const placeholders = [...content.matchAll(documentPlaceholderPattern)];
    const unmatched = content.replace(documentPlaceholderPattern, '');
    if (unmatched.includes('{{') || unmatched.includes('}}'))
      throw new Error('HTML contains an invalid placeholder; use {{path.to.value}}.');
    const expected = new Set(placeholders.map((match) => match[1]));
    const missing = [...expected].find((path) => !values.has(path));
    if (missing) throw new Error(`Missing required data variable "${missing}".`);
    const unused = [...values.keys()].find((path) => !expected.has(path));
    if (unused)
      throw new Error(`Unknown data variable "${unused}"; every supplied value must be used.`);
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

  function renderMarkdownPreviewFragment(markdown) {
    if (!window.marked?.parse || !window.marked.Renderer)
      throw new Error('Markdown preview is unavailable. Reload the dashboard and try again.');
    const renderer = new window.marked.Renderer();
    renderer.html = () => '';
    return window.marked.parse(markdown, { gfm: true, renderer });
  }

  function syncDocumentPreviewStageHeight() {
    const isMarkdown = document.getElementById('documentSourceTypeInput')?.value === 'markdown';
    const payload = document.getElementById(
      isMarkdown ? 'documentMarkdownFields' : 'documentJsonField'
    );
    const stage = document.querySelector('.document-json-preview-stage');
    if (!payload || !stage) return;
    if (window.matchMedia('(max-width: 760px)').matches) {
      stage.style.removeProperty('height');
      return;
    }

    const height = Math.round(
      payload.getBoundingClientRect().bottom - stage.getBoundingClientRect().top
    );
    if (height > 0) stage.style.height = `${height}px`;
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('message', (event) => {
      const { data } = event;
      if (!data || data.type !== 'renderpdf-paged-preview-size' || !Number.isFinite(data.height))
        return;

      const preview = ['templatePreview', 'documentJsonPreview']
        .map((id) => document.getElementById(id))
        .find((frame) => frame?.contentWindow === event.source);
      if (!preview) return;

      preview.style.height = `${Math.max(1, Math.ceil(data.height))}px`;
      if (preview.id === 'documentJsonPreview') syncDocumentPreviewStageHeight();
    });

    window.addEventListener('resize', () =>
      window.requestAnimationFrame(syncDocumentPreviewStageHeight)
    );
    window.requestAnimationFrame(() => {
      syncDocumentPreviewStageHeight();
      const fields = ['documentJsonField', 'documentMarkdownFields']
        .map((id) => document.getElementById(id))
        .filter(Boolean);
      if (fields.length && window.ResizeObserver) {
        const observer = new ResizeObserver(syncDocumentPreviewStageHeight);
        fields.forEach((field) => observer.observe(field));
      }
    });
  }

  function buildDocumentJsonPreview(request, values, usesMarkdown) {
    let resolvedHTML;
    if (usesMarkdown) {
      const resolvedMarkdown = request.source.content.replace(documentPlaceholderPattern, (_, path) =>
        escapeMarkdownBindingValue(values.get(path))
      );
      resolvedHTML = renderMarkdownPreviewFragment(resolvedMarkdown);
      validateDocumentMarkupForPreview(resolvedHTML);
    } else {
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
      resolvedHTML = request.html.replace(documentPlaceholderPattern, (_, path) =>
        escHtml(values.get(path))
      );
    }
    const parsed = new DOMParser().parseFromString(resolvedHTML, 'text/html');
    parsed.querySelectorAll('script, iframe, object, embed').forEach((element) => element.remove());
    parsed.querySelectorAll('*').forEach((element) => {
      element.getAttributeNames().forEach((name) => {
        const value = element.getAttribute(name)?.trim().toLowerCase() || '';
        if (name.toLowerCase().startsWith('on') || value.startsWith('javascript:'))
          element.removeAttribute(name);
      });
      ['href', 'action', 'formaction', 'xlink:href'].forEach((attribute) =>
        element.removeAttribute(attribute)
      );
    });
    const contentSecurityPolicy =
      "default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https:; font-src data: https:; script-src 'unsafe-inline' https://unpkg.com; connect-src https:; frame-src 'none'; form-action 'none'; base-uri 'none'";
    const previewHead = global.pagedPreviewHead || (typeof pagedPreviewHead !== 'undefined' ? pagedPreviewHead : '');
    const documentCSS = usesMarkdown ? markdownDocumentDefaultCSS + request.css : request.css;
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}"><style>${documentCSS}\n@page { size: ${request.options.format}; margin: ${request.options.margin}; }</style>${previewHead}</head><body>${parsed.body.innerHTML}</body></html>`;
  }

  function previewDocumentJson() {
    const parsed = parseDocumentEditor();
    const setPreview =
      typeof global.setPagedPreview === 'function'
        ? global.setPagedPreview
        : typeof setPagedPreview === 'function'
          ? setPagedPreview
          : null;
    if (setPreview) {
      setPreview(
        'documentJsonPreview',
        buildDocumentJsonPreview(parsed.request, parsed.values, parsed.usesMarkdown)
      );
    }
    return parsed.request;
  }

  function loadDocumentEditorSample(type) {
    if (type === 'markdown') {
      setEditorValue('documentMarkdownInput', sampleMarkdownDocumentRequest.source.content);
      setEditorValue(
        'documentMarkdownSettingsInput',
        JSON.stringify(
          {
            css: sampleMarkdownDocumentRequest.css,
            data: sampleMarkdownDocumentRequest.data,
            options: sampleMarkdownDocumentRequest.options,
          },
          null,
          2
        )
      );
      return;
    }
    setEditorValue('documentJsonInput', JSON.stringify(sampleDocumentRequest, null, 2));
  }

  function setDocumentEditorMode(type, loadSample = false) {
    const isMarkdown = type === 'markdown';
    const sourceInput = document.getElementById('documentSourceTypeInput');
    if (sourceInput) sourceInput.value = isMarkdown ? 'markdown' : 'html';
    const jsonField = document.getElementById('documentJsonField');
    if (jsonField) jsonField.hidden = isMarkdown;
    const mdFields = document.getElementById('documentMarkdownFields');
    if (mdFields) mdFields.hidden = !isMarkdown;
    const editorDesc = document.getElementById('documentEditorDescription');
    if (editorDesc) {
      editorDesc.textContent = isMarkdown
        ? 'Write the Markdown content first, then open the optional data, CSS, and print settings.'
        : 'Provide the complete, versioned HTML/CSS JSON request.';
    }
    if (loadSample) loadDocumentEditorSample(isMarkdown ? 'markdown' : 'html');
    const editors = getCodeEditors();
    ['documentJsonInput', 'documentMarkdownInput', 'documentMarkdownSettingsInput'].forEach((id) => {
      window.setTimeout(() => editors[id]?.refresh(), 0);
    });
    window.requestAnimationFrame(syncDocumentPreviewStageHeight);
  }

  function setCreateRenderMode(mode, loadSample = false) {
    const isTemplate = mode === 'template';
    const isMarkdown = mode === 'markdown';
    const isStored = mode === 'stored';
    const templateWorkspace = document.getElementById('templateWorkspace');
    const documentWorkspace = document.getElementById('documentWorkspace');
    const storedSourceWorkspace = document.getElementById('storedSourceWorkspace');

    if (templateWorkspace) templateWorkspace.hidden = !isTemplate;
    if (documentWorkspace) documentWorkspace.hidden = isTemplate || isStored;
    if (storedSourceWorkspace) storedSourceWorkspace.hidden = !isStored;
    document.querySelectorAll('[data-source-choice]').forEach((choice) => {
      const selected = choice.dataset.sourceChoice === mode;
      choice.classList.toggle('is-selected', selected);
      choice.setAttribute('aria-pressed', String(selected));
    });
    if (!isTemplate && !isStored) setDocumentEditorMode(isMarkdown ? 'markdown' : 'html', loadSample);

    const editors = getCodeEditors();
    window.requestAnimationFrame(() => {
      Object.values(editors).forEach((editor) => editor.refresh());
      if (!isTemplate && !isStored) syncDocumentPreviewStageHeight();
    });
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
    renderMarkdownPreviewFragment,
    syncDocumentPreviewStageHeight,
    buildDocumentJsonPreview,
    previewDocumentJson,
    loadDocumentEditorSample,
    setDocumentEditorMode,
    setCreateRenderMode,
  };

  // Expose on global window object for browser scripts
  Object.assign(global, moduleExports);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = moduleExports;
  }
})(typeof window === 'undefined' ? globalThis : window);
