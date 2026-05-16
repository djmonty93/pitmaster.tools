#!/usr/bin/env node
/**
 * validate-schema.test.js — codifies the CLAUDE.md JSON-LD convention so a
 * future page can't land without it.
 *
 * Rule (from CLAUDE.md):
 *   "Schema (WebApplication + FAQPage) is required on tool pages; omit on
 *    legal pages."
 *
 * This test enumerates _src/**.html and asserts every non-exempt tool page
 * has at least one <script type="application/ld+json"> block AND that the
 * parsed JSON-LD content covers `WebApplication` and `FAQPage` somewhere.
 * Generated metro pages count — the marker exists in _src/smoke-weather/ from
 * generate-metros.js but the SOURCE for those is here, not in dist/, so
 * source-tree coverage is the right check.
 *
 * Metro pages also carry BreadcrumbList JSON-LD:
 *   Home -> Best Smoke Days -> metro page
 *
 * Exempt pages fall in two buckets:
 *   - Legal / system pages with no functional surface — 404, privacy,
 *     terms, smoke-weather/disclosures.
 *   - Editorial pages that legitimately carry a different schema graph
 *     (Organization + ContactPoint for `about`) rather than the
 *     tool-pattern WebApplication + FAQPage.
 *
 * Future informational pages added under _src/smoke-weather/ that aren't
 * tools themselves (e.g. methodology, faq, status) should be added to the
 * EXEMPT_PAGES list with a one-line justification.
 *
 * Run via: node --test scripts/validate-schema.test.js
 * Also chained from `npm test` via test:scripts.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_DIR = '_src';
const METRO_DIR = '_src/smoke-weather';
const GENERATED_MARKER = '<!-- generated:best-smoke-days-metro -->';

/**
 * Pages exempt from the WebApplication + FAQPage schema requirement.
 * Paths are relative to repo root and use forward slashes for portability
 * across the OS check below (we normalize at compare time).
 */
const EXEMPT_PAGES = new Set([
  '_src/pages/404.html',
  '_src/legal/privacy-policy.html',
  '_src/legal/terms-of-service.html',
  // FTC affiliate-disclosure page — Step 10 (#43). `noindex, follow`,
  // omitted from sitemap.xml, no tool functionality.
  '_src/smoke-weather/disclosures.html',
  // Editorial "About" page — legitimately uses Organization +
  // ContactPoint schema (organizational identity), not the tool-page
  // WebApplication + FAQPage pattern.
  '_src/pages/about.html',
  // Tools index / catalog page — emits ItemList + ListItem to describe
  // the collection of calculators, not a tool itself.
  '_src/pages/tools.html',
  // Operational status page — Step 17 (F21). `noindex, follow`, reads
  // /api/status, surfaces MailerLite queue and recent errors. Not a
  // tool placement; no JSON-LD value for an operational dashboard.
  '_src/smoke-weather/status.html',
]);

function listHtmlRecursive(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
        // Normalize to forward-slash for stable cross-platform compare.
        out.push(full.split(path.sep).join('/'));
      }
    }
  }
  return out.sort();
}

