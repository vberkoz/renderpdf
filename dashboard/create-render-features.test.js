const { test } = require('node:test');
const assert = require('node:assert');

// Mock browser globals needed by create-render.js and batches.js
global.DOMParser = class {
  parseFromString(str) {
    return {
      querySelector: () => null,
      querySelectorAll: () => [],
      body: { innerHTML: str },
    };
  }
};

global.document = {
  getElementById: (id) => {
    if (id === 'documentSourceTypeInput') return { value: 'html' };
    if (id === 'documentJsonInput') return { value: '' };
    if (id === 'batchSourceSelect') return { value: 'src_123' };
    if (id === 'batchItemsInput') return { value: '[{"data":{"x":1}}]' };
    if (id === 'batchMergeOutput') return { checked: true };
    return null;
  },
  querySelectorAll: () => [],
};

const createRender = require('./features/create-render.js');
const batches = require('./features/batches.js');

test('parseDocumentEditor accepts source with type url and options', () => {
  const urlPayload = {
    version: '1',
    source: {
      type: 'url',
      url: 'https://example.com/page',
    },
    options: {
      format: 'A4',
      margin: '18mm',
      watermark: { text: 'CONFIDENTIAL' },
      pageNumbers: { format: 'Page {page} of {total}' },
    },
  };
  global.document.getElementById = (id) => {
    if (id === 'documentSourceTypeInput') return { value: 'html' };
    if (id === 'documentJsonInput') return { value: JSON.stringify(urlPayload) };
    return null;
  };

  const parsed = createRender.parseDocumentEditor();
  assert.strictEqual(parsed.request.source.type, 'url');
  assert.strictEqual(parsed.request.source.url, 'https://example.com/page');
  assert.deepStrictEqual(parsed.request.options.watermark, { text: 'CONFIDENTIAL' });
  assert.deepStrictEqual(parsed.request.options.pageNumbers, { format: 'Page {page} of {total}' });
});

test('parseDocumentEditor validates custom headers and cookies on url source and rejects forbidden headers', () => {
  const authedUrlPayload = {
    version: '1',
    source: {
      type: 'url',
      url: 'https://example.com/protected-report',
      headers: {
        Authorization: 'Bearer secret-token',
        'X-Report-Tenant': 'acme',
      },
      cookies: [
        { name: 'session_id', value: 's_12345', domain: 'example.com', path: '/', secure: true },
      ],
    },
    options: { format: 'A4', margin: '15mm' },
  };
  global.document.getElementById = (id) => {
    if (id === 'documentSourceTypeInput') return { value: 'html' };
    if (id === 'documentJsonInput') return { value: JSON.stringify(authedUrlPayload) };
    return null;
  };
  const parsed = createRender.parseDocumentEditor();
  assert.strictEqual(parsed.request.source.headers.Authorization, 'Bearer secret-token');
  assert.strictEqual(parsed.request.source.cookies.length, 1);

  const forbiddenHeaderPayload = {
    version: '1',
    source: {
      type: 'url',
      url: 'https://example.com/protected-report',
      headers: { Host: 'internal.local' },
    },
  };
  global.document.getElementById = (id) => {
    if (id === 'documentSourceTypeInput') return { value: 'html' };
    if (id === 'documentJsonInput') return { value: JSON.stringify(forbiddenHeaderPayload) };
    return null;
  };
  assert.throws(
    () => createRender.parseDocumentEditor(),
    /Header "Host" is not permitted on URL renders/
  );

  const nonUrlWithHeaders = {
    version: '1',
    source: {
      type: 'markdown',
      content: '# Hello',
      headers: { Authorization: 'Bearer x' },
    },
    data: {},
  };
  global.document.getElementById = (id) => {
    if (id === 'documentSourceTypeInput') return { value: 'html' };
    if (id === 'documentJsonInput') return { value: JSON.stringify(nonUrlWithHeaders) };
    return null;
  };
  assert.throws(
    () => createRender.parseDocumentEditor(),
    /source\.headers and source\.cookies are only supported when source\.type is "url"/
  );
});

test('parseDocumentEditor accepts source with type upload', () => {
  const uploadPayload = {
    version: '1',
    source: {
      type: 'upload',
      uploadId: 'file_zip_123',
    },
    options: {
      format: 'Letter',
      margin: '1in',
    },
  };
  global.document.getElementById = (id) => {
    if (id === 'documentSourceTypeInput') return { value: 'html' };
    if (id === 'documentJsonInput') return { value: JSON.stringify(uploadPayload) };
    return null;
  };

  const parsed = createRender.parseDocumentEditor();
  assert.strictEqual(parsed.request.source.type, 'upload');
  assert.strictEqual(parsed.request.source.uploadId, 'file_zip_123');
});

