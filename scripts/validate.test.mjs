import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stripJsonc,
  validateXmlBalance,
  findUnresolvedInjects,
  findUnresolvedTokens,
  consentBeforeAnalytics,
  checkHeadBlock
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
