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
      pageNumbers: { format: 'Page {page} of {pages}' },
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
  assert.deepStrictEqual(parsed.request.options.pageNumbers, { format: 'Page {page} of {pages}' });
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

test('parseDocumentEditor allows compliance, signing, redaction, waitFor options', () => {
  const advancedPayload = {
    version: '1',
    html: '<p>Invoice {{customer.name}}</p>',
    data: { customer: { name: 'Ada' } },
    options: {
      format: 'A4',
      margin: '10mm',
      compliance: 'pdfa-3b',
      signing: { kmsKeyId: 'arn:aws:kms:123' },
      redaction: { enabled: true },
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
  assert.deepStrictEqual(parsed.request.options.signing, { kmsKeyId: 'arn:aws:kms:123' });
  assert.deepStrictEqual(parsed.request.options.redaction, { enabled: true });
  assert.deepStrictEqual(parsed.request.options.waitFor, { selector: '#done' });
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