test('parseDocumentEditor allows compliance and waitFor options and rejects signing and redaction', () => {
  const advancedPayload = {
    version: '1',
    html: '<p>Invoice {{customer.name}}</p>',
    data: { customer: { name: 'Ada' } },
    options: {
      format: 'A4',
      margin: '10mm',
      compliance: 'pdfa-3b',
      waitFor: { selector: '#done' },
    },
  };
  global.document.getElementById = (id) => {
    if (id === 'documentSourceTypeInput') return { value: 'html' };
    if (id === 'documentJsonInput') return { value: JSON.stringify(advancedPayload) };
    return null;
  };

  const parsed = createRender.parseDocumentEditor();
  assert.strictEqual(parsed.request.options.compliance, 'pdfa-3b');
  assert.deepStrictEqual(parsed.request.options.waitFor, { selector: '#done' });

  for (const retiredOption of ['signing', 'redaction']) {
    const retiredPayload = {
      version: '1',
      html: '<p>Invoice {{customer.name}}</p>',
      data: { customer: { name: 'Ada' } },
      options: {
        format: 'A4',
        margin: '10mm',
        [retiredOption]: { enabled: true },
      },
    };
    global.document.getElementById = (id) => {
      if (id === 'documentSourceTypeInput') return { value: 'html' };
      if (id === 'documentJsonInput') return { value: JSON.stringify(retiredPayload) };
      return null;
    };
    assert.throws(
      () => createRender.parseDocumentEditor(),
      new RegExp(`Unknown options field "${retiredOption}"`)
    );
  }
});

test('batchSubmission extracts mergeOutput state', () => {
  global.document.getElementById = (id) => {
    if (id === 'batchSourceSelect') return { value: 'source_456' };
    if (id === 'batchItemsInput') return { value: '[{"data":{"name":"Ada"}}]' };
    if (id === 'batchMergeOutput') return { checked: true };
    return null;
  };
  const sub = batches.batchSubmission();
  assert.strictEqual(sub.sourceID, 'source_456');
  assert.strictEqual(sub.mergeOutput, true);
  assert.strictEqual(sub.items.length, 1);
});

test('documentRequestFromEditor handles empty JSON input gracefully', () => {
  global.document.getElementById = (id) => {
    if (id === 'documentSourceTypeInput') return { value: 'html' };
    if (id === 'documentJsonInput') return { value: '   ' };
    return null;
  };
  assert.throws(() => {
    createRender.documentRequestFromEditor();
  }, /Document request JSON is empty/);
});

test('loadDocumentEditorSample populates documentJsonInput and preview succeeds', () => {
  const store = {};
  global.document.getElementById = (id) => {
    if (!store[id]) store[id] = { value: '' };
    return store[id];
  };
  global.setTemplateEditorValue = (id, val) => {
    if (!store[id]) store[id] = { value: '' };
    store[id].value = val;
  };

  const preview = require('./features/create-render-preview.js');
  preview.loadDocumentEditorSample('html');
  assert.ok(store['documentJsonInput'].value.includes('"version": "1"'));

  store['documentSourceTypeInput'] = { value: 'html' };
  const req = preview.previewDocumentJson();
  assert.ok(req);
  assert.strictEqual(req.version, '1');
});

test('parseDocumentEditor supports zeroRetention, responseFormat, strictVariables, and control blocks', () => {
  const payload = {
    version: '1',
    html: '<h1>{{title}}</h1>{{#if showItems}}<ul>{{#each items}}<li>{{name}}</li>{{/each}}</ul>{{/if}}',
    data: {
      title: 'Invoice',
      showItems: true,
      items: [{ name: 'Line 1', extraSku: 'A1' }],
      unusedField: 'allowedWithControlBlocks',
    },
    options: {
      format: 'A4',
      margin: '15mm',
      zeroRetention: true,
      responseFormat: 'binary',
      strictVariables: false,
    },
  };
  global.document.getElementById = (id) => {
    if (id === 'documentSourceTypeInput') return { value: 'html' };
    if (id === 'documentJsonInput') return { value: JSON.stringify(payload) };
    return null;
  };

  const parsed = createRender.parseDocumentEditor();
  assert.strictEqual(parsed.request.options.zeroRetention, true);
  assert.strictEqual(parsed.request.options.responseFormat, 'binary');
  assert.strictEqual(parsed.request.options.strictVariables, false);

  const badFormatPayload = {
    ...payload,
    options: { format: 'A4', margin: '15mm', responseFormat: 'xml' },
  };
  global.document.getElementById = (id) => {
    if (id === 'documentSourceTypeInput') return { value: 'html' };
    if (id === 'documentJsonInput') return { value: JSON.stringify(badFormatPayload) };
    return null;
  };
  assert.throws(
    () => createRender.parseDocumentEditor(),
    /options\.responseFormat must be one of json, binary, or pdf/
  );
});

