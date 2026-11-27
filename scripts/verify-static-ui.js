#!/usr/bin/env node
'use strict';

// Verify local structural contracts in the static landing and dashboard HTML.
// This deliberately uses only Node.js built-in modules: no browser, packages,
// network access, or cloud credentials are required.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PAGE_ROOTS = [path.join(ROOT, 'landing'), path.join(ROOT, 'dashboard')];
const SECTION_NUMBER = /^\s*(\d+(?:\.\d+)*\.?)(?:\s|$)/;
const CANONICAL_HEADER_NAV = [
  { text: 'Home', href: '/' },
  { text: 'Pricing', href: '/#pricing' },
  { text: 'API docs', href: '/docs/api/' },
  { text: 'Dashboard', href: '/app/' },
  { text: 'GitHub', href: 'https://github.com/vberkoz/renderpdf' },
];

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function lineNumber(source, position) {
  return source.slice(0, position).split('\n').length;
}

function tagEnd(source, start) {
  let quote = '';
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return source.length - 1;
}

function attributes(source) {
  const values = new Map();
  const expression = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(expression)) {
    values.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
  }
  return values;
}

function parsePage(source) {
  const facts = {
    ids: [],
    fragments: [],
    stylesheets: [],
    navigation: [],
    targets: new Set(),
    headings: [],
    isRedirect: false,
    hasHeaderNav: false,
    headerNavLinks: [],
  };
  let heading = null;
  let headerDepth = 0;
  let inHeaderNav = false;
  let checkedHeaderNav = false;
  let headerNavLink = null;
  let svgDepth = 0;
  let index = 0;

  function text(value) {
    if (heading) heading.parts.push(value);
    if (headerNavLink && svgDepth === 0) headerNavLink.parts.push(value);
  }

  while (index < source.length) {
    const start = source.indexOf('<', index);
    if (start === -1) {
      text(source.slice(index));
      break;
    }
    text(source.slice(index, start));

    if (source.startsWith('<!--', start)) {
      const end = source.indexOf('-->', start + 4);
      index = end === -1 ? source.length : end + 3;
      continue;
    }

    const end = tagEnd(source, start + 1);
    const rawTag = source.slice(start + 1, end).trim();
    const closing = rawTag.startsWith('/');
    const selfClosing = rawTag.endsWith('/');
    const tagMatch = rawTag.match(/^\/?\s*([\w:-]+)/);
    const tag = tagMatch ? tagMatch[1].toLowerCase() : '';
    const line = lineNumber(source, start);

    if (closing) {
      if (heading && tag === `h${heading.level}`) {
        facts.headings.push({
          level: heading.level,
          line: heading.line,
          text: heading.parts.join('').replace(/\s+/g, ' ').trim(),
        });
        heading = null;
      }
      if (tag === 'svg' && svgDepth > 0) svgDepth -= 1;
      if (tag === 'a' && headerNavLink) {
        facts.headerNavLinks.push({
          href: headerNavLink.href,
          ariaCurrent: headerNavLink.ariaCurrent,
          line: headerNavLink.line,
          text: headerNavLink.parts.join('').replace(/\s+/g, ' ').trim(),
        });
        headerNavLink = null;
        svgDepth = 0;
      }
      if (tag === 'nav' && inHeaderNav) {
        inHeaderNav = false;
        checkedHeaderNav = true;
      }
      if (tag === 'header' && headerDepth > 0) {
        headerDepth -= 1;
        if (headerDepth === 0 && inHeaderNav) {
          inHeaderNav = false;
          checkedHeaderNav = true;
        }
      }
    } else if (tag) {
      const attrs = attributes(rawTag.slice(tagMatch[0].length));
      const id = attrs.get('id');
      if (id) facts.ids.push({ value: id, line });

      if (tag === 'meta' && (attrs.get('http-equiv') ?? '').toLowerCase() === 'refresh') {
        facts.isRedirect = true;
      }
      if (tag === 'header' && !selfClosing) headerDepth += 1;
      if (tag === 'nav' && headerDepth > 0 && !inHeaderNav && !checkedHeaderNav && !selfClosing) {
        inHeaderNav = true;
        facts.hasHeaderNav = true;
      }
      if (tag === 'svg' && headerNavLink && !selfClosing) svgDepth += 1;

      if (tag === 'a') {
        const href = attrs.get('href') ?? '';
        if (href.startsWith('#') && href.length > 1) {
          facts.fragments.push({ value: decode(href.slice(1)), line });
        }
        if (attrs.has('data-dashboard-nav')) {
          facts.navigation.push({ value: attrs.get('data-dashboard-nav'), line });
        }
        if (inHeaderNav && !selfClosing) {
          headerNavLink = {
            href,
            ariaCurrent: attrs.has('aria-current') ? attrs.get('aria-current') : null,
            line,
            parts: [],
          };
        }
      }

      if (attrs.has('data-dashboard-view')) facts.targets.add(attrs.get('data-dashboard-view'));
      if (tag === 'link') {
        const rel = new Set((attrs.get('rel') ?? '').toLowerCase().split(/\s+/));
        const href = attrs.get('href') ?? '';
        if (rel.has('stylesheet') && href) facts.stylesheets.push({ value: href, line });
      }
      if (/^h[1-6]$/.test(tag)) heading = { level: Number(tag[1]), line, parts: [] };

      // Tags in JavaScript strings must not be mistaken for document markup.
      if (tag === 'script' || tag === 'style') {
        const closingTag = new RegExp(`<\\/\\s*${tag}\\s*>`, 'ig');
        closingTag.lastIndex = end + 1;
        const closingMatch = closingTag.exec(source);
        index = closingMatch ? closingMatch.index : source.length;
        continue;
      }
    }
    index = end + 1;
  }
  return facts;
}

