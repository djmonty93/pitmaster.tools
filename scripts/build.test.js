'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseFrontmatter, substituteVars, injectPartials, resolvePermalink
} = require('../build.js');

test('parseFrontmatter — extracts simple key/value pairs', () => {
  const src = `<!-- meta:
  title="Hello"
  description="A page"
-->
<html>body</html>`;
  const { vars, body } = parseFrontmatter(src);
  assert.equal(vars.title, 'Hello');
  assert.equal(vars.description, 'A page');
  assert.equal(body, '<html>body</html>');
});

test('parseFrontmatter — returns empty vars when no frontmatter', () => {
  const src = '<html>no frontmatter</html>';
  const { vars, body } = parseFrontmatter(src);
  assert.deepEqual(vars, {});
  assert.equal(body, src);
});

test('parseFrontmatter — keys are lower-cased; escaped quotes unescaped', () => {
  const src = `<!-- meta: TITLE="A \\"quoted\\" name" -->
rest`;
  const { vars } = parseFrontmatter(src);
  assert.equal(vars.title, 'A "quoted" name');
});

test('parseFrontmatter — literal backslash escape \\\\ is unescaped', () => {
  const src = `<!-- meta: path="C:\\\\Users\\\\file" -->
rest`;
  const { vars } = parseFrontmatter(src);
  assert.equal(vars.path, 'C:\\Users\\file');
});

test('parseFrontmatter — other escape sequences pass through literally', () => {
  // \n and \t aren't recognized escapes; they survive as the literal two-
  // character sequences backslash-n and backslash-t (meta values don't
  // contain control characters).
  const src = `<!-- meta: title="line\\none\\ttwo" -->
rest`;
  const { vars } = parseFrontmatter(src);
  assert.equal(vars.title, 'line\\none\\ttwo');
});

test('parseFrontmatter — ignores frontmatter that is not at the very start', () => {
  const src = `<!DOCTYPE html>
<!-- meta: title="X" -->`;
  const { vars } = parseFrontmatter(src);
  assert.deepEqual(vars, {});
});

test('parseFrontmatter — allows a leading non-meta HTML comment before the meta block', () => {
  // The metro generator emits a "<!-- generated:... -->" marker on line 1 and
  // the meta block on line 2. parseFrontmatter must skip past the marker,
  // parse the meta, strip only the meta comment, and pass the marker through
  // to the body so it survives into dist for traceability and the sweep step.
  const src = `<!-- generated:metro-page -->
<!-- meta: title="Hello" -->
<html>body</html>`;
  const { vars, body } = parseFrontmatter(src);
  assert.equal(vars.title, 'Hello');
  assert.ok(body.startsWith('<!-- generated:metro-page -->'),
    'generator marker must survive into body');
  assert.ok(body.includes('<html>body</html>'));
  assert.ok(!body.includes('<!-- meta:'),
    'meta comment must be stripped from body');
});

test('parseFrontmatter — allows multiple leading non-meta comments before the meta block', () => {
  // Contract pinned: any number of leading non-meta HTML comments (license
  // headers, generator markers, audit notes, etc.) may appear before the meta
  // block. They all survive into the body; only the meta block is stripped.
  // The parser stays intentionally generic — special-casing one marker would
  // make this more brittle, not less.
  const src = `<!-- license: MIT -->
<!-- audit: 2026-05-15 -->
<!-- meta: title="Multi" -->
<html>body</html>`;
  const { vars, body } = parseFrontmatter(src);
  assert.equal(vars.title, 'Multi');
  assert.ok(body.includes('<!-- license: MIT -->'));
  assert.ok(body.includes('<!-- audit: 2026-05-15 -->'));
  assert.ok(!body.includes('<!-- meta:'));
});

test('parseFrontmatter — throws on unquoted assignment so malformed permalink cannot silently bypass validation', () => {
  // Without this gate, `permalink=/bad.html` (no quotes) is dropped by KV_RE,
  // vars.permalink stays unset, resolvePermalink falls back to the source path,
  // and the entire `permalink` validation block (leading-slash, traversal,
  // .html suffix, etc.) is silently skipped. Catching it at parse time fails
  // loudly instead.
  const src = `<!-- meta:
  title="Hello"
  permalink=/bad.html
-->
rest`;
  assert.throws(
    () => parseFrontmatter(src),
    /Malformed frontmatter assignment "permalink=\.\.\."/
  );
});