function createMockDom() {
  const elements = {};
  const createEl = (tag = 'div', id = '') => {
    const listeners = {};
    const children = [];
    const el = {
      tagName: tag.toUpperCase(),
      id,
      value: '',
      textContent: '',
      href: '',
      target: '',
      rel: '',
      download: '',
      hidden: false,
      disabled: false,
      open: false,
      focused: false,
      dataset: {},
      attributes: {},
      classList: {
        add() {},
        remove() {},
        toggle() {},
      },
      setAttribute(k, v) {
        this.attributes[k] = String(v);
      },
      removeAttribute(k) {
        delete this.attributes[k];
      },
      addEventListener(type, fn) {
        if (!listeners[type]) listeners[type] = [];
        listeners[type].push(fn);
      },
      async trigger(type, event = {}) {
        const evt = {
          preventDefault() {
            evt.defaultPrevented = true;
          },
          ...event,
        };
        for (const fn of listeners[type] || []) {
          await fn(evt);
        }
        return evt;
      },
      append(...nodes) {
        children.push(...nodes);
      },
      replaceChildren(...nodes) {
        children.length = 0;
        children.push(...nodes);
      },
      get children() {
        return children;
      },
      focus() {
        this.focused = true;
      },
      closest() {
        return this.parentDetails || null;
      },
    };
    return el;
  };

  const ids = [
    'templatesStatus', 'templateForm', 'templateRenderResult', 'saveTemplateBtn',
    'previewTemplateBtn', 'renderTemplateBtn', 'deleteTemplateBtn', 'templateId',
    'templateHtmlInput', 'templateVariablesInput', 'continueSavedSourceBtn',
    'storedSourcePickerInput', 'storedSourceStatus', 'batchSourceSelect', 'batchItemsInput',
    'urlForm', 'renderUrlBtn', 'urlStatus', 'urlRenderResult', 'urlInput',
    'urlFormatSelect', 'urlMarginInput', 'documentJsonStatus', 'documentJsonResult',
    'previewDocumentJsonBtn', 'renderDocumentJsonBtn', 'saveDocumentSourceBtn',
    'resetDocumentJsonBtn', 'documentJsonInput', 'documentMarkdownInput',
    'documentMarkdownSettingsInput', 'documentSourceTypeInput', 'optionWatermarkText',
    'optionPassword', 'optionPageNumberFormat',
  ];
  for (const id of ids) {
    elements[id] = createEl('div', id);
  }
  elements.urlFormatSelect.value = 'A4';
  elements.urlMarginInput.value = '18mm';
  elements.documentSourceTypeInput.value = 'html';

  const secondaryDetails = { open: true };
  elements.saveDocumentSourceBtn.parentDetails = secondaryDetails;
  elements.resetDocumentJsonBtn.parentDetails = secondaryDetails;
  const batchComposer = { open: false };

  return { elements, createEl, secondaryDetails, batchComposer };
}