function resolveStylesheet(page, href) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return null;
  const pathname = decode(href.split(/[?#]/, 1)[0]);
  if (pathname.startsWith('/')) return path.join(ROOT, 'landing', pathname);
  return path.resolve(path.dirname(page), pathname);
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function expectedHeaderNavCurrent(label) {
  const normalized = label.split(path.sep).join('/');
  if (normalized === 'landing/index.html') return '/';
  if (normalized.startsWith('landing/docs/api/')) return '/docs/api/';
  if (normalized === 'dashboard/index.html') return '/app/';
  return null;
}

function checkHeaderNav(facts, label) {
  if (facts.isRedirect) return [];
  if (!facts.hasHeaderNav) return [`${label}: missing header <nav>`];

  const errors = [];
  const links = facts.headerNavLinks;
  const expectedCurrent = expectedHeaderNavCurrent(label);

  if (links.length !== CANONICAL_HEADER_NAV.length) {
    errors.push(
      `${label}: header <nav> has ${links.length} links, expected ${CANONICAL_HEADER_NAV.length}`
    );
  }

  const count = Math.min(links.length, CANONICAL_HEADER_NAV.length);
  for (let i = 0; i < count; i += 1) {
    const actual = links[i];
    const expected = CANONICAL_HEADER_NAV[i];
    if (actual.text !== expected.text || actual.href !== expected.href) {
      errors.push(
        `${label}:${actual.line}: header <nav> item ${i + 1} is ${JSON.stringify(actual.text)} -> ${JSON.stringify(actual.href)}, expected ${JSON.stringify(expected.text)} -> ${JSON.stringify(expected.href)}`
      );
    }
  }

  for (const link of links) {
    const isCurrent = link.ariaCurrent === 'page';
    const shouldBeCurrent = link.href === expectedCurrent;
    if (link.ariaCurrent !== null && !isCurrent) {
      errors.push(
        `${label}:${link.line}: header <nav> link ${JSON.stringify(link.href)} has unexpected aria-current=${JSON.stringify(link.ariaCurrent)}`
      );
    } else if (isCurrent !== shouldBeCurrent) {
      errors.push(
        `${label}:${link.line}: header <nav> link ${JSON.stringify(link.href)} ${shouldBeCurrent ? 'must have' : 'must not have'} aria-current="page"`
      );
    }
  }

  return errors;
}

function checkPage(page) {
  const source = fs.readFileSync(page, 'utf8');
  const facts = parsePage(source);
  const label = path.relative(ROOT, page);
  const errors = checkHeaderNav(facts, label);
  const idLines = new Map();

  for (const id of facts.ids) {
    const lines = idLines.get(id.value) ?? [];
    lines.push(id.line);
    idLines.set(id.value, lines);
  }
  for (const [id, lines] of idLines) {
    if (lines.length > 1)
      errors.push(`${label}:${lines.join(', ')}: duplicate id ${JSON.stringify(id)}`);
  }

  for (const fragment of facts.fragments) {
    if (!idLines.has(fragment.value)) {
      errors.push(
        `${label}:${fragment.line}: internal anchor #${fragment.value} has no target element`
      );
    }
  }
  for (const navigation of facts.navigation) {
    if (!facts.targets.has(navigation.value)) {
      errors.push(
        `${label}:${navigation.line}: navigation view ${JSON.stringify(navigation.value)} has no data-dashboard-view target`
      );
    }
  }

  let previousLevel = null;
  const sectionLines = new Map();
  for (const heading of facts.headings) {
    if (previousLevel !== null && heading.level > previousLevel + 1) {
      errors.push(
        `${label}:${heading.line}: heading hierarchy skips from h${previousLevel} to h${heading.level}`
      );
    }
    previousLevel = heading.level;
    const match = heading.text.match(SECTION_NUMBER);
    if (match) {
      const number = match[1].replace(/\.$/, '');
      const lines = sectionLines.get(number) ?? [];
      lines.push(heading.line);
      sectionLines.set(number, lines);
    }
  }
  for (const [number, lines] of sectionLines) {
    if (lines.length > 1)
      errors.push(`${label}:${lines.join(', ')}: duplicate documentation section number ${number}`);
  }

  for (const stylesheet of facts.stylesheets) {
    const target = resolveStylesheet(page, stylesheet.value);
    if (target && !isFile(target)) {
      errors.push(
        `${label}:${stylesheet.line}: stylesheet ${JSON.stringify(stylesheet.value)} does not exist locally`
      );
    }
  }
  return errors;
}

function htmlPages(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return htmlPages(entryPath);
    return entry.isFile() && entry.name.endsWith('.html') ? [entryPath] : [];
  });
}

const pages = PAGE_ROOTS.flatMap(htmlPages).sort();
const errors = pages.flatMap(checkPage);
if (errors.length) {
  console.error(
    `Static UI verification failed:\n${errors.map((error) => `- ${error}`).join('\n')}`
  );
  process.exitCode = 1;
} else {
  console.log(`Static UI verification passed (${pages.length} HTML pages checked).`);
}
