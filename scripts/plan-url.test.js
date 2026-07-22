// Unit tests for _partials/plan-url.js — the pure encode/decode module
// behind shareable cook-plan URLs (Milestone 3). Run under `node --test`
// via the test:scripts chain. The module ships to the browser as an
// inlined <script> but carries a UMD guard so it can be require()'d here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const planUrl = require('../_partials/plan-url.js');
const { encodePlanParams, decodePlanParams, encodeCookPlan, decodeCookPlan, CUTS } = planUrl;

// A fully-populated, valid plan state — the encode→decode round trip must
// return exactly this.
const FULL = {
  cut: 'brisket-sliced',
  wt: 12.5,
  wu: 'lbs',
  ppl: 8,
  temp: 225,
  ck: 'offset',
  wp: 1,
  serve: '18:00',
  wrap: 'paper',
  bone: 1,
  inj: 0,
  injp: 10,
  fat: 0.25,
  spz: 2,
  np: 2,
  wind: 8,
  sz: 'normal',
  tu: 'F',
  grill: 'charcoal',
  sear: 500,
};

test('round-trips a fully-populated valid plan', () => {
  const decoded = decodePlanParams(encodePlanParams(FULL));
  assert.deepEqual(decoded, FULL);
});

test('round-trips through a real query string (leading ?)', () => {
  const qs = encodePlanParams(FULL);
  assert.equal(typeof qs, 'string');
  const decoded = decodePlanParams('?' + qs.replace(/^\?/, ''));
  assert.deepEqual(decoded, FULL);
});

test('CUTS is the validated cut allowlist and includes the homepage default', () => {
  assert.ok(Array.isArray(CUTS) && CUTS.length >= 20);
  assert.ok(CUTS.includes('brisket-sliced'));
});

test('decode drops an unknown cut but keeps the rest', () => {
  const decoded = decodePlanParams('cut=dragon-flank&wt=10&wu=lbs&ppl=6');
  assert.equal(decoded.cut, undefined);
  assert.equal(decoded.wt, 10);
  assert.equal(decoded.ppl, 6);
});

test('decode rejects out-of-enum cooker / wrap / sz / tu / wu / grill', () => {
  const decoded = decodePlanParams('ck=microwave&wrap=cling&sz=ravenous&tu=K&wu=stone&grill=laser');
  assert.deepEqual(decoded, {});
});

test('decode clamps numerics into range', () => {
  const decoded = decodePlanParams('wt=99999&ppl=100000&sear=9000');
  assert.equal(decoded.wt, 999);   // wt clamp ceiling
  assert.equal(decoded.ppl, 999);  // ppl clamp ceiling
  assert.equal(decoded.sear, 800); // sear clamp ceiling
});

test('decode clamps low numerics up to the floor', () => {
  const decoded = decodePlanParams('wt=0&ppl=0&sear=10');
  assert.equal(decoded.wt, 0.1);
  assert.equal(decoded.ppl, 1);
  assert.equal(decoded.sear, 200);
});

test('decode coerces ppl to an integer', () => {
  assert.equal(decodePlanParams('ppl=6.9').ppl, 6);
});

test('decode rejects suffix-garbage numerics (full numeric match required)', () => {
  assert.equal(decodePlanParams('wt=12abc').wt, undefined);
  assert.equal(decodePlanParams('ppl=6x').ppl, undefined);
  assert.equal(decodePlanParams('temp=225foo').temp, undefined);
  assert.equal(decodePlanParams('sear=500!').sear, undefined);
  assert.equal(decodePlanParams('thick=2in').thick, undefined);
  // Clean values (including a fractional ppl that truncates) still parse.
  assert.equal(decodePlanParams('wt=12.5').wt, 12.5);
  assert.equal(decodePlanParams('ppl=6.9').ppl, 6);
});

test('decode rejects a non-member smoker temp (select has fixed options)', () => {
  assert.equal(decodePlanParams('temp=240').temp, undefined);
  assert.equal(decodePlanParams('temp=275').temp, 275);
});

test('decode rejects a fractional smoker temp instead of truncating it', () => {
  assert.equal(decodePlanParams('temp=225.9').temp, undefined);
  assert.equal(decodePlanParams('temp=250.0').temp, undefined);
  assert.equal(decodeCookPlan('m=spare-ribs~10~250.9~foil').meats, undefined);
  assert.equal(decodeCookPlan('m=spare-ribs~10~250~foil').meats.length, 1);
});

test('decode rejects malformed serve times, accepts valid HH:MM', () => {
  assert.equal(decodePlanParams('serve=99:99').serve, undefined);
  assert.equal(decodePlanParams('serve=7:5').serve, undefined); // not zero-padded
  assert.equal(decodePlanParams('serve=6pm').serve, undefined);
  assert.equal(decodePlanParams('serve=06:30').serve, '06:30');
  assert.equal(decodePlanParams('serve=23:59').serve, '23:59');
});

