#!/usr/bin/env node
/**
 * generate-metros.test.js — Node-builtin tests for the metro page generator.
 *
 * Run via: node --test scripts/generate-metros.test.js
 * Also chained from `npm test` via the test:scripts npm script.
 *
 * Coverage:
 *   - Parity: every metro in worker/migrations/0001_init.sql (metros table) is present
 *     in scripts/generate-metros.js and vice versa (slug, name, state, zip,
 *     latitude, longitude, timezone, population all agree).
 *   - renderMetro(metro) produces HTML that:
 *       · starts with the generated marker
 *       · has the right canonical, title, and description
 *       · pre-fills the ZIP input with the metro zip
 *       · embeds two JSON-LD blocks (WebApplication + FAQPage)
 *       · references all four <!-- INJECT --> directives (header.css,
 *         base.css, smoke-weather.css, smoke-weather-app.js, etc.)
 *       · carries a body with ≥300 plain-text words (F16 acceptance).
 *   - run({ outDir, metros }) writes one file per metro and sweeps prior
 *     generated files on re-run.
 *   - Static maps cover every state present in METROS.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gen = require('./generate-metros.js');

const SEED_SQL_PATH = path.join('worker', 'migrations', '0001_init.sql');

function extractMetrosSection(sqlText) {
  // Task 12 squashed migrations 0001–0005 into a single 0001_init.sql.
  // Extract just the metros INSERT block (from the metros table definition
  // through the final semicolon).
  const start = sqlText.indexOf('INSERT OR IGNORE INTO metros');
  if (start === -1) {
    throw new Error('metros INSERT block not found in ' + SEED_SQL_PATH);
  }
  const end = sqlText.indexOf(';', start);
  if (end === -1) {
    throw new Error('trailing semicolon for metros INSERT block not found');
  }
  return sqlText.slice(start, end + 1);
}

function parseSqlSeed(sqlText) {
  // Each row is `('slug','name','state','zip',lat,lng,'tz',pop)`. There's a
  // trailing semicolon after the final row. We parse line-by-line on rows
  // starting with whitespace + '(' so the file's header comments are skipped.
  const rows = [];
  for (const rawLine of sqlText.split(/\r?\n/)) {
    const m = rawLine.match(/^\s*\(\s*(.+?)\s*\)(,|;)?\s*$/);
    if (!m) continue;
    const inner = m[1];
    // Split on commas not inside single-quoted strings. SQL strings here
    // don't contain commas — `Dallas–Fort Worth` uses an en-dash — so a
    // light state machine suffices.
    const parts = [];
    let buf = '';
    let inStr = false;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === "'") {
        inStr = !inStr;
        continue;
      }
      if (ch === ',' && !inStr) {
        parts.push(buf.trim());
        buf = '';
        continue;
      }
      buf += ch;
    }
    parts.push(buf.trim());
    if (parts.length !== 8) continue;
    rows.push({
      slug:       parts[0],
      name:       parts[1],
      state:      parts[2],
      zip:        parts[3],
      latitude:   Number(parts[4]),
      longitude:  Number(parts[5]),
      timezone:   parts[6],
      population: Number(parts[7]),
    });
  }
  return rows;
}

function plainTextWordCount(html) {
  // Strip <script> + <style> + json-ld blocks, then HTML tags, then count
  // non-empty whitespace-separated tokens. Matches what a search-engine
  // crawler would treat as the body's word count for an editorial-quality
  // check.
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-zA-Z]+;/g, ' ')
    .replace(/&#\d+;/g, ' ');
  return stripped.split(/\s+/).filter(Boolean).length;
}

test('METROS contains exactly 50 entries', () => {
  assert.equal(gen.METROS.length, 50);
});

test('slugs are unique', () => {
  const slugs = gen.METROS.map((m) => m.slug);
  assert.equal(new Set(slugs).size, slugs.length);
});

test('zips are unique', () => {
  const zips = gen.METROS.map((m) => m.zip);
  assert.equal(new Set(zips).size, zips.length);
});

test('every metro has a valid 5-digit ZIP', () => {
  for (const m of gen.METROS) {
    assert.match(m.zip, /^\d{5}$/, m.slug + ' zip ' + m.zip);
  }
});

test('METROS matches worker/migrations/0001_init.sql metros section exactly', () => {
  const allSqlText = fs.readFileSync(SEED_SQL_PATH, 'utf8');
  const metrosSection = extractMetrosSection(allSqlText);
  const sqlRows = parseSqlSeed(metrosSection);
  assert.equal(sqlRows.length, gen.METROS.length, 'row count');
  const sqlBySlug = new Map(sqlRows.map((r) => [r.slug, r]));
  for (const m of gen.METROS) {
    const s = sqlBySlug.get(m.slug);
    assert.ok(s, 'sql missing metro: ' + m.slug);
    assert.equal(s.name, m.name, m.slug + ' name');
    assert.equal(s.state, m.state, m.slug + ' state');
    assert.equal(s.zip, m.zip, m.slug + ' zip');
    assert.ok(Math.abs(s.latitude - m.latitude) < 1e-6, m.slug + ' latitude');
    assert.ok(Math.abs(s.longitude - m.longitude) < 1e-6, m.slug + ' longitude');
    assert.equal(s.timezone, m.timezone, m.slug + ' timezone');
    assert.equal(s.population, m.population, m.slug + ' population');
  }
});

test('every metro has a unique METRO_NOTE woven into the intro', () => {
  const notes = new Set();
  for (const m of gen.METROS) {
    const note = gen.METRO_NOTE[m.slug];
    assert.ok(note, m.slug + ' missing METRO_NOTE');
    assert.ok(note.length >= 80, m.slug + ' note is too short (' + note.length + ' chars)');
    assert.equal(notes.has(note), false, m.slug + ' duplicate note');
    notes.add(note);
    const html = gen.renderMetro(m);
    assert.ok(html.includes(gen.escapeHtml(note)),
      m.slug + ' rendered HTML does not contain its METRO_NOTE');
  }
});

test('same-state metros have distinct intros (no near-duplicate SEO pages)', () => {
  // Group metros by state and assert that any state with 2+ metros produces
  // distinct page-hero intro paragraphs. Catches regressions where someone
  // adds a new metro but forgets the METRO_NOTE override.
  const byState = new Map();
  for (const m of gen.METROS) {
    if (!byState.has(m.state)) byState.set(m.state, []);
    byState.get(m.state).push(m);
  }
  for (const [state, metros] of byState) {
    if (metros.length < 2) continue;
    const introHtmls = metros.map((m) => {
      const html = gen.renderMetro(m);
      const match = html.match(/<section class="page-hero"[^>]*>([\s\S]*?)<\/section>/);
      assert.ok(match, m.slug + ' page-hero missing');
      return match[1];
    });
    const unique = new Set(introHtmls);
    assert.equal(unique.size, introHtmls.length,
      state + ' has duplicate page-hero content across same-state metros');
  }
});

test('every state in METROS has a region, state-name, and either state or regional heritage', () => {
  for (const m of gen.METROS) {
    assert.ok(gen.REGION_BY_STATE[m.state], m.slug + ' missing region map');
    assert.ok(gen.STATE_NAME[m.state], m.slug + ' missing state name');
    const region = gen.REGION_BY_STATE[m.state];
    assert.ok(gen.REGION_LABEL[region], m.slug + ' missing region label');
    assert.ok(gen.REGION_CLIMATE[region], m.slug + ' missing region climate');
    assert.ok(gen.REGION_COOKER_TIP[region], m.slug + ' missing region cooker tip');
    const heritage = gen.BBQ_HERITAGE_BY_STATE[m.state] || gen.BBQ_HERITAGE_BY_REGION[region];
    assert.ok(heritage, m.slug + ' missing heritage');
  }
});

test('cookerTipFor returns a per-metro override for inland Pacific metros, falls back otherwise', () => {
  // Inland Pacific metros carry a climate override; their cooker tip must
  // match so the same page can't say "inland/desert" in one paragraph and
  // "coastal wind" in the next.
  for (const slug of ['sacramento-ca', 'riverside-ca', 'portland-or']) {
    const metro = gen.METROS.find((m) => m.slug === slug);
    assert.ok(metro, slug + ' not found in METROS');
    const tip = gen.cookerTipFor(metro);
    assert.equal(tip, gen.COOKER_TIP_BY_METRO[slug], slug + ' should use its cooker-tip override');
    assert.notEqual(tip, gen.REGION_COOKER_TIP.pacific, slug + ' must not fall back to the coastal Pacific tip');
  }
  // A metro without an override falls back to its region tip.
  const coastal = gen.METROS.find((m) => m.slug === 'san-diego-ca');
  assert.ok(coastal, 'san-diego-ca not found in METROS');
  assert.equal(gen.cookerTipFor(coastal), gen.REGION_COOKER_TIP.pacific,
    'san-diego-ca should fall back to the region cooker tip');
});

test('every overridden metro renders its cooker-tip override in the page body', () => {
  for (const slug of Object.keys(gen.COOKER_TIP_BY_METRO)) {
    const metro = gen.METROS.find((m) => m.slug === slug);
    assert.ok(metro, slug + ' not found in METROS');
    const html = gen.renderMetro(metro);
    assert.ok(html.includes(gen.escapeHtml(gen.COOKER_TIP_BY_METRO[slug])),
      slug + ' page body missing its cooker-tip override');
  }
});

test('renderMetro emits the marker as the first line', () => {
  const html = gen.renderMetro(gen.METROS[0]);
  assert.equal(html.startsWith(gen.GENERATED_MARKER), true);
});

test('renderMetro embeds canonical, title, description, and ZIP-prefilled input', () => {
  for (const metro of gen.METROS) {
    const html = gen.renderMetro(metro);
    const canonical = 'https://pitmaster.tools/smoke-weather/' + metro.slug;
    // canonical, title, description, og_title now live in the frontmatter
    // <!-- meta: ... --> block; head-meta.html / head-og.html partials emit
    // the final <title>/<link>/<meta> at build time via {{TOKEN}} substitution.
    assert.ok(html.includes('canonical="' + canonical + '"'),
      metro.slug + ' canonical missing from frontmatter');
    assert.ok(html.includes('title="' + metro.name + ', ' + metro.state),
      metro.slug + ' title missing metro name from frontmatter');
    assert.ok(html.includes('Best Smoke Days in ' + metro.name + ', ' + metro.state),
      metro.slug + ' h1 missing');
    assert.ok(html.includes('value="' + metro.zip + '"'),
      metro.slug + ' zip prefill missing');
  }
});

test('renderMetro embeds three JSON-LD blocks (WebApplication + FAQPage + BreadcrumbList)', () => {
  const html = gen.renderMetro(gen.METROS[0]);
  const ldBlocks = html.match(/<script type="application\/ld\+json">/g) || [];
  assert.equal(ldBlocks.length, 3);
  assert.ok(html.includes('"@type": "WebApplication"'));
  assert.ok(html.includes('"@type": "FAQPage"'));
  assert.ok(html.includes('"@type": "BreadcrumbList"'));
});

test('every metro emits a 3-level BreadcrumbList (Home → Best Smoke Days → metro)', () => {
  for (const metro of gen.METROS) {
    const html = gen.renderMetro(metro);
    // Parse every JSON-LD block separately (a `[\s\S]*?` across multiple
    // <script> tags concatenates blocks and breaks JSON.parse) and find
    // the BreadcrumbList. The page has three blocks today; this stays
    // correct if the order ever changes.
    const blocks = [];
    const re = /<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g;
    let m;
    while ((m = re.exec(html)) !== null) blocks.push(m[1]);
    let parsed = null;
    for (const raw of blocks) {
      const candidate = JSON.parse(raw);
      if (candidate && candidate['@type'] === 'BreadcrumbList') {
        parsed = candidate;
        break;
      }
    }
    assert.ok(parsed, metro.slug + ' BreadcrumbList JSON-LD block missing');
    assert.equal(parsed['@type'], 'BreadcrumbList');
    assert.equal(parsed.itemListElement.length, 3);
    assert.equal(parsed.itemListElement[0].name, 'Home');
    assert.equal(parsed.itemListElement[0].item, 'https://pitmaster.tools/');
    assert.equal(parsed.itemListElement[1].name, 'Best Smoke Days');
    assert.equal(parsed.itemListElement[1].item, 'https://pitmaster.tools/smoke-weather/');
    assert.equal(parsed.itemListElement[2].name, metro.name + ', ' + metro.state);
    assert.equal(
      parsed.itemListElement[2].item,
      'https://pitmaster.tools/smoke-weather/' + metro.slug
    );
    // Schema.org positions are 1-based.
    assert.equal(parsed.itemListElement[0].position, 1);
    assert.equal(parsed.itemListElement[1].position, 2);
    assert.equal(parsed.itemListElement[2].position, 3);
  }
});

test('every metro renders a visible breadcrumb that leads <main> and mirrors the trail', () => {
  for (const metro of gen.METROS) {
    const html = gen.renderMetro(metro);
    // Must be the FIRST element inside <main id="main-content">, matching the
    // tool-page convention enforced by tests/trust-polish.spec.js. The regex
    // allows whitespace/newlines between the opening <main> tag and the nav.
    const leads = new RegExp(
      '<main id="main-content">\\s*<nav class="breadcrumb" aria-label="Breadcrumb">'
    );
    assert.ok(leads.test(html), metro.slug + ' breadcrumb is not the first child of <main>');
    // Trail mirrors the BreadcrumbList: Home → Best Smoke Days → this metro.
    assert.ok(html.includes('<li><a href="/">Home</a></li>'),
      metro.slug + ' breadcrumb missing Home link');
    assert.ok(html.includes('<li><a href="/smoke-weather/">Best Smoke Days</a></li>'),
      metro.slug + ' breadcrumb missing Best Smoke Days link');
    const leaf = '<li><span aria-current="page">' +
      gen.escapeHtml(metro.name + ', ' + metro.state) + '</span></li>';
    assert.ok(html.includes(leaf), metro.slug + ' breadcrumb missing current-page leaf');
  }
});

test('renderMetro references all build-time INJECT directives', () => {
  const html = gen.renderMetro(gen.METROS[0]);
  // Head partials (meta/og/favicons/consent now come from shared HTML partials).
  assert.ok(html.includes('<!-- INJECT:head-meta.html -->'));
  assert.ok(html.includes('<!-- INJECT:head-og.html -->'));
  assert.ok(html.includes('<!-- INJECT:head-favicons.html -->'));
  assert.ok(html.includes('<!-- INJECT:consent-init.html -->'));
  // CSS.
  assert.ok(html.includes('<!-- INJECT:site-header.css -->'));
  assert.ok(html.includes('<!-- INJECT:site-base.css -->'));
  assert.ok(html.includes('<!-- INJECT:smoke-weather.css -->'));
  // Header + footer partials (site-utils.js + site-header.js + consent bootstrap
  // are nested inside site-footer-smoke.html).
  assert.ok(html.includes('<!-- INJECT:site-header-smoke.html -->'));
  assert.ok(html.includes('<!-- INJECT:site-footer-smoke.html -->'));
  // Per-page smoke-weather scripts (still inline alongside the footer partial).
  assert.ok(html.includes('<!-- INJECT:smoke-weather-app.js:script -->'));
  assert.ok(html.includes('<!-- INJECT:weather-score-shared.js:script -->'));
  // Weekly-forecast email capture (Milestone 2): markup, styles, behavior.
  assert.ok(html.includes('<!-- INJECT:subscribe-form.html -->'));
  assert.ok(html.includes('<!-- INJECT:subscribe-form.css -->'));
  assert.ok(html.includes('<!-- INJECT:subscribe-form.js:script -->'));
});

test('renderMetro feeds parseFrontmatter + injectPartials into a valid final <head>', () => {
  // Integration check: the old per-page tests asserted that the FINAL HTML
  // (after head expansion) carried <link rel="canonical">, <title>, OG meta,
  // etc. Now that those tags live in shared partials, generator-only tests
  // would miss a regression in head-meta.html, head-og.html, or
  // parseFrontmatter itself. This wires the whole pipeline against one metro
  // and asserts the post-build head is correct.
  const build = require('../build.js');
  const partials = {};
  for (const file of fs.readdirSync('_partials')) {
    partials[file] = fs.readFileSync(path.join('_partials', file), 'utf8').trimEnd();
  }
  const metro = gen.METROS[0];
  const src = gen.renderMetro(metro);
  const fm = build.parseFrontmatter(src);
  const out = build.injectPartials(fm.body, fm.vars, partials, metro.slug);

  const canonical = 'https://pitmaster.tools/smoke-weather/' + metro.slug;
  assert.ok(out.includes('<link rel="canonical" href="' + canonical + '">'),
    'final canonical link missing from expanded head');
  assert.ok(out.includes('<title>' + metro.name + ', ' + metro.state),
    'final <title> missing from expanded head');
  assert.ok(out.includes('<meta property="og:url" content="' + canonical + '">'),
    'final og:url missing from expanded head');
  assert.ok(out.includes('<meta property="og:title" content="' + metro.name + ', ' + metro.state),
    'final og:title missing from expanded head');
  // Header and footer partials expanded into real markup.
  assert.ok(out.includes('aria-label="Site navigation"'),
    'expanded site-header markup missing');
  assert.ok(out.includes('id="cookieBanner"'),
    'expanded cookie banner / footer markup missing');
  // No unresolved {{TOKENS}} survived substitution.
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(out),
    'unresolved {{TOKEN}} survived into expanded HTML');
});

test('renderMetro emits scripts in the expected load order', () => {
  // site-footer-smoke.html injects site-utils.js + the initEmbedMode/
  // initConsentBanner bootstrap + site-header.js, in that order. The per-page
  // smoke-weather scripts (weather-score-shared.js → smoke-weather-app.js)
  // are inlined after the footer. weather-score-shared.js exposes
  // WeatherScore before smoke-weather-app.js's DOMContentLoaded init runs, so
  // their order matters; lock that down with a positional assertion.
  const html = gen.renderMetro(gen.METROS[0]);
  const footerIdx  = html.indexOf('<!-- INJECT:site-footer-smoke.html -->');
  const sharedIdx  = html.indexOf('<!-- INJECT:weather-score-shared.js:script -->');
  const appIdx     = html.indexOf('<!-- INJECT:smoke-weather-app.js:script -->');
  assert.ok(footerIdx > 0, 'site-footer-smoke.html INJECT missing');
  assert.ok(footerIdx < sharedIdx,
    'weather-score-shared.js must follow site-footer-smoke.html (which loads site-utils.js)');
  assert.ok(sharedIdx < appIdx,
    'smoke-weather-app.js must follow weather-score-shared.js');
});

test('LAST_MODIFIED ISO date in the generator matches site-footer-smoke.html display string', () => {
  // The metro JSON-LD dateModified uses LAST_MODIFIED in ISO form (e.g.
  // "2026-05-15"). site-footer-smoke.html hardcodes the same date as a
  // display string (e.g. "May 15, 2026"). Bumping one without the other lets
  // the date displayed on the page drift away from the date reported to
  // search engines. This test catches that drift before merge.
  const footer = fs.readFileSync(path.join('_partials', 'site-footer-smoke.html'), 'utf8');
  const [y, m, d] = gen.LAST_MODIFIED.split('-').map(Number);
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const expected = months[m - 1] + ' ' + d + ', ' + y;
  assert.ok(footer.includes('Last updated: ' + expected),
    'site-footer-smoke.html should display "Last updated: ' + expected
      + '" to match generator LAST_MODIFIED=' + gen.LAST_MODIFIED);
});

test('every metro renders a body with at least 300 plain-text words (F16)', () => {
  for (const metro of gen.METROS) {
    const html = gen.renderMetro(metro);
    const count = plainTextWordCount(html);
    assert.ok(count >= 300, metro.slug + ' has only ' + count + ' words (needs ≥300)');
  }
});

test('run() writes one file per metro and sweeps stale generated files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metros-test-'));
  try {
    // Seed a hand-authored page that must survive the sweep, plus a stale
    // generated file from a "removed" metro that must be deleted.
    fs.writeFileSync(path.join(tmp, 'index.html'), '<!-- hand authored -->\n');
    fs.writeFileSync(path.join(tmp, 'stale-old-metro.html'),
      gen.GENERATED_MARKER + '\n<html>old</html>\n');

    const subset = gen.METROS.slice(0, 3);
    const result = gen.run({ outDir: tmp, metros: subset });

    assert.equal(result.written, 3);
    assert.equal(result.swept, 1, 'stale file should have been swept');
    assert.equal(fs.existsSync(path.join(tmp, 'stale-old-metro.html')), false);
    assert.equal(fs.existsSync(path.join(tmp, 'index.html')), true,
      'hand-authored page must survive');
    for (const metro of subset) {
      assert.equal(fs.existsSync(path.join(tmp, metro.slug + '.html')), true,
        metro.slug + ' file missing');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('run() with empty metros only sweeps, never writes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metros-test-'));
  try {
    fs.writeFileSync(path.join(tmp, 'stale.html'),
      gen.GENERATED_MARKER + '\n<html>stale</html>\n');
    const result = gen.run({ outDir: tmp, metros: [] });
    assert.equal(result.written, 0);
    assert.equal(result.swept, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('regionOf throws for unknown states', () => {
  assert.throws(() => gen.regionOf('ZZ'), /no region mapping/);
});

test('sitemap.xml lists every metro page exactly once', () => {
  const sitemap = fs.readFileSync('sitemap.xml', 'utf8');
  for (const m of gen.METROS) {
    const url = 'https://pitmaster.tools/smoke-weather/' + m.slug;
    const occurrences = sitemap.split(url).length - 1;
    assert.equal(occurrences, 1,
      'sitemap.xml should contain ' + url + ' exactly once (saw ' + occurrences + ')');
  }
});

// ── Metro local guide (Milestone 6, batched rollout) ────────────────────────

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
// 5-word shingles, used to detect near-duplicate prose between metros.
function shingles(text) {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const set = new Set();
  for (let i = 0; i + 5 <= words.length; i++) set.add(words.slice(i, i + 5).join(' '));
  return set;
}
// Overlap coefficient (shared / smaller set), NOT Jaccard — deliberately
// stricter for unequal-length entries, since it flags when one entry's prose
// is largely a subset of another's even if the other is much longer.
function shingleOverlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const s of a) if (b.has(s)) shared++;
  return shared / Math.min(a.size, b.size);
}

test('every METRO_LOCAL key is a real metro slug', () => {
  const slugs = new Set(gen.METROS.map((m) => m.slug));
  for (const slug of Object.keys(gen.METRO_LOCAL)) {
    assert.ok(slugs.has(slug), 'METRO_LOCAL has unknown slug: ' + slug);
  }
});

test('every METRO_LOCAL entry is a paragraph array of at least 150 words', () => {
  for (const [slug, paras] of Object.entries(gen.METRO_LOCAL)) {
    assert.ok(Array.isArray(paras) && paras.length >= 1, slug + ' must be a non-empty array');
    assert.ok(paras.every((p) => typeof p === 'string' && p.trim().length > 0),
      slug + ' paragraphs must be non-empty strings');
    const count = wordCount(paras.join(' '));
    // Spec: a 150-200 word section. 205 is a small counting-quirk margin over
    // the 200 target, not license to write long.
    assert.ok(count >= 150, slug + ' local guide has only ' + count + ' words (needs ≥150)');
    assert.ok(count <= 205, slug + ' local guide has ' + count + ' words (target 150-200)');
  }
});

test('METRO_LOCAL entries are not near-duplicates of one another', () => {
  const entries = Object.entries(gen.METRO_LOCAL).map(([slug, paras]) => ({
    slug, sh: shingles(paras.join(' ')),
  }));
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const ov = shingleOverlap(entries[i].sh, entries[j].sh);
      assert.ok(ov < 0.2,
        'near-duplicate local content: ' + entries[i].slug + ' vs ' + entries[j].slug +
        ' (5-gram overlap ' + ov.toFixed(2) + ')');
    }
  }
});

test('renderMetro emits the local-guide section for a metro that has an entry', () => {
  const metro = gen.METROS.find((m) => gen.METRO_LOCAL[m.slug]);
  assert.ok(metro, 'expected at least one metro with a METRO_LOCAL entry');
  const html = gen.renderMetro(metro);
  assert.ok(html.includes('class="editorial-section local-guide"'),
    'local-guide section missing for ' + metro.slug);
  assert.ok(html.includes('Planning a weekend smoke in ' + metro.name),
    'local-guide heading missing for ' + metro.slug);
  // Every paragraph’s text must appear in the rendered HTML.
  for (const p of gen.METRO_LOCAL[metro.slug]) {
    assert.ok(html.includes(gen.escapeHtml(p)), metro.slug + ' missing a local paragraph');
  }
});

test('renderMetro omits the local-guide section for a metro without an entry', () => {
  const metro = gen.METROS.find((m) => !gen.METRO_LOCAL[m.slug]);
  // Once the rollout completes and every metro has an entry, there is nothing
  // to assert here — skip gracefully rather than fail on the final batch.
  if (!metro) return;
  const html = gen.renderMetro(metro);
  assert.ok(!html.includes('local-guide'),
    metro.slug + ' should not render a local-guide section yet');
});

test('every metro has a METRO_LOCAL entry (rollout complete)', () => {
  // The batched rollout is finished: all 50 metros carry a local guide, and
  // any metro added later must ship with one too.
  const missing = gen.METROS.filter((m) => !gen.METRO_LOCAL[m.slug]).map((m) => m.slug);
  assert.deepEqual(missing, [], 'metros missing a local guide: ' + missing.join(', '));
});
