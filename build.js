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
 *   -->
 *
 * Frontmatter values are substituted into injected partial bodies only
 * (never the surrounding page body), via {{TITLE}} / {{DESCRIPTION}} /
 * {{CANONICAL}} / {{ROBOTS}} / {{OG_TITLE}} / {{OG_DESC}} tokens.
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

// Static assets to copy from repo root to dist/
const STATIC_ASSETS = [
  'favicon.ico', 'robots.txt', 'sitemap.xml', 'ads.txt',
  '_headers', '_redirects', 'og-image.png', 'llms.txt',
];

// ── Frontmatter parsing ─────────────────────────────────────────────────────
// Matches a leading "<!-- meta: ... -->" comment (whitespace-tolerant) at the
// very top of the file. Returns the parsed key/value map plus the body with
// the comment removed.
const FRONTMATTER_RE = /^\s*<!--\s*meta:\s*([\s\S]*?)\s*-->\s*\r?\n?/;
const KV_RE = /(\w+)\s*=\s*"((?:\\.|[^"\\])*)"/g;

function parseFrontmatter(html) {
  var m = html.match(FRONTMATTER_RE);
  if (!m) return { vars: {}, body: html };
  var vars = {};
  var kv;
  KV_RE.lastIndex = 0;
  while ((kv = KV_RE.exec(m[1])) !== null) {
    vars[kv[1].toLowerCase()] = kv[2].replace(/\\"/g, '"');
  }
  return { vars: vars, body: html.slice(m[0].length) };
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
module.exports = { parseFrontmatter, substituteVars, injectPartials, listHtml };

// ── Script entry point (skipped when imported as a module) ──────────────────
if (require.main !== module) return;

// Load partials from _partials/
const partials = {};
fs.readdirSync(PARTIALS).forEach(function(file) {
  partials[file] = fs.readFileSync(path.join(PARTIALS, file), 'utf8').trimEnd();
});

// Recreate dist/ from a clean slate
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// Build HTML files
var htmlFiles = listHtml(SRC);
var built = 0;
htmlFiles.forEach(function(srcPath) {
  var rel      = path.relative(SRC, srcPath);
  var distPath = path.join(DIST, rel);
  var source   = fs.readFileSync(srcPath, 'utf8');
  var fm       = parseFrontmatter(source);
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
