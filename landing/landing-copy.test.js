'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const pdfSecurityHtml = fs.readFileSync(
  path.join(__dirname, 'docs', 'api', 'pdf-security', 'index.html'),
  'utf8'
);

test('#panel-curl cURL snippet contains valid canonical Factur-X render JSON with invoiceXml', () => {
  const panelMatch = indexHtml.match(
    /<div id="panel-curl"[\s\S]*?<pre[^>]*><code>([\s\S]*?)<\/code><\/pre>/
  );
  assert.ok(panelMatch, '#panel-curl code block should exist');

  const codeText = panelMatch[1]
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

  assert.ok(!codeText.includes('printBackground'), '#panel-curl must not contain printBackground');

  const dataMatch = codeText.match(/-d\s+'(\{[\s\S]*\})'/);
  assert.ok(dataMatch, '#panel-curl must contain a -d JSON body');

  const payload = JSON.parse(dataMatch[1]);
  assert.deepStrictEqual(Object.keys(payload).sort(), ['options', 'source', 'version']);
  assert.strictEqual(payload.version, '1');
  assert.deepStrictEqual(Object.keys(payload.source).sort(), ['content', 'type']);
  assert.strictEqual(payload.source.type, 'html');
  assert.ok(typeof payload.source.content === 'string' && payload.source.content.length > 0);
  assert.deepStrictEqual(Object.keys(payload.options).sort(), ['compliance', 'format']);
  assert.strictEqual(payload.options.format, 'A4');
  assert.deepStrictEqual(
    Object.keys(payload.options.compliance).sort(),
    ['invoiceProfile', 'invoiceXml', 'profile']
  );
  assert.strictEqual(payload.options.compliance.profile, 'factur-x');
  assert.strictEqual(payload.options.compliance.invoiceProfile, 'EN 16931');
  assert.ok(
    typeof payload.options.compliance.invoiceXml === 'string' &&
      payload.options.compliance.invoiceXml.trim().startsWith('<')
  );
});

test('landing and security docs omit unvalidated claims and stale overage pricing', () => {
  const forbiddenLandingPatterns = [
    /working capital/i,
    /non-dilutive/i,
    /\bHIPAA\b/i,
    /\bPAdES\b/i,
    /legally binding/i,
    /printBackground/i,
    /\$10/,
  ];
  for (const pattern of forbiddenLandingPatterns) {
    assert.doesNotMatch(indexHtml, pattern, `landing/index.html must not match ${pattern}`);
  }

  for (const pattern of [/\bPAdES\b/i, /\bHIPAA\b/i, /printBackground/i]) {
    assert.doesNotMatch(
      pdfSecurityHtml,
      pattern,
      `landing/docs/api/pdf-security/index.html must not match ${pattern}`
    );
  }
  assert.ok(
    pdfSecurityHtml.includes('id="digital-signatures"'),
    'pdf-security docs must preserve #digital-signatures anchor'
  );
});

test('JSON-LD structured data parses cleanly and matches visible FAQ and pricing copy', () => {
  const ldMatch = indexHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(ldMatch, 'landing/index.html must contain JSON-LD script');

  const structured = JSON.parse(ldMatch[1]);
  const graph = structured['@graph'];
  assert.ok(Array.isArray(graph));

  const software = graph.find((node) => node['@type'] === 'SoftwareApplication');
  assert.ok(software, 'JSON-LD must include SoftwareApplication');
  const featureText = software.featureList.join('\n');
  assert.ok(featureText.includes('X.509 PKCS#7'));
  assert.ok(!featureText.includes('PAdES'));

  const faqPage = graph.find((node) => node['@type'] === 'FAQPage');
  assert.ok(faqPage, 'JSON-LD must include FAQPage');

  const cssFaq = faqPage.mainEntity.find((q) => q.name.includes('custom CSS and web fonts'));
  assert.ok(cssFaq, 'JSON-LD FAQ must include custom CSS and web fonts question');
  const cssAnswer = cssFaq.acceptedAnswer.text;
  assert.ok(cssAnswer.includes('Document JSON'));
  assert.ok(cssAnswer.includes('markdown'));
  assert.ok(cssAnswer.includes('422'));
  assert.ok(cssAnswer.includes('options.landscape'));
  assert.ok(cssAnswer.includes('upload'));
  assert.ok(cssAnswer.includes('CSP'));

  const quotaFaq = faqPage.mainEntity.find((q) => q.name.includes('exceed my monthly plan quota'));
  assert.ok(quotaFaq, 'JSON-LD FAQ must include quota question');
  assert.ok(quotaFaq.acceptedAnswer.text.includes('$5 USD'));
  assert.ok(!quotaFaq.acceptedAnswer.text.includes('$10'));

  const visibleFaqMatch = indexHtml.match(
    /<summary class="faq-question">\s*<h3>How does RenderPDF handle custom CSS and web fonts\?<\/h3>[\s\S]*?<div class="faq-answer">([\s\S]*?)<\/div>/
  );
  assert.ok(visibleFaqMatch, 'Visible CSS/fonts FAQ answer must exist');
  const visibleCssText = visibleFaqMatch[1].replace(/<[^>]+>/g, '');
  assert.ok(visibleCssText.includes('Document JSON'));
  assert.ok(visibleCssText.includes('markdown'));
  assert.ok(visibleCssText.includes('422'));
  assert.ok(visibleCssText.includes('options.landscape'));
  assert.ok(visibleCssText.includes('upload'));
  assert.ok(visibleCssText.includes('CSP'));
});
