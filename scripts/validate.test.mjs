import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  stripJsonc,
  validateXmlBalance,
  findUnresolvedInjects,
  findUnresolvedTokens,
  consentBeforeAnalytics,
  checkHeadBlock,
  resolveLocalLink,
  findBrokenLocalLinks,
  discoverHtmlFiles,
  findUnwrappedTables,
  TABLE_SCROLL_WRAPPERS
} from './validate.mjs';

// ── stripJsonc ──────────────────────────────────────────────────────────────
test('stripJsonc — preserves strings, drops // and /* */ comments, trims trailing commas', () => {
  const src = `{
    "name": "x", // inline
    /* block */
    "list": [1, 2,],
  }`;
  assert.equal(JSON.parse(stripJsonc(src)).name, 'x');
  assert.deepEqual(JSON.parse(stripJsonc(src)).list, [1, 2]);
});

test('stripJsonc — does not strip comment-like substrings inside string values', () => {
  const src = '{"url": "http://x.test//path"}';
  assert.equal(JSON.parse(stripJsonc(src)).url, 'http://x.test//path');
});

// ── validateXmlBalance ──────────────────────────────────────────────────────
test('validateXmlBalance — well-formed sitemap returns null', () => {
  const xml = `<?xml version="1.0"?>
<urlset xmlns="x">
  <url><loc>a</loc></url>
  <url><loc>b</loc></url>
</urlset>`;
  assert.equal(validateXmlBalance(xml), null);
});

test('validateXmlBalance — flags unmatched close tag', () => {
  const xml = '<a><b></c></a>';
  assert.match(validateXmlBalance(xml), /mismatched close tag <\/c>/);
});

test('validateXmlBalance — flags unclosed tag', () => {
  const xml = '<a><b></a>';
  assert.match(validateXmlBalance(xml), /mismatched close tag <\/a>/);
});

test('validateXmlBalance — self-closing tags balance', () => {
  assert.equal(validateXmlBalance('<root><img/><br/></root>'), null);
});

test('validateXmlBalance — comments and prolog are skipped', () => {
  const xml = `<?xml version="1.0"?>
<!-- a comment -->
<root/>`;
  assert.equal(validateXmlBalance(xml), null);
});

test('validateXmlBalance — literal > inside double-quoted attribute is not a tag terminator', () => {
  // Without the quote-aware parser, this would terminate at the > inside
  // the title attribute and produce a spurious mismatch.
  const xml = `<root><item title="A > B"/></root>`;
  assert.equal(validateXmlBalance(xml), null);
});

test('validateXmlBalance — literal > inside single-quoted attribute is not a tag terminator', () => {
  const xml = `<root><item title='A > B'/></root>`;
  assert.equal(validateXmlBalance(xml), null);
});

test('validateXmlBalance — handles CDATA blocks containing < and >', () => {
  const xml = `<root><![CDATA[ if (a < b && b > c) {} ]]></root>`;
  assert.equal(validateXmlBalance(xml), null);
});

// ── findUnresolvedInjects / findUnresolvedTokens ────────────────────────────
test('findUnresolvedInjects — true when placeholder present', () => {
  assert.equal(findUnresolvedInjects('<p><!-- INJECT:x.html --></p>'), true);
  assert.equal(findUnresolvedInjects('<p>clean</p>'), false);
});

test('findUnresolvedTokens — returns the set of leftover tokens', () => {
  assert.deepEqual(findUnresolvedTokens('Hi {{TITLE}} and {{X_Y}}'), ['{{TITLE}}', '{{X_Y}}']);
  assert.deepEqual(findUnresolvedTokens('all good'), []);
});

// ── consentBeforeAnalytics ──────────────────────────────────────────────────
test('consentBeforeAnalytics — passes when consent precedes loaders', () => {
  const html = `gtag('consent', 'default', {})
  ... later ... googletagmanager.com/gtag.js`;
  assert.equal(consentBeforeAnalytics(html), null);
});

test('consentBeforeAnalytics — fails when analytics loads before consent', () => {
  const html = `googletagmanager.com/gtag.js ... gtag('consent', 'default', {})`;
  assert.match(consentBeforeAnalytics(html), /consent default must precede/);
});

test('consentBeforeAnalytics — passes when no analytics loader present', () => {
  const html = `gtag('consent', 'default', {})`;
  assert.equal(consentBeforeAnalytics(html), null);
});

