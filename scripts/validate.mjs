#!/usr/bin/env node
/**
 * validate.mjs — cross-platform port of validate.ps1.
 *
 * Runs the same gates as validate.ps1 (XML, JSONC, local-link resolution,
 * unresolved INJECT placeholders, unresolved {{tokens}}, consent-before-
 * analytics ordering, head-block tag ordering + presence) on the built
 * dist/ directory.
 *
 * Assumes `npm run build` has already produced dist/. The Linux CI job calls
 * `npm run build && node scripts/validate.mjs`.
 *
 * Pure check functions are exported so scripts/validate.test.js can exercise
 * them without touching the filesystem. The bottom of this file wires them
 * up to dist/ when invoked directly as a script.
 *
 * No npm dependencies required.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── JSONC normalizer ────────────────────────────────────────────────────────
export function stripJsonc(text) {
  const stringOrComment = /"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g;
  const stripped = text.replace(stringOrComment, (m) => (m.startsWith('"') ? m : ''));
  return stripped.replace(/,(\s*[}\]])/g, '$1');
}

// ── XML balance parser ──────────────────────────────────────────────────────
// Stream-tokenizes XML and verifies that every open tag has a matching close.
// Handles <?prolog?>, <!--comments-->, <self-closing/>, and standard elements.
// Returns null on success, or a string describing the first structural error.
export function validateXmlBalance(text) {
  let i = 0;
  const stack = [];
  const len = text.length;
  while (i < len) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end < 0) return 'unterminated <?...?> prolog';
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) return 'unterminated <!-- comment';
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) return 'unterminated CDATA';
      i = end + 3;
      continue;
    }
    const gt = text.indexOf('>', lt);
    if (gt < 0) return `unterminated tag starting at offset ${lt}`;
    const tag = text.slice(lt + 1, gt);
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim().split(/\s+/)[0];
      const top = stack.pop();
      if (top !== name) {
        return `mismatched close tag </${name}> (expected </${top ?? '(none)'}>)`;
      }
    } else if (tag.endsWith('/')) {
      // self-closing, no stack change
    } else {
      const name = tag.trim().split(/\s+/)[0];
      stack.push(name);
    }
    i = gt + 1;
  }
  if (stack.length > 0) return `unclosed tag(s): ${stack.join(', ')}`;
  return null;
}

// ── Gates (filesystem-agnostic core; pass content in) ───────────────────────

export function findUnresolvedInjects(content) {
  return /<!--\s*INJECT:/.test(content);
}

export function findUnresolvedTokens(content) {
  return content.match(/\{\{[A-Z_]+\}\}/g) || [];
}

export function consentBeforeAnalytics(content) {
  const consentIdx = content.indexOf("gtag('consent', 'default'");
  const analyticsIdx = ['googletagmanager.com', 'pagead2.googlesyndication']
    .map((needle) => content.indexOf(needle))
    .filter((idx) => idx >= 0)
    .sort((a, b) => a - b)[0];
  if (consentIdx < 0 || analyticsIdx == null) return null;
  if (analyticsIdx < consentIdx) return 'consent default must precede analytics loader';
  return null;
}

// Tags that MUST be present in every <head> block (page is broken without them).
const UNIVERSAL_HEAD_TAGS = ['charset', 'viewport', 'title', 'description', 'canonical'];

// Tags required on every page that is indexable (robots != noindex). 404 and
// other minimal pages are exempt because they don't claim social-share metadata.
const SOCIAL_HEAD_TAGS = [
  'og:title', 'og:description', 'og:type', 'og:url', 'og:image',
  'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image'
];

const HEAD_TAG_PATTERNS = {
  'charset':              /<meta\s+charset=/,
  'viewport':             /<meta\s+name="viewport"/,
  'title':                /<title>/,
  'description':          /<meta\s+name="description"/,
  'robots':               /<meta\s+name="robots"/,
  'canonical':            /<link\s+rel="canonical"/,
  'og:title':             /<meta\s+property="og:title"/,
  'og:description':       /<meta\s+property="og:description"/,
  'og:type':              /<meta\s+property="og:type"/,
  'og:url':               /<meta\s+property="og:url"/,
  'og:image':             /<meta\s+property="og:image"/,
  'twitter:card':         /<meta\s+name="twitter:card"/,
  'twitter:title':        /<meta\s+name="twitter:title"/,
  'twitter:description':  /<meta\s+name="twitter:description"/,
  'twitter:image':        /<meta\s+name="twitter:image"/,
  'favicon':              /<link\s+rel="icon"\s+href=/,
  'consent':              /gtag\('consent', 'default'/
};

// Expected ordering (only enforced for tags that are present).
const HEAD_ORDER = [
  'charset', 'viewport', 'title', 'description', 'robots', 'canonical',
  'og:title', 'og:description', 'og:type', 'og:url', 'og:image',
  'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image',
  'favicon', 'consent'
];

// Returns array of error messages (empty = OK).
export function checkHeadBlock(content, { isMinimalPage = false } = {}) {
  const errors = [];
  const headMatch = content.match(/<head>([\s\S]*?)<\/head>/);
  if (!headMatch) return ['no <head> block found'];
  const head = headMatch[1];

  // Presence: universal tags required everywhere.
  for (const name of UNIVERSAL_HEAD_TAGS) {
    if (!HEAD_TAG_PATTERNS[name].test(head)) {
      errors.push(`missing required head tag: ${name}`);
    }
  }
  // Presence: social tags required unless this page is minimal (404, etc.).
  if (!isMinimalPage) {
    for (const name of SOCIAL_HEAD_TAGS) {
      if (!HEAD_TAG_PATTERNS[name].test(head)) {
        errors.push(`missing required head tag: ${name}`);
      }
    }
  }

  // Ordering: present tags must appear in the canonical order.
  let lastIdx = -1;
  let lastName = '(start)';
  for (const name of HEAD_ORDER) {
    const m = head.match(HEAD_TAG_PATTERNS[name]);
    if (!m) continue;
    const idx = m.index;
    if (idx < lastIdx) {
      errors.push(`head tag out of order: '${name}' appears before '${lastName}'`);
      break;
    }
    lastIdx = idx;
    lastName = name;
  }
  return errors;
}

// ── Link resolution (filesystem-aware) ──────────────────────────────────────

const HREF_SRC_RE = /<[^>\r\n]+\b(?:href|src)="([^"]+)"/g;

export function resolveLocalLink(target, fullPath, baseDir) {
  if (/^(https?:\/\/|mailto:|data:|#)/.test(target)) return { skip: true };
  const clean = target.split('#')[0].split('?')[0];
  if (!clean.trim()) return { skip: true };

  let resolved;
  if (clean === '/') {
    resolved = join(baseDir, 'index.html');
  } else if (clean.startsWith('/')) {
    resolved = join(baseDir, clean.slice(1));
  } else {
    resolved = join(dirname(fullPath), clean);
  }
  if (!existsSync(resolved) && !extname(resolved)) {
    const htmlPath = `${resolved}.html`;
    if (existsSync(htmlPath)) resolved = htmlPath;
  }
  return { resolved, exists: existsSync(resolved) };
}

export function findBrokenLocalLinks(content, fullPath, baseDir) {
  const broken = [];
  HREF_SRC_RE.lastIndex = 0;
  let m;
  while ((m = HREF_SRC_RE.exec(content)) !== null) {
    const r = resolveLocalLink(m[1], fullPath, baseDir);
    if (!r.skip && !r.exists) broken.push(m[1]);
  }
  return broken;
}

// ── Script entry point ──────────────────────────────────────────────────────

function isMinimal(rel) {
  // Pages that legitimately ship without OG/Twitter metadata.
  return rel === '404.html';
}

function discoverSubdir(baseDir, name) {
  const dir = join(baseDir, name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .sort()
    .map((f) => `${name}/${f}`);
}

function runScript() {
  const __filename = fileURLToPath(import.meta.url);
  const repoRoot = dirname(dirname(__filename));
  const distRoot = join(repoRoot, 'dist');
  const errors = [];
  const addError = (msg) => errors.push(msg);

  if (!existsSync(distRoot)) {
    console.error('dist/ does not exist — run `npm run build` first.');
    process.exit(1);
  }

  if (!existsSync(join(distRoot, 'favicon.ico'))) addError('Missing favicon.ico in dist/.');
  else console.log('OK FILE dist/favicon.ico');
  if (!existsSync(join(distRoot, 'og-image.png'))) addError('Missing og-image.png in dist/.');
  else console.log('OK FILE dist/og-image.png');

  // XML
  const sitemapPath = join(distRoot, 'sitemap.xml');
  try {
    const raw = readFileSync(sitemapPath, 'utf8');
    if (!raw.trim().startsWith('<?xml')) addError(`sitemap.xml missing <?xml prolog`);
    const xmlError = validateXmlBalance(raw);
    if (xmlError) addError(`Invalid XML in sitemap.xml: ${xmlError}`);
    else console.log(`OK XML  ${sitemapPath}`);
  } catch (e) {
    addError(`Read failed: ${sitemapPath}: ${e.message}`);
  }

  // JSONC
  try {
    const raw = readFileSync(join(repoRoot, 'wrangler.jsonc'), 'utf8');
    JSON.parse(stripJsonc(raw));
    console.log('OK JSON wrangler.jsonc');
  } catch (e) {
    addError(`Invalid JSON: wrangler.jsonc: ${e.message}`);
  }

  const htmlFiles = [
    '404.html', 'about.html', 'bbq-cost-calculator.html', 'brisket-calculator.html',
    'brisket-yield-calculator.html', 'brine-calculator.html', 'catering-calculator.html',
    'cook-time-coordinator.html', 'pork-shoulder-calculator.html', 'index.html',
    'charcoal-calculator.html', 'dry-rub-calculator.html', 'meat-per-person.html',
    'privacy-policy.html', 'rib-calculator.html', 'tools.html',
    'turkey-smoking-calculator.html', 'terms-of-service.html'
  ];
  const allHtmlFiles = [
    ...htmlFiles,
    ...discoverSubdir(distRoot, 'smoke-weather'),
    ...discoverSubdir(distRoot, 'seasonal')
  ];

  for (const rel of allHtmlFiles) {
    const fullPath = join(distRoot, rel);
    const content = readFileSync(fullPath, 'utf8');

    // Local links
    const broken = findBrokenLocalLinks(content, fullPath, distRoot);
    if (broken.length) {
      for (const b of broken) addError(`Missing local link target in ${rel}: ${b}`);
    } else {
      console.log(`OK LINK ${rel}`);
    }

    // Unresolved INJECT placeholders
    if (findUnresolvedInjects(content)) {
      addError(`Unresolved partial placeholder in ${rel}`);
    } else {
      console.log(`OK INJ  ${rel}`);
    }

    // Unresolved {{tokens}}
    const tokens = findUnresolvedTokens(content);
    if (tokens.length) {
      for (const t of tokens) addError(`Unresolved ${t} in ${rel}`);
    } else {
      console.log(`OK TOK  ${rel}`);
    }

    // Consent ordering
    const consentErr = consentBeforeAnalytics(content);
    if (consentErr) addError(`${consentErr} in ${rel}`);
    else console.log(`OK CON  ${rel}`);

    // Head block
    const headErrs = checkHeadBlock(content, { isMinimalPage: isMinimal(rel) });
    if (headErrs.length) {
      for (const e of headErrs) addError(`${rel}: ${e}`);
    } else {
      console.log(`OK HEAD ${rel}`);
    }
  }

  if (errors.length > 0) {
    console.error('\nValidation failed:');
    for (const e of errors) console.error(`- ${e}`);
    process.exit(1);
  }
  console.log('\nAll validation checks passed.');
}

if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  runScript();
}
