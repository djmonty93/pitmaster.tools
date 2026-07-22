/* plan-url.js — encode/decode shareable cook-plan URLs (Milestone 3).

   Calculator inputs are mirrored into the query string so a plan survives a
   reload and can be shared by link. decodePlanParams() validates every key
   (clamp numerics, enum-check selects, reject garbage) so a hand-edited or
   stale URL can never inject a bad value — the calculator's own validation
   stays the final authority. encodePlanParams() MERGES into the existing
   query string, preserving foreign params it does not own (notably embed=1
   and utm_*), and overwrites any stale plan keys.

   Ships to the browser as an inlined <script> (window.PlanUrl) but carries a
   UMD guard so scripts/plan-url.test.js can require() it under node --test.
   Mirrors build.js's module.exports pattern. */
(function (root) {
  'use strict';

  // Cut keys — mirror of the #meatType <option> values in
  // _src/pages/index.html. scripts/plan-url.test.js asserts they stay in
  // sync, so adding a cut to the homepage select fails the test until it's
  // added here too.
  var CUTS = [
    'brisket-sliced', 'brisket-pulled', 'pork-butt-sliced', 'pork-butt-pulled',
    'pork-loin', 'baby-back-ribs', 'competition-ribs', 'spare-ribs', 'beef-ribs',
    'prime-rib', 'tri-tip', 'whole-chicken', 'whole-chicken-spatch',
    'chicken-breast', 'chicken-thighs', 'chicken-quarters', 'chicken-wings',
    'whole-turkey', 'whole-turkey-spatch', 'turkey-breast', 'turkey-leg',
    'turkey-thighs', 'turkey-wings', 'lamb-shoulder', 'lamb-chops', 'lamb-loin',
    'pork-belly', 'beef-chuck'
  ];

  var ENUMS = {
    wu: ['lbs', 'kg'],
    ck: ['pellet', 'offset', 'kamado', 'kettle', 'electric'],
    wrap: ['foil', 'paper', 'none', 'boat'],
    sz: ['light', 'normal', 'hungry'],
    tu: ['F', 'C'],
    grill: ['charcoal', 'gas', 'castIron'],
    style: ['sliced', 'pulled']        // brisket-calculator doneness style
  };
  var TEMPS = [225, 250, 275, 300];
  var SERVE_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  // A whole string that is a number — so "12abc"/"6x"/"225foo" are rejected
  // outright rather than parsed to their numeric prefix.
  var NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
  // Cut keys vary per tool (the homepage 28, the coordinator's own list), so
  // the coordinator validates cut structurally and the page applies it
  // defensively (setSelectIfOption) — only an existing <option> takes effect.
  var CUT_SLUG_RE = /^[a-z0-9-]{1,40}$/;

  function clampNum(raw, min, max, integer) {
    var n;
    if (typeof raw === 'number') {
      n = raw;
    } else {
      var s = String(raw).trim();
      if (!NUMERIC_RE.test(s)) return undefined;
      n = parseFloat(s);
    }
    if (!isFinite(n)) return undefined;
    if (integer) n = Math.trunc(n);
    if (n < min) n = min;
    if (n > max) n = max;
    return n;
  }

  function inEnum(raw, list) {
    var s = String(raw);
    return list.indexOf(s) !== -1 ? s : undefined;
  }

  function bool01(raw) {
    var s = String(raw);
    if (s === '0') return 0;
    if (s === '1') return 1;
    return undefined;
  }

  // key → validator(rawValue) → canonical typed value, or undefined to drop.
  // Used by BOTH decode (raw = string from the URL) and encode (raw = the
  // state value, which may already be a number); String()/parseFloat handle
  // either form.
  var VALIDATORS = {
    cut: function (v) { return CUTS.indexOf(String(v)) !== -1 ? String(v) : undefined; },
    wt: function (v) { return clampNum(v, 0.1, 999, false); },
    wu: function (v) { return inEnum(v, ENUMS.wu); },
    ppl: function (v) { return clampNum(v, 1, 999, true); },
    temp: function (v) {
      // Fixed-option select: require an exact integer (no truncation) that is
      // one of the offered temps, so 225.9 / 240 / "225foo" are all rejected.
      var s = (typeof v === 'number') ? String(v) : String(v).trim();
      if (!/^\d+$/.test(s)) return undefined;
      var n = parseInt(s, 10);
      return TEMPS.indexOf(n) !== -1 ? n : undefined;
    },
    ck: function (v) { return inEnum(v, ENUMS.ck); },
    serve: function (v) { return SERVE_RE.test(String(v)) ? String(v) : undefined; },
    wrap: function (v) { return inEnum(v, ENUMS.wrap); },
    bone: bool01,
    inj: bool01,
    wp: bool01,
    sz: function (v) { return inEnum(v, ENUMS.sz); },
    tu: function (v) { return inEnum(v, ENUMS.tu); },
    grill: function (v) { return inEnum(v, ENUMS.grill); },
    sear: function (v) { return clampNum(v, 200, 800, true); },
    style: function (v) { return inEnum(v, ENUMS.style); },     // brisket
    thick: function (v) { return clampNum(v, 0, 6, false); },   // brisket flat thickness (in)
    injp: function (v) { return clampNum(v, 0, 25, true); },    // injection % of weight
    fat:  function (v) { return clampNum(v, 0, 1, false); },    // fat cap thickness (in)
    spz:  function (v) { return clampNum(v, 0, 6, true); },     // spritzes per hour
    np:   function (v) { return clampNum(v, 1, 12, true); },    // load count (pieces on the smoker)
    wind: function (v) { return clampNum(v, 0, 40, true); }     // wind (mph)
  };
  var KEYS = Object.keys(VALIDATORS);
  // Every key the plan family owns across both encoders (flat schema + the
  // coordinator's `m` meat list). Both encoders purge this whole set before
  // writing their own keys, so neither can leave the other's stale params in
  // a shared URL while still preserving foreign params (embed, utm_*).
  var ALL_PLAN_KEYS = KEYS.concat(['m']);

  function stripQ(search) {
    var s = search == null ? '' : String(search);
    return s.charAt(0) === '?' ? s.slice(1) : s;
  }

  // Parse a query string into a validated plan object. Only whitelisted
  // keys are ever read from the URL, so URL-supplied keys like __proto__ are
  // never touched — no prototype pollution, and the result is a plain object.
  function decodePlanParams(search) {
    var out = {};
    var params;
    try { params = new URLSearchParams(stripQ(search)); } catch (e) { return out; }
    for (var i = 0; i < KEYS.length; i++) {
      var key = KEYS[i];
      if (!params.has(key)) continue;
      var raw = params.get(key);
      if (raw == null) continue;
      var val = VALIDATORS[key](raw);
      if (val !== undefined) out[key] = val;
    }
    return out;
  }

  // Merge a plan state into an existing query string. Stale plan keys are
  // removed first; foreign keys (embed, utm_*, anything else) are preserved.
  // Returns the query string WITHOUT a leading '?'.
  function encodePlanParams(state, existingSearch) {
    var params;
    try { params = new URLSearchParams(stripQ(existingSearch || '')); }
    catch (e) { params = new URLSearchParams(); }
    for (var i = 0; i < ALL_PLAN_KEYS.length; i++) params.delete(ALL_PLAN_KEYS[i]);
    if (state) {
      for (var j = 0; j < KEYS.length; j++) {
        var key = KEYS[j];
        if (state[key] == null) continue;
        var val = VALIDATORS[key](state[key]);
        if (val !== undefined) params.set(key, String(val));
      }
    }
    return params.toString();
  }

  // ── Cook-time coordinator: a variable-length meat list ────────────────────
  // The coordinator's plan is N meats, each {cut, wt(lbs), temp, wrap}, plus a
  // global serve time and unit prefs. That doesn't fit the flat single-plan
  // schema above, so it gets its own pair. The meat list rides in one `m`
  // param: items joined by ';', fields by '~' (cut~wtLbs~temp~wrap). Weights
  // are canonical pounds so the param is unit-independent. Foreign params
  // (embed, utm_*) are preserved by encodeCookPlan just like encodePlanParams.

  function decodeMeat(token) {
    var f = String(token).split('~');
    if (f.length < 4) return undefined;
    var cut = CUT_SLUG_RE.test(f[0]) ? f[0] : undefined;
    var wt = clampNum(f[1], 0.5, 999, false);
    var temp = VALIDATORS.temp(f[2]);
    var wrap = inEnum(f[3], ENUMS.wrap);
    if (cut === undefined || wt === undefined || temp === undefined || wrap === undefined) {
      return undefined;
    }
    return { cut: cut, wt: wt, temp: temp, wrap: wrap };
  }

  function decodeCookPlan(search) {
    var out = {};
    var params;
    try { params = new URLSearchParams(stripQ(search)); } catch (e) { return out; }
    if (params.has('serve')) { var s = VALIDATORS.serve(params.get('serve')); if (s !== undefined) out.serve = s; }
    if (params.has('wu')) { var wu = VALIDATORS.wu(params.get('wu')); if (wu !== undefined) out.wu = wu; }
    if (params.has('tu')) { var tu = VALIDATORS.tu(params.get('tu')); if (tu !== undefined) out.tu = tu; }
    if (params.has('m')) {
      var raw = params.get('m');
      if (raw) {
        var meats = [];
        var items = raw.split(';');
        for (var i = 0; i < items.length; i++) {
          if (!items[i]) continue;
          var meat = decodeMeat(items[i]);
          if (meat) meats.push(meat);
        }
        if (meats.length) out.meats = meats;
      }
    }
    return out;
  }

  function encodeCookPlan(state, existingSearch) {
    var params;
    try { params = new URLSearchParams(stripQ(existingSearch || '')); }
    catch (e) { params = new URLSearchParams(); }
    for (var i = 0; i < ALL_PLAN_KEYS.length; i++) params.delete(ALL_PLAN_KEYS[i]);
    if (state) {
      if (state.serve != null) { var s = VALIDATORS.serve(state.serve); if (s !== undefined) params.set('serve', s); }
      if (state.wu != null) { var wu = VALIDATORS.wu(state.wu); if (wu !== undefined) params.set('wu', wu); }
      if (state.tu != null) { var tu = VALIDATORS.tu(state.tu); if (tu !== undefined) params.set('tu', tu); }
      if (Array.isArray(state.meats) && state.meats.length) {
        var toks = [];
        for (var j = 0; j < state.meats.length; j++) {
          var m = state.meats[j] || {};
          var cut = CUT_SLUG_RE.test(String(m.cut)) ? String(m.cut) : undefined;
          var wt = clampNum(m.wt, 0.5, 999, false);
          var temp = VALIDATORS.temp(m.temp);
          var wrap = inEnum(m.wrap, ENUMS.wrap);
          if (cut !== undefined && wt !== undefined && temp !== undefined && wrap !== undefined) {
            toks.push([cut, wt, temp, wrap].join('~'));
          }
        }
        if (toks.length) params.set('m', toks.join(';'));
      }
    }
    return params.toString();
  }

  var api = {
    encodePlanParams: encodePlanParams,
    decodePlanParams: decodePlanParams,
    encodeCookPlan: encodeCookPlan,
    decodeCookPlan: decodeCookPlan,
    CUTS: CUTS,
    PLAN_KEYS: KEYS
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;          // node --test
  } else {
    root.PlanUrl = api;            // browser global
  }
})(typeof self !== 'undefined' ? self : this);
