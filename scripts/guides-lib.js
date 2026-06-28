#!/usr/bin/env node
/**
 * guides-lib.js — shared logic for the Guides content section.
 *
 * One source of truth for:
 *   - the category taxonomy (CATEGORIES),
 *   - the publish-date gate (isLive / todayUTC) used by BOTH build.js (to
 *     withhold future-dated guide pages from dist/) and generate-guides.js
 *     (to withhold them from the nav, hubs, sitemap, and llms),
 *   - scanning _src/guides/** into structured guide records (scanGuides),
 *   - deterministic rendering of the generated nav menu, category grids,
 *     and the marked sitemap / llms blocks.
 *
 * A guide is "live" when its `published` date (frontmatter) is today-or-earlier
 * in UTC. Future-dated guides are authored and merged now but stay invisible
 * until a scheduled rebuild (see .github/workflows/publish.yml) crosses the
 * date — that's how "build all up front, publish ~3/week" works on a static
 * build → Cloudflare site.
 *
 * Pure functions are exported for scripts/generate-guides.test.js. The only
 * filesystem reader is scanGuides; it borrows build.js's parseFrontmatter so
 * the meta-comment grammar stays identical to every other page.
 *
 * NOTE on the build.js require: build.js assigns module.exports before its
 * `require.main === module` entry guard runs, and build.js only requires this
 * module *lazily* from inside runBuild(). So by the time guides-lib loads,
 * build.js's exports are populated — no circular-require hazard.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../build.js');

const ORIGIN = 'https://pitmaster.tools';

// ── Category taxonomy (order = display order in nav + top hub) ───────────────
const CATEGORIES = [
  { slug: 'techniques',         title: 'Technique & How-To',  blurb: 'Step-by-step methods for the cook itself — the stall, wrapping, fire management, resting, and more.' },
  { slug: 'gear',               title: 'Gear & Equipment',    blurb: 'Plain-English explainers on smokers, thermometers, and the tools that actually move the needle.' },
  { slug: 'wood-and-smoke',     title: 'Wood & Smoke',        blurb: 'Wood pairings, chunks vs chips vs pellets, and how to read your smoke.' },
  { slug: 'prep-and-seasoning', title: 'Prep & Seasoning',    blurb: 'Brines, rubs, injections, and binders — what to do before the meat ever hits the grate.' },
  { slug: 'cuts-and-selection', title: 'Cuts & Selection',    blurb: 'How to choose and understand the cuts you cook, from packer briskets to pork shoulders.' },
  { slug: 'food-safety',        title: 'Food Safety',         blurb: 'Safe internal temperatures, the danger zone, and storing and reheating barbecue.' },
];

function categoryTitle(slug) {
  const c = CATEGORIES.find((x) => x.slug === slug);
  return c ? c.title : slug;
}

// ── HTML / XML escaping ─────────────────────────────────────────────────────
const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => HTML_ESCAPE_MAP[c]);
}

// ── Date gate ───────────────────────────────────────────────────────────────
function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function todayUTC(now) {
  const d = now || new Date();
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

// A guide with no `published` date is treated as immediately live (the page
// template always sets one; a missing date should never silently hide a page).
// Both operands are ISO YYYY-MM-DD, so a lexicographic compare is a date compare.
function isLive(published, today) {
  if (!published) return true;
  return String(published) <= String(today);
}

// ── Path classification (rel = path under _src, any slash style) ─────────────
function normRel(rel) { return String(rel).replace(/\\/g, '/'); }

function isGuideLeaf(rel) {
  const p = normRel(rel);
  return p.startsWith('guides/') && p.endsWith('.html') && path.basename(p) !== 'index.html';
}

function categoryOf(rel) {
  return normRel(rel).split('/')[1];
}

function slugOf(rel) {
  return path.basename(normRel(rel), '.html');
}

// ── Marked-block replacement (sitemap.xml / llms.txt managed regions) ───────
// Replaces everything between `<!-- NAME:START -->` and `<!-- NAME:END -->`
// with `inner`, keeping the marker lines. Throws if either marker is absent so
// a renamed/clobbered file fails loudly instead of silently dropping guides.
function replaceMarkedBlock(text, name, inner) {
  const startMark = '<!-- ' + name + ':START -->';
  const endMark = '<!-- ' + name + ':END -->';
  const s = text.indexOf(startMark);
  const e = text.indexOf(endMark);
  if (s < 0 || e < 0 || e < s) {
    throw new Error('Missing or malformed marked block "' + name + '" (need ' + startMark + ' … ' + endMark + ')');
  }
  const before = text.slice(0, s + startMark.length);
  const after = text.slice(e);
  return before + '\n' + inner + '\n' + after;
}

// ── Scan _src/guides/** into guide records ──────────────────────────────────
function listHtmlRecursive(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listHtmlRecursive(full));
    else if (entry.isFile() && entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

// Returns leaf-guide records (hubs excluded), sorted newest-first by published
// then by url for stability. `today` defaults to the current UTC date.
function scanGuides(srcDir, today) {
  const t = today || todayUTC();
  const guidesDir = path.join(srcDir, 'guides');
  const records = [];
  for (const full of listHtmlRecursive(guidesDir)) {
    const rel = normRel(path.relative(srcDir, full));
    if (!isGuideLeaf(rel)) continue;
    const fm = parseFrontmatter(fs.readFileSync(full, 'utf8')).vars;
    const slug = slugOf(rel);
    const category = categoryOf(rel);
    const url = ORIGIN + '/guides/' + category + '/' + slug;
    const published = fm.published || '';
    records.push({
      rel, category, slug, url,
      title: fm.title || slug,
      ogTitle: fm.og_title || fm.title || slug,
      description: fm.description || '',
      published,
      modified: fm.modified || published,
      live: isLive(published, t),
    });
  }
  records.sort((a, b) => (b.published || '').localeCompare(a.published || '') || a.url.localeCompare(b.url));
  return records;
}

// ── Renderers (pure; input is a list of guide records) ──────────────────────

// Group live guides by category, preserving CATEGORIES order. Only categories
// with at least one live guide are returned.
function groupByCategory(liveGuides) {
  return CATEGORIES
    .map((c) => ({ category: c, guides: liveGuides.filter((g) => g.category === c.slug) }))
    .filter((g) => g.guides.length > 0);
}

function renderNavMenu(liveGuides) {
  const groups = groupByCategory(liveGuides);
  const lines = [];
  lines.push('<ul class="nav-dropdown__menu" id="guides-menu" role="list">');
  lines.push('          <li><a href="/guides/">All Guides</a></li>');
  for (const { category, guides } of groups) {
    const labelId = 'guides-group-' + category.slug;
    lines.push('          <li class="nav-dropdown__group">');
    lines.push('            <span class="nav-dropdown__group-label" id="' + labelId + '">' + escapeHtml(category.title) + '</span>');
    lines.push('            <ul role="list" aria-labelledby="' + labelId + '">');
    for (const g of guides) {
      lines.push('              <li><a href="/guides/' + category.slug + '/' + g.slug + '">' + escapeHtml(g.ogTitle) + '</a></li>');
    }
    lines.push('            </ul>');
    lines.push('          </li>');
  }
  lines.push('        </ul>');
  return lines.join('\n') + '\n';
}

// Card grid for the top /guides/ hub: one card per category. `categories` is a
// list of {slug, title, blurb} (already filtered to those whose hub page
// exists), rendered in the given order.
function renderHubGrid(categories) {
  if (!categories || categories.length === 0) {
    return '<p class="guides-empty">Guides are on the way — check back soon.</p>\n';
  }
  const cards = categories.map((c) => {
    const href = '/guides/' + c.slug + '/';
    return [
      '  <article class="guide-card">',
      '    <a class="guide-card__name" href="' + href + '">' + escapeHtml(c.title) + '</a>',
      '    <p class="guide-card__desc">' + escapeHtml(c.blurb) + '</p>',
      '    <a class="guide-card__link" href="' + href + '">Browse guides</a>',
      '  </article>',
    ].join('\n');
  });
  return '<div class="guides-grid">\n' + cards.join('\n') + '\n</div>\n';
}

// Card grid for a single category hub. Returns the inner of a .guides-grid;
// the hub page wraps it. Empty category → a friendly "coming soon" note.
function renderCategoryGrid(liveGuides, categorySlug) {
  const guides = liveGuides.filter((g) => g.category === categorySlug);
  if (guides.length === 0) {
    return '<p class="guides-empty">New guides in this category are on the way — check back soon.</p>\n';
  }
  const cards = guides.map((g) => {
    const href = '/guides/' + g.category + '/' + g.slug;
    return [
      '  <article class="guide-card">',
      '    <a class="guide-card__name" href="' + href + '">' + escapeHtml(g.ogTitle) + '</a>',
      '    <p class="guide-card__desc">' + escapeHtml(g.description) + '</p>',
      '    <a class="guide-card__link" href="' + href + '">Read guide</a>',
      '  </article>',
    ].join('\n');
  });
  return '<div class="guides-grid">\n' + cards.join('\n') + '\n</div>\n';
}

// Sitemap <url> entries for the top hub, each category hub that has ≥1 live
// guide, and each live guide. Hubs priority 0.7, guides 0.6.
function renderSitemapBlock(liveGuides, today) {
  const t = today || todayUTC();
  const entry = (loc, priority) =>
    '  <url>\n' +
    '    <loc>' + loc + '</loc>\n' +
    '    <lastmod>' + t + '</lastmod>\n' +
    '    <changefreq>monthly</changefreq>\n' +
    '    <priority>' + priority + '</priority>\n' +
    '  </url>';
  const out = [entry(ORIGIN + '/guides/', '0.7')];
  for (const { category } of groupByCategory(liveGuides)) {
    out.push(entry(ORIGIN + '/guides/' + category.slug + '/', '0.7'));
  }
  for (const g of liveGuides) {
    out.push(entry(g.url, '0.6'));
  }
  return out.join('\n');
}

// llms.txt "## Guides" section: a heading plus one bullet per live guide.
function renderLlmsBlock(liveGuides) {
  const lines = ['## Guides', ''];
  for (const g of liveGuides) {
    const desc = g.description ? ' — ' + g.description : '';
    lines.push('- [' + g.ogTitle + '](' + g.url + ')' + desc);
  }
  return lines.join('\n');
}

module.exports = {
  CATEGORIES, ORIGIN,
  categoryTitle, escapeHtml,
  todayUTC, isLive,
  isGuideLeaf, categoryOf, slugOf,
  replaceMarkedBlock,
  scanGuides, groupByCategory,
  renderNavMenu, renderHubGrid, renderCategoryGrid, renderSitemapBlock, renderLlmsBlock,
};
