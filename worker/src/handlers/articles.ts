// GET /articles/:slug — renders a single article from D1 as HTML.
//
// Articles live in the `articles` table (migration 0003); Step 13's
// cron writes them weekly. The worker emits a minimal HTML shell
// that picks up the same `<!-- INJECT:... -->` partials as static
// pages — that's a build-time stitch we replicate at render time via
// a small handful of inline partial slots. For Step 7 we ship the
// raw `body_html` inside a known shell; Step 13 can iterate on the
// shell when the actual templates land.

import { html, jsonError, type RouteContext } from '../router.js';

interface ArticleRow {
  slug: string;
  kind: string;
  metro_slug: string | null;
  title: string;
  body_html: string;
  body_text: string;
  hero_band: 'red' | 'yellow' | 'green' | 'ideal';
  published_at: number;
  updated_at: number;
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export async function handleArticles(rc: RouteContext): Promise<Response> {
  const slug = rc.params['slug'];
  if (!slug || !SLUG_RE.test(slug)) {
    return jsonError(400, 'invalid_slug', 'Article slug must be lowercase letters, digits, and dashes');
  }
  const row = await rc.env.SMOKE_DB.prepare(
    `SELECT slug, kind, metro_slug, title, body_html, body_text, hero_band, published_at, updated_at
       FROM articles WHERE slug = ?`
  )
    .bind(slug)
    .first<ArticleRow>();
  if (!row) {
    // 404 as HTML so the browser shows our shell, not raw JSON.
    return html(404, render404(slug), { 'Cache-Control': 'public, max-age=60' });
  }
  return html(200, renderArticle(row), {
    'Cache-Control': 'public, max-age=300',
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) are valid
// inside JSON strings but legal line terminators in some HTML parsers;
// embedding them via numeric escape avoids a literal in source code
// (which some toolchains mishandle as a line break).
const RE_LS = new RegExp(String.fromCharCode(0x2028), 'g');
const RE_PS = new RegExp(String.fromCharCode(0x2029), 'g');

/**
 * Serialize a value as JSON safe for direct embedding inside a `<script
 * type="application/ld+json">` block. JSON.stringify alone is unsafe:
 * a value like `"</script>"` or `"</title>"` would close the script
 * tag and enable an injection. Replacing `<`, `>`, `&`, U+2028,
 * U+2029 with their `\uXXXX` escape forms keeps the output valid JSON
 * but inert to the HTML parser.
 */
function jsonLdSafe(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(RE_LS, '\\u2028')
    .replace(RE_PS, '\\u2029');
}

function renderArticle(row: ArticleRow): string {
  const title = escapeHtml(row.title);
  const description = escapeHtml(row.body_text.slice(0, 160));
  const canonical = `https://pitmaster.tools/articles/${row.slug}`;
  const publishedIso = new Date(row.published_at).toISOString();
  const updatedIso = new Date(row.updated_at).toISOString();
  // body_html is treated as trusted because it's authored by Step 13's
  // template renderer (server-controlled). If we ever ingest user-
  // generated body_html we'll need to sanitize before this point.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — pitmaster.tools</title>
<meta name="description" content="${description}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:type" content="article">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="https://pitmaster.tools/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<link rel="icon" href="/favicon.ico" sizes="any">
<script type="application/ld+json">${jsonLdSafe({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: row.title,
    datePublished: publishedIso,
    dateModified: updatedIso,
    mainEntityOfPage: canonical,
    publisher: {
      '@type': 'Organization',
      name: 'pitmaster.tools',
      url: 'https://pitmaster.tools',
    },
  })}</script>
</head>
<body>
<article class="article article--${row.hero_band}">
  <header>
    <h1>${title}</h1>
    <time datetime="${publishedIso}">${publishedIso.slice(0, 10)}</time>
  </header>
  ${row.body_html}
</article>
</body>
</html>`;
}

function render404(slug: string): string {
  const safeSlug = escapeHtml(slug);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Article not found — pitmaster.tools</title>
<meta name="robots" content="noindex, follow">
<link rel="canonical" href="https://pitmaster.tools/articles/${safeSlug}">
</head>
<body>
<main><h1>Article not found</h1><p>No article archived at <code>${safeSlug}</code>.</p></main>
</body>
</html>`;
}
