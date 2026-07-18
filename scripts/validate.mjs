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
import { join, dirname, extname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── JSONC normalizer ────────────────────────────────────────────────────────
export function stripJsonc(text) {
  const stringOrComment = /"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g;
  const stripped = text.replace(stringOrComment, (m) => (m.startsWith('"') ? m : ''));
  return stripped.replace(/,(\s*[}\]])/g, '$1');
}

// ── XML balance parser ──────────────────────────────────────────────────────
// Stream-tokenizes XML and verifies that every open tag has a matching close.
// Handles <?prolog?>, <!--comments-->, <![CDATA[...]]>, <self-closing/>, and
// standard elements. Skips over quoted attribute regions so a literal '>'
// inside an attribute value doesn't end the tag prematurely. Returns null
// on success or a string describing the first structural error.
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

    // Find the matching '>' that closes this tag, skipping past any '>'
    // that appears inside a "double-quoted" or 'single-quoted' attribute
    // value. Without this, <a title="A > B"> would terminate at the
    // attribute '>' and produce a spurious mismatch.
    let j = lt + 1;
    let inQuote = null;
    while (j < len) {
      const ch = text[j];
      if (inQuote) {
        if (ch === inQuote) inQuote = null;
      } else if (ch === '"' || ch === "'") {
        inQuote = ch;
      } else if (ch === '>') {
        break;
      }
      j++;
    }
    if (j >= len) return `unterminated tag starting at offset ${lt}`;
    const gt = j;
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

