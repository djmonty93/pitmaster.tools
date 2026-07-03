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
 * Usage: node build.js   (set MINIFY=0 to skip JS/CSS minification)
 * Dependencies: terser + csso (devDependencies) minify each _partials/*.js
 * and *.css once at load time. Everything else is Node built-ins.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { escapeHtml } = require('./scripts/lib/text.js');

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
// Anchored: a recognized key must be preceded by start-of-string or whitespace,
// never by another non-whitespace char. Without the lookbehind, KV_RE matched
// `permalink="foo"` inside `not-permalink="foo"` (the hyphen is a \w boundary),
// silently parsing the partial and dropping `not-` to the residue. A typoed
// hyphenated key would then bypass validation by partial-match instead of
// failing.
const KV_RE = /(?<![^\s])(\w+)\s*=\s*"((?:\\.|[^"\\])*)"/g;
const FRONTMATTER_UNESCAPE_RE = /\\(["\\])/g;

// After stripping every recognized `key="value"` from a working copy of the
// meta block, the only legitimate residue is whitespace. Any non-whitespace
// content was either a malformed assignment or stray garbage — both must
// fail loudly. This invariant catches every silent-bypass shape at once:
//   - unquoted:        permalink=/bad.html
//   - empty value:     permalink=
//   - unterminated:    permalink="oops
//   - hyphenated typo: not-permalink="foo"  (anchored KV_RE refuses to
//                                            partial-match, residue keeps
//                                            the full token)
// RESIDUAL_KV_RE is the targeted pattern used to surface a useful key name
// in the error; the trim-check below is the catch-all backstop.
const RESIDUAL_KV_RE = /(\S+?)\s*=/;

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
  var meta = m[1];
  var vars = {};
  var kv;
  KV_RE.lastIndex = 0;
  // Strip each recognized `key="value"` from a working copy as we parse it.
  // Anything that survives must be whitespace or a malformed assignment.
  var residue = meta;
  while ((kv = KV_RE.exec(meta)) !== null) {
    vars[kv[1].toLowerCase()] = kv[2].replace(FRONTMATTER_UNESCAPE_RE, '$1');
    residue = residue.replace(kv[0], '');
  }
  if (residue.trim() !== '') {
    // Prefer a "key=..." message if we can extract one; otherwise surface the
    // raw garbage so the author can see exactly what didn't parse.
    var malformed = residue.match(RESIDUAL_KV_RE);
    if (malformed) {
      throw new Error(
        'Malformed frontmatter assignment "' + malformed[1] +
        '=..." — keys must be unhyphenated identifiers and values must be ' +
        'double-quoted, non-empty, and properly terminated'
      );
    }
    throw new Error(
      'Unparsed content in meta block: "' + residue.trim() + '"'
    );
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

function resolveVar(key, vars) {
  if (vars[key] != null) return vars[key];
  // Sensible fallbacks: og_title → title, og_desc → description.
  if (key === 'og_title' && vars.title != null) return vars.title;
  if (key === 'og_desc'  && vars.description != null) return vars.description;
  if (key === 'robots'   && vars.robots == null)      return 'index, follow';
  // Social / Pinterest defaults. head-og.html references these on EVERY page;
  // non-"article" pages carry no og_* frontmatter, so these defaults reproduce
  // the pre-Pinterest output byte-for-byte (website / shared og-image.png /
  // 1200x630). Calculator ("article") pages override via derivePinVars +
  // frontmatter. Keeping the defaults here means an unresolved {{token}} can
  // never leak to dist (which validate.mjs treats as a hard failure).
  if (key === 'og_type')      return 'website';
  if (key === 'og_image')     return 'https://pitmaster.tools/og-image.png';
  if (key === 'og_image_w')   return '1200';
  if (key === 'og_image_h')   return '630';
  if (key === 'og_image_alt') return 'Pitmaster Tools - Free BBQ Calculators';
  // article:published_time / article:modified_time mirror each other when only
  // one is set, so an author dating an "article" page with either key satisfies
  // both tokens. Omitting BOTH still leaves the token unresolved → a loud
  // validate.mjs failure, which is the intended signal that an article page
  // must carry a date.
  if (key === 'modified'  && vars.published != null) return vars.published;
  if (key === 'published' && vars.modified  != null) return vars.modified;
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
// mapping. Forward-slashed, must end in .html, no leading slash, no traversal,
// no empty or "." segments (those collapse via path.join and break the
// emitted-map collision check), and no URL syntax characters that would emit
// platform-dependent filenames.
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
  // Reject URL-syntax characters before the .html suffix check: "foo.html?x"
  // and "foo?x.html" both pass an endsWith test but emit literal-question-mark
  // filenames on Linux and crash on write on Windows. Validation must be
  // platform-agnostic.
  if (/[?#]/.test(p)) {
    throw new Error('permalink in ' + sourceFile + ' must not contain "?" or "#" (got "' + p + '")');
  }
  var segments = p.split(/[\\/]/);
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    if (seg === '..') {
      throw new Error('permalink in ' + sourceFile + ' must not contain ".." (got "' + p + '")');
    }
    if (seg === '' || seg === '.') {
      // Empty segments (a//b.html) and "." segments (a/./b.html) survive the
      // string-key collision map but path.join normalizes them out, so two
      // sources can write to the same dist path without tripping the collision
      // check. Reject both.
      throw new Error(
        'permalink in ' + sourceFile + ' must not contain empty or "." segments (got "' + p + '")'
      );
    }
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

// ── Per-page Pinterest / article social derivation ──────────────────────────
// Calculator pages opt into Rich Pins with a single `og_type="article"`
// frontmatter line. This derives, per page, the vertical OG image, its
// dimensions, and a prefilled pinterest.com "create pin" link — all overridable
// by an explicit frontmatter key. Non-article pages get an empty object so
// their output is unchanged.
//
// Image: a calculator at dist path `<slug>.html` maps to /og/<slug>.png. If
// that PNG isn't present at build time (ogImageExists=false) we fall back to the
// site-wide /og-image.png at 1200x630 so the build never references a missing
// file (Pinterest images are rendered locally and committed; see
// scripts/render-pins.mjs). Returned values are raw (unescaped); substituteVars
// HTML-escapes them at injection time, turning the pin_href '&' separators into
// '&amp;' — valid inside an HTML attribute.
const PINTEREST_CREATE = 'https://www.pinterest.com/pin/create/button/';

function derivePinVars(distRel, vars, ogImageExists) {
  if (vars.og_type !== 'article') return {};
  var slug = String(distRel).replace(/\.html$/, '').split('/').pop();
  var ogImage = vars.og_image != null ? vars.og_image
    : (ogImageExists ? 'https://pitmaster.tools/og/' + slug + '.png'
                     : 'https://pitmaster.tools/og-image.png');
  var ogW = vars.og_image_w != null ? vars.og_image_w : (ogImageExists ? '1000' : '1200');
  var ogH = vars.og_image_h != null ? vars.og_image_h : (ogImageExists ? '1500' : '630');
  var desc = vars.pin_desc != null ? vars.pin_desc
    : (vars.description != null ? vars.description : '');
  var url = vars.canonical != null ? vars.canonical : '';
  var pinHref = PINTEREST_CREATE + '?url=' + encodeURIComponent(url) +
    '&media=' + encodeURIComponent(ogImage) +
    '&description=' + encodeURIComponent(desc);
  return { og_image: ogImage, og_image_w: ogW, og_image_h: ogH, pin_href: pinHref };
}

// ── Recursive directory copy (for the og/ image tree → dist/og/) ────────────
// STATIC_ASSETS only copies flat files; per-calculator Pinterest PNGs live under
// og/ and must mirror into dist/og/. Returns the number of files copied (0 if
// the source directory is absent, so a checkout without rendered pins still
// builds cleanly).
// `opts.noClobber` makes the copy refuse to overwrite an existing dist file —
// used for the public/ passthrough so a stale or misplaced file there can never
// silently replace HTML-build output (the file names are disjoint today; this
// keeps it that way loudly).
function copyDir(srcDir, destDir, opts) {
  if (!fs.existsSync(srcDir)) return 0;
  fs.mkdirSync(destDir, { recursive: true });
  var noClobber = opts && opts.noClobber;
  var n = 0;
  fs.readdirSync(srcDir, { withFileTypes: true }).forEach(function(entry) {
    var s = path.join(srcDir, entry.name);
    var d = path.join(destDir, entry.name);
    if (entry.isDirectory()) n += copyDir(s, d, opts);
    else if (entry.isFile()) {
      if (noClobber && fs.existsSync(d)) {
        throw new Error('public/ copy would overwrite build output: ' + d +
          ' (rename the public/ source or the conflicting page)');
      }
      fs.copyFileSync(s, d);
      n++;
    }
  });
  return n;
}

// ── Partial minification ────────────────────────────────────────────────────
// Each _partials/*.js is minified with terser and each *.css with csso ONCE at
// load time (then injected into every page that references it), shrinking the
// inline JS/CSS shipped on every request. terser's default mangle keeps
// top-level names intact (mangle.toplevel = false), which is required: the
// global helpers in site-utils.js (escapeHtml, isEmbedMode, initEmbedMode, …)
// and window.PlanUrl's method names are referenced by name from un-minified
// page-inline scripts, so they must survive. .html partials pass through
// untouched. Set MINIFY=0 to skip minification for readable debug output
// (read per call so the escape hatch is testable). A minify error fails the
// build loudly rather than shipping a broken asset.
async function minifyAsset(name, content) {
  if (process.env.MINIFY === '0') return content;
  if (name.endsWith('.js')) {
    const { minify } = require('terser');
    let result;
    try {
      result = await minify(content, {
        compress: { defaults: true, unsafe: false },
        mangle: true,                 // locals only — toplevel defaults to false
        format: { comments: false }
      });
    } catch (err) {
      throw new Error('terser failed to minify ' + name + ': ' + (err && err.message || err));
    }
    if (!result || typeof result.code !== 'string') {
      throw new Error('terser produced no output for ' + name);
    }
    return result.code;
  }
  if (name.endsWith('.css')) {
    const csso = require('csso');
    return csso.minify(content).css;
  }
  return content;
}

// ── Exports for unit tests ──────────────────────────────────────────────────
module.exports = {
  parseFrontmatter, substituteVars, injectPartials, listHtml, resolvePermalink,
  minifyAsset, derivePinVars, copyDir
};

// ── Script entry point (skipped when imported as a module) ──────────────────
async function runBuild() {
  // Load partials from _partials/, minifying each .js/.css once at load time.
  var partials = {};
  var partialFiles = fs.readdirSync(PARTIALS);
  for (var pi = 0; pi < partialFiles.length; pi++) {
    var file = partialFiles[pi];
    var raw = fs.readFileSync(path.join(PARTIALS, file), 'utf8').trimEnd();
    partials[file] = await minifyAsset(file, raw);
  }

  // Recreate dist/ from a clean slate
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  // Build HTML files. Track emitted dist-relative paths so two source files
  // claiming the same permalink fail loudly instead of silently clobbering.
  // Case-insensitive Windows filesystems would otherwise let "Foo.html" and
  // "foo.html" pass the exact-match map and clobber on disk while emitting
  // two distinct files on Linux CI — break dist parity across platforms.
  // A secondary lowercase key catches that.
  var htmlFiles = listHtml(SRC);
  var emitted = Object.create(null);
  var emittedCi = Object.create(null);
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
    var ciKey = distRel.toLowerCase();
    if (emittedCi[ciKey] != null && emittedCi[ciKey] !== distRel) {
      throw new Error(
        'Case-insensitive permalink collision: ' + emittedCi[ciKey] +
        ' and ' + distRel + ' differ only in case (would clobber on Windows)'
      );
    }
    emitted[distRel] = rel;
    emittedCi[ciKey] = distRel;
    // Merge per-page Pinterest/article defaults (no-op for non-article pages).
    // The og PNG existence check decides vertical-image vs site-wide fallback.
    var slug = distRel.replace(/\.html$/, '').split('/').pop();
    var ogExists = fs.existsSync(path.join('og', slug + '.png'));
    Object.assign(fm.vars, derivePinVars(distRel, fm.vars, ogExists));
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

  // Copy the per-calculator Pinterest image tree (og/ → dist/og/), if present.
  var ogCopied = copyDir('og', path.join(DIST, 'og'));
  if (ogCopied) console.log('Copied ' + ogCopied + ' og/ images → ' + DIST + '/og/');

  // Copy the generated passthrough tree (public/ → dist/), if present. Holds
  // the per-metro climate-normals distribution JSON emitted by
  // scripts/generate-metros.js (the Dataset DataDownload targets). A checkout
  // that hasn't run build:metros yet simply copies nothing.
  var publicCopied = copyDir('public', DIST, { noClobber: true });
  if (publicCopied) console.log('Copied ' + publicCopied + ' public/ files → ' + DIST + '/');

  console.log('Build complete.');
}

if (require.main === module) {
  runBuild().catch(function(err) {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