test('parseFrontmatter — throws on any malformed key, not just permalink', () => {
  // The gate must catch malformed assignments for any frontmatter key — a
  // permalink-only check would let a future required field silently disappear
  // the same way. Pin that the validation is general.
  const src = `<!-- meta: title=raw -->
rest`;
  assert.throws(
    () => parseFrontmatter(src),
    /Malformed frontmatter assignment "title=\.\.\."/
  );
});

test('parseFrontmatter — throws on empty-value assignment (permalink=)', () => {
  // A bare `key=` (no value at all) also skips KV_RE and would silently
  // bypass downstream validation. The residue scan must catch it.
  const src = `<!-- meta:
  title="Hello"
  permalink=
-->
rest`;
  assert.throws(
    () => parseFrontmatter(src),
    /Malformed frontmatter assignment "permalink=\.\.\."/
  );
});

test('parseFrontmatter — throws on hyphenated key (not-permalink="foo")', () => {
  // Without anchoring KV_RE, `not-permalink="foo.html"` was partial-matched
  // as `permalink="foo.html"`, leaving `not-` as residue. The old `\b\w+=`
  // residue scan never fired (no = after the residue), so the partial-match
  // silently parsed the wrong key. The anchored KV_RE refuses the partial
  // and the trim-check residue scan catches the leftover token.
  const src = `<!-- meta:
  title="Hello"
  not-permalink="foo.html"
-->
rest`;
  assert.throws(
    () => parseFrontmatter(src),
    /Malformed frontmatter assignment "not-permalink=\.\.\."/
  );
});

test('parseFrontmatter — throws on hyphenated prefix even when valid key follows (data-title="X")', () => {
  // Same shape, different key — `data-title="X"` would have partial-matched
  // as `title="X"` under the old regex.
  const src = `<!-- meta: data-title="X" -->
rest`;
  assert.throws(
    () => parseFrontmatter(src),
    /Malformed frontmatter assignment "data-title=\.\.\."/
  );
});

test('parseFrontmatter — throws on plain garbage in the meta block', () => {
  // The trim-check residue scan also catches stray text that isn't an
  // assignment at all — e.g. an author leaves a stray note inside the meta
  // comment. Backstops every other gate.
  const src = `<!-- meta:
  title="Hello"
  random stray text
-->
rest`;
  assert.throws(
    () => parseFrontmatter(src),
    /Unparsed content in meta block/
  );
});

test('parseFrontmatter — throws on unterminated quoted value', () => {
  // KV_RE requires a closing double-quote; an unterminated value never
  // matches, so the residue keeps the broken `key="...` and the scan must
  // catch it.
  const src = `<!-- meta:
  title="Hello"
  permalink="unterminated
-->
rest`;
  assert.throws(
    () => parseFrontmatter(src),
    /Malformed frontmatter assignment "permalink=\.\.\."/
  );
});

test('parseFrontmatter — allows whitespace and newlines in a well-formed meta block', () => {
  // Sanity check: the residue scan must not false-positive on the whitespace
  // and newlines that legitimately separate well-formed key="value" pairs.
  const src = `<!-- meta:
  title="Hello"
  description="A page"
  permalink="ok.html"
-->
rest`;
  const { vars } = parseFrontmatter(src);
  assert.equal(vars.title, 'Hello');
  assert.equal(vars.description, 'A page');
  assert.equal(vars.permalink, 'ok.html');
});

test('parseFrontmatter — still ignores a meta comment that follows non-comment content', () => {
  // Confirms the loosened parser only walks leading HTML comments — DOCTYPE,
  // plain text, or any non-comment markup still anchors the search, so a
  // "<!-- meta: ... -->" sitting inside the page body cannot be mistaken for
  // frontmatter.
  const src = `<!-- generator -->
<!DOCTYPE html>
<!-- meta: title="Ignored" -->`;
  const { vars } = parseFrontmatter(src);
  assert.deepEqual(vars, {});
});

