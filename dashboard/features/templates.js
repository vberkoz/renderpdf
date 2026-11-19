(function (global) {
  'use strict';

  function callApiRequest(path, options) {
    if (typeof global.apiRequest === 'function') {
      return global.apiRequest(path, options);
    }
    if (typeof apiRequest === 'function') {
      return apiRequest(path, options);
    }
    throw new Error('apiRequest is not defined');
  }

  function getAuthHeaders() {
    if (typeof global.authHeaders === 'function') {
      return global.authHeaders();
    }
    if (typeof authHeaders === 'function') {
      return authHeaders();
    }
    return {};
  }

  function dashboardTemplateRequest(path, options = {}) {
    return callApiRequest(path, {
      ...options,
      headers: { ...getAuthHeaders(), ...(options.headers || {}) },
    });
  }

  function listTemplates() {
    return dashboardTemplateRequest('/dashboard/templates');
  }

  function createTemplate(template) {
    return dashboardTemplateRequest('/dashboard/templates', {
      method: 'POST',
      body: JSON.stringify(template),
    });
  }

  function getStoredTemplate(templateId) {
    return dashboardTemplateRequest(`/dashboard/templates/${encodeURIComponent(templateId)}`);
  }

  function updateTemplate(templateId, template) {
    return dashboardTemplateRequest(`/dashboard/templates/${encodeURIComponent(templateId)}`, {
      method: 'PUT',
      body: JSON.stringify(template),
    });
  }

  function removeTemplate(templateId) {
    return dashboardTemplateRequest(`/dashboard/templates/${encodeURIComponent(templateId)}`, {
      method: 'DELETE',
    });
  }

  function renderStoredTemplate(templateId, variables) {
    return dashboardTemplateRequest('/dashboard/render-template', {
      method: 'POST',
      body: JSON.stringify({ templateId, variables }),
    });
  }

  const templateCodeEditors = {};

  function initializeTemplateCodeEditor(id, mode) {
    const textarea = document.getElementById(id);
    if (!textarea || !(typeof window !== 'undefined' && window.CodeMirror)) return null;

    const editor = window.CodeMirror.fromTextArea(textarea, {
      mode,
      lineNumbers: true,
      lineWrapping: true,
      indentUnit: 2,
      tabSize: 2,
    });
    editor.on('change', () => {
      editor.save();
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    templateCodeEditors[id] = editor;
    return editor;
  }

  function templateEditorValue(id) {
    return templateCodeEditors[id]?.getValue() ?? (document.getElementById(id)?.value || '');
  }

  function setTemplateEditorValue(id, value) {
    const textarea = document.getElementById(id);
    const nextValue = String(value ?? '');
    if (templateCodeEditors[id]) {
      templateCodeEditors[id].setValue(nextValue);
    } else if (textarea) {
      textarea.value = nextValue;
    }
  }

  function templatePayloadFromForm() {
    return {
      name: document.getElementById('templateNameInput').value.trim(),
      type: document.getElementById('templateTypeInput').value,
      html: templateEditorValue('templateHtmlInput').trim(),
      variables: templateVariablesFromEditor(),
    };
  }

  function templateVariablesFromEditor() {
    const variables = JSON.parse(templateEditorValue('templateVariablesInput'));
    if (!variables || Array.isArray(variables) || typeof variables !== 'object')
      throw new Error('Variables must be an object');
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

  function reportPagedPreviewSize() {
    const pages = document.querySelector('.pagedjs_pages');
    const height = pages
      ? Math.ceil(pages.getBoundingClientRect().height)
      : Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
    window.parent.postMessage({ type: 'renderpdf-paged-preview-size', height: Math.max(1, height) }, '*');
  }

  window.PagedConfig = { auto: false };
  window.addEventListener('load', () => {
    applyTemplatePrintRules();
    reducePagedPreviewMargins();
    if (!window.PagedPolyfill) {
      reportPagedPreviewSize();
      return;
    }
    const render = window.PagedPolyfill.preview();
    if (render && typeof render.then === 'function') render.then(
      () => { fitPagedPreviewPages(); reportPagedPreviewSize(); },
      () => { reportPagedPreviewSize(); }
    );
    else requestAnimationFrame(() => { fitPagedPreviewPages(); reportPagedPreviewSize(); });
    window.setTimeout(reportPagedPreviewSize, 250);
    if (window.ResizeObserver) new ResizeObserver(reportPagedPreviewSize).observe(document.body);
  });
  window.addEventListener('resize', fitPagedPreviewPages);
</script>
<script src="https://unpkg.com/pagedjs@0.4.3/dist/paged.polyfill.js"></script>`;

  const pendingPagedPreviews = new Map();

  function setPagedPreview(previewId, srcdoc) {
    const preview = document.getElementById(previewId);
    if (!preview) return;
    const pending = pendingPagedPreviews.get(previewId);
    if (pending) window.clearTimeout(pending);
    preview.style.height = '1px';
    if (preview.parentElement) preview.parentElement.scrollTop = 0;
    const timer = window.setTimeout(() => {
      pendingPagedPreviews.delete(previewId);
      preview.srcdoc = srcdoc;
    }, 160);
    pendingPagedPreviews.set(previewId, timer);
  }

  function revealWorkflowPreview(detailsId) {
    const details = document.getElementById(detailsId);
    if (!details) return;
    details.open = true;
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches) {
      details.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function previewTemplateHTML(html) {
    const fallback =
      '<main style="font-family:\'IBM Plex Sans\',Arial,sans-serif;padding:24px;color:#586473">Your template preview appears here.</main>';
    if (typeof DOMParser === 'undefined') return;
    const documentPreview = new DOMParser().parseFromString(html || fallback, 'text/html');
    documentPreview
      .querySelectorAll('script, iframe, object, embed')
      .forEach((element) => element.remove());
    documentPreview.querySelectorAll('*').forEach((element) => {
      element.getAttributeNames().forEach((name) => {
        const value = element.getAttribute(name)?.trim().toLowerCase() || '';
        if (name.toLowerCase().startsWith('on') || value.startsWith('javascript:'))
          element.removeAttribute(name);
      });
    });
    documentPreview.head.insertAdjacentHTML('afterbegin', pagedPreviewHead);
    setPagedPreview('templatePreview', `<!doctype html>${documentPreview.documentElement.outerHTML}`);
  }

  function escapeTemplatePreviewHTML(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function previewTemplateWithVariables() {
    const templateHTML = templateEditorValue('templateHtmlInput');
    let variables;
    try {
      variables = templateVariablesFromEditor();
    } catch (_) {
      previewTemplateHTML(templateHTML);
      return;
    }
    const renderedHTML = templateHTML.replace(
      /{{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*}}/g,
      (placeholder, path) => {
        const value = path.split('.').reduce((current, key) => current && current[key], variables);
        return value === undefined || value === null || typeof value === 'object'
          ? placeholder
          : escapeTemplatePreviewHTML(value);
      }
    );
    previewTemplateHTML(renderedHTML);
  }

  function resetTemplateEditor() {
    document.getElementById('templateForm')?.reset();
    const idEl = document.getElementById('templateId');
    if (idEl) idEl.value = '';
    const delBtn = document.getElementById('deleteTemplateBtn');
    if (delBtn) delBtn.hidden = true;
    const saveBtn = document.getElementById('saveTemplateBtn');
    if (saveBtn) saveBtn.disabled = false;
    ['templateNameInput', 'templateTypeInput', 'templateHtmlInput'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = false;
    });
    const typeEl = document.getElementById('templateTypeInput');
    if (typeEl) typeEl.value = 'custom';
    setTemplateEditorValue('templateHtmlInput', '');
    setTemplateEditorValue('templateVariablesInput', '{}');
    if (typeof window !== 'undefined') {
      window.customSelect?.setValue('templatePickerInput', 'new');
    }
    previewTemplateHTML('');
  }

  function populateTemplateEditor(template, pickerValue) {
    const idEl = document.getElementById('templateId');
    if (idEl) idEl.value = template.id || '';
    const nameEl = document.getElementById('templateNameInput');
    if (nameEl) nameEl.value = template.name || '';
    const typeEl = document.getElementById('templateTypeInput');
    if (typeEl) typeEl.value = template.type || 'custom';
    if (pickerValue && typeof window !== 'undefined') {
      window.customSelect?.setValue('templatePickerInput', pickerValue);
    }
    setTemplateEditorValue('templateHtmlInput', template.html || '');
    setTemplateEditorValue(
      'templateVariablesInput',
      JSON.stringify(template.exampleVariables || template.variables || {}, null, 2)
    );
    const delBtn = document.getElementById('deleteTemplateBtn');
    if (delBtn) delBtn.hidden = !template.id;
    const saveBtn = document.getElementById('saveTemplateBtn');
    if (saveBtn) saveBtn.disabled = false;
    ['templateNameInput', 'templateTypeInput', 'templateHtmlInput'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = false;
    });
    previewTemplateWithVariables();
  }

  const moduleExports = {
    dashboardTemplateRequest,
    listTemplates,
    createTemplate,
    getStoredTemplate,
    updateTemplate,
    removeTemplate,
    renderStoredTemplate,
    templateCodeEditors,
    initializeTemplateCodeEditor,
    templateEditorValue,
    setTemplateEditorValue,
    templatePayloadFromForm,
    templateVariablesFromEditor,
    pagedPreviewHead,
    pendingPagedPreviews,
    setPagedPreview,
    revealWorkflowPreview,
    previewTemplateHTML,
    escapeTemplatePreviewHTML,
    previewTemplateWithVariables,
    resetTemplateEditor,
    populateTemplateEditor,
  };

  Object.assign(global, moduleExports);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = moduleExports;
  }
})(typeof window === 'undefined' ? globalThis : window);
