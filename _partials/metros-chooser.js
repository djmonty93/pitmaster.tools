/* metros-chooser.js — /smoke-weather/metros/ tile populate + filter.

   Tile skeletons are emitted at build time by scripts/generate-metros.js
   (one anchor per metro with data-slug / data-zip / data-name /
   data-state attributes). This file fetches the aggregate /api/metros
   payload, finds the matching tile, and fills in the score + best-day
   text. On fetch failure, the skeleton "Score loading…" copy stays
   visible so navigation still works.

   Filter input toggles each tile's display by:
     • substring match against the metro name (so "orle" finds New
       Orleans, "kansas" finds Kansas City), and
     • prefix match against the 2-letter state code (so "ca" finds
       every California metro but "a" doesn't pull in NY/AZ/MA just
       because their state code contains "a").
   The asymmetry is intentional — state codes are short and almost
   always typed at the start of a query, while names need substring
   matching to be useful. 50 elements → no debounce needed. */

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  // escapeHtml() is the global defined in _partials/site-utils.js.
  // site-footer-smoke.html injects site-utils.js ahead of this script on
  // the /smoke-weather/metros/ page, so the global is defined before any
  // call here runs (load order pinned by a test in
  // scripts/generate-metros.test.js). Kept as one source instead of a
  // local copy — same pattern smoke-weather-app.js already uses.

  // Quality labels — byte-identical to the server chooser bandLabel in
  // worker/src/handlers/metrosChooser.ts (and the shared/client copies).
  // This client path renders when SSR hydration is absent (KV-degraded).
  function bandLabel(b) {
    if (b === 'ideal')  return 'Ideal';
    if (b === 'green')  return 'Good';
    if (b === 'yellow') return 'Average';
    if (b === 'red')    return 'Poor';
    return '';
  }

  // YYYY-MM-DD → "Sat May 16". Constructs the Date with explicit
  // y/m/d so Safari/Chrome don't disagree on UTC-vs-local midnight.
  function formatShortDate(iso) {
    if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
    var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var parts = iso.split('-');
    var d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    return DAYS[d.getDay()] + ' ' + MONTHS[d.getMonth()] + ' ' + d.getDate();
  }

  function applyTile(anchor, tile) {
    var bandClass = 'band-' + tile.todayBand;
    // Remove the pending-state class and any prior band class before
    // applying the fresh one so a hot-reload during dev doesn't leave
    // stale band-* classes accumulating on the element.
    anchor.classList.remove('band-pending', 'band-ideal', 'band-green', 'band-yellow', 'band-red');
    anchor.classList.add(bandClass);

    var scoreEl = anchor.querySelector('[data-role="today"]');
    if (scoreEl) {
      scoreEl.innerHTML =
        '<strong>' + Number(tile.todayScore) + '/100</strong> · ' + escapeHtml(bandLabel(tile.todayBand));
    }
    var bestEl = anchor.querySelector('[data-role="best"]');
    if (bestEl && tile.bestDay) {
      bestEl.textContent =
        'Best: ' + formatShortDate(tile.bestDay.date) + ' — ' + Number(tile.bestDay.score) + '/100';
    }
  }

  function loadAndPopulate() {
    return fetch('/api/metros', {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      credentials: 'omit',
    }).then(function (res) {
      if (!res.ok) throw new Error('http ' + res.status);
      return res.json();
    }).then(function (payload) {
      if (!payload || !Array.isArray(payload.metros)) return;
      var bySlug = {};
      for (var i = 0; i < payload.metros.length; i++) {
        bySlug[payload.metros[i].slug] = payload.metros[i];
      }
      var anchors = document.querySelectorAll('.metro-tile');
      for (var j = 0; j < anchors.length; j++) {
        var slug = anchors[j].getAttribute('data-slug');
        var tile = bySlug[slug];
        if (tile) applyTile(anchors[j], tile);
      }
    }).catch(function () {
      // Silent fail — tiles stay in skeleton state with their loading
      // copy intact. Navigation links still work, which is the minimum
      // viable degraded mode. We don't surface a banner because the
      // failure is recoverable on next page load (the aggregate is
      // CDN-cached for 5 min and refreshes nightly).
    });
  }

  function initFilter() {
    var input = $('metroSearch');
    if (!input) return;
    var help = $('metroSearchHelp');
    var anchors = document.querySelectorAll('.metro-tile');

    input.addEventListener('input', function () {
      var q = input.value.trim().toLowerCase();
      var visible = 0;
      for (var i = 0; i < anchors.length; i++) {
        var a = anchors[i];
        var name = (a.getAttribute('data-name') || '').toLowerCase();
        var state = (a.getAttribute('data-state') || '').toLowerCase();
        var match = q.length === 0 || name.indexOf(q) !== -1 || state.indexOf(q) === 0;
        a.style.display = match ? '' : 'none';
        if (match) visible++;
      }
      if (help) {
        if (q.length === 0) {
          help.hidden = true;
          help.textContent = '';
        } else {
          help.hidden = false;
          help.textContent = visible === 0
            ? 'No metros match "' + q + '".'
            : visible + ' ' + (visible === 1 ? 'metro' : 'metros') + ' shown.';
        }
      }
    });
  }

  function init() {
    initFilter();
    // SSR fast path: when the Worker handler `handleMetrosChooser` has
    // already filled in every tile's score + best day from the daily
    // KV aggregate, it drops a `<script id="metros-hydrated">` marker
    // into <main>. Skip the redundant /api/metros fetch in that case
    // (the response data would match the SSR exactly), but keep the
    // filter input wired up.
    if (document.getElementById('metros-hydrated')) return;
    loadAndPopulate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