// ── checkHeadBlock ──────────────────────────────────────────────────────────
const fullHead = `<head>
<meta charset="UTF-8">
<meta name="viewport" content="x">
<title>T</title>
<meta name="description" content="d">
<meta name="robots" content="index, follow">
<link rel="canonical" href="u">
<meta property="og:title" content="t">
<meta property="og:description" content="d">
<meta property="og:type" content="website">
<meta property="og:url" content="u">
<meta property="og:image" content="i">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="t">
<meta name="twitter:description" content="d">
<meta name="twitter:image" content="i">
<link rel="icon" href="favicon.ico" sizes="any">
</head>`;

test('checkHeadBlock — accepts a complete, ordered head block', () => {
  assert.deepEqual(checkHeadBlock(fullHead), []);
});

test('checkHeadBlock — flags missing universal tag', () => {
  const broken = fullHead.replace('<meta charset="UTF-8">\n', '');
  const errs = checkHeadBlock(broken);
  assert.ok(errs.some((e) => e.includes('charset')), errs.join('|'));
});

test('checkHeadBlock — flags missing social tag on non-minimal page', () => {
  const broken = fullHead.replace(/<meta property="og:image"[^>]*>\n?/, '');
  const errs = checkHeadBlock(broken, { isMinimalPage: false });
  assert.ok(errs.some((e) => e.includes('og:image')), errs.join('|'));
});

test('checkHeadBlock — minimal page exempt from social-tag requirement', () => {
  const minimalHead = `<head>
<meta charset="UTF-8">
<meta name="viewport" content="x">
<title>404</title>
<meta name="description" content="d">
<link rel="canonical" href="u">
</head>`;
  assert.deepEqual(checkHeadBlock(minimalHead, { isMinimalPage: true }), []);
});

test('checkHeadBlock — flags out-of-order tags', () => {
  const broken = `<head>
<title>T</title>
<meta charset="UTF-8">
<meta name="viewport" content="x">
<meta name="description" content="d">
<link rel="canonical" href="u">
<meta property="og:title" content="t">
<meta property="og:description" content="d">
<meta property="og:type" content="website">
<meta property="og:url" content="u">
<meta property="og:image" content="i">
<meta name="twitter:card" content="x">
<meta name="twitter:title" content="t">
<meta name="twitter:description" content="d">
<meta name="twitter:image" content="i">
</head>`;
  const errs = checkHeadBlock(broken);
  assert.ok(errs.some((e) => /out of order/.test(e)), errs.join('|'));
});

test('checkHeadBlock — flags missing <head> entirely', () => {
  const errs = checkHeadBlock('<html><body>nope</body></html>');
  assert.deepEqual(errs, ['no <head> block found']);
});

test('checkHeadBlock — double-quoted consent satisfies the head-order check', () => {
  // Tag patterns must use the same quote-agnostic matcher as the consent
  // ordering gate. Otherwise a future page using double-quoted gtag() would
  // bypass the head-order presence check.
  const headWithDoubleQuoteConsent = fullHead.replace(
    /<\/head>/,
    `<script>gtag("consent", "default", {});</script></head>`
  );
  // Drop the single-quoted consent so only the double-quoted variant remains.
  // (fullHead doesn't include consent today; check that adding a double-quoted
  // one is recognized, i.e. no "out of order" error fires.)
  assert.deepEqual(checkHeadBlock(headWithDoubleQuoteConsent), []);
});

// ── consentBeforeAnalytics quote variants ───────────────────────────────────
test('consentBeforeAnalytics — matches double-quoted gtag call', () => {
  const html = `gtag("consent", "default", {})`;
  // No analytics loader → null (consent present, but nothing to order against).
  assert.equal(consentBeforeAnalytics(html), null);
});

test('consentBeforeAnalytics — fails when double-quoted analytics precedes consent', () => {
  const html = `googletagmanager.com/gtag.js ... gtag("consent", "default", {})`;
  assert.match(consentBeforeAnalytics(html), /consent default must precede/);
});

// ── findUnwrappedTables ─────────────────────────────────────────────────────
test('findUnwrappedTables — bare table is flagged', () => {
  assert.deepEqual(
    findUnwrappedTables('<section><table class="times-table"><tr><td>x</td></tr></table></section>'),
    ['times-table']
  );
});