test('initCreateRenderHandlers wires template preview, save, delete, and render', async () => {
  const { elements, createEl, batchComposer } = createMockDom();
  const prevDoc = global.document;
  global.document = {
    getElementById: (id) => elements[id] || null,
    querySelector: (sel) => (sel === '.batch-composer' ? batchComposer : null),
    querySelectorAll: () => [],
    createElement: (tag) => createEl(tag),
  };

  try {
    let created = null;
    let updated = null;
    let deletedId = null;
    let renderedArgs = null;
    let previewedWithVars = 0;

    createRender.initCreateRenderHandlers({
      templateVariablesFromEditor: () => ({ customer: { name: 'Ada' } }),
      previewTemplateWithVariables: () => { previewedWithVars += 1; },
      previewTemplateHTML: () => {},
      revealWorkflowPreview: () => {},
      templatePayloadFromForm: () => ({ name: 'Invoice', type: 'custom', html: '<p>{{customer.name}}</p>', variables: {} }),
      createTemplate: async (tpl) => { created = tpl; return { id: 'tpl_1', ...tpl }; },
      updateTemplate: async (id, tpl) => { updated = { id, tpl }; return { id, ...tpl }; },
      removeTemplate: async (id) => { deletedId = id; },
      populateTemplateEditor: (tpl) => { elements.templateId.value = tpl.id; },
      resetTemplateEditor: () => { elements.templateId.value = ''; },
      loadTemplates: async () => {},
      confirmDashboardAction: async () => true,
      renderStoredTemplate: async (id, vars) => {
        renderedArgs = { id, vars };
        return { url: 'https://cdn.example/tpl.pdf', size: 2048 };
      },
      isLocalPreview: false,
    });

    await elements.previewTemplateBtn.trigger('click');
    assert.strictEqual(previewedWithVars, 1);
    assert.strictEqual(elements.templatesStatus.dataset.state, 'success');

    // Unsaved render blocked
    await elements.renderTemplateBtn.trigger('click');
    assert.strictEqual(elements.templateRenderResult.dataset.state, 'error');

    // Create + update via form submit
    await elements.templateForm.trigger('submit');
    assert.strictEqual(created.name, 'Invoice');
    assert.strictEqual(elements.templateId.value, 'tpl_1');

    await elements.templateForm.trigger('submit');
    assert.strictEqual(updated.id, 'tpl_1');

    // Render saved template
    await elements.renderTemplateBtn.trigger('click');
    assert.deepStrictEqual(renderedArgs, { id: 'tpl_1', vars: { customer: { name: 'Ada' } } });
    assert.strictEqual(elements.templateRenderResult.dataset.state, 'success');
    assert.strictEqual(elements.templateRenderResult.children[0].href, 'https://cdn.example/tpl.pdf');

    // Delete template
    await elements.deleteTemplateBtn.trigger('click');
    assert.strictEqual(deletedId, 'tpl_1');
    assert.strictEqual(elements.templateId.value, '');
  } finally {
    global.document = prevDoc;
  }
});

test('initCreateRenderHandlers wires saved source continue-to-batch and public URL render', async () => {
  const { elements, createEl, batchComposer } = createMockDom();
  const prevDoc = global.document;
  global.document = {
    getElementById: (id) => elements[id] || null,
    querySelector: (sel) => (sel === '.batch-composer' ? batchComposer : null),
    querySelectorAll: () => [],
    createElement: (tag) => createEl(tag),
  };

  try {
    let switchedView = null;
    let batchReviewed = false;
    let urlPayload = null;

    elements.storedSourcePickerInput.value = 'src_abc';
    createRender.initCreateRenderHandlers({
      getSavedSources: () => new Map([['src_abc', { id: 'src_abc', name: 'Monthly Invoice' }]]),
      updateBatchReview: () => { batchReviewed = true; },
      setDashboardView: (view) => { switchedView = view; },
      renderDocumentRequest: async (req) => {
        urlPayload = req;
        return { url: 'https://cdn.example/url.pdf', size: 4096, requestId: 'req_9' };
      },
      isLocalPreview: false,
    });

    await elements.continueSavedSourceBtn.trigger('click');
    assert.strictEqual(elements.batchSourceSelect.value, 'src_abc');
    assert.strictEqual(batchReviewed, true);
    assert.strictEqual(switchedView, 'batches');
    assert.strictEqual(batchComposer.open, true);
    assert.strictEqual(elements.batchItemsInput.focused, true);

    // Invalid URL rejected
    elements.urlInput.value = 'ftp://invalid.local';
    await elements.urlForm.trigger('submit');
    assert.strictEqual(elements.urlStatus.dataset.state, 'error');
    assert.strictEqual(urlPayload, null);

    // Valid URL renders via form submit
    elements.urlInput.value = 'https://example.com/report';
    elements.urlFormatSelect.value = 'Letter';
    elements.urlMarginInput.value = '12mm';
    await elements.urlForm.trigger('submit');
    assert.deepStrictEqual(urlPayload, {
      version: '1',
      source: { type: 'url', url: 'https://example.com/report' },
      options: { format: 'Letter', margin: '12mm' },
    });
    assert.strictEqual(elements.urlRenderResult.dataset.state, 'success');
    assert.strictEqual(elements.urlRenderResult.children[1].href, 'https://cdn.example/url.pdf');
  } finally {
    global.document = prevDoc;
  }
});

