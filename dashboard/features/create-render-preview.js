(function (global) {
  'use strict';

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

    const escMd =
      typeof global.escapeMarkdownBindingValue === 'function'
        ? global.escapeMarkdownBindingValue
        : typeof escapeMarkdownBindingValue === 'function'
          ? escapeMarkdownBindingValue
          : (val) => escHtml(val).replace(/[\\`*_{}\[\]()<>#+\-.!|~]/g, '\\$&');

    const validateMarkup =
      typeof global.validateDocumentMarkupForPreview === 'function'
        ? global.validateDocumentMarkupForPreview
        : typeof validateDocumentMarkupForPreview === 'function'
          ? validateDocumentMarkupForPreview
          : () => {};

    const placeholderPattern =
      global.documentPlaceholderPattern ||
      (typeof documentPlaceholderPattern !== 'undefined'
        ? documentPlaceholderPattern
        : /{{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*}}/g);

    let resolvedHTML;
    if (request.source && request.source.type === 'url') {
      resolvedHTML = `<div style="font-family:system-ui,-apple-system,sans-serif;padding:32px;color:#1e293b;"><h2>URL Source</h2><p>Page to render: <a href="${escHtml(request.source.url)}" target="_blank" rel="noopener">${escHtml(request.source.url)}</a></p><p style="color:#64748b;">Live rendering runs via Chrome headless when you click Render PDF.</p></div>`;
    } else if (request.source && request.source.type === 'upload') {
      resolvedHTML = `<div style="font-family:system-ui,-apple-system,sans-serif;padding:32px;color:#1e293b;"><h2>Uploaded Package Source</h2><p>Package ID: <code>${escHtml(request.source.uploadId)}</code></p><p style="color:#64748b;">Package assets will be extracted and rendered when you click Render PDF.</p></div>`;
    } else if (usesMarkdown) {
      const resolvedMarkdown = request.source.content.replace(placeholderPattern, (_, path) =>
        escMd(values.get(path))
      );
      resolvedHTML = renderMarkdownPreviewFragment(resolvedMarkdown);
      validateMarkup(resolvedHTML);
    } else {
      resolvedHTML = request.html.replace(placeholderPattern, (_, path) =>
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
    const defaultCSS = global.markdownDocumentDefaultCSS || '';
    const documentCSS = usesMarkdown ? defaultCSS + request.css : request.css;
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}"><style>${documentCSS}\n@page { size: ${request.options.format}; margin: ${request.options.margin}; }</style>${previewHead}</head><body>${parsed.body.innerHTML}</body></html>`;
  }

  function previewDocumentJson() {
    const parseFn =
      global.parseDocumentEditor ||
      (typeof parseDocumentEditor === 'function' ? parseDocumentEditor : null);
    if (!parseFn) return null;
    const parsed = parseFn();
    if (!parsed) return null;
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

  function getCodeEditors() {
    return global.templateCodeEditors || (typeof templateCodeEditors !== 'undefined' ? templateCodeEditors : {});
  }

  function loadDocumentEditorSample(type) {
    const setVal =
      global.setTemplateEditorValue ||
      global.setEditorValue ||
      (typeof setTemplateEditorValue === 'function' ? setTemplateEditorValue : null) ||
      (typeof setEditorValue === 'function' ? setEditorValue : null) ||
      ((id, v) => {
        const el = document.getElementById(id);
        if (el) el.value = String(v ?? '');
      });
    if (type === 'markdown') {
      const sample =
        global.sampleMarkdownDocumentRequest ||
        (typeof sampleMarkdownDocumentRequest !== 'undefined'
          ? sampleMarkdownDocumentRequest
          : null);
      if (sample) {
        setVal('documentMarkdownInput', sample.source.content);
        setVal(
          'documentMarkdownSettingsInput',
          JSON.stringify(
            {
              css: sample.css,
              data: sample.data,
              options: sample.options,
            },
            null,
            2
          )
        );
      }
      return;
    }
    const sample =
      global.sampleDocumentRequest ||
      (typeof sampleDocumentRequest !== 'undefined' ? sampleDocumentRequest : null);
    if (sample) {
      setVal('documentJsonInput', JSON.stringify(sample, null, 2));
    }
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
    const isUrl = mode === 'url';
    const templateWorkspace = document.getElementById('templateWorkspace');
    const documentWorkspace = document.getElementById('documentWorkspace');
    const storedSourceWorkspace = document.getElementById('storedSourceWorkspace');
    const urlWorkspace = document.getElementById('urlWorkspace');

    if (templateWorkspace) templateWorkspace.hidden = !isTemplate;
    if (documentWorkspace) documentWorkspace.hidden = isTemplate || isStored || isUrl;
    if (storedSourceWorkspace) storedSourceWorkspace.hidden = !isStored;
    if (urlWorkspace) urlWorkspace.hidden = !isUrl;
    document.querySelectorAll('[data-source-choice]').forEach((choice) => {
      const selected = choice.dataset.sourceChoice === mode;
      choice.classList.toggle('is-selected', selected);
      choice.setAttribute('aria-pressed', String(selected));
    });
    if (!isTemplate && !isStored && !isUrl) setDocumentEditorMode(isMarkdown ? 'markdown' : 'html', loadSample);

    const editors = getCodeEditors();
    window.requestAnimationFrame(() => {
      Object.values(editors).forEach((editor) => editor.refresh());
      if (!isTemplate && !isStored && !isUrl) syncDocumentPreviewStageHeight();
    });
  }

  const moduleExports = {
    renderMarkdownPreviewFragment,
    syncDocumentPreviewStageHeight,
    buildDocumentJsonPreview,
    previewDocumentJson,
    loadDocumentEditorSample,
    setDocumentEditorMode,
    setCreateRenderMode,
  };

  Object.assign(global, moduleExports);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = moduleExports;
  }
})(typeof window === 'undefined' ? globalThis : window);
