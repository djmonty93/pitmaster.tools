#!/usr/bin/env node
/**
 * validate.mjs — cross-platform port of validate.ps1.
 *
 * Runs the same gates as validate.ps1 (XML, JSONC, local-link resolution,
 * unresolved INJECT placeholders, unresolved {{tokens}}, consent-before-
 * analytics ordering, head-block tag ordering) on the built dist/ directory.
 *
 * Assumes `npm run build` has already produced dist/. The Linux CI job calls
 * `npm run build && node scripts/validate.mjs`.
 *
 * No npm dependencies required.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(__filename));
const distRoot = join(repoRoot, 'dist');
const errors = [];
const addError = (msg) => errors.push(msg);

// ── JSONC normalizer ────────────────────────────────────────────────────────
function stripJsonc(text) {
  const stringOrComment = /"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g;
  const stripped = text.replace(stringOrComment, (m) => (m.startsWith('"') ? m : ''));
  return stripped.replace(/,(\s*[}\]])/g, '$1');
}

// ── Gates ────────────────────────────────────────────────────────────────────
function checkXml(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    if (!raw.trim().startsWith('<?xml')) {
      addError(`Invalid XML (no <?xml prolog): ${path}`);
      return;
    }
    // Crude well-formed check: balanced tags via DOMParser is overkill in Node
    // without deps; rely on the XML prolog + sitemap-specific structure check.
    if (path.endsWith('sitemap.xml') && !raw.includes('</urlset>')) {
      addError(`sitemap.xml missing </urlset>: ${path}`);
      return;
    }
    console.log(`OK XML  ${path}`);
  } catch (e) {
    addError(`Read failed: ${path}: ${e.message}`);
  }
}

function checkJson(path) {
  try {
    let raw = readFileSync(path, 'utf8');
    if (path.endsWith('.jsonc')) raw = stripJsonc(raw);
    JSON.parse(raw);
    console.log(`OK JSON ${path}`);
  } catch (e) {
    addError(`Invalid JSON: ${path}: ${e.message}`);
  }
}

const HREF_SRC_RE = /<[^>\r\n]+\b(?:href|src)="([^"]+)"/g;

function checkLocalLinks(baseDir, paths) {
  for (const rel of paths) {
    const fullPath = join(baseDir, rel);
    const content = readFileSync(fullPath, 'utf8');
    let m;
    HREF_SRC_RE.lastIndex = 0;
    while ((m = HREF_SRC_RE.exec(content)) !== null) {
      const target = m[1];
      if (/^(https?:\/\/|mailto:|data:|#)/.test(target)) continue;
      const clean = target.split('#')[0].split('?')[0];
      if (!clean.trim()) continue;

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
      if (!existsSync(resolved)) {
        addError(`Missing local link target in ${rel}: ${target}`);
      }
    }
    console.log(`OK LINK ${rel}`);
  }
}

function checkNoInjectPlaceholders(baseDir, paths) {
  for (const rel of paths) {
    const content = readFileSync(join(baseDir, rel), 'utf8');
    if (/<!--\s*INJECT:/.test(content)) {
      addError(`Unresolved partial placeholder in ${rel}`);
    } else {
      console.log(`OK INJ  ${rel}`);
    }
  }
}

function checkUnresolvedTokens(baseDir, paths) {
  for (const rel of paths) {
    const content = readFileSync(join(baseDir, rel), 'utf8');
    const matches = content.match(/\{\{[A-Z_]+\}\}/g);
    if (matches) {
      for (const tok of matches) addError(`Unresolved ${tok} in ${rel}`);
    } else {
      console.log(`OK TOK  ${rel}`);
    }
  }
}

function checkConsentBeforeAnalytics(baseDir, paths) {
  for (const rel of paths) {
    const content = readFileSync(join(baseDir, rel), 'utf8');
    const consentIdx  = content.indexOf("gtag('consent', 'default'");
    const gtmIdx      = content.indexOf('googletagmanager.com');
    const adsIdx      = content.indexOf('pagead2.googlesyndication');
    const earliestAnalytics = [gtmIdx, adsIdx].filter((i) => i >= 0).sort((a, b) => a - b)[0];
    if (consentIdx >= 0 && earliestAnalytics != null && earliestAnalytics < consentIdx) {
      addError(`Consent default must precede analytics loader in ${rel}`);
    } else {
      console.log(`OK CON  ${rel}`);
    }
  }
}

const EXPECTED_HEAD_TAGS = [
  { name: 'charset',           pattern: /<meta\s+charset=/ },
  { name: 'viewport',          pattern: /<meta\s+name="viewport"/ },
  { name: 'title',             pattern: /<title>/ },
  { name: 'description',       pattern: /<meta\s+name="description"/ },
  { name: 'robots',            pattern: /<meta\s+name="robots"/ },
  { name: 'canonical',         pattern: /<link\s+rel="canonical"/ },
  { name: 'og:title',          pattern: /<meta\s+property="og:title"/ },
  { name: 'og:description',    pattern: /<meta\s+property="og:description"/ },
  { name: 'og:type',           pattern: /<meta\s+property="og:type"/ },
  { name: 'og:url',            pattern: /<meta\s+property="og:url"/ },
  { name: 'og:image',          pattern: /<meta\s+property="og:image"/ },
  { name: 'twitter:card',      pattern: /<meta\s+name="twitter:card"/ },
  { name: 'twitter:title',     pattern: /<meta\s+name="twitter:title"/ },
  { name: 'twitter:description', pattern: /<meta\s+name="twitter:description"/ },
  { name: 'twitter:image',     pattern: /<meta\s+name="twitter:image"/ },
  { name: 'favicon',           pattern: /<link\s+rel="icon"\s+href=/ },
  { name: 'consent',           pattern: /gtag\('consent', 'default'/ }
];

function checkHeadOrder(baseDir, paths) {
  for (const rel of paths) {
    const content = readFileSync(join(baseDir, rel), 'utf8');
    const headMatch = content.match(/<head>([\s\S]*?)<\/head>/);
    if (!headMatch) {
      addError(`No <head> block found in ${rel}`);
      continue;
    }
    const head = headMatch[1];
    let lastIdx = -1;
    let lastName = '(start)';
    let pageOk = true;
    for (const tag of EXPECTED_HEAD_TAGS) {
      const m = head.match(tag.pattern);
      if (!m) continue;
      const idx = head.indexOf(m[0]);
      if (idx < lastIdx) {
        addError(`Head tag out of order in ${rel}: '${tag.name}' appears before '${lastName}'`);
        pageOk = false;
        break;
      }
      lastIdx = idx;
      lastName = tag.name;
    }
    if (pageOk) console.log(`OK HEAD ${rel}`);
  }
}

// ── Inputs ──────────────────────────────────────────────────────────────────
const htmlFiles = [
  '404.html', 'about.html', 'bbq-cost-calculator.html', 'brisket-calculator.html',
  'brisket-yield-calculator.html', 'brine-calculator.html', 'catering-calculator.html',
  'cook-time-coordinator.html', 'pork-shoulder-calculator.html', 'index.html',
  'charcoal-calculator.html', 'dry-rub-calculator.html', 'meat-per-person.html',
  'privacy-policy.html', 'rib-calculator.html', 'tools.html',
  'turkey-smoking-calculator.html', 'terms-of-service.html'
];

function discoverSubdir(baseDir, name) {
  const dir = join(baseDir, name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .sort()
    .map((f) => `${name}/${f}`);
}

// ── Run ─────────────────────────────────────────────────────────────────────
if (!existsSync(distRoot)) {
  console.error('dist/ does not exist — run `npm run build` first.');
  process.exit(1);
}

if (!existsSync(join(distRoot, 'favicon.ico'))) addError('Missing favicon.ico in dist/.');
else console.log('OK FILE dist/favicon.ico');
if (!existsSync(join(distRoot, 'og-image.png'))) addError('Missing og-image.png in dist/.');
else console.log('OK FILE dist/og-image.png');

checkXml(join(distRoot, 'sitemap.xml'));
checkJson(join(repoRoot, 'wrangler.jsonc'));

const allHtmlFiles = [
  ...htmlFiles,
  ...discoverSubdir(distRoot, 'smoke-weather'),
  ...discoverSubdir(distRoot, 'seasonal')
];

checkLocalLinks(distRoot, allHtmlFiles);
checkNoInjectPlaceholders(distRoot, allHtmlFiles);
checkUnresolvedTokens(distRoot, allHtmlFiles);
checkConsentBeforeAnalytics(distRoot, allHtmlFiles);
checkHeadOrder(distRoot, allHtmlFiles);

if (errors.length > 0) {
  console.error('\nValidation failed:');
  for (const e of errors) console.error(`- ${e}`);
  process.exit(1);
}

console.log('\nAll validation checks passed.');
