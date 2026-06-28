#!/usr/bin/env node
/**
 * generate-guides.js — regenerates every date-gated, derived guides artifact
 * from the guide source files, then exits. Wired into `npm run build` BEFORE
 * `node build.js` (same slot as build:metros), so build.js always sees a fresh
 * nav menu / hub grids / sitemap / llms reflecting today's live set.
 *
 * Reads:   _src/guides/**.html (frontmatter only)
 * Writes:  _partials/site-header-guides-menu.html   (generated; gitignored)
 *          _partials/guides-hub-grid.html            (generated; gitignored)
 *          _partials/guides-cat-<slug>-grid.html     (one per category hub; gitignored)
 *          sitemap.xml  (GUIDES marked block, in place)
 *          llms.txt     (GUIDES marked block, in place)
 *
 * "Live" = published date today-or-earlier (UTC). Future-dated guides are
 * skipped everywhere here AND withheld from dist by build.js, so they stay
 * invisible until a scheduled rebuild crosses their date.
 *
 * Determinism: output depends only on (guide files, today). Date can be pinned
 * via GUIDES_TODAY=YYYY-MM-DD for reproducible builds / testing.
 *
 * All writes use '\n' newlines to avoid CRLF churn on Windows checkouts.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./guides-lib.js');

const SRC = '_src';
const PARTIALS = '_partials';
const GUIDES_SRC = path.join(SRC, 'guides');

function writeLf(file, content) {
  fs.writeFileSync(file, content.replace(/\r\n/g, '\n'));
}

// Discover category hubs that physically exist (_src/guides/<slug>/index.html),
// preserving CATEGORIES order. Each needs a generated grid partial, and the top
// hub links only to these.
function existingCategoryHubs() {
  return lib.CATEGORIES.filter((c) =>
    fs.existsSync(path.join(GUIDES_SRC, c.slug, 'index.html'))
  );
}

// Best-effort warning: a live guide must not link to a still-scheduled guide
// (that target won't exist in dist, and validate.mjs would fail the build).
function warnCrossLinksToScheduled(allGuides) {
  const scheduledUrls = new Set(
    allGuides.filter((g) => !g.live).map((g) => '/guides/' + g.category + '/' + g.slug)
  );
  if (scheduledUrls.size === 0) return;
  for (const g of allGuides) {
    if (!g.live) continue;
    const html = fs.readFileSync(path.join(SRC, g.rel), 'utf8');
    for (const url of scheduledUrls) {
      if (html.includes('href="' + url + '"')) {
        console.warn(
          'WARN generate-guides: live guide ' + g.rel + ' links to scheduled guide ' +
          url + ' — that page is not built yet and will fail validation. Remove the link ' +
          'or bring the target forward.'
        );
      }
    }
  }
}

function run() {
  const today = process.env.GUIDES_TODAY || lib.todayUTC();
  const all = lib.scanGuides(SRC, today);
  const live = all.filter((g) => g.live);

  // 1) Nav mega-menu (injected by every site-header* variant).
  writeLf(path.join(PARTIALS, 'site-header-guides-menu.html'), lib.renderNavMenu(live));

  // 2) Top hub grid — only categories whose hub page exists.
  const hubs = existingCategoryHubs();
  writeLf(path.join(PARTIALS, 'guides-hub-grid.html'), lib.renderHubGrid(hubs));

  // 3) One grid partial per existing category hub.
  for (const c of hubs) {
    writeLf(
      path.join(PARTIALS, 'guides-cat-' + c.slug + '-grid.html'),
      lib.renderCategoryGrid(live, c.slug)
    );
  }

  // 4) sitemap.xml + llms.txt managed blocks (in place).
  const sitemapPath = 'sitemap.xml';
  writeLf(sitemapPath, lib.replaceMarkedBlock(
    fs.readFileSync(sitemapPath, 'utf8'), 'GUIDES', lib.renderSitemapBlock(live, today)
  ));
  const llmsPath = 'llms.txt';
  writeLf(llmsPath, lib.replaceMarkedBlock(
    fs.readFileSync(llmsPath, 'utf8'), 'GUIDES', lib.renderLlmsBlock(live)
  ));

  warnCrossLinksToScheduled(all);

  console.log(
    'Generated guides artifacts: ' + live.length + ' live / ' + all.length +
    ' total guides, ' + hubs.length + ' category hub(s) [today=' + today + ']'
  );
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

module.exports = { run, existingCategoryHubs };
