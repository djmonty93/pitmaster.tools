#!/usr/bin/env node
/**
 * generate-metros.js — emit one HTML page per Best-Smoke-Days metro into
 * _src/smoke-weather/<slug>.html before build.js runs.
 *
 * Step 12 populates METROS and renders real content. Step 1 keeps the
 * script idempotent and no-op so `npm run build` chains cleanly.
 *
 * Usage: node scripts/generate-metros.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const OUT_DIR = path.join('_src', 'smoke-weather');

// TODO(Step 12): replace with the 50-metro array sourced from D1 seed.
const METROS = [];

fs.mkdirSync(OUT_DIR, { recursive: true });

if (METROS.length === 0) {
  console.log('generate-metros: 0 metros configured — run `npm run build` will skip emission.');
  process.exit(0);
}

let written = 0;
for (const metro of METROS) {
  const out = path.join(OUT_DIR, metro.slug + '.html');
  fs.writeFileSync(out, renderMetro(metro));
  written++;
}
console.log('generate-metros: wrote ' + written + ' metro pages → ' + OUT_DIR + '/');

function renderMetro(_metro) {
  throw new Error('renderMetro: not implemented — wired in Step 12');
}
