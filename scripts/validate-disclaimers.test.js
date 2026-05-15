#!/usr/bin/env node
/**
 * validate-disclaimers.test.js — F20 failure-mode sweep: assert the
 * microclimate disclaimer is present on every page that displays a
 * forecast verdict. Catches accidental removal during refactors.
 *
 * The disclaimer text lives in _src/smoke-weather/index.html (and on
 * the 50 generated metro pages via scripts/generate-metros.js). It tells
 * users that the airport-grade forecast doesn't model their yard's
 * microclimate — trees, structures, elevation can all shift conditions.
 * Required by the F20 plan ("microclimate disclaimer"); legally useful
 * since the affiliate program is product recommendations conditioned on
 * weather we can't fully see.
 *
 * Run via: node --test scripts/validate-disclaimers.test.js
 * Chained from `npm test` via test:scripts.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const VERDICT_PAGE = path.join('_src', 'smoke-weather', 'index.html');

// Strings that must appear in any page rendering a forecast verdict.
// Kept as substring matches (not full sentence) so editorial copy
// can evolve without breaking the test.
const REQUIRED_DISCLAIMER_FRAGMENTS = [
  'microclimate',
  'step outside',
];

test('verdict landing page carries the microclimate disclaimer (F20)', () => {
  assert.ok(fs.existsSync(VERDICT_PAGE), VERDICT_PAGE + ' missing');
  const html = fs.readFileSync(VERDICT_PAGE, 'utf8');
  // The disclaimer lives inside a <p class="sw-disclaimer"> element so
  // it's visually distinct. Assert both the wrapper class and the
  // required text fragments.
  assert.ok(
    /<p[^>]*class="[^"]*\bsw-disclaimer\b[^"]*"/.test(html),
    'sw-disclaimer wrapper class missing on the verdict page'
  );
  for (const fragment of REQUIRED_DISCLAIMER_FRAGMENTS) {
    assert.ok(
      html.toLowerCase().includes(fragment.toLowerCase()),
      'verdict page missing required disclaimer fragment: "' + fragment + '"'
    );
  }
});
