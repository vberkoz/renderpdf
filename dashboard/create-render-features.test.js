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
