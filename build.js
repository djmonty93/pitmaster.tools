#!/usr/bin/env node
/**
 * build.js — Pitmaster Tools build script
 *
 * Reads source HTML from _src/, replaces <!-- INJECT:name --> placeholders
 * with inlined content from _partials/, writes output to dist/.
 * Mirrors the _src/ directory tree under dist/ (e.g. _src/smoke-weather/
 * index.html → dist/smoke-weather/index.html).
 * Copies static assets from root to dist/.
 *
 * Placeholder forms:
 *   <!-- INJECT:name.css -->        → <style>…content…</style>
 *   <!-- INJECT:name.js:script -->  → <script>…content…</script>
 *   <!-- INJECT:name.html -->       → …content… (raw HTML, no wrap)
 *
 * Per-page frontmatter (leading HTML comment, stripped from output):
 *   <!-- meta:
 *     title="…"
 *     description="…"
 *     canonical="…"
 *     robots="…"
 *     og_title="…"
 *     og_desc="…"
 *     permalink="…"
 *   -->
 *
 * Frontmatter values are substituted into injected partial bodies only
 * (never the surrounding page body), via {{TITLE}} / {{DESCRIPTION}} /
 * {{CANONICAL}} / {{ROBOTS}} / {{OG_TITLE}} / {{OG_DESC}} tokens.
 *
 * The `permalink` value is a build directive (not a template token): when
 * present it overrides the default `_src/<rel> → dist/<rel>` mapping so a
 * source file can move under `_src/` without changing its public URL.
 * Paths are forward-slashed, must end in `.html`, may not start with `/`,
 * and may not contain `..`.
 *
 * Pure functions (parseFrontmatter, substituteVars, injectPartials) are
 * exported via module.exports so scripts/build.test.js can exercise them
 * without touching the filesystem. The script body at the bottom runs only
 * when this file is invoked directly.
 *
 * Usage: node build.js
 * No npm dependencies required.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const SRC      = '_src';
const PARTIALS = '_partials';
const DIST     = 'dist';

// Static assets to copy from repo root to dist/. _redirects is omitted
// because the file is unused: Workers Assets handles clean URLs via the
// default auto-trailing-slash html_handling, and the "block internal
// files" lines defended against files build.js doesn't copy anyway.
// Cloudflare Workers also rejected the Pages-style 404 / forced-301
// syntax the old file used, which was failing Workers Builds on every
// commit.
const STATIC_ASSETS = [
  'favicon.ico', 'robots.txt', 'sitemap.xml', 'ads.txt',
  '_headers', 'og-image.png', 'llms.txt',
];

// ── Frontmatter parsing ─────────────────────────────────────────────────────
// Matches a leading "<!-- meta: ... -->" comment (whitespace-tolerant) at the
// top of the file, optionally preceded by other HTML comments — e.g. the
// "<!-- generated:... -->" marker the metro generator emits. Returns the
// parsed key/value map plus the body with the meta comment removed (any
// preceding comments pass through to the body so they survive into dist).
//
// Value escapes: KV_RE skips past any backslash-pair inside a value so the
// captured group is the raw content. We then drop the backslash from \" and
// \\ — those are the only two escapes a frontmatter author needs (literal
// quote, literal backslash). Other escapes (\n, \t) survive as literal
// two-character sequences since meta values don't carry control characters.
const NONMETA_COMMENT_RE = /^\s*<!--(?!\s*meta:)[\s\S]*?-->\s*/;
const META_COMMENT_RE = /^\s*<!--\s*meta:\s*([\s\S]*?)\s*-->\s*\r?\n?/;
const KV_RE = /(\w+)\s*=\s*"((?:\\.|[^"\\])*)"/g;
const FRONTMATTER_UNESCAPE_RE = /\\(["\\])/g;

function parseFrontmatter(html) {
  var prefixLen = 0;
  var rest = html;
  var pre;
  while ((pre = rest.match(NONMETA_COMMENT_RE)) !== null) {
    prefixLen += pre[0].length;
    rest = rest.slice(pre[0].length);
  }
  var m = rest.match(META_COMMENT_RE);
  if (!m) return { vars: {}, body: html };
  var vars = {};
  var kv;
  KV_RE.lastIndex = 0;
  while ((kv = KV_RE.exec(m[1])) !== null) {
    vars[kv[1].toLowerCase()] = kv[2].replace(FRONTMATTER_UNESCAPE_RE, '$1');
  }
  var prefix = html.slice(0, prefixLen);
  var afterMeta = rest.slice(m[0].length);
  return { vars: vars, body: prefix + afterMeta };
}

// ── Variable substitution (scoped to partial bodies) ────────────────────────
// Substituted values are HTML-escaped before insertion so that a title or
// description containing &, <, >, ", or ' cannot break out of an attribute
// context. Frontmatter values are author-controlled (not end-user input), but
// escaping defends against simple punctuation in titles and against any future
// caller that pipes less-trusted data through these functions.
const TOKEN_RE = /\{\{([A-Z_]+)\}\}/g;
const HTML_ESCAPE_RE = /[&<>"']/g;
const HTML_ESCAPE_MAP = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
};

function escapeHtml(s) {
  return String(s).replace(HTML_ESCAPE_RE, function(c) { return HTML_ESCAPE_MAP[c]; });
}

function resolveVar(key, vars) {
  if (vars[key] != null) return vars[key];
  // Sensible fallbacks: og_title → title, og_desc → description.
  if (key === 'og_title' && vars.title != null) return vars.title;
  if (key === 'og_desc'  && vars.description != null) return vars.description;
  if (key === 'robots'   && vars.robots == null)      return 'index, follow';
  return null;
}

function substituteVars(content, vars) {
  return content.replace(TOKEN_RE, function(match, name) {
    var value = resolveVar(name.toLowerCase(), vars);
    return value == null ? match : escapeHtml(value);
  });
}

// ── Inject partials into HTML ────────────────────────────────────────────────
// Runs passes until no INJECT placeholders remain, so HTML partials may
// themselves reference further partials. MAX_PASSES caps recursion depth to
// catch partial-include cycles (an A.html that injects B.html that injects
// A.html). Today the deepest legitimate chain is 1, so any value above 2 is
// safety margin; 8 is generous without being absurd.
const INJECT_RE = /<!--\s*INJECT:([^\s:>]+)(:script)?\s*-->/g;
const MAX_PASSES = 8;

function injectPartials(html, vars, partials, sourceFile) {
  for (var pass = 0; pass < MAX_PASSES; pass++) {
    if (!html.includes('<!-- INJECT:')) return html;
    INJECT_RE.lastIndex = 0;
    html = html.replace(INJECT_RE, function(match, name, isScript) {
      var content = partials[name];
      if (content == null) {
        throw new Error('Missing partial "' + name + '" referenced in ' + sourceFile);
      }
      var body = substituteVars(content, vars);
      if (name.endsWith('.html')) return body;
      if (isScript)               return '<script>\n' + body + '\n</script>';
      return                              '<style>\n'  + body + '\n</style>';
    });
  }
  throw new Error('INJECT depth exceeded in ' + sourceFile + ' (likely a partial-inclusion cycle)');
}

// ── Permalink resolution ────────────────────────────────────────────────────
// A `permalink` frontmatter value overrides the default `_src/<rel> → dist/<rel>`
// mapping. Forward-slashed, must end in .html, no leading slash, no traversal.
// Returns the dist-relative path (forward-slashed) the file should be written to.
function resolvePermalink(rel, vars, sourceFile) {
  if (vars.permalink == null) {
    return rel.split(path.sep).join('/');
  }
  var p = String(vars.permalink).trim();
  if (p === '') {
    throw new Error('permalink in ' + sourceFile + ' must not be empty');
  }
  if (p.startsWith('/') || p.startsWith('\\')) {
    throw new Error('permalink in ' + sourceFile + ' must not start with "/" (got "' + p + '")');
  }
  var segments = p.split(/[\\/]/);
  if (segments.indexOf('..') !== -1) {
    throw new Error('permalink in ' + sourceFile + ' must not contain ".." (got "' + p + '")');
  }
  if (!p.endsWith('.html')) {
    throw new Error('permalink in ' + sourceFile + ' must end with ".html" (got "' + p + '")');
  }
  return segments.join('/');
}

// ── Walk a directory recursively, yield relative .html paths ────────────────
function listHtml(dir) {
  var out = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function(entry) {
    var full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(listHtml(full));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      out.push(full);
    }
  });
  return out;
}

