const test = require('node:test');
const assert = require('node:assert/strict');
const { PLAYGROUND_TEMPLATES } = require('./playground-templates.js');

test('playground templates include all required presets', () => {
  const expectedTemplates = [
    'agreement',
    'invoice',
    'receipt',
    'boarding-pass',
    'certificate',
  ];

  for (const name of expectedTemplates) {
    assert.ok(PLAYGROUND_TEMPLATES[name], `Template ${name} should exist`);
    assert.ok(
      PLAYGROUND_TEMPLATES[name].length > 100,
      `Template ${name} should have non-trivial content`
    );
    assert.match(
      PLAYGROUND_TEMPLATES[name],
      /<!doctype html>/i,
      `Template ${name} should declare an HTML doctype`
    );
  }
});
