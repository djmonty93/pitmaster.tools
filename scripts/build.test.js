'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFrontmatter, substituteVars, injectPartials } = require('../build.js');

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

test('parseFrontmatter — ignores frontmatter that is not at the very start', () => {
  const src = `<!DOCTYPE html>
<!-- meta: title="X" -->`;
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