test('decode treats bone/inj/wp as strict 0|1 booleans', () => {
  assert.equal(decodePlanParams('bone=1&inj=0').bone, 1);
  assert.equal(decodePlanParams('bone=1&inj=0').inj, 0);
  assert.deepEqual(decodePlanParams('bone=yes&inj=2'), {}); // garbage dropped
  assert.equal(decodePlanParams('wp=1').wp, 1);
  assert.equal(decodePlanParams('wp=0').wp, 0);
  assert.deepEqual(decodePlanParams('wp=yes'), {}); // garbage dropped
});

test('decode ignores non-numeric weight and unknown keys', () => {
  const decoded = decodePlanParams('wt=heavy&utm_source=newsletter&fbclid=abc&cut=pork-loin');
  assert.equal(decoded.wt, undefined);
  assert.equal(decoded.cut, 'pork-loin');
  assert.equal('utm_source' in decoded, false);
  assert.equal('fbclid' in decoded, false);
});

test('decode of empty / junk search yields an empty object', () => {
  assert.deepEqual(decodePlanParams(''), {});
  assert.deepEqual(decodePlanParams('?'), {});
  assert.deepEqual(decodePlanParams('&&=&='), {});
});

test('encode preserves foreign params (embed, utm) it does not own', () => {
  const qs = encodePlanParams({ cut: 'pork-loin', ppl: 4 }, '?embed=1&utm_source=ig');
  const params = new URLSearchParams(qs);
  assert.equal(params.get('embed'), '1');
  assert.equal(params.get('utm_source'), 'ig');
  assert.equal(params.get('cut'), 'pork-loin');
  assert.equal(params.get('ppl'), '4');
});

test('encode overwrites stale plan keys from the existing search', () => {
  // Old URL had cut=tri-tip; new state says brisket — the new value wins
  // and no duplicate cut key remains.
  const qs = encodePlanParams({ cut: 'brisket-pulled' }, '?cut=tri-tip&embed=1');
  const params = new URLSearchParams(qs);
  assert.deepEqual(params.getAll('cut'), ['brisket-pulled']);
  assert.equal(params.get('embed'), '1');
});

test('encode omits invalid/absent fields rather than emitting garbage', () => {
  const qs = encodePlanParams({ cut: 'not-a-cut', wt: NaN, ppl: 6 });
  const params = new URLSearchParams(qs);
  assert.equal(params.get('cut'), null);
  assert.equal(params.get('wt'), null);
  assert.equal(params.get('ppl'), '6');
});

test('decode never returns prototype-polluting keys', () => {
  const decoded = decodePlanParams('__proto__=x&constructor=y&cut=tri-tip');
  assert.equal(decoded.cut, 'tri-tip');
  assert.equal(Object.prototype.hasOwnProperty.call(decoded, '__proto__'), false);
});

// ── Brisket-calculator keys (style, thick) ──────────────────────────────────

test('round-trips a brisket plan (style + thick + shared keys)', () => {
  const state = { style: 'pulled', wt: 14, temp: 250, ck: 'offset', wrap: 'paper', serve: '13:00', thick: 2.5 };
  assert.deepEqual(decodePlanParams(encodePlanParams(state)), state);
});

test('decode rejects an unknown brisket style and clamps thickness', () => {
  assert.equal(decodePlanParams('style=shredded').style, undefined);
  assert.equal(decodePlanParams('style=sliced').style, 'sliced');
  assert.equal(decodePlanParams('thick=99').thick, 6);   // clamp ceiling
  assert.equal(decodePlanParams('thick=abc').thick, undefined);
});

test('round-trips the M2 modifier keys (injp/fat/spz/np/wind + boat wrap)', () => {
  const state = { wrap: 'boat', injp: 12, fat: 0.5, spz: 3, np: 4, wind: 15 };
  assert.deepEqual(decodePlanParams(encodePlanParams(state)), state);
});

test('decode accepts boat wrap and clamps M2 modifier ranges', () => {
  assert.equal(decodePlanParams('wrap=boat').wrap, 'boat');
  assert.equal(decodePlanParams('injp=999').injp, 25);   // ceiling
  assert.equal(decodePlanParams('injp=-5').injp, 0);      // floor
  assert.equal(decodePlanParams('fat=9').fat, 1);         // ceiling
  assert.equal(decodePlanParams('spz=99').spz, 6);        // ceiling
  assert.equal(decodePlanParams('np=0').np, 1);           // floor
  assert.equal(decodePlanParams('wind=999').wind, 40);    // ceiling
  assert.equal(decodePlanParams('injp=abc').injp, undefined); // garbage dropped
});

// ── Cook-time coordinator: variable-length meat list ────────────────────────

test('round-trips a multi-meat cook plan', () => {
  const state = {
    serve: '14:00',
    wu: 'lbs',
    tu: 'F',
    meats: [
      { cut: 'brisket-flat', wt: 12, temp: 250, wrap: 'paper' },
      { cut: 'pork-butt', wt: 8, temp: 225, wrap: 'foil' }
    ]
  };
  assert.deepEqual(decodeCookPlan(encodeCookPlan(state)), state);
});