// Matches gtag('consent', 'default'...) and the double-quoted variant. The
// project standard is single quotes today, but the gate must not silently
// pass if a future page or partial uses double-quoted JS strings. Shared
// with HEAD_TAG_PATTERNS['consent'] below so head-order detection uses
// the exact same matcher.
const CONSENT_RE = /gtag\(\s*['"]consent['"]\s*,\s*['"]default['"]/;

export function consentBeforeAnalytics(content) {
  const consentMatch = CONSENT_RE.exec(content);
  const consentIdx = consentMatch ? consentMatch.index : -1;
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
  'consent':              CONSENT_RE
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

// Matches href/src attributes with single OR double quotes. The captured
// group is always the URL value; we use a backreference so quote characters
// must match (no mixing).
const HREF_SRC_RE = /<[^>\r\n]+\b(?:href|src)=(["'])([^"']+)\1/g;

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
    // m[1] is the quote character (captured for backref); m[2] is the URL.
    const target = m[2];
    const r = resolveLocalLink(target, fullPath, baseDir);
    if (!r.skip && !r.exists) broken.push(target);
  }
  return broken;
}

// ── Responsive-table wrapper gate ───────────────────────────────────────────

// Every data <table> must live inside one of these scroll-wrapper classes so
// it scrolls within its own container on narrow viewports instead of forcing
// the whole page into horizontal scroll (which reads to users as a clipped,
// half-visible table). Keep in sync with the selectors in site-base.css /
// smoke-weather.css that apply the overflow + edge-fade treatment.
export const TABLE_SCROLL_WRAPPERS = [
  'table-scroll', 'ref-table-wrap', 'rub-table-wrap',
  'editorial-table-wrap', 'normals-scroll'
];

// Container elements that can act as a table's scroll wrapper. Only these are
// tracked on the ancestor stack; every other tag (including void elements and
// unclosed inline elements like <p>/<li>) is ignored, so they can't corrupt it.
const CONTAINER_TAGS = new Set([
  'div', 'section', 'article', 'main', 'aside', 'figure', 'details'
]);

// Extracts the class token list from a start tag's attribute text, matching
// double-quoted, single-quoted, AND unquoted (class=foo) values. The leading
// (?:^|\s) boundary is load-bearing: it stops `data-class="table-scroll"` from
// being read as `class="table-scroll"` (a substring match there would wrongly
// treat the table as wrapped). Returns [] when there is no class attribute.
function classTokensOf(attrs) {
  const m = attrs.match(/(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
  const value = m && (m[1] ?? m[2] ?? m[3]);
  return value ? value.trim().split(/\s+/).filter(Boolean) : [];
}

// Returns the class string of every <table> NOT nested inside an approved
// scroll wrapper (empty array = OK). A stack of {name, tokens} tracks open
// container ancestors; a close tag pops to the nearest same-named open
// container (tolerating unclosed containers) and a stray close is ignored, so
// mismatched nesting can't fake a wrapper. Tags are scanned quote-aware (a '>'
// inside an attribute value doesn't terminate the tag early), and comments and
// <script>/<style> blocks are stripped first so markup inside JS template
// strings can neither corrupt the stack nor trip a false positive. Class
// matching is token-exact, so "ref-table-wrapper" doesn't satisfy the gate.
export function findUnwrappedTables(content) {
  const cleaned = content
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '');
  const stack = [];
  const unwrapped = [];
  const len = cleaned.length;
  let i = 0;
  while (i < len) {
    const lt = cleaned.indexOf('<', i);
    if (lt < 0) break;
    // Find the '>' that closes this tag, skipping any '>' inside a quoted
    // attribute value (same approach as validateXmlBalance above).
    let j = lt + 1;
    let inQuote = null;
    while (j < len) {
      const ch = cleaned[j];
      if (inQuote) { if (ch === inQuote) inQuote = null; }
      else if (ch === '"' || ch === "'") inQuote = ch;
      else if (ch === '>') break;
      j++;
    }
    if (j >= len) break;
    const raw = cleaned.slice(lt + 1, j);
    i = j + 1;
    if (!raw || raw[0] === '!' || raw[0] === '?') continue; // stray decl/prolog
    const isClose = raw[0] === '/';
    const nameMatch = (isClose ? raw.slice(1) : raw).match(/^\s*([a-zA-Z][\w-]*)/);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();
    const attrs = (isClose ? raw.slice(1) : raw).slice(nameMatch[0].length);

    if (name === 'table') {
      if (isClose) continue;
      const wrapped = stack.some((e) =>
        e.tokens.some((t) => TABLE_SCROLL_WRAPPERS.includes(t)));
      if (!wrapped) {
        const tokens = classTokensOf(attrs);
        unwrapped.push(tokens.length ? tokens.join(' ') : '(no class)');
      }
      continue;
    }
    if (!CONTAINER_TAGS.has(name)) continue;
    if (isClose) {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].name === name) { stack.length = k; break; }
      }
      continue;
    }
    // Container elements are never void: a trailing slash (`<div/>`) does NOT
    // self-close them in HTML, so always push.
    stack.push({ name, tokens: classTokensOf(attrs) });
  }
  return unwrapped;
}

// ── Script entry point ──────────────────────────────────────────────────────

function isMinimal(rel) {
  // Pages that legitimately ship without OG/Twitter metadata.
  return rel === '404.html';
}

// Recursively discover every .html file under baseDir, the same way build.js
// walks _src/. Returns paths relative to baseDir, forward-slashed for output
// consistency across Windows/Linux.
export function discoverHtmlFiles(baseDir) {
  const out = [];
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.html')) {
        out.push(relative(baseDir, full).replace(/\\/g, '/'));
      }
    }
  }
  walk(baseDir);
  return out.sort();
}

function runScript() {
  // Derive repoRoot from the script's own location rather than process.cwd(),
  // so `node scripts/validate.mjs` works regardless of where it's invoked from.
  // dist/ always lives at repoRoot/dist.
  const __filename = fileURLToPath(import.meta.url);
  const scriptsDir = dirname(__filename);
  const repoRoot = dirname(scriptsDir);
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

  // Auto-discover every dist HTML file the same way build.js walks _src/, so
  // a newly added page is gated by every check without touching this list.
  const allHtmlFiles = discoverHtmlFiles(distRoot);

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

    // Responsive-table wrappers
    const unwrappedTables = findUnwrappedTables(content);
    if (unwrappedTables.length) {
      for (const c of unwrappedTables) {
        addError(`Table without scroll wrapper in ${rel}: <table class="${c}"> (wrap it in a .table-scroll element)`);
      }
    } else {
      console.log(`OK TBL  ${rel}`);
    }
  }

  if (errors.length > 0) {
    console.error('\nValidation failed:');
    for (const e of errors) console.error(`- ${e}`);
    process.exit(1);
  }
  console.log('\nAll validation checks passed.');
}

// Run the script body only when invoked directly (not when imported as a
// module). pathToFileURL handles Windows drive letters and spaces correctly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runScript();
}