test('findUnwrappedTables — table inside a div.table-scroll passes', () => {
  assert.deepEqual(
    findUnwrappedTables('<div class="table-scroll"><table class="times-table"></table></div>'),
    []
  );
});

test('findUnwrappedTables — every approved wrapper class satisfies the gate', () => {
  for (const cls of TABLE_SCROLL_WRAPPERS) {
    // section wrapper here proves the gate is not div-only.
    assert.deepEqual(
      findUnwrappedTables(`<section class="${cls}"><table class="ref-table"></table></section>`),
      [],
      cls
    );
  }
});

test('findUnwrappedTables — approved class among several tokens still passes', () => {
  assert.deepEqual(
    findUnwrappedTables('<div class="card table-scroll no-print"><table></table></div>'),
    []
  );
});

test('findUnwrappedTables — non-approved wrapper does not satisfy the gate', () => {
  assert.deepEqual(
    findUnwrappedTables('<div class="card"><table class="breakdown-table"></table></div>'),
    ['breakdown-table']
  );
});

test('findUnwrappedTables — class matching is token-exact (no substring pass)', () => {
  // "ref-table-wrapper" contains "ref-table-wrap" as a substring but is not
  // the same class token, so the table must still be flagged.
  assert.deepEqual(
    findUnwrappedTables('<div class="ref-table-wrapper"><table class="ref-table"></table></div>'),
    ['ref-table']
  );
});

test('findUnwrappedTables — table markup inside <script> is ignored', () => {
  const html = `<script>const t = '<table class="fake"></table>';</script>
    <div class="table-scroll"><table class="real"></table></div>`;
  assert.deepEqual(findUnwrappedTables(html), []);
});

test('findUnwrappedTables — unbalanced div inside a comment does not corrupt the stack', () => {
  const html = `<!-- <div class="table-scroll"> --><table class="lonely"></table>`;
  assert.deepEqual(findUnwrappedTables(html), ['lonely']);
});

test('findUnwrappedTables — a table with no class attribute reports (no class)', () => {
  assert.deepEqual(findUnwrappedTables('<main><table></table></main>'), ['(no class)']);
});

test('findUnwrappedTables — data-class is not read as class (no false wrap)', () => {
  assert.deepEqual(
    findUnwrappedTables('<div data-class="table-scroll"><table class="x"></table></div>'),
    ['x']
  );
});

test('findUnwrappedTables — mismatched nesting does not fake a wrapper', () => {
  // </div> closes the table-scroll div (popping the stray inner <section>), so
  // the following <table> is outside the wrapper and must be flagged.
  assert.deepEqual(
    findUnwrappedTables('<div class="table-scroll"><section></div><table class="y"></table>'),
    ['y']
  );
});

test('findUnwrappedTables — a <details> wrapper satisfies the gate', () => {
  assert.deepEqual(
    findUnwrappedTables('<details class="table-scroll"><table class="z"></table></details>'),
    []
  );
});

test('findUnwrappedTables — unclosed inline element inside a wrapper still passes', () => {
  assert.deepEqual(
    findUnwrappedTables('<div class="table-scroll"><p><table class="q"></table></div>'),
    []
  );
});

test('findUnwrappedTables — a stray closing container tag is ignored', () => {
  assert.deepEqual(
    findUnwrappedTables('</div><div class="table-scroll"><table class="r"></table></div>'),
    []
  );
});

