/* smoke-weather-app.js — F8/F9/F10/F11/F12 client renderer.
   Inlined at build time via the smoke-weather-app.js script partial.

   Responsibilities:
     - Read zip from input or localStorage (F9 zip memory).
     - Read cooker/cut from <select>s, persist to localStorage (F7 cooker
       toggle, plus cut for symmetry).
     - Fetch /api/forecast?zip&cut&cooker; on success, render verdict
       hero + day cards (F8/F11). On failure, render an inline error.
     - Lean DOM: no framework, matches the rest of the site's vanilla
       JS calculators (F12 perf).

   Geo-IP (F10) is the worker's job: when the user submits with no zip
   the request goes out without ?zip and the worker fills it from
   request.cf.postalCode. The response comes back with the resolved
   zip, which we then write into the input + localStorage so future
   loads skip the geo-IP path entirely.

   WeatherScore (from weather-score-shared.js) is loaded ahead of this
   file but is currently used only as a parity reference — re-scoring
   client-side without re-fetching is reserved for a follow-up step
   (cut/cooker toggle without a roundtrip). For v1 every change
   triggers a worker call so caching stays effective and the response
   stays canonical. */

(function () {
  'use strict';

  var ZIP_KEY    = 'pitmaster_zip';
  var COOKER_KEY = 'pitmaster_cooker';
  var CUT_KEY    = 'pitmaster_cut';

  var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function $(id) { return document.getElementById(id); }

  function getStored(key) {
    try { return localStorage.getItem(key); } catch (err) { return null; }
  }
  function setStored(key, value) {
    try { localStorage.setItem(key, value); } catch (err) { /* private mode */ }
  }

  function isValidUSZip(zip) {
    return typeof zip === 'string' && /^\d{5}$/.test(zip);
  }

  function isValidIsoDate(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  }

  // Format a number for display, returning an em dash when the
  // upstream day omitted the field. NWS partial responses can leave
  // tempLowF / gustMphMax undefined, and Math.round(undefined) is NaN —
  // we don't want "NaN°F" leaking onto the page.
  function fmtNum(v) {
    return Number.isFinite(v) ? String(Math.round(v)) : '—';
  }

  // YYYY-MM-DD → "Sat, May 16". Built without the Date constructor on
  // the date-only string because Safari/Chrome disagree on whether
  // YYYY-MM-DD is parsed as UTC midnight or local midnight, and that
  // can shift the displayed weekday by one day.
  function formatDateLabel(iso) {
    var parts = iso.split('-');
    if (parts.length !== 3) return iso;
    var y = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10) - 1;
    var d = parseInt(parts[2], 10);
    var localDate = new Date(y, m, d);
    return DAY_NAMES[localDate.getDay()] + ', ' + MONTH_NAMES[m] + ' ' + d;
  }

  function setStatus(message, isError) {
    var el = $('swStatus');
    if (!el) return;
    if (!message) {
      el.hidden = true;
      el.textContent = '';
      el.classList.remove('error');
      return;
    }
    el.hidden = false;
    el.textContent = message;
    el.classList.toggle('error', !!isError);
  }

  function clearResults() {
    var hero = $('verdictHero');
    var grid = $('dayCards');
    if (hero) { hero.hidden = true; hero.className = 'verdict-hero'; }
    if (grid) grid.innerHTML = '';
  }

  // Tie-break: strict `>` keeps the EARLIEST day on a tie, since the
  // user wants the soonest opportunity to cook when conditions are
  // equally good. Don't change to `>=` without updating the e2e fixture
  // and the verdict-hero copy.
  function pickBestDay(days) {
    var best = null;
    for (var i = 0; i < days.length; i++) {
      var d = days[i];
      if (!best || d.score.score > best.score.score) best = d;
    }
    return best;
  }

  function renderVerdictHero(forecast, days) {
    var hero = $('verdictHero');
    if (!hero) return;
    var best = pickBestDay(days);
    if (!best) {
      hero.hidden = true;
      return;
    }
    var bandClass = 'band-' + best.score.band;
    hero.className = 'verdict-hero ' + bandClass;
    hero.hidden = false;

    var verdict;
    if (best.score.band === 'ideal') verdict = 'Ideal smoke day';
    else if (best.score.band === 'green') verdict = 'Good smoke day';
    else if (best.score.band === 'yellow') verdict = 'Workable, plan ahead';
    else verdict = 'Tough conditions';

    // `forecast.metro` and `forecast.zip` are server-derived but still
    // funnel into innerHTML; escape both as defense-in-depth so a
    // malformed upstream response can't inject markup. `forecast.days
    // .length` and `best.score.score` are numeric (Number()), safe.
    var locLabel = forecast.metro ? forecast.metro : 'ZIP ' + forecast.zip;
    var sourceLabel = forecast.source === 'nws' ? 'National Weather Service' : 'Open-Meteo';
    hero.innerHTML =
      '<div class="verdict-hero__label">Best day in the next ' + Number(days.length) + ' days</div>' +
      '<h2 class="verdict-hero__verdict">' + escapeHtml(verdict) + ' &mdash; ' + escapeHtml(formatDateLabel(best.date)) + '</h2>' +
      '<div class="verdict-hero__meta">' +
        '<span>Score <strong>' + Number(best.score.score) + '</strong>/100</span>' +
        '<span>High ' + fmtNum(best.day.tempHighF) + '&deg;F / Low ' + fmtNum(best.day.tempLowF) + '&deg;F</span>' +
        '<span>' + escapeHtml(locLabel) + '</span>' +
      '</div>' +
      '<div class="verdict-hero__source">Source: ' + escapeHtml(sourceLabel) + '</div>';
  }

  // Confidence-pill tooltip text (F3). Same wording shown across all
  // day cards — kept short so the native `title` tooltip pops cleanly
  // on desktop and on mobile long-press.
  var CONFIDENCE_TOOLTIP =
    'Forecast certainty: high (next 1-2 days), medium (3-4 days), low (5+ days).';

  // Dew-point tooltip (F4). Pinned to 60 °F because that's the stall
  // threshold the scoring engine uses for long-cook cuts (brisket,
  // pork butt, ribs). Don't change without updating scoring.ts in
  // lockstep — the number on screen has to match the engine's logic.
  var DEWPOINT_TOOLTIP =
    'Dew point above ~60 °F slows evaporative cooling and lengthens the stall on long cuts.';

  function fmtHour(t) {
    // Both feeds put HH at offset 11-13 of the ISO string:
    //   Open-Meteo (timezone=auto) → '2026-05-15T08:00'
    //   NWS                         → '2026-05-15T08:00:00-05:00'
    // Slicing avoids constructing a Date in the user's tz, which
    // would shift the hour off by their UTC offset for the NWS path.
    if (typeof t !== 'string' || t.length < 13 || t.charAt(10) !== 'T') return '';
    var hh = parseInt(t.slice(11, 13), 10);
    if (!Number.isFinite(hh) || hh < 0 || hh > 23) return '';
    var period = hh < 12 ? 'AM' : 'PM';
    var h12 = hh % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ' ' + period;
  }

  function renderHourlyTable(hours) {
    if (!Array.isArray(hours) || hours.length === 0) {
      return '<p class="day-card__hourly-empty">No hourly data for this day.</p>';
    }
    // Numeric fields go through fmtNum so a null/undefined value (NWS
    // partial responses) renders as an em dash, never "NaN".
    var rows = '';
    for (var i = 0; i < hours.length; i++) {
      var h = hours[i];
      rows +=
        '<tr>' +
          '<th scope="row">' + escapeHtml(fmtHour(h.t)) + '</th>' +
          '<td>' + fmtNum(h.tempF) + '&deg;F</td>' +
          '<td>' + fmtNum(h.windMph) + '/' + fmtNum(h.gustMph) + '</td>' +
          '<td>' + fmtNum(h.precipProbPct) + '%</td>' +
          '<td>' + fmtNum(h.dewPointF) + '&deg;F</td>' +
        '</tr>';
    }
    // Scroll container wraps the table instead of `display: block` on
    // the table itself — keeps native <table> semantics intact for
    // screen readers while still giving narrow phones a horizontal
    // overflow escape hatch.
    return (
      '<div class="hourly-table-scroll">' +
        '<table class="hourly-table">' +
          '<thead>' +
            '<tr>' +
              '<th scope="col">Hour</th>' +
              '<th scope="col">Temp</th>' +
              '<th scope="col">Wind/Gust</th>' +
              '<th scope="col">Rain</th>' +
              '<th scope="col">Dew</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>' +
      '</div>'
    );
  }

  function renderDayCard(entry, isBest) {
    var bandClass = 'band-' + entry.score.band;
    var article = document.createElement('article');
    article.className = 'day-card ' + bandClass + (isBest ? ' is-best' : '');
    // Date is validated by the caller, but assigning via setAttribute
    // is safe even if it weren't — no HTML parsing happens for an
    // attribute value.
    article.setAttribute('data-date', entry.date);

    var reasonsHtml = '';
    var reasons = entry.score.reasons.slice(0, 3);
    for (var i = 0; i < reasons.length; i++) {
      reasonsHtml += '<li>' + escapeHtml(reasons[i]) + '</li>';
    }

    article.innerHTML =
      '<div class="day-card__date">' + escapeHtml(formatDateLabel(entry.date)) + '</div>' +
      '<div class="day-card__score">' +
        '<span class="day-card__score-num">' + Number(entry.score.score) + '</span>' +
        '<span class="day-card__score-band">' + escapeHtml(entry.score.band) + '</span>' +
      '</div>' +
      '<div class="day-card__temps">' + fmtNum(entry.day.tempHighF) + '&deg;F / ' + fmtNum(entry.day.tempLowF) + '&deg;F &middot; gust ' + fmtNum(entry.day.gustMphMax) + ' mph</div>' +
      '<ul class="day-card__reasons">' + reasonsHtml + '</ul>' +
      // Dew-point + confidence both rely on a native title for mouse
      // hover, AND embed the same wording in a visually-hidden span
      // so assistive tech reliably announces the explanation. title
      // alone is unreliable for screen readers and unreachable for
      // keyboard-only users without pointer hover.
      '<div class="day-card__dewpoint" title="' + escapeHtml(DEWPOINT_TOOLTIP) + '">Dew point ' + fmtNum(entry.day.dewPointMeanF) + '&deg;F<span class="sw-sr-only"> — ' + escapeHtml(DEWPOINT_TOOLTIP) + '</span></div>' +
      '<details class="day-card__hourly">' +
        '<summary>Hour-by-hour</summary>' +
        '<div class="day-card__hourly-body" data-hourly-pending="1"></div>' +
      '</details>' +
      '<div class="day-card__confidence is-' + escapeHtml(entry.score.confidence) + '" title="' + escapeHtml(CONFIDENCE_TOOLTIP) + '">Confidence: ' + escapeHtml(entry.score.confidence) + '<span class="sw-sr-only"> — ' + escapeHtml(CONFIDENCE_TOOLTIP) + '</span></div>';

    // Lazy-populate the hourly table on the first open (F5
    // progressive disclosure). Keeps initial DOM small — a 7-day
    // forecast with 24h each would otherwise add ~170 rows up front.
    // The data-hourly-pending guard makes the fill idempotent so
    // toggling open/closed/open does no extra work.
    var details = article.querySelector('.day-card__hourly');
    var body = article.querySelector('.day-card__hourly-body');
    if (details && body) {
      details.addEventListener('toggle', function () {
        if (!details.open) return;
        if (body.getAttribute('data-hourly-pending') !== '1') return;
        body.removeAttribute('data-hourly-pending');
        body.innerHTML = renderHourlyTable(entry.day.hourly);
      });
    }
    return article;
  }

  function renderDayCards(days) {
    var grid = $('dayCards');
    if (!grid) return;
    grid.innerHTML = '';
    var bestDate = pickBestDay(days);
    var bestKey = bestDate ? bestDate.date : null;
    for (var j = 0; j < days.length; j++) {
      var entry = days[j];
      grid.appendChild(renderDayCard(entry, entry.date === bestKey));
    }
  }

  function renderForecast(forecast) {
    // Filter out malformed days (missing or bad ISO date) ONCE up
    // front, then use the filtered list for both the verdict hero
    // and the day cards. Filtering inside renderDayCards but not
    // renderVerdictHero would let the hero advertise a "best day"
    // whose card never renders.
    var clean = [];
    for (var i = 0; i < forecast.days.length; i++) {
      if (isValidIsoDate(forecast.days[i].date)) clean.push(forecast.days[i]);
    }
    setStatus('', false);
    renderVerdictHero(forecast, clean);
    renderDayCards(clean);
  }

  function buildUrl(zip, cut, cooker) {
    var p = new URLSearchParams();
    if (zip) p.set('zip', zip);
    if (cut) p.set('cut', cut);
    if (cooker) p.set('cooker', cooker);
    var qs = p.toString();
    return '/api/forecast' + (qs ? '?' + qs : '');
  }

  function errorMessage(status, body) {
    if (body && body.error) {
      if (body.error === 'unknown_zip') return 'We could not look up that ZIP. Double-check the 5 digits.';
      if (body.error === 'missing_zip') return 'Enter a 5-digit US ZIP to get your forecast.';
      if (body.error === 'invalid_cut' || body.error === 'invalid_cooker') return 'Pick a valid cut and cooker.';
      if (body.error === 'weather_unavailable') return 'Weather sources are temporarily unavailable. Try again in a moment.';
      if (body.error === 'geocoder_unavailable') return 'ZIP lookup is offline. Try again shortly.';
    }
    if (status >= 500) return 'Server error. Try again in a moment.';
    return 'Something went wrong fetching the forecast.';
  }

  // Module-scoped controller so a rapid cut/cooker toggle aborts the
  // previous in-flight request before starting a new one. Without
  // this, a slow first response can land AFTER the second and
  // overwrite the DOM with stale day cards.
  var inflightCtrl = null;

  function loadForecast(opts) {
    var zip = opts.zip || '';
    var cut = opts.cut;
    var cooker = opts.cooker;
    setStatus('Loading forecast…', false);
    clearResults();

    if (inflightCtrl) {
      try { inflightCtrl.abort(); } catch (e) { /* already settled */ }
    }
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    inflightCtrl = ctrl;
    var timeoutId = null;
    if (ctrl) {
      timeoutId = setTimeout(function () { ctrl.abort(); }, 12000);
    }

    function clearPendingTimeout() {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    }

    return fetch(buildUrl(zip, cut, cooker), {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      credentials: 'omit',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      clearPendingTimeout();
      return res.json().catch(function () { return null; }).then(function (body) {
        if (!res.ok) {
          throw { status: res.status, body: body };
        }
        return body;
      });
    }).then(function (forecast) {
      if (!forecast || !Array.isArray(forecast.days) || forecast.days.length === 0) {
        throw { status: 502, body: { error: 'weather_unavailable' } };
      }
      // Persist the resolved zip ONLY when the request was made without
      // an explicit zip — i.e. the geo-IP fallback path. When the user
      // supplied a zip we already stored it before sending and must not
      // overwrite it, since the server might echo a normalized form
      // (or in tests, a fixture value).
      if (!zip && forecast.zip) {
        setStored(ZIP_KEY, forecast.zip);
        var input = $('zipInput');
        if (input && !input.value) input.value = forecast.zip;
      }
      // Only commit a render if this fetch is still the active one.
      // A newer request may have already aborted us during a rapid
      // cut/cooker change; in that case the newer call owns the DOM.
      if (inflightCtrl === ctrl) renderForecast(forecast);
    }).catch(function (err) {
      // Always clear the pending 12s timer on the failure path so a
      // superseded fetch doesn't leak a no-op abort up to 12 seconds
      // later on a controller that's already settled.
      clearPendingTimeout();
      // Any error from a superseded request must be dropped silently —
      // surfacing a stale 503 (or AbortError, or timeout) on top of a
      // newer successful render would tell the user the page failed
      // when in fact it just succeeded with newer parameters. The
      // active request is the only one that owns #swStatus.
      if (inflightCtrl !== ctrl) return;
      if (err && err.name === 'AbortError') {
        setStatus('The forecast request timed out. Check your connection and try again.', true);
        return;
      }
      var status = (err && err.status) || 0;
      var body = err && err.body;
      setStatus(errorMessage(status, body), true);
    });
  }

  function handleSubmit(e) {
    if (e) e.preventDefault();
    var zipEl = $('zipInput');
    var cutEl = $('cutSelect');
    var cookerEl = $('cookerSelect');
    var zip = zipEl ? zipEl.value.trim() : '';
    var cut = cutEl ? cutEl.value : '';
    var cooker = cookerEl ? cookerEl.value : '';

    if (zip && !isValidUSZip(zip)) {
      // Cancel any in-flight auto-load and wipe any prior render so the
      // user doesn't see the validation error stacked on top of a
      // forecast for a different zip. Drop inflightCtrl to null AFTER
      // aborting so the in-flight catch path also sees `inflightCtrl
      // !== ctrl` and stays silent.
      if (inflightCtrl) {
        try { inflightCtrl.abort(); } catch (e) { /* already settled */ }
        inflightCtrl = null;
      }
      clearResults();
      setStatus('Enter a valid 5-digit US ZIP code.', true);
      return;
    }
    if (zip) setStored(ZIP_KEY, zip);
    if (cut) setStored(CUT_KEY, cut);
    if (cooker) setStored(COOKER_KEY, cooker);
    loadForecast({ zip: zip, cut: cut, cooker: cooker });
  }

  function init() {
    var form = $('swForm');
    if (!form) return;
    var zipEl = $('zipInput');
    var cutEl = $('cutSelect');
    var cookerEl = $('cookerSelect');

    var savedZip    = getStored(ZIP_KEY);
    var savedCut    = getStored(CUT_KEY);
    var savedCooker = getStored(COOKER_KEY);
    if (zipEl    && savedZip    && isValidUSZip(savedZip)) zipEl.value = savedZip;
    if (cutEl    && savedCut)                              cutEl.value = savedCut;
    if (cookerEl && savedCooker)                           cookerEl.value = savedCooker;

    form.addEventListener('submit', handleSubmit);

    // Re-fetch on cut/cooker change so the verdict tracks the user's
    // current selection without requiring a manual submit.
    [cutEl, cookerEl].forEach(function (el) {
      if (!el) return;
      el.addEventListener('change', function () { handleSubmit(); });
    });

    // Auto-load on first paint:
    //   - If we have a stored or pre-filled valid zip, fetch with it.
    //   - If we don't, send the request without a zip and let the
    //     worker fill from request.cf.postalCode (geo-IP, F10).
    var initialZip = zipEl && zipEl.value.trim();
    var initialCut = cutEl ? cutEl.value : '';
    var initialCooker = cookerEl ? cookerEl.value : '';
    loadForecast({ zip: initialZip, cut: initialCut, cooker: initialCooker });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
