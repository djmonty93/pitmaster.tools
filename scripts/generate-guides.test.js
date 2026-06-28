#!/usr/bin/env node
/**
 * generate-guides.test.js — unit tests for the guides generation library
 * (scripts/guides-lib.js). Covers the publish-date gate, path classification,
 * marked-block replacement, and the deterministic rendering of the nav menu,
 * category grids, sitemap block, and llms block.
 *
 * Run via: node --test scripts/generate-guides.test.js
 * Also chained from `npm test` via test:scripts.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('./guides-lib.js');

test('todayUTC formats a Date as YYYY-MM-DD (UTC)', () => {
  const d = new Date(Date.UTC(2026, 5, 27, 23, 30, 0)); // 2026-06-27
  assert.equal(lib.todayUTC(d), '2026-06-27');
});

test('isLive: missing date is live; past/today live; future not', () => {
  assert.equal(lib.isLive('2026-06-01', '2026-06-27'), true);
  assert.equal(lib.isLive('2026-06-27', '2026-06-27'), true);
  assert.equal(lib.isLive('2026-07-01', '2026-06-27'), false);
  assert.equal(lib.isLive('', '2026-06-27'), true);
  assert.equal(lib.isLive(undefined, '2026-06-27'), true);
});

test('isGuideLeaf: leaf guides only, never hubs or non-guides', () => {
  assert.equal(lib.isGuideLeaf('guides/techniques/managing-the-stall.html'), true);
  assert.equal(lib.isGuideLeaf('guides\\techniques\\managing-the-stall.html'), true);
  assert.equal(lib.isGuideLeaf('guides/index.html'), false);
  assert.equal(lib.isGuideLeaf('guides/techniques/index.html'), false);
  assert.equal(lib.isGuideLeaf('tools/brisket-calculator.html'), false);
  assert.equal(lib.isGuideLeaf('pages/about.html'), false);
});

test('categoryOf / slugOf extract the path parts', () => {
  assert.equal(lib.categoryOf('guides/techniques/managing-the-stall.html'), 'techniques');
  assert.equal(lib.slugOf('guides/techniques/managing-the-stall.html'), 'managing-the-stall');
});

test('CATEGORIES are well-formed and unique', () => {
  assert.ok(Array.isArray(lib.CATEGORIES) && lib.CATEGORIES.length >= 6);
  const slugs = new Set();
  for (const c of lib.CATEGORIES) {
    assert.match(c.slug, /^[a-z0-9-]+$/);
    assert.ok(typeof c.title === 'string' && c.title.length > 0);
    assert.ok(!slugs.has(c.slug), 'duplicate category slug: ' + c.slug);
    slugs.add(c.slug);
  }
});

test('replaceMarkedBlock swaps content between markers, preserving them', () => {
  const text = 'A\n<!-- GUIDES:START -->\nOLD\n<!-- GUIDES:END -->\nB';
  const out = lib.replaceMarkedBlock(text, 'GUIDES', 'NEW');
  assert.ok(out.includes('<!-- GUIDES:START -->'));
  assert.ok(out.includes('<!-- GUIDES:END -->'));
  assert.ok(out.includes('NEW'));
  assert.ok(!out.includes('OLD'));
  assert.ok(out.startsWith('A\n'));
  assert.ok(out.endsWith('\nB'));
});

test('replaceMarkedBlock throws when markers are missing', () => {
  assert.throws(() => lib.replaceMarkedBlock('no markers here', 'GUIDES', 'X'));
});

// ── Sample guide set for rendering tests ───────────────────────────────────
const SAMPLE = [
  {
    rel: 'guides/techniques/managing-the-stall.html',
    category: 'techniques',
    slug: 'managing-the-stall',
    url: 'https://pitmaster.tools/guides/techniques/managing-the-stall',
    title: 'How to Manage the Brisket Stall | Pitmaster Tools',
    ogTitle: 'How to Manage the Brisket Stall',
    description: 'What the stall is and how to push through it.',
    published: '2026-06-20',
    modified: '2026-06-20',
    live: true,
  },
  {
    rel: 'guides/gear/meat-thermometers-explained.html',
    category: 'gear',
    slug: 'meat-thermometers-explained',
    url: 'https://pitmaster.tools/guides/gear/meat-thermometers-explained',
    title: 'Meat Thermometers Explained | Pitmaster Tools',
    ogTitle: 'Meat Thermometers Explained',
    description: 'Instant-read vs leave-in vs wireless probes.',
    published: '2026-07-15',
    modified: '2026-07-15',
    live: false, // scheduled
  },
];

test('renderNavMenu includes only live guides and the All Guides link', () => {
  const live = SAMPLE.filter((g) => g.live);
  const html = lib.renderNavMenu(live);
  assert.ok(html.includes('id="guides-menu"'));
  assert.ok(html.includes('/guides/'));
  assert.ok(html.includes('All Guides'));
  assert.ok(html.includes('/guides/techniques/managing-the-stall'));
  assert.ok(html.includes('Technique')); // category label
  // scheduled guide must never appear
  assert.ok(!html.includes('meat-thermometers-explained'));
  // a category with no live guides should not render a group
  assert.ok(!html.includes('/guides/gear/'));
});

test('renderSitemapBlock lists hubs + live guides only, with lastmod', () => {
  const live = SAMPLE.filter((g) => g.live);
  const xml = lib.renderSitemapBlock(live, '2026-06-27');
  assert.ok(xml.includes('https://pitmaster.tools/guides/'));
  assert.ok(xml.includes('https://pitmaster.tools/guides/techniques/'));
  assert.ok(xml.includes('https://pitmaster.tools/guides/techniques/managing-the-stall'));
  assert.ok(xml.includes('<lastmod>2026-06-27</lastmod>'));
  assert.ok(!xml.includes('meat-thermometers-explained'));
});

test('renderLlmsBlock lists live guides as markdown bullets', () => {
  const live = SAMPLE.filter((g) => g.live);
  const md = lib.renderLlmsBlock(live);
  assert.ok(md.includes('## Guides'));
  assert.ok(md.includes('[How to Manage the Brisket Stall]'));
  assert.ok(md.includes('https://pitmaster.tools/guides/techniques/managing-the-stall'));
  assert.ok(!md.includes('meat-thermometers-explained'));
});

test('renderHubGrid renders a card per category, escaping titles', () => {
  const html = lib.renderHubGrid([
    { slug: 'techniques', title: 'Technique & How-To', blurb: 'Methods.' },
  ]);
  assert.ok(html.includes('/guides/techniques/'));
  assert.ok(html.includes('Technique &amp; How-To'));
  assert.equal(lib.renderHubGrid([]).includes('guides-empty'), true);
});

test('renderCategoryGrid renders a card per live guide in the category', () => {
  const html = lib.renderCategoryGrid(SAMPLE.filter((g) => g.live), 'techniques');
  assert.ok(html.includes('How to Manage the Brisket Stall'));
  assert.ok(html.includes('/guides/techniques/managing-the-stall'));
  // amp-encoded titles must be escaped, never raw
  const amp = lib.renderCategoryGrid([{
    ...SAMPLE[0], ogTitle: 'Salt & Pepper Basics', title: 'Salt & Pepper Basics',
  }], 'techniques');
  assert.ok(amp.includes('Salt &amp; Pepper Basics'));
  assert.ok(!amp.includes('Salt & Pepper'));
});