test('cook plan drops malformed meat tokens but keeps valid ones', () => {
  // second token has a bad temp (240 not in the select), third is truncated
  const decoded = decodeCookPlan('serve=12:00&m=brisket-flat~10~250~foil;pork-butt~8~240~foil;junk~~~');
  assert.equal(decoded.serve, '12:00');
  assert.equal(decoded.meats.length, 1);
  assert.deepEqual(decoded.meats[0], { cut: 'brisket-flat', wt: 10, temp: 250, wrap: 'foil' });
});

test('cook plan clamps meat weights and rejects bad wrap/cut', () => {
  const decoded = decodeCookPlan('m=spare-ribs~99999~275~none;BAD CUT~5~250~foil;ribs~5~250~cling');
  // first: weight clamped to the 999 ceiling; second: cut has a space (invalid
  // slug); third: bad wrap
  assert.equal(decoded.meats.length, 1);
  assert.deepEqual(decoded.meats[0], { cut: 'spare-ribs', wt: 999, temp: 275, wrap: 'none' });
});

test('cook plan preserves a 250 lb meat (no premature clamp)', () => {
  // Regression: the coordinator accepts weights above the old 200 ceiling, so
  // a generated schedule must round-trip the real weight, not a clamped one.
  const decoded = decodeCookPlan('m=spare-ribs~250~250~foil');
  assert.equal(decoded.meats[0].wt, 250);
});

test('cook plan rejects a meat token with suffix-garbage weight or temp', () => {
  const decoded = decodeCookPlan('m=spare-ribs~12abc~250~foil;pork-butt~8~250foo~foil');
  assert.equal('meats' in decoded, false); // both tokens invalid
});

test('cook plan with no valid meats omits the meats key', () => {
  const decoded = decodeCookPlan('serve=10:00&m=;;~~~');
  assert.equal(decoded.serve, '10:00');
  assert.equal('meats' in decoded, false);
});

test('encodePlanParams strips a stale coordinator meat list (m) it does not own', () => {
  // A flat-plan encode must not leave a foreign `m` param behind, or the plan
  // URL would carry a phantom meat list that a coordinator page would ingest.
  const qs = encodePlanParams({ cut: 'tri-tip', ppl: 2 }, '?m=brisket-sliced~12~250~foil&embed=1');
  const params = new URLSearchParams(qs);
  assert.equal(params.get('m'), null);     // stale meat list removed
  assert.equal(params.get('embed'), '1');  // foreign param preserved
  assert.equal(params.get('cut'), 'tri-tip');
});

test('encodeCookPlan strips stale flat plan keys it does not own', () => {
  const qs = encodeCookPlan(
    { serve: '15:00', meats: [{ cut: 'tri-tip', wt: 3, temp: 300, wrap: 'none' }] },
    '?cut=brisket-pulled&wt=12&ppl=6&sear=500&utm_source=fb'
  );
  const params = new URLSearchParams(qs);
  assert.equal(params.get('cut'), null);   // stale flat keys removed
  assert.equal(params.get('wt'), null);
  assert.equal(params.get('ppl'), null);
  assert.equal(params.get('sear'), null);
  assert.equal(params.get('utm_source'), 'fb'); // foreign param preserved
  assert.equal(params.get('serve'), '15:00');
  assert.equal(params.get('m'), 'tri-tip~3~300~none');
});

test('encodeCookPlan preserves foreign params and overwrites stale meat list', () => {
  const qs = encodeCookPlan(
    { serve: '15:00', meats: [{ cut: 'tri-tip', wt: 3, temp: 300, wrap: 'none' }] },
    '?embed=1&m=old~1~225~foil&utm_source=fb'
  );
  const params = new URLSearchParams(qs);
  assert.equal(params.get('embed'), '1');
  assert.equal(params.get('utm_source'), 'fb');
  assert.equal(params.get('serve'), '15:00');
  assert.equal(params.get('m'), 'tri-tip~3~300~none');
});

test('CUTS matches the #meatType <option> values in index.html exactly', () => {
  // The module hardcodes the cut allowlist; this guards it against drift
  // from the homepage select. Adding/removing a meat type on the homepage
  // without updating plan-url.js CUTS fails here.
  const html = fs.readFileSync(path.join('_src', 'pages', 'index.html'), 'utf8');
  const select = html.slice(
    html.indexOf('<select id="meatType">'),
    html.indexOf('</select>', html.indexOf('<select id="meatType">'))
  );
  const options = [];
  const re = /<option value="([^"]+)"/g;
  let m;
  while ((m = re.exec(select)) !== null) options.push(m[1]);

  assert.ok(options.length > 0, 'failed to extract #meatType options');
  assert.deepEqual(
    [...CUTS].sort(),
    [...options].sort(),
    'plan-url.js CUTS is out of sync with #meatType options in index.html'
  );
});