function extractLdBlocks(html) {
  const blocks = [];
  const re = /<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

function collectTypes(parsed, out) {
  if (parsed === null || typeof parsed !== 'object') return;
  if (Array.isArray(parsed)) {
    for (const item of parsed) collectTypes(item, out);
    return;
  }
  if (typeof parsed['@type'] === 'string') out.add(parsed['@type']);
  if (Array.isArray(parsed['@type'])) {
    for (const t of parsed['@type']) {
      if (typeof t === 'string') out.add(t);
    }
  }
  for (const v of Object.values(parsed)) collectTypes(v, out);
}

function parseLdBlocks(file, html) {
  const blocks = extractLdBlocks(html);
  const parsedBlocks = [];
  for (const raw of blocks) {
    try {
      parsedBlocks.push(JSON.parse(raw));
    } catch (err) {
      assert.fail(file + ' has malformed JSON-LD: ' + err.message);
    }
  }
  return parsedBlocks;
}

function findJsonLdType(parsedBlocks, type) {
  return parsedBlocks.find((block) => block && block['@type'] === type) || null;
}

test('every non-exempt _src/**.html carries the CLAUDE.md JSON-LD shape', () => {
  const files = listHtmlRecursive(SRC_DIR);
  assert.ok(files.length > 0, 'no HTML pages found under ' + SRC_DIR);

  // Sanity check: every entry in EXEMPT_PAGES should still exist on disk.
  // Stale exemptions are a footgun — they let a renamed page silently
  // bypass the schema requirement under its new name.
  for (const legal of EXEMPT_PAGES) {
    assert.ok(
      fs.existsSync(legal),
      'EXEMPT_PAGES entry "' + legal + '" no longer exists on disk — ' +
        'remove the exemption or rename to match.'
    );
  }

  for (const file of files) {
    if (EXEMPT_PAGES.has(file)) continue;
    const html = fs.readFileSync(file, 'utf8');
    const blocks = extractLdBlocks(html);
    assert.ok(
      blocks.length >= 1,
      file + ' has no <script type="application/ld+json"> block'
    );
    const types = new Set();
    for (const parsed of parseLdBlocks(file, html)) {
      collectTypes(parsed, types);
    }
    assert.ok(
      types.has('WebApplication'),
      file + ' is missing WebApplication JSON-LD (CLAUDE.md requirement). ' +
        'Got @types: [' + [...types].join(', ') + ']'
    );
    assert.ok(
      types.has('FAQPage'),
      file + ' is missing FAQPage JSON-LD (CLAUDE.md requirement). ' +
        'Got @types: [' + [...types].join(', ') + ']'
    );
  }
});

test('exempt-page set matches the documented allowlist (no silent drift)', () => {
  // Pin the exemption count + names so an accidental addition stands out
  // in code review.
  assert.equal(EXEMPT_PAGES.size, 7);
  assert.ok(EXEMPT_PAGES.has('_src/pages/404.html'));
  assert.ok(EXEMPT_PAGES.has('_src/legal/privacy-policy.html'));
  assert.ok(EXEMPT_PAGES.has('_src/legal/terms-of-service.html'));
  assert.ok(EXEMPT_PAGES.has('_src/smoke-weather/disclosures.html'));
  assert.ok(EXEMPT_PAGES.has('_src/pages/about.html'));
  assert.ok(EXEMPT_PAGES.has('_src/pages/tools.html'));
  assert.ok(EXEMPT_PAGES.has('_src/smoke-weather/status.html'));
});

test('generated metro pages carry a valid 3-level BreadcrumbList', () => {
  const files = listHtmlRecursive(METRO_DIR)
    .filter((file) => !EXEMPT_PAGES.has(file))
    .filter((file) => {
      const html = fs.readFileSync(file, 'utf8');
      return html.startsWith(GENERATED_MARKER);
    });

  assert.equal(files.length, 50, 'expected exactly 50 generated metro pages');

  for (const file of files) {
    const html = fs.readFileSync(file, 'utf8');
    const breadcrumb = findJsonLdType(parseLdBlocks(file, html), 'BreadcrumbList');
    assert.ok(breadcrumb, file + ' is missing BreadcrumbList JSON-LD');

    const items = breadcrumb.itemListElement;
    assert.ok(Array.isArray(items), file + ' BreadcrumbList.itemListElement must be an array');
    assert.equal(items.length, 3, file + ' BreadcrumbList must have exactly 3 levels');

    const slug = path.basename(file, '.html');
    const expectedMetroUrl = 'https://pitmaster.tools/smoke-weather/' + slug;

    assert.deepEqual(
      items.map((item) => item && item['@type']),
      ['ListItem', 'ListItem', 'ListItem'],
      file + ' BreadcrumbList entries must all be ListItem nodes'
    );
    assert.deepEqual(
      items.map((item) => item && item.position),
      [1, 2, 3],
      file + ' BreadcrumbList positions must be 1, 2, 3'
    );
    assert.equal(items[0].name, 'Home', file + ' breadcrumb level 1 name');
    assert.equal(items[0].item, 'https://pitmaster.tools/', file + ' breadcrumb level 1 URL');
    assert.equal(items[1].name, 'Best Smoke Days', file + ' breadcrumb level 2 name');
    assert.equal(items[1].item, 'https://pitmaster.tools/smoke-weather/', file + ' breadcrumb level 2 URL');
    assert.match(items[2].name, /^[^,]+, [A-Z]{2}$/, file + ' breadcrumb level 3 name');
    assert.equal(items[2].item, expectedMetroUrl, file + ' breadcrumb level 3 URL');
  }
});
