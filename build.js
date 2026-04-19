#!/usr/bin/env node
/**
 * build.js — Pitmaster Tools build script
 *
 * Reads source HTML from _src/, replaces <!-- INJECT:name --> placeholders
 * with inlined content from _partials/, writes output to dist/.
 * Copies static assets from root to dist/.
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
  '_headers', '_redirects', 'og-image.png',
];

// ── Load partials ───────────────────────────────────────────────────────────
const partials = {};
fs.readdirSync(PARTIALS).forEach(function(file) {
  partials[file] = fs.readFileSync(path.join(PARTIALS, file), 'utf8').trimEnd();
});

// ── Inject partials into HTML ────────────────────────────────────────────────
// Placeholder syntax:
//   <!-- INJECT:filename.css -->          → <style>…content…</style>
//   <!-- INJECT:filename.js:script -->    → <script>…content…</script>
function injectPartials(html, sourceFile) {
  return html.replace(/<!--\s*INJECT:([^\s:>]+)(:script)?\s*-->/g, function(match, name, isScript) {
    var content = partials[name];
    if (!content) {
      throw new Error('Missing partial "' + name + '" referenced in ' + sourceFile);
    }
    return isScript
      ? '<script>\n' + content + '\n</script>'
      : '<style>\n' + content + '\n</style>';
  });
}

// ── Recreate dist/ from a clean slate ───────────────────────────────────────
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// ── Build HTML files ─────────────────────────────────────────────────────────
var htmlFiles = fs.readdirSync(SRC).filter(function(f) { return f.endsWith('.html'); });
var built = 0;
htmlFiles.forEach(function(file) {
  var srcPath  = path.join(SRC, file);
  var distPath = path.join(DIST, file);
  var source   = fs.readFileSync(srcPath, 'utf8');
  var output   = injectPartials(source, file);
  fs.writeFileSync(distPath, output);
  built++;
});
console.log('Built ' + built + ' HTML files → ' + DIST + '/');

// ── Copy static assets ───────────────────────────────────────────────────────
var copied = 0;
STATIC_ASSETS.forEach(function(file) {
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, path.join(DIST, file));
    copied++;
  }
});
console.log('Copied ' + copied + ' static assets → ' + DIST + '/');
console.log('Build complete.');
