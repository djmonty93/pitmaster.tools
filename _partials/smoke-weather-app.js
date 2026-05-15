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

  function renderVerdictHero(forecast) {
    var hero = $('verdictHero');
    if (!hero) return;
    var best = pickBestDay(forecast.days);
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
      '<div class="verdict-hero__label">Best day in the next ' + Number(forecast.days.length) + ' days</div>' +
      '<h2 class="verdict-hero__verdict">' + escapeHtml(verdict) + ' &mdash; ' + escapeHtml(formatDateLabel(best.date)) + '</h2>' +
      '<div class="verdict-hero__meta">' +
        '<span>Score <strong>' + Number(best.score.score) + '</strong>/100</span>' +
        '<span>High ' + fmtNum(best.day.tempHighF) + '&deg;F / Low ' + fmtNum(best.day.tempLowF) + '&deg;F</span>' +
        '<span>' + escapeHtml(locLabel) + '</span>' +
      '</div>' +
      '<div class="verdict-hero__source">Source: ' + escapeHtml(sourceLabel) + '</div>';
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
      '<div class="day-card__confidence is-' + escapeHtml(entry.score.confidence) + '">Confidence: ' + escapeHtml(entry.score.confidence) + '</div>';
    return article;
  }

  function renderDayCards(forecast) {
    var grid = $('dayCards');
    if (!grid) return;
    grid.innerHTML = '';
    // Filter out malformed days (missing or bad ISO date) before
    // rendering — a day without a date can't get a stable
    // `data-date` selector and is useless to the user anyway.
    var clean = [];
    for (var i = 0; i < forecast.days.length; i++) {
      if (isValidIsoDate(forecast.days[i].date)) clean.push(forecast.days[i]);
    }
    var bestDate = pickBestDay(clean);
    var bestKey = bestDate ? bestDate.date : null;
    for (var j = 0; j < clean.length; j++) {
      var entry = clean[j];
      grid.appendChild(renderDayCard(entry, entry.date === bestKey));
    }
  }

  function renderForecast(forecast) {
    setStatus('', false);
    renderVerdictHero(forecast);
    renderDayCards(forecast);
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

    return fetch(buildUrl(zip, cut, cooker), {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      credentials: 'omit',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (timeoutId) clearTimeout(timeoutId);
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
      // A user-initiated abort (newer request supersedes this one)
      // shows up as AbortError but `inflightCtrl` will already point
      // at a different controller — drop silently in that case.
      if (err && err.name === 'AbortError') {
        if (inflightCtrl !== ctrl) return;
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