test('initCreateRenderHandlers wires document preview, render with options, save source, and reset', async () => {
  const { elements, createEl, secondaryDetails, batchComposer } = createMockDom();
  const prevDoc = global.document;
  global.document = {
    getElementById: (id) => elements[id] || null,
    querySelector: (sel) => (sel === '.batch-composer' ? batchComposer : null),
    querySelectorAll: () => [],
    createElement: (tag) => createEl(tag),
  };

  try {
    elements.documentJsonInput.value = JSON.stringify({
      version: '1',
      html: '<p>Hello {{name}}</p>',
      data: { name: 'World' },
      options: { format: 'A4', margin: '18mm' },
    });
    elements.optionWatermarkText.value = 'DRAFT';
    elements.optionPassword.value = 'secret';
    elements.optionPageNumberFormat.value = 'Page {page}';

    let renderedDoc = null;
    let savedSourceBody = null;
    let loadedSampleType = null;

    createRender.initCreateRenderHandlers({
      previewDocumentJson: () => createRender.parseDocumentEditor().request,
      revealWorkflowPreview: () => {},
      renderDocumentRequest: async (req) => {
        renderedDoc = req;
        return { url: 'https://cdn.example/doc.pdf', size: 1024, requestId: 'req_doc' };
      },
      promptDashboardText: async () => 'My Saved Source',
      dashboardTemplateRequest: async (path, opts) => {
        savedSourceBody = { path, body: JSON.parse(opts.body) };
        return { id: 'src_new' };
      },
      loadSavedSources: async () => {},
      loadDocumentEditorSample: (type) => { loadedSampleType = type; },
      isLocalPreview: false,
    });

    await elements.previewDocumentJsonBtn.trigger('click');
    assert.strictEqual(elements.documentJsonStatus.dataset.state, 'success');

    await elements.renderDocumentJsonBtn.trigger('click');
    assert.deepStrictEqual(renderedDoc.options.watermark, { text: 'DRAFT' });
    assert.strictEqual(renderedDoc.options.password, 'secret');
    assert.deepStrictEqual(renderedDoc.options.pageNumbers, { format: 'Page {page}' });
    assert.strictEqual(elements.documentJsonResult.dataset.state, 'success');

    await elements.saveDocumentSourceBtn.trigger('click');
    assert.strictEqual(savedSourceBody.path, '/dashboard/sources');
    assert.strictEqual(savedSourceBody.body.name, 'My Saved Source');
    assert.strictEqual(savedSourceBody.body.definition.source.type, 'html');
    assert.strictEqual(secondaryDetails.open, false);

    secondaryDetails.open = true;
    await elements.resetDocumentJsonBtn.trigger('click');
    assert.strictEqual(loadedSampleType, 'html');
    assert.strictEqual(secondaryDetails.open, false);
  } finally {
    global.document = prevDoc;
  }
});

test('documentRequestFromEditor populates compliance and zeroRetention from form inputs without overwriting JSON', () => {
  const prevDoc = global.document;
  try {
    let jsonValue = JSON.stringify({
      version: '1',
      source: { type: 'html', content: '<h1>Compliance</h1>' },
    });
    const elements = {
      documentSourceTypeInput: { value: 'html' },
      documentJsonInput: { get value() { return jsonValue; } },
      optionComplianceProfile: { value: 'pdfua-1' },
      optionZeroRetention: { checked: true },
    };
    global.document = { getElementById: (id) => elements[id] || null };

    const populated = createRender.documentRequestFromEditor();
    assert.deepStrictEqual(populated.options.compliance, { profile: 'pdfua-1' });
    assert.strictEqual(populated.options.zeroRetention, true);

    jsonValue = JSON.stringify({
      version: '1',
      source: { type: 'html', content: '<h1>Override</h1>' },
      options: { compliance: { profile: 'pdfa-2b' }, zeroRetention: false },
    });
    const preserved = createRender.documentRequestFromEditor();
    assert.deepStrictEqual(preserved.options.compliance, { profile: 'pdfa-2b' });
    assert.strictEqual(preserved.options.zeroRetention, false);
  } finally {
    global.document = prevDoc;
  }
});
