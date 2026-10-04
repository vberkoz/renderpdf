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
    assert.match(
      PLAYGROUND_TEMPLATES[name],
      /@page\s*\{/i,
      `Template ${name} should declare an @page rule`
    );
  }
});

test('certificate and boarding pass declare landscape format', () => {
  assert.match(
    PLAYGROUND_TEMPLATES['certificate'],
    /@page[^{]*\{[^}]*size\s*:\s*A4\s+landscape/i,
    'Certificate should declare A4 landscape'
  );
  assert.match(
    PLAYGROUND_TEMPLATES['boarding-pass'],
    /@page[^{]*\{[^}]*size\s*:\s*A4\s+landscape/i,
    'Boarding pass should declare A4 landscape'
  );
});