// ── Exports for unit tests ──────────────────────────────────────────────────
module.exports = {
  parseFrontmatter, substituteVars, injectPartials, listHtml, resolvePermalink
};

// ── Script entry point (skipped when imported as a module) ──────────────────
function runBuild() {
  // Load partials from _partials/
  var partials = {};
  fs.readdirSync(PARTIALS).forEach(function(file) {
    partials[file] = fs.readFileSync(path.join(PARTIALS, file), 'utf8').trimEnd();
  });

  // Recreate dist/ from a clean slate
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  // Build HTML files. Track emitted dist-relative paths so two source files
  // claiming the same permalink fail loudly instead of silently clobbering.
  var htmlFiles = listHtml(SRC);
  var emitted = Object.create(null);
  var built = 0;
  htmlFiles.forEach(function(srcPath) {
    var rel      = path.relative(SRC, srcPath);
    var source   = fs.readFileSync(srcPath, 'utf8');
    var fm       = parseFrontmatter(source);
    var distRel  = resolvePermalink(rel, fm.vars, rel);
    if (emitted[distRel] != null) {
      throw new Error(
        'Permalink collision: both ' + emitted[distRel] + ' and ' + rel +
        ' emit to dist/' + distRel
      );
    }
    emitted[distRel] = rel;
    var distPath = path.join(DIST, distRel);
    var output   = injectPartials(fm.body, fm.vars, partials, rel);
    fs.mkdirSync(path.dirname(distPath), { recursive: true });
    fs.writeFileSync(distPath, output);
    built++;
  });
  console.log('Built ' + built + ' HTML files → ' + DIST + '/');

  // Copy static assets
  var copied = 0;
  STATIC_ASSETS.forEach(function(file) {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, path.join(DIST, file));
      copied++;
    }
  });
  console.log('Copied ' + copied + ' static assets → ' + DIST + '/');
  console.log('Build complete.');
}

if (require.main === module) runBuild();