test('substituteVars — replaces known tokens, leaves unknown ones', () => {
  const out = substituteVars('Hi {{TITLE}} / {{MYSTERY}}', { title: 'World' });
  assert.equal(out, 'Hi World / {{MYSTERY}}');
});

test('substituteVars — og_title falls back to title; og_desc to description', () => {
  const out = substituteVars('{{OG_TITLE}} | {{OG_DESC}}', {
    title: 'T', description: 'D'
  });
  assert.equal(out, 'T | D');
});

test('substituteVars — robots defaults to "index, follow" when absent', () => {
  const out = substituteVars('<meta name="robots" content="{{ROBOTS}}">', {});
  assert.equal(out, '<meta name="robots" content="index, follow">');
});

test('substituteVars — explicit robots value beats the default', () => {
  const out = substituteVars('{{ROBOTS}}', { robots: 'noindex, follow' });
  assert.equal(out, 'noindex, follow');
});

test('substituteVars — HTML-escapes substituted values so they cannot break attributes', () => {
  const out = substituteVars(
    '<meta name="description" content="{{DESCRIPTION}}">',
    { description: 'A "smart" title with <script>alert(1)</script> & ampersand' }
  );
  assert.equal(
    out,
    '<meta name="description" content="A &quot;smart&quot; title with &lt;script&gt;alert(1)&lt;/script&gt; &amp; ampersand">'
  );
});

test('substituteVars — escapes single quotes and ampersands too', () => {
  const out = substituteVars("{{TITLE}}", { title: "Mike's & Mary's" });
  assert.equal(out, 'Mike&#39;s &amp; Mary&#39;s');
});

test('injectPartials — wraps .css as <style>, .js:script as <script>, .html raw', () => {
  const partials = {
    'a.css': 'body{}',
    'b.js': 'init();',
    'c.html': '<p>raw</p>'
  };
  const src = '<!-- INJECT:a.css --><!-- INJECT:b.js:script --><!-- INJECT:c.html -->';
  const out = injectPartials(src, {}, partials, 'test.html');
  assert.ok(out.includes('<style>\nbody{}\n</style>'));
  assert.ok(out.includes('<script>\ninit();\n</script>'));
  assert.ok(out.includes('<p>raw</p>'));
  assert.ok(!out.includes('<style>\n<p>raw</p>'));
});

test('injectPartials — substitutes tokens inside partial bodies only', () => {
  const partials = { 'head.html': '<title>{{TITLE}}</title>' };
  // {{TITLE}} appears in BOTH the partial and the page body. Only the
  // partial-body occurrence should be substituted.
  const src = '<!-- INJECT:head.html -->\n<body>{{TITLE}} in body</body>';
  const out = injectPartials(src, { title: 'Hello' }, partials, 'test.html');
  assert.ok(out.includes('<title>Hello</title>'));
  assert.ok(out.includes('{{TITLE}} in body'));
});

test('injectPartials — resolves nested HTML partials', () => {
  const partials = {
    'outer.html': '<wrap><!-- INJECT:inner.html --></wrap>',
    'inner.html': '<core/>'
  };
  const out = injectPartials('<!-- INJECT:outer.html -->', {}, partials, 'test.html');
  assert.equal(out, '<wrap><core/></wrap>');
});

test('injectPartials — throws on missing partial', () => {
  assert.throws(() => {
    injectPartials('<!-- INJECT:nope.html -->', {}, {}, 'test.html');
  }, /Missing partial "nope\.html"/);
});

test('injectPartials — throws on partial-inclusion cycle', () => {
  const partials = {
    'a.html': '<!-- INJECT:b.html -->',
    'b.html': '<!-- INJECT:a.html -->'
  };
  assert.throws(() => {
    injectPartials('<!-- INJECT:a.html -->', {}, partials, 'test.html');
  }, /INJECT depth exceeded/);
});

// ── resolvePermalink ────────────────────────────────────────────────────────

test('resolvePermalink — without permalink, normalizes the source rel to forward slashes', () => {
  // Windows source paths come in with backslashes; dist-relative paths must be
  // forward-slashed regardless of platform so downstream string keys (collision
  // map, validator output) are stable.
  const rel = ['smoke-weather', 'index.html'].join(require('node:path').sep);
  assert.equal(resolvePermalink(rel, {}, rel), 'smoke-weather/index.html');
});

