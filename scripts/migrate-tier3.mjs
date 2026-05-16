#!/usr/bin/env node
/**
 * scripts/migrate-tier3.mjs — one-shot migrator for tier 3 of the staged
 * refactor. Transforms each tool .html file in _src/ onto the head + tool
 * header + footer partials introduced in tiers 1 + 2.
 *
 * For each input file:
 *  1. Extract title, description, canonical, og:title, og:description
 *     from the existing head.
 *  2. Prepend a <!-- meta: ... --> frontmatter block with those values.
 *  3. Replace the head boilerplate (charset → consent script) with the
 *     four head INJECTs (head-meta, head-og, head-favicons, consent-init).
 *  4. Replace the skip-link + header block with INJECT:site-header-tool[-weight].html.
 *  5. Replace the cookie-banner + footer + closing scripts with INJECT:site-footer.html.
 *
 * Inline JSON-LD scripts, page-specific styles, page-specific tail scripts,
 * and the main content are preserved verbatim.
 *
 * Usage: node scripts/migrate-tier3.mjs [path-glob...]
 *   default: migrate all tool pages listed below.
 *
 * Not committed long-term — this is a one-shot bridge. Delete after tier 3
 * lands unless we plan to repeat the operation for follow-on tiers.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(__filename));

// Tier-3 targets and which header variant they use.
// "tw" = temp+weight toggle, "w" = weight-only toggle.
// index.html is deferred to a separate PR (tier-3b) — see refactor plan.
const TIER3 = [
  { file: 'bbq-cost-calculator.html',         header: 'w'  },
  { file: 'brine-calculator.html',            header: 'tw' },
  { file: 'brisket-calculator.html',          header: 'tw' },
  { file: 'brisket-yield-calculator.html',    header: 'w'  },
  { file: 'catering-calculator.html',         header: 'w'  },
  { file: 'charcoal-calculator.html',         header: 'tw' },
  { file: 'cook-time-coordinator.html',       header: 'tw' },
  { file: 'dry-rub-calculator.html',          header: 'tw' },
  { file: 'meat-per-person.html',             header: 'tw' }, // page JS binds #tempToggle for cross-page persistence
  { file: 'pork-shoulder-calculator.html',    header: 'tw' },
  { file: 'rib-calculator.html',              header: 'tw' },
  { file: 'turkey-smoking-calculator.html',   header: 'tw' }
];

// ── Extractors ──────────────────────────────────────────────────────────────

function extract(re, src, group = 1) {
  const m = src.match(re);
  return m ? m[group] : null;
}

function parseExistingHead(src) {
  // Tolerant extractors — single-line attribute order is consistent in this
  // codebase, but allow whitespace variation.
  return {
    title:       extract(/<title>([\s\S]*?)<\/title>/, src),
    description: extract(/<meta\s+name="description"\s+content="([^"]*)"/, src),
    robots:      extract(/<meta\s+name="robots"\s+content="([^"]*)"/, src),
    canonical:   extract(/<link\s+rel="canonical"\s+href="([^"]*)"/, src),
    ogTitle:     extract(/<meta\s+property="og:title"\s+content="([^"]*)"/, src),
    ogDesc:      extract(/<meta\s+property="og:description"\s+content="([^"]*)"/, src)
  };
}

// ── Transformer ─────────────────────────────────────────────────────────────

function migrate(src, headerVariant) {
  const meta = parseExistingHead(src);
  if (!meta.title || !meta.canonical) {
    throw new Error('could not extract title/canonical from head');
  }

  // Build the frontmatter block. Only emit og_title / og_desc / robots if
  // they differ from the defaults (og fallbacks to title/description, robots
  // defaults to "index, follow") so frontmatter stays compact.
  const fmLines = [
    `  title="${escape(meta.title)}"`,
    `  description="${escape(meta.description)}"`
  ];
  if (meta.robots && meta.robots !== 'index, follow') {
    fmLines.push(`  robots="${escape(meta.robots)}"`);
  }
  fmLines.push(`  canonical="${escape(meta.canonical)}"`);
  if (meta.ogTitle && meta.ogTitle !== meta.title) {
    fmLines.push(`  og_title="${escape(meta.ogTitle)}"`);
  }
  if (meta.ogDesc && meta.ogDesc !== meta.description) {
    fmLines.push(`  og_desc="${escape(meta.ogDesc)}"`);
  }
  const frontmatter = '<!-- meta:\n' + fmLines.join('\n') + '\n-->\n';

  // 1. Replace head boilerplate. Match from the opening <meta charset=
  //    through the closing </script> of the consent block (inclusive).
  //    The consent block ends with `</script>` after the `gtag('consent'`
  //    call; everything before it (charset → twitter:image → favicons → consent)
  //    becomes the four head INJECTs.
  const HEAD_BLOCK_RE = /<meta charset="UTF-8">[\s\S]*?gtag\('consent'[\s\S]*?<\/script>/;
  let out = src.replace(HEAD_BLOCK_RE,
    '<!-- INJECT:head-meta.html -->\n' +
    '<!-- INJECT:head-og.html -->\n' +
    '<!-- INJECT:head-favicons.html -->\n' +
    '<!-- INJECT:consent-init.html -->'
  );

  // 2. Replace the skip-link + header block with the appropriate tool header
  //    partial INJECT.
  const headerPartial = headerVariant === 'w'
    ? 'site-header-tool-weight.html'
    : 'site-header-tool.html';
  const HEADER_BLOCK_RE = /<a href="#main-content"[^>]*class="skip-link"[^>]*>[\s\S]*?<\/header>/;
  out = out.replace(HEADER_BLOCK_RE, `<!-- INJECT:${headerPartial} -->`);

  // 3. Replace the cookie-banner + footer + site-utils inject with the
  //    site-footer-tool.html partial. The block stops at INJECT:site-utils.js:script
  //    (inclusive) so that page-specific tail INJECTs (e.g. smoke-physics.js:script)
  //    and the page's inline init <script>...</script> survive verbatim.
  //    INJECT:site-header.js:script stays in place at the bottom of the page.
  const FOOTER_BLOCK_RE = /<div class="cookie-banner"[\s\S]*?<!-- INJECT:site-utils\.js:script -->/;
  out = out.replace(FOOTER_BLOCK_RE, '<!-- INJECT:site-footer-tool.html -->');

  // 4. Prepend frontmatter.
  return frontmatter + out;
}

function escape(s) {
  if (s == null) return '';
  // Frontmatter values are quoted; only " and \ need escaping.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ── Driver ──────────────────────────────────────────────────────────────────

const targets = process.argv.slice(2).length > 0
  ? process.argv.slice(2).map((rel) => ({ file: rel, header: 'tw' }))
  : TIER3;

let migrated = 0;
let skipped = 0;
const failures = [];
for (const t of targets) {
  const srcPath = join(repoRoot, '_src', t.file);
  let src;
  try {
    src = readFileSync(srcPath, 'utf8');
  } catch (e) {
    failures.push({ file: t.file, err: `read failed: ${e.message}` });
    continue;
  }
  if (/^<!--\s*meta:/.test(src)) {
    console.log(`SKIP ${t.file} (already migrated — frontmatter present)`);
    skipped++;
    continue;
  }
  try {
    const out = migrate(src, t.header);
    writeFileSync(srcPath, out);
    console.log(`OK   ${t.file} (${t.header})`);
    migrated++;
  } catch (e) {
    failures.push({ file: t.file, err: e.message });
  }
}

console.log(`\n${migrated} migrated, ${skipped} skipped, ${failures.length} failed.`);
if (failures.length) {
  for (const f of failures) console.error(`- ${f.file}: ${f.err}`);
  process.exit(1);
}
