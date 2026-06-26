/* gauge-svg.js — the signature smoke-score gauge.
   Injected via an INJECT:gauge-svg.js:script directive (build.js wraps this raw
   JS in a script element), so it must appear BEFORE any inline script that
   calls renderGauge(). Render-only: scoring/band logic stays in
   weather-score-shared.js. Exposes window.renderGauge.

   renderGauge(score, band, opts) -> SVG string.
     score  0-100 (clamped, rounded).
     band   semantic band — accepts "band-green" or "green"
            (red | yellow | green | ideal). Drives the arc color only;
            the brand ember/amber/gold is reserved for top-rules/texture.
     opts   { label, showNumber, size }  (all optional)

   Geometry: a 180° track (M20 110 A90 90 0 0 1 200 110, r=90, center 110,110);
   the foreground arc is the same path with stroke-dasharray = filled fraction
   of the semicircle (score/100 × π·90). The needle sweeps left(0)→up(50)→
   right(100) at angle π·(1 − score/100) from the hub. Number in Zilla Slab 700.
*/
(function () {
  var R = 90, CX = 110, CY = 110, SEMI = Math.PI * R;
  // Semantic band colors — mirror smoke-weather.css --score-* (kept in sync
  // here so the gauge renders identically on pages that don't load that CSS,
  // e.g. the homepage and the leaderboard).
  var BAND = {
    red:    '#B5311F',
    yellow: '#8A6308',
    green:  '#2D7A3A',
    ideal:  '#1F5DAA'
  };

  function bandColor(band) {
    var key = String(band == null ? '' : band).replace(/^band-/, '').toLowerCase();
    return BAND[key] || '#ED7818'; // amber fallback for unknown/pending band
  }

  // Escape a value destined for a double-quoted SVG attribute. renderGauge is a
  // global, so it self-defends even if a future caller passes an unsanitized
  // string (e.g. an API-supplied city name) straight into opts.label.
  function escAttr(v) {
    return String(v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderGauge(score, band, opts) {
    opts = opts || {};
    var s = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
    var color = bandColor(band);
    var filled = (s / 100) * SEMI;
    var theta = Math.PI * (1 - s / 100);
    var nx = (CX + (R - 14) * Math.cos(theta)).toFixed(1);
    var ny = (CY - (R - 14) * Math.sin(theta)).toFixed(1);
    var label = opts.label || ('Smoke score ' + s + ' of 100');
    var showNumber = opts.showNumber !== false;
    var size = Number(opts.size);
    var sizeAttr = (isFinite(size) && size > 0) ? ' width="' + size + '"' : '';

    // role="meter" exposes the 0-100 value to assistive tech as a navigable
    // range; aria-label carries the prose description.
    return '<svg class="gauge" viewBox="0 0 220 150"' + sizeAttr +
      ' role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + s + '"' +
      ' aria-label="' + escAttr(label) + '" xmlns="http://www.w3.org/2000/svg">' +
      '<path class="gauge__track" d="M20 110 A90 90 0 0 1 200 110" fill="none" ' +
        'stroke="#E6D9BE" stroke-width="16" stroke-linecap="round"/>' +
      '<path class="gauge__fill" d="M20 110 A90 90 0 0 1 200 110" fill="none" ' +
        'stroke="' + color + '" stroke-width="16" stroke-linecap="round" ' +
        'stroke-dasharray="' + filled.toFixed(2) + ' ' + SEMI.toFixed(2) + '"/>' +
      '<line class="gauge__needle" x1="' + CX + '" y1="' + CY + '" x2="' + nx + '" y2="' + ny + '" ' +
        'stroke="#26231F" stroke-width="6" stroke-linecap="round"/>' +
      '<circle cx="' + CX + '" cy="' + CY + '" r="9" fill="#26231F"/>' +
      (showNumber
        ? '<text class="gauge__num" x="' + CX + '" y="' + (CY + 38) + '" text-anchor="middle" ' +
          'font-family="\'Zilla Slab\',Georgia,serif" font-weight="700" font-size="42" ' +
          'fill="#26231F">' + s + '</text>'
        : '') +
      '</svg>';
  }

  window.renderGauge = renderGauge;
})();