test('resolvePermalink — passes through a flat .html source unchanged', () => {
  assert.equal(resolvePermalink('about.html', {}, 'about.html'), 'about.html');
});

test('resolvePermalink — uses permalink when set, overriding source rel', () => {
  assert.equal(
    resolvePermalink('tools/brisket-calculator.html',
      { permalink: 'brisket-calculator.html' }, 'tools/brisket-calculator.html'),
    'brisket-calculator.html'
  );
});

test('resolvePermalink — permalink with subdirectory survives', () => {
  assert.equal(
    resolvePermalink('legal/privacy.html',
      { permalink: 'legal/privacy-policy.html' }, 'legal/privacy.html'),
    'legal/privacy-policy.html'
  );
});

test('resolvePermalink — normalizes backslashes in permalink to forward slashes', () => {
  // An author writing a Windows-style path in frontmatter shouldn't break the
  // dist tree on Linux CI. Backslashes are treated as separators.
  assert.equal(
    resolvePermalink('x.html', { permalink: 'a\\b.html' }, 'x.html'),
    'a/b.html'
  );
});

test('resolvePermalink — rejects leading slash', () => {
  assert.throws(
    () => resolvePermalink('x.html', { permalink: '/abs.html' }, 'x.html'),
    /must not start with "\/"/
  );
});

test('resolvePermalink — rejects leading backslash', () => {
  assert.throws(
    () => resolvePermalink('x.html', { permalink: '\\abs.html' }, 'x.html'),
    /must not start with "\/"/
  );
});

test('resolvePermalink — rejects ".." traversal', () => {
  assert.throws(
    () => resolvePermalink('x.html', { permalink: '../escape.html' }, 'x.html'),
    /must not contain "\.\."/
  );
});

test('resolvePermalink — rejects ".." segment anywhere in the path', () => {
  assert.throws(
    () => resolvePermalink('x.html', { permalink: 'a/../b.html' }, 'x.html'),
    /must not contain "\.\."/
  );
});

test('resolvePermalink — rejects empty segment from double slash (a//b.html)', () => {
  // path.join collapses // to /, so a//b.html and a/b.html would both write to
  // dist/a/b.html. Without this gate the collision check is bypassed.
  assert.throws(
    () => resolvePermalink('x.html', { permalink: 'a//b.html' }, 'x.html'),
    /must not contain empty or "\." segments/
  );
});

test('resolvePermalink — rejects "." segment (a/./b.html)', () => {
  assert.throws(
    () => resolvePermalink('x.html', { permalink: 'a/./b.html' }, 'x.html'),
    /must not contain empty or "\." segments/
  );
});

test('resolvePermalink — rejects trailing slash (empty final segment)', () => {
  assert.throws(
    () => resolvePermalink('x.html', { permalink: 'a/b/' }, 'x.html'),
    /must not contain empty or "\." segments/
  );
});

test('resolvePermalink — rejects "?" before .html suffix', () => {
  assert.throws(
    () => resolvePermalink('x.html', { permalink: 'foo?x.html' }, 'x.html'),
    /must not contain "\?" or "#"/
  );
});

test('resolvePermalink — rejects "?" after .html suffix', () => {
  // Without the explicit ?/# gate this would slip past the endsWith check on
  // Linux (literal "foo.html?x" filename) and crash at write time on Windows.
  assert.throws(
    () => resolvePermalink('x.html', { permalink: 'foo.html?x' }, 'x.html'),
    /must not contain "\?" or "#"/
  );
});

test('resolvePermalink — rejects "#"', () => {
  assert.throws(
    () => resolvePermalink('x.html', { permalink: 'foo#bar.html' }, 'x.html'),
    /must not contain "\?" or "#"/
  );
});

test('resolvePermalink — rejects non-.html extension', () => {
  assert.throws(
    () => resolvePermalink('x.html', { permalink: 'feed.xml' }, 'x.html'),
    /must end with "\.html"/
  );
});

test('resolvePermalink — rejects empty permalink', () => {
  assert.throws(
    () => resolvePermalink('x.html', { permalink: '   ' }, 'x.html'),
    /must not be empty/
  );
});
