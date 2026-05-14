/* weather-score-shared.js — browser-side mirror of
   packages/shared/src/scoring.ts. Injected via
   <!-- INJECT:weather-score-shared.js:script --> into every smoke-weather
   page so the client can re-score on cut/cooker toggle without a worker
   round-trip.

   Behavior is pinned to the TS source by
   worker/tests/unit/weather/scoring-parity.test.ts which runs both
   implementations on the same fixtures and asserts identical scores.

   IIFE pattern matches site-utils.js / smoke-physics.js: exposes a
   global namespace, no module loader required. */
(function (root) {
  'use strict';

  // ── Physics: wet-bulb (Stull 2011). Identical to smoke-physics.js. ─
  function wetBulbF(Tdb_F, rh) {
    var T = (Tdb_F - 32) * 5 / 9;
    var tw = T * Math.atan(0.151977 * Math.pow(rh + 8.313659, 0.5))
      + Math.atan(T + rh)
      - Math.atan(rh - 1.676331)
      + 0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh)
      - 4.686035;
    return tw * 9 / 5 + 32;
  }

  var COOKER_RH = {
    offset:   4,
    pellet:   12,
    kamado:   25,
    kettle:   18,
    electric: 45
  };

  var COOKER_WIND_SENSITIVITY = {
    offset:   1.5,
    pellet:   1.0,
    kettle:   1.2,
    kamado:   0.5,
    electric: 0.1
  };

  var ALL_CUTS = {
    'brisket-flat':       true,
    'brisket-packer':     true,
    'pork-butt':          true,
    'spare-ribs':         true,
    'baby-back-ribs':     true,
    'pork-loin':          true,
    'whole-chicken':      true,
    'spatchcock-chicken': true,
    'chicken-thighs':     true,
    'whole-turkey':       true,
    'turkey-breast':      true,
    'fish':               true,
    'lamb-shoulder':      true
  };

  var STALL_SENSITIVE = {
    'brisket-flat':    true,
    'brisket-packer':  true,
    'pork-butt':       true,
    'spare-ribs':      true,
    'baby-back-ribs':  true,
    'lamb-shoulder':   true
  };

  var PIT_TEMP_F = 225;

  function clamp(x, lo, hi) {
    if (x < lo) return lo;
    if (x > hi) return hi;
    return x;
  }
  function clamp01(x) { return clamp(x, 0, 1); }

  function bandFor(score) {
    if (score >= 85) return 'ideal';
    if (score >= 70) return 'green';
    if (score >= 50) return 'yellow';
    return 'red';
  }

  function scoreDay(input) {
    var cut = input.cut;
    var cooker = input.cooker;
    var day = input.day;
    var reasons = [];

    // Defensive swap if a malformed adapter inverts the day's envelope.
    var tempHigh = Math.max(day.tempHighF, day.tempLowF);
    var tempLow  = Math.min(day.tempHighF, day.tempLowF);

    var precipPenalty = clamp01(
      (day.precipProbPct / 100) * (1 + day.precipIn * 0.5)
    ) * 40;
    if (day.precipProbPct >= 60) {
      reasons.push('High chance of rain (' + Math.round(day.precipProbPct) + '%)');
    } else if (day.precipIn >= 0.25) {
      reasons.push('Heavy rain expected (' + day.precipIn.toFixed(2) + '")');
    }

    // No silent default — an unknown cooker / cut is a contract violation
    // that the API layer is responsible for catching. Use hasOwnProperty
    // so a malicious "toString" / "__proto__" value can't slip through
    // the prototype chain (mirrors the guard in scoring.ts).
    if (!Object.prototype.hasOwnProperty.call(COOKER_WIND_SENSITIVITY, cooker)) {
      throw new Error('unknown cooker: ' + cooker);
    }
    if (!Object.prototype.hasOwnProperty.call(ALL_CUTS, cut)) {
      throw new Error('unknown cut: ' + cut);
    }
    var windSensitivity = COOKER_WIND_SENSITIVITY[cooker];
    // NWS hourly forecasts commonly omit windGust; the adapter turns
    // that into gustMphMax = 0 while preserving the sustained wind in
    // windMphMean. Detect the absent-not-zero case and fall back to
    // windMphMean × 1.4 (CONUS inland gust factor); otherwise trust
    // the reported gust verbatim.
    var effectiveGust = day.gustMphMax > 0 ? day.gustMphMax : day.windMphMean * 1.4;
    var windRaw = Math.max(0, (effectiveGust - 10) / 25);
    var windPenalty = clamp01(windRaw) * 20 * windSensitivity;
    if (effectiveGust >= 25) {
      reasons.push('Gusts to ' + Math.round(effectiveGust) + ' mph (' + cooker + ' sensitivity)');
    }

    var coldPenalty = Math.max(0, (40 - tempLow) / 30) * 15;
    var hotPenalty = Math.max(0, (tempHigh - 90) / 20) * 15;
    if (coldPenalty > 0) reasons.push('Cold start (' + Math.round(tempLow) + ' °F low)');
    if (hotPenalty > 0) reasons.push('Hot afternoon (' + Math.round(tempHigh) + ' °F high)');

    if (!Object.prototype.hasOwnProperty.call(COOKER_RH, cooker)) {
      throw new Error('unknown cooker: ' + cooker);
    }
    var cookerBaseRh = COOKER_RH[cooker];
    var cookerCavityRh = clamp(cookerBaseRh + day.rhMean * 0.15, 0, 100);
    var wb = wetBulbF(PIT_TEMP_F, cookerCavityRh);
    var stallRiskPct = clamp(((wb - 110) / 50) * 100, 0, 100);
    var isStallSensitive = Object.prototype.hasOwnProperty.call(STALL_SENSITIVE, cut);
    var stallPenalty = isStallSensitive ? (stallRiskPct / 100) * 20 : 0;
    if (isStallSensitive && stallRiskPct >= 60) {
      reasons.push('High stall risk for ' + cut + ' (cavity wet-bulb ' + wb.toFixed(0) + ' °F)');
    }

    var rawScore = clamp(
      100 - precipPenalty - windPenalty - coldPenalty - hotPenalty - stallPenalty,
      0,
      100
    );
    // Band from the rounded score so {score: 85, band: "ideal"} stays
    // consistent — mirrors the TS source.
    var finalScore = Math.round(rawScore);

    if (reasons.length === 0) reasons.push('Conditions look good');

    return {
      score: finalScore,
      band: bandFor(finalScore),
      stallRiskPct: Math.round(stallRiskPct),
      reasons: reasons,
      confidence: day.confidence
    };
  }

  function scoreForecast(cut, cooker, days) {
    return days.map(function (d) { return scoreDay({ cut: cut, cooker: cooker, day: d }); });
  }

  root.WeatherScore = {
    scoreDay: scoreDay,
    scoreForecast: scoreForecast,
    bandFor: bandFor,
    wetBulbF: wetBulbF,
    COOKER_RH: COOKER_RH,
    COOKER_WIND_SENSITIVITY: COOKER_WIND_SENSITIVITY,
    STALL_SENSITIVE: STALL_SENSITIVE,
    ALL_CUTS: ALL_CUTS,
    PIT_TEMP_F: PIT_TEMP_F
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
