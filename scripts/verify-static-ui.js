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
    ids: [], fragments: [], stylesheets: [], navigation: [],
    targets: new Set(), headings: [],
  };
  let heading = null;
  let index = 0;

  function text(value) {
    if (heading) heading.parts.push(value);
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
    } else if (tag) {
      const attrs = attributes(rawTag.slice(tagMatch[0].length));
      const id = attrs.get('id');
      if (id) facts.ids.push({ value: id, line });

      if (tag === 'a') {
        const href = attrs.get('href') ?? '';
        if (href.startsWith('#') && href.length > 1) {
          facts.fragments.push({ value: decode(href.slice(1)), line });
        }
        if (attrs.has('data-dashboard-nav')) {
          facts.navigation.push({ value: attrs.get('data-dashboard-nav'), line });
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

function checkPage(page) {
  const source = fs.readFileSync(page, 'utf8');
  const facts = parsePage(source);
  const label = path.relative(ROOT, page);
  const errors = [];
  const idLines = new Map();

  for (const id of facts.ids) {
    const lines = idLines.get(id.value) ?? [];
    lines.push(id.line);
    idLines.set(id.value, lines);
  }
  for (const [id, lines] of idLines) {
    if (lines.length > 1) errors.push(`${label}:${lines.join(', ')}: duplicate id ${JSON.stringify(id)}`);
  }

  for (const fragment of facts.fragments) {
    if (!idLines.has(fragment.value)) {
      errors.push(`${label}:${fragment.line}: internal anchor #${fragment.value} has no target element`);
    }
  }
  for (const navigation of facts.navigation) {
    if (!facts.targets.has(navigation.value)) {
      errors.push(`${label}:${navigation.line}: navigation view ${JSON.stringify(navigation.value)} has no data-dashboard-view target`);
    }
  }

  let previousLevel = null;
  const sectionLines = new Map();
  for (const heading of facts.headings) {
    if (previousLevel !== null && heading.level > previousLevel + 1) {
      errors.push(`${label}:${heading.line}: heading hierarchy skips from h${previousLevel} to h${heading.level}`);
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
    if (lines.length > 1) errors.push(`${label}:${lines.join(', ')}: duplicate documentation section number ${number}`);
  }

  for (const stylesheet of facts.stylesheets) {
    const target = resolveStylesheet(page, stylesheet.value);
    if (target && !isFile(target)) {
      errors.push(`${label}:${stylesheet.line}: stylesheet ${JSON.stringify(stylesheet.value)} does not exist locally`);
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
  console.error(`Static UI verification failed:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Static UI verification passed (${pages.length} HTML pages checked).`);
}
