#!/usr/bin/env node
/**
 * generate-metros.js — emit one HTML page per Best-Smoke-Days metro into
 * _src/smoke-weather/<slug>.html before build.js runs.
 *
 * Step 12 populates METROS and renders real content. Step 1 keeps the
 * script idempotent and no-op so `npm run build` chains cleanly.
 *
 * Stale-page guard: every emitted file carries the marker below in an HTML
 * comment. Before re-emitting we delete any file in OUT_DIR that contains
 * the marker, so removing a metro from METROS also removes its dist page.
 * Hand-authored pages in OUT_DIR (index.html, methodology.html, …) lack
 * the marker and are left untouched.
 *
 * Usage: node scripts/generate-metros.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const OUT_DIR = path.join('_src', 'smoke-weather');
const GENERATED_MARKER = '<!-- generated:best-smoke-days-metro -->';

// TODO(Step 12): replace with the 50-metro array sourced from D1 seed.
const METROS = [];

fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Sweep prior generated pages so removed metros don't ship stale ──────────
let swept = 0;
for (const name of fs.readdirSync(OUT_DIR)) {
  if (!name.endsWith('.html')) continue;
  const full = path.join(OUT_DIR, name);
  let head;
  try {
    const fd = fs.openSync(full, 'r');
    const buf = Buffer.alloc(256);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.slice(0, bytesRead).toString('utf8');
  } catch {
    continue;
  }
  if (head.includes(GENERATED_MARKER)) {
    fs.unlinkSync(full);
    swept++;
  }
}
if (swept > 0) {
  console.log('generate-metros: removed ' + swept + ' stale generated page(s) from ' + OUT_DIR + '/');
}

if (METROS.length === 0) {
  console.log('generate-metros: 0 metros configured — emission skipped.');
  process.exit(0);
}

let written = 0;
for (const metro of METROS) {
  const out = path.join(OUT_DIR, metro.slug + '.html');
  // The marker is prepended here (not inside renderMetro) so the sweep above
  // is guaranteed to recognize anything this loop wrote, even if a future
  // template forgets it.
  fs.writeFileSync(out, GENERATED_MARKER + '\n' + renderMetro(metro));
  written++;
}
console.log('generate-metros: wrote ' + written + ' metro pages → ' + OUT_DIR + '/');

function renderMetro(_metro) {
  throw new Error('renderMetro: not implemented — wired in Step 12');
}