// ── resolveLocalLink ────────────────────────────────────────────────────────
function withTempDist(layout) {
  const dir = mkdtempSync(join(tmpdir(), 'pmt-validate-'));
  for (const [rel, body] of Object.entries(layout)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('resolveLocalLink — skips external, mailto, data, and anchor targets', () => {
  const dummy = '/tmp/anywhere/page.html';
  for (const t of ['https://x.test/y', 'http://x', 'mailto:a@b', 'data:foo', '#frag']) {
    assert.deepEqual(resolveLocalLink(t, dummy, '/tmp/anywhere'), { skip: true });
  }
});

test('resolveLocalLink — skips empty / whitespace targets', () => {
  assert.deepEqual(resolveLocalLink('', '/d/p.html', '/d'), { skip: true });
  assert.deepEqual(resolveLocalLink('?q=1', '/d/p.html', '/d'), { skip: true });
  assert.deepEqual(resolveLocalLink('#frag-only', '/d/p.html', '/d'), { skip: true });
});

test('resolveLocalLink — "/" resolves to baseDir/index.html', () => {
  const t = withTempDist({ 'index.html': '<p>i</p>' });
  try {
    const r = resolveLocalLink('/', join(t.dir, 'index.html'), t.dir);
    assert.equal(r.exists, true);
    assert.equal(r.resolved, join(t.dir, 'index.html'));
  } finally { t.cleanup(); }
});

test('resolveLocalLink — root-relative resolves against baseDir', () => {
  const t = withTempDist({ 'tools.html': 'x' });
  try {
    const r = resolveLocalLink('/tools', join(t.dir, 'about.html'), t.dir);
    assert.equal(r.exists, true);
    assert.ok(r.resolved.endsWith('tools.html'));
  } finally { t.cleanup(); }
});

test('resolveLocalLink — document-relative resolves against fullPath dirname', () => {
  const t = withTempDist({
    'a/page.html': 'x',
    'a/sibling.html': 'y'
  });
  try {
    const r = resolveLocalLink('sibling', join(t.dir, 'a', 'page.html'), t.dir);
    assert.equal(r.exists, true);
  } finally { t.cleanup(); }
});

test('resolveLocalLink — extensionless target falls back to .html', () => {
  const t = withTempDist({ 'meat-per-person.html': 'x' });
  try {
    const r = resolveLocalLink('/meat-per-person', join(t.dir, 'i.html'), t.dir);
    assert.equal(r.exists, true);
  } finally { t.cleanup(); }
});

test('resolveLocalLink — anchor and query strings are stripped before resolution', () => {
  const t = withTempDist({ 'tools.html': 'x' });
  try {
    assert.equal(resolveLocalLink('/tools?utm=1', join(t.dir, 'i.html'), t.dir).exists, true);
    assert.equal(resolveLocalLink('/tools#a', join(t.dir, 'i.html'), t.dir).exists, true);
  } finally { t.cleanup(); }
});

test('resolveLocalLink — missing target returns exists=false', () => {
  const t = withTempDist({ 'real.html': 'x' });
  try {
    assert.equal(resolveLocalLink('/missing', join(t.dir, 'i.html'), t.dir).exists, false);
  } finally { t.cleanup(); }
});

// ── findBrokenLocalLinks ────────────────────────────────────────────────────
test('findBrokenLocalLinks — flags only the broken href; skips external + valid', () => {
  const t = withTempDist({ 'tools.html': 'x', 'i.html': 'x' });
  try {
    const content =
      '<a href="https://x.test">ext</a>' +
      '<a href="/tools">ok</a>' +
      '<a href="/missing">bad</a>' +
      '<a href="mailto:a@b">mail</a>';
    const broken = findBrokenLocalLinks(content, join(t.dir, 'i.html'), t.dir);
    assert.deepEqual(broken, ['/missing']);
  } finally { t.cleanup(); }
});

test('findBrokenLocalLinks — also matches single-quoted href and src attributes', () => {
  const t = withTempDist({ 'tools.html': 'x', 'i.html': 'x' });
  try {
    const content =
      "<a href='/tools'>ok</a>" +
      "<img src='/missing.png'>" +
      "<script src='/also-missing.js'></script>";
    const broken = findBrokenLocalLinks(content, join(t.dir, 'i.html'), t.dir);
    assert.deepEqual(broken, ['/missing.png', '/also-missing.js']);
  } finally { t.cleanup(); }
});

// ── discoverHtmlFiles ───────────────────────────────────────────────────────
test('discoverHtmlFiles — recurses subdirs, sorts, forward-slashes paths', () => {
  const t = withTempDist({
    'about.html': 'x',
    'tools.html': 'x',
    'smoke-weather/disclosures.html': 'x',
    'smoke-weather/index.html': 'x',
    'seasonal/winter.html': 'x',
    'not-html.txt': 'x'
  });
  try {
    const files = discoverHtmlFiles(t.dir);
    assert.deepEqual(files, [
      'about.html',
      'seasonal/winter.html',
      'smoke-weather/disclosures.html',
      'smoke-weather/index.html',
      'tools.html'
    ]);
  } finally { t.cleanup(); }
});

test('discoverHtmlFiles — returns empty array when baseDir missing', () => {
  assert.deepEqual(discoverHtmlFiles('/nonexistent-path-xyzzy-123'), []);
});
