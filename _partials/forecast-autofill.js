/* forecast-autofill.js — map a Best Smoke Days forecast day onto the stall
   engine's ambient inputs, and (browser) fetch it on demand. Inlined via
   INJECT:forecast-autofill.js:script AFTER smoke-physics.js (needs spPSat/spF2C).
   Privacy: the fetch sends the user's zip / relies on edge geo-IP; it runs only
   on an explicit user action (see the calculators' "Use my local weather"
   button). Never writes pitmaster_zip. */
(function (root) {
  'use strict';

  /* Pure: forecast day (WeatherDay-shaped: tempHighF/tempLowF/dewPointMeanF/
     windMphMean) -> ambient inputs. Null for any field the day omits so the
     caller can skip it and keep the engine default. RH is derived from
     dewpoint via the Buck pSat already in smoke-physics (spPSat/spF2C) rather
     than trusting the forecast's own rhMean, so the UI's dewpoint field and
     the engine's RH stay on one derivation path. */
  function spForecastToAmbient(day) {
    var out = { ambientF: null, ambientRh: null, windMph: null, dewPointF: null };
    if (!day) return out;
    var hi = day.tempHighF, lo = day.tempLowF;
    var tempF = (typeof hi === 'number' && typeof lo === 'number') ? (hi + lo) / 2
              : (typeof hi === 'number' ? hi : (typeof lo === 'number' ? lo : null));
    if (tempF != null) out.ambientF = Math.round(tempF);
    var dp = day.dewPointMeanF;
    if (typeof dp === 'number') out.dewPointF = Math.round(dp);
    if (tempF != null && typeof dp === 'number' && typeof spPSat === 'function') {
      var rh = 100 * spPSat(spF2C(dp)) / spPSat(spF2C(tempF));
      out.ambientRh = Math.min(100, Math.max(1, Math.round(rh)));
    }
    // Wind: WeatherDay carries windMphMean (confirmed in packages/shared/src/types.ts).
    var w = (typeof day.windMphMean === 'number') ? day.windMphMean : null;
    if (w != null) out.windMph = Math.round(w);
    return out;
  }

  /* Browser: fetch today's forecast and apply it. opts.onApply(ambient) gets
     the mapped object with null fields removed; opts.onError(msg) on any
     failure. Reads a saved zip if present but never writes one.

     ForecastResponse.days is Array<{ date, day: WeatherDay, score }> (see
     packages/shared/src/types.ts) — each array entry is a wrapper, not the
     WeatherDay itself, so we unwrap entry.day before mapping. */
  function spUseLocalForecast(opts) {
    opts = opts || {};
    var zip = '';
    try { zip = (root.localStorage && root.localStorage.getItem('pitmaster_zip')) || ''; } catch (e) { zip = ''; }
    var qs = [];
    if (zip) qs.push('zip=' + encodeURIComponent(zip));
    if (opts.cooker) qs.push('cooker=' + encodeURIComponent(opts.cooker));
    if (opts.cut) qs.push('cut=' + encodeURIComponent(opts.cut));
    qs.push('days=1');
    if (opts.onStart) opts.onStart();
    return fetch('/api/forecast' + (qs.length ? '?' + qs.join('&') : ''))
      .then(function (r) { if (!r.ok) throw new Error('forecast ' + r.status); return r.json(); })
      .then(function (data) {
        var days = data && data.days;
        var entry = days && days.length ? days[0] : null;
        var day = entry && entry.day;
        if (!day) throw new Error('no forecast day');
        var amb = spForecastToAmbient(day);
        var clean = {};
        if (amb.ambientF != null) clean.ambientF = amb.ambientF;
        if (amb.dewPointF != null) clean.dewPointF = amb.dewPointF;
        if (amb.windMph != null) clean.windMph = amb.windMph;
        if (opts.onApply) opts.onApply(clean);
      })
      .catch(function (err) {
        if (opts.onError) opts.onError('Could not load local weather. Enter conditions manually.');
      });
  }

  var api = { spForecastToAmbient: spForecastToAmbient, spUseLocalForecast: spUseLocalForecast };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  else { root.spForecastToAmbient = spForecastToAmbient; root.spUseLocalForecast = spUseLocalForecast; }
})(typeof self !== 'undefined' ? self : this);
