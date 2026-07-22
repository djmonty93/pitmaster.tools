# Stall Model v2 — Milestone 2 (Stage A: modifiers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the spec §7 stall modifiers — wrap variants (foil/butcher-paper/foil-boat), spritz, injection %, and fat cap — plus load-count and wind UI, to the three dedicated stall calculators (brisket, pork shoulder, ribs), building on the M1 two-axis engine.

**Architecture:** The engine (`_partials/smoke-physics.js`) already computes an additive dwell in `spStall`/`spCompute`/`spResolve` and already *accepts* `nPieces`/`windMph`. Stage A adds four modifier terms to the dwell math, differentiates the wrap variants (M1 collapsed foil==paper), and wires new form controls on three calculators through the existing plan-URL persistence layer. All new engine params are optional and default to a no-op, so untouched pages (index, turkey, coordinator) keep byte-identical behavior.

**Tech Stack:** Vanilla ES5-style browser JS (no build-time transpile of the partial; it is inlined verbatim into every page). Tests: Vitest (`vitest run --root worker`) for the engine, `node --test` for `plan-url.js`, Playwright for browser-smoke.

## Global Constraints

- **Spec is authority:** `docs/superpowers/specs/2026-07-19-stall-model-v2-design.md` §7. Exact formulas:
  - Wrap (§7.1): dwell × factor from wrap time. **Foil ×0** (full truncation), **butcher paper ×0.45**, **foil boat ×0.70**, none ×1.
  - Spritz (§7.2): `dwell × (1 + 0.06 · spritzes_per_hour)`, capped at **×1.5**, **applies only while unwrapped**.
  - Injection (§7.3): `Xw_effective = Xw + injectionPct/100`.
  - Fat cap (§7.4): `Lc_effective = Lc + 0.5 · fatCapInches`.
- **No behavior change to untouched pages.** index.html (has a legacy boolean `inj`/`bone` model and the `inj` plan-URL key), turkey (no stall), and the cook-time coordinator are OUT of scope for Stage A. The engine changes must be backward-compatible: with no new params, `spStall`/`spCompute`/`spResolve` return exactly what they return today.
- **Do not reuse the `inj` plan-URL key.** It is already a `bool01` used by index.html. New keys: `injp` (injection %), `fat` (fat cap in), `spz` (spritzes/hr), `np` (pieces), `wind` (mph).
- **No new client storage.** New inputs persist only in the shareable plan-URL query string (same mechanism as `ck`/`wp`/`wrap`), NOT cookies or localStorage — so `privacy-policy.html` needs no change (project rule: policy consistency).
- **Windows build noise:** `npm run build` rewrites ~51 files (`_partials/metros-list.html`, `_src/smoke-weather/*.html`) as CRLF-only churn. `git restore` them; never `git add .`. Stage only files this plan touches.
- **SEO/head rules unchanged** — this plan touches no `<head>`, sitemap, robots, redirects, or canonical.
- **Validation gate:** `npm run validate` must pass before merge (build + `scripts/validate.mjs`).

---

## File Structure

- `_partials/smoke-physics.js` — engine: new modifier constants + terms in `spStall`, `spCompute` (wrapped + unwrapped), `spResolve` (wrapped + unwrapped). (Task 1)
- `worker/tests/unit/smoke-physics.test.ts` — extend `loadPhysics()` return list + add modifier tests. (Task 1)
- `_partials/plan-url.js` — add `boat` to `ENUMS.wrap`; add `injp`/`fat`/`spz`/`np`/`wind` validators. (Task 2)
- `scripts/plan-url.test.js` — extend FULL fixture + add modifier round-trip/clamp tests. (Task 2)
- `_src/tools/brisket-calculator.html` — full modifier control set + wiring. (Task 3)
- `_src/tools/pork-shoulder-calculator.html` — full modifier control set + wiring. (Task 4)
- `_src/tools/rib-calculator.html` — wrap-boat + spritz + load + wind (NO injection/fat cap). (Task 5)
- `tests/browser-smoke.spec.js` — bump inline-script byte budget if the enlarged partial overflows it. Plus final build/validate/full-suite gate. (Task 6)

---

## Task 1: Engine — stall modifiers

**Files:**
- Modify: `_partials/smoke-physics.js` (constants block ~145-147; `spStall` 170-182; `spCompute` wrapped 254-264 and unwrapped 274-281; `spResolve` 305-348)
- Test: `worker/tests/unit/smoke-physics.test.ts` (extend `loadPhysics` 6-15; add a `describe` block)

**Interfaces:**
- Consumes: existing `spStall(p)`, `spCompute(p)`, `spResolve(p)`, `spPhase`, `spStallDwellH`, `spPlateauTempF`, `spLc`, `spFade` (all in this file).
- Produces (new engine params, all optional): `p.spritzesPerHour` (number, /hr), `p.injectionPct` (number, %), `p.fatCapInches` (number, in), `p.wrapMethod` gains `'boat'`. New exported globals for tests: `spSpritzFactor(spritzesPerHour) → number`, `spCutParams`, and constants `SP_WRAP_FACTOR`, `SP_SPRITZ_C`, `SP_SPRITZ_CAP`, `SP_FATCAP_C`, `SP_INJ_XW_MAX`.

- [ ] **Step 1: Write the failing tests**

Add to the end of `worker/tests/unit/smoke-physics.test.ts` (uses the existing `compute`, `stall`, `AMB`, and `P` helpers defined earlier in the file):

```ts
describe('stage-5 modifiers (spec §7)', () => {
  it('wrap variants scale residual dwell: foil 0 < paper < boat < unwrapped', () => {
    const unwrapped = compute({ wrapMethod: 'none' }).t2h; // additive dwell
    const foil = compute({ wrapMethod: 'foil' }).t2h;
    const paper = compute({ wrapMethod: 'paper' }).t2h;
    const boat = compute({ wrapMethod: 'boat' }).t2h;
    expect(foil).toBe(0);
    expect(paper).toBeGreaterThan(0);
    expect(boat).toBeGreaterThan(paper);
    expect(unwrapped).toBeGreaterThan(boat);
    expect(paper).toBeCloseTo(unwrapped * 0.45, 6);
    expect(boat).toBeCloseTo(unwrapped * 0.70, 6);
  });
  it('wrapped totals order foil < paper < boat < none', () => {
    const f = compute({ wrapMethod: 'foil' }).totalH;
    const p = compute({ wrapMethod: 'paper' }).totalH;
    const b = compute({ wrapMethod: 'boat' }).totalH;
    const n = compute({ wrapMethod: 'none' }).totalH;
    expect(f).toBeLessThan(p);
    expect(p).toBeLessThan(b);
    expect(b).toBeLessThan(n);
  });
  it('spritz lengthens the unwrapped dwell, capped at 1.5x', () => {
    const base = compute({ spritzesPerHour: 0 }).t2h;
    const s2 = compute({ spritzesPerHour: 2 }).t2h;
    const s100 = compute({ spritzesPerHour: 100 }).t2h;
    expect(s2).toBeCloseTo(base * (1 + 0.06 * 2), 6);
    expect(s100).toBeCloseTo(base * 1.5, 6); // capped
  });
  it('spritz does not affect a wrapped cook (unwrapped-only)', () => {
    expect(compute({ wrapMethod: 'foil', spritzesPerHour: 5 }).totalH)
      .toBeCloseTo(compute({ wrapMethod: 'foil', spritzesPerHour: 0 }).totalH, 6);
    expect(compute({ wrapMethod: 'paper', spritzesPerHour: 5 }).totalH)
      .toBeCloseTo(compute({ wrapMethod: 'paper', spritzesPerHour: 0 }).totalH, 6);
  });
  it('injection raises the dwell via water fraction (Xw 0.71->0.81 ~ +14%)', () => {
    const base = stall('offset', { injectionPct: 0 }).dwellH;
    const inj = stall('offset', { injectionPct: 10 }).dwellH;
    expect(inj / base).toBeCloseTo(0.81 / 0.71, 2);
  });
  it('fat cap lowers plateau temp and lengthens dwell', () => {
    const base = stall('offset', { fatCapInches: 0 });
    const fat = stall('offset', { fatCapInches: 0.5 });
    expect(fat.Lc).toBeCloseTo(base.Lc + 0.25, 6); // +0.5*0.5 in
    expect(fat.T_plat).toBeLessThan(base.T_plat);
    expect(fat.dwellH).toBeGreaterThan(base.dwellH);
  });
  it('spResolve: paper wrap keeps partial residual dwell, foil keeps none', () => {
    const base = { kmKey: 'brisket-packer', weightLbs: 14, pitF: 225, tiF: 38, tfF: 203,
      hasStall: true, cookerType: 'offset', wrapTriggerF: 150, ...AMB };
    const s = P.spStall({ ...base });
    const belowF = Math.round(s.T_plat) - 20; // below the plateau -> full residual ahead
    const foil = P.spResolve({ ...base, wrapMethod: 'foil', currentF: belowF }).remainingH;
    const paper = P.spResolve({ ...base, wrapMethod: 'paper', currentF: belowF }).remainingH;
    const climb = P.spResolve({ ...base, hasStall: false, currentF: belowF }).remainingH;
    expect(Math.abs(foil - climb)).toBeLessThan(0.01);       // foil: no dwell
    expect(paper - foil).toBeCloseTo(s.dwellH * 0.45, 2);    // paper: +45% residual
  });
});
```

Also extend the `loadPhysics()` return list (line ~11-13) to expose the new globals — change the returned object to include `spSpritzFactor, spCutParams, SP_WRAP_FACTOR, SP_SPRITZ_C, SP_SPRITZ_CAP, SP_FATCAP_C, SP_INJ_XW_MAX`:

```ts
    smokePhysicsSource +
      '\n; return { spF2C, spC2F, spPSat, spPAtm, spHumidityRatio, spWetBulbC,' +
      ' spLc, spSurfaceArea, spPitWetBulbF, spPlateauTempF, spStallDwellH, spFade,' +
      ' spStall, spCompute, spResolve, spPhase, spGetL, wetBulb_F, spSpritzFactor,' +
      ' spCutParams, SP_AIR_EXCHANGE, SP_CUT, SP_KM, SP_EVAP_C, SP_STALL_K, SP_STALL_START,' +
      ' SP_WRAP_FACTOR, SP_SPRITZ_C, SP_SPRITZ_CAP, SP_FATCAP_C, SP_INJ_XW_MAX }; '
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --root worker tests/unit/smoke-physics.test.ts`
Expected: the new `stage-5 modifiers` tests FAIL (paper/boat currently equal foil → `paper` is 0; `spSpritzFactor` undefined). Existing tests still pass.

- [ ] **Step 3: Add the modifier constants + spritz helper**

In `_partials/smoke-physics.js`, immediately after the `var SP_PLAT_FADE = 15;` line (~147), insert:

```js
/* ── Stage-5 modifier constants (spec §7) ─────────────────────────────────── */
var SP_WRAP_FACTOR = { none: 1, foil: 0, paper: 0.45, boat: 0.70 };
var SP_SPRITZ_C   = 0.06;  /* dwell multiplier per spritz/hour */
var SP_SPRITZ_CAP = 1.5;   /* max spritz multiplier */
var SP_FATCAP_C   = 0.5;   /* Lc added (in) per inch of fat cap */
var SP_INJ_XW_MAX = 0.95;  /* clamp on injected water fraction */

/* Spritz re-wets the surface and re-arms evaporation — unwrapped only. */
function spSpritzFactor(spritzesPerHour) {
  var s = spritzesPerHour > 0 ? spritzesPerHour : 0;
  var f = 1 + SP_SPRITZ_C * s;
  return f > SP_SPRITZ_CAP ? SP_SPRITZ_CAP : f;
}
```

- [ ] **Step 4: Apply injection (Xw) and fat cap (Lc) inside `spStall`**

Replace the body of `spStall` (lines ~170-182) with:

```js
function spStall(p) {
  var c = spCutParams(p.kmKey);
  var Lc = spLc(p.kmKey, p.weightLbs || c.wRef, p.thicknessIn);
  /* Fat cap: an untrimmed cap insulates the capped face (spec §7.4) — raises
     the conduction path, which lowers T_plat and lengthens dwell. */
  if (p.fatCapInches > 0) Lc = Lc + SP_FATCAP_C * p.fatCapInches;
  var T_wb = (p.cookerType)
    ? spPitWetBulbF({ pitF: p.pitF, cookerType: p.cookerType,
        ambientF: p.ambientF, ambientRh: p.ambientRh, altitudeM: p.altitudeM,
        waterPan: p.waterPan, nPieces: p.nPieces, kmKey: p.kmKey,
        weightLbs: p.weightLbs, windMph: p.windMph })
    : wetBulb_F(p.pitF, p.rh || 12);
  /* Injection: free interior water raises the water fraction (spec §7.3). */
  var Xw = c.Xw + (p.injectionPct > 0 ? p.injectionPct / 100 : 0);
  if (Xw > SP_INJ_XW_MAX) Xw = SP_INJ_XW_MAX;
  var T_plat = spPlateauTempF(T_wb, p.pitF, Lc);
  var dwellH = spStallDwellH(Lc, Xw, p.pitF, T_wb) * spFade(T_plat, p.tfF);
  return { T_wb: T_wb, T_plat: T_plat, Lc: Lc, dwellH: dwellH };
}
```

- [ ] **Step 5: Differentiate wrap variants + apply spritz in `spCompute`**

In `spCompute`, change the `wrapActive` guard (line ~254) to include `boat`:

```js
  var wrapActive = (p.wrapMethod === 'foil' || p.wrapMethod === 'paper' || p.wrapMethod === 'boat');
```

Replace the wrapped-cook `return` block (lines ~255-264) with a residual-dwell version:

```js
  if (wrapActive) {
    var Twrap = p.wrapTriggerF || SP_STALL_START;
    var wrapAtF = Math.min(Twrap, s.T_plat);
    var wf = SP_WRAP_FACTOR[p.wrapMethod];        /* foil 0, paper .45, boat .70 */
    var t1w = spPhase(Km, L, p.pitF, tiF, wrapAtF);
    var t2w = s.dwellH * wf;                       /* residual dwell after wrapping */
    var t3w = spPhase(Km, L, p.pitF, wrapAtF, p.tfF);
    if (!isFinite(t1w) || !isFinite(t3w)) {
      return { error: 'Pull temperature or wrap trigger temperature exceeds pit temperature.' };
    }
    return { t1h: t1w, t2h: t2w, t3h: t3w, totalH: t1w + t2w + t3w, T_wb: s.T_wb, T_plat: s.T_plat, L: L, dwellH: t2w, wrapAtF: wrapAtF, error: null };
  }
```

Then in the unwrapped additive branch (lines ~274-281), apply the spritz factor to the dwell:

```js
  var t1 = spPhase(Km, L, p.pitF, tiF, s.T_plat);
  var t2 = s.dwellH * spSpritzFactor(p.spritzesPerHour);
  var t3 = spPhase(Km, L, p.pitF, s.T_plat, p.tfF);
  if (!isFinite(t1) || !isFinite(t3)) {
    return { error: 'Pull temperature exceeds pit temperature.' };
  }
  return { t1h: t1, t2h: t2, t3h: t3, totalH: t1 + t2 + t3, T_wb: s.T_wb, T_plat: s.T_plat, L: L, dwellH: t2, error: null };
```

- [ ] **Step 6: Mirror the modifiers in `spResolve`**

In `spResolve`, change the `wrapActive` computation (line ~311) to include `boat`:

```js
  var wrapActive = (wrapMethod === 'foil' || wrapMethod === 'paper' || wrapMethod === 'boat');
```

Replace the wrapped branch (lines ~320-326) so it carries residual dwell (foil → 0, unchanged):

```js
  } else if (wrapActive) {
    var sw = spStall(p);
    var wf = SP_WRAP_FACTOR[wrapMethod] != null ? SP_WRAP_FACTOR[wrapMethod] : 0;
    var residual = sw.dwellH * wf;
    var fracW = (p.currentF <= sw.T_plat) ? 1 : 0;
    t = spPhase(Km, L, p.pitF, p.currentF, p.tfF) + residual * fracW;
```

Replace the unwrapped `else` branch (lines ~327-342) so it applies the spritz factor:

```js
  } else {
    var s = spStall(p);
    if (s.T_wb >= p.pitF) {
      return { remainingH: 0, error: 'Pit temperature is too low to cook. Raise smoker temperature.' };
    }
    var dwellEff = s.dwellH * spSpritzFactor(p.spritzesPerHour);
    if (s.T_plat >= p.tfF || dwellEff <= 0) {
      t = spPhase(Km, L, p.pitF, p.currentF, p.tfF);
    } else {
      /* Dwell is a discrete lump at the plateau; hold it full until the reading
         is past T_plat, then drop to zero (post-stall climb only). */
      var frac = (p.currentF <= s.T_plat) ? 1 : 0;
      t = spPhase(Km, L, p.pitF, p.currentF, p.tfF) + dwellEff * frac;
    }
  }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run --root worker tests/unit/smoke-physics.test.ts`
Expected: all tests PASS (the new `stage-5 modifiers` block + all pre-existing tests, including `wrapped cook truncates the stall (t2h == 0)` which uses foil, and `a wrapped cook carries no dwell` which uses foil).

Then run the parity guard: `npx vitest run --root worker tests/unit/physics-parity.test.ts`
Expected: PASS (legacy `wetBulb_F` path untouched).

- [ ] **Step 8: Commit**

```bash
git add _partials/smoke-physics.js worker/tests/unit/smoke-physics.test.ts
git commit -m "feat(#141): stall-model v2 M2 engine modifiers (wrap variants, spritz, injection, fat cap)"
```

---

## Task 2: Plan-URL — persist the new modifier inputs

**Files:**
- Modify: `_partials/plan-url.js` (`ENUMS.wrap` line ~34; `VALIDATORS` map lines ~82-107)
- Test: `scripts/plan-url.test.js` (FULL fixture ~15-31; add tests)

**Interfaces:**
- Consumes: existing `clampNum`, `inEnum`, `VALIDATORS`, `KEYS` machinery.
- Produces: new plan keys usable by the calculators — `injp` (int 0-25), `fat` (float 0-1), `spz` (int 0-6), `np` (int 1-12), `wind` (int 0-40); `wrap` now also accepts `'boat'`.

- [ ] **Step 1: Write the failing tests**

Extend the `FULL` fixture object in `scripts/plan-url.test.js` (lines ~15-31) to include the new keys, so the existing round-trip test also covers them:

```js
  bone: 1,
  inj: 0,
  injp: 10,
  fat: 0.25,
  spz: 2,
  np: 2,
  wind: 8,
  sz: 'normal',
```

Then add these tests after the existing brisket-keys block (~line 178):

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/plan-url.test.js`
Expected: FAIL — `wrap=boat` dropped (not in enum), new validators undefined so `injp`/`fat`/`spz`/`np`/`wind` never round-trip.

- [ ] **Step 3: Add `boat` to the wrap enum**

In `_partials/plan-url.js`, change (line ~34):

```js
    wrap: ['foil', 'paper', 'none', 'boat'],
```

- [ ] **Step 4: Add the new validators**

In the `VALIDATORS` map, after the `thick` entry (line ~106), add (note the trailing comma on the `thick` line):

```js
    thick: function (v) { return clampNum(v, 0, 6, false); },   // brisket flat thickness (in)
    injp: function (v) { return clampNum(v, 0, 25, true); },    // injection % of weight
    fat:  function (v) { return clampNum(v, 0, 1, false); },    // fat cap thickness (in)
    spz:  function (v) { return clampNum(v, 0, 6, true); },     // spritzes per hour
    np:   function (v) { return clampNum(v, 1, 12, true); },    // load count (pieces on the smoker)
    wind: function (v) { return clampNum(v, 0, 40, true); }     // wind (mph)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test scripts/plan-url.test.js`
Expected: PASS (all, including the CUTS-in-sync guard, which is unaffected).

- [ ] **Step 6: Commit**

```bash
git add _partials/plan-url.js scripts/plan-url.test.js
git commit -m "feat(#141): plan-url support for boat wrap + spritz/injection/fat-cap/load/wind keys"
```

---

## Task 3: Brisket calculator — full modifier UI

**Files:**
- Modify: `_src/tools/brisket-calculator.html` (wrap-toggle ~259-263; advanced controls near the water-pan group ~248-250; `spCompute` call ~627-640; `_lastPhysicsParams` object ~648-660; plan-state object ~574-579; hydration block ~880-887; stall-note switch ~694-697)

**Interfaces:**
- Consumes: `spCompute`/`spResolve` params from Task 1 (`spritzesPerHour`, `injectionPct`, `fatCapInches`, `nPieces`, `windMph`, `wrapMethod:'boat'`); plan keys from Task 2 (`injp`/`fat`/`spz`/`np`/`wind`).
- Produces: nothing consumed by later tasks (self-contained page).

**Before editing:** read the current file to confirm the exact anchors above; follow the existing `cookerType`/`waterPan` control + wiring pattern already in the file.

- [ ] **Step 1: Add the "Foil Boat" wrap button**

In the `.wrap-toggle` group, insert after the `paper` button (line ~261), before the `none` button:

```html
          <button data-wrap="boat" type="button" aria-pressed="false">Foil Boat<br><small style="font-weight:400;font-size:.8rem">Bark + speed</small></button>
```

- [ ] **Step 2: Add the advanced modifier controls**

Immediately after the water-pan `.form-group.full-width` (line ~250), insert:

```html
      <div class="form-group full-width">
        <label for="spritzRate">Spritz / mop (times per hour)</label>
        <input type="number" id="spritzRate" min="0" max="6" step="1" value="0" inputmode="numeric">
      </div>
      <div class="form-group full-width">
        <label for="injectionPct">Injection (% of weight)</label>
        <input type="number" id="injectionPct" min="0" max="25" step="1" value="0" inputmode="numeric">
      </div>
      <div class="form-group full-width">
        <label for="fatCap">Fat cap thickness (in)</label>
        <input type="number" id="fatCap" min="0" max="1" step="0.25" value="0" inputmode="decimal">
      </div>
      <div class="form-group">
        <label for="loadCount">Pieces on the smoker</label>
        <input type="number" id="loadCount" min="1" max="12" step="1" value="1" inputmode="numeric">
      </div>
      <div class="form-group">
        <label for="windMph">Wind (mph)</label>
        <input type="number" id="windMph" min="0" max="40" step="1" value="0" inputmode="numeric">
      </div>
```

- [ ] **Step 3: Pass the new params into `spCompute` and `_lastPhysicsParams`**

In the `spCompute({...})` call (add before its closing `});`, ~line 639) AND in the `_lastPhysicsParams = {...}` object (~line 659), add the same five lines to BOTH:

```js
    spritzesPerHour: parseInt(document.getElementById('spritzRate').value, 10) || 0,
    injectionPct: parseInt(document.getElementById('injectionPct').value, 10) || 0,
    fatCapInches: parseFloat(document.getElementById('fatCap').value) || 0,
    nPieces: parseInt(document.getElementById('loadCount').value, 10) || 1,
    windMph: parseInt(document.getElementById('windMph').value, 10) || 0,
```

- [ ] **Step 4: Mirror the inputs into the plan-URL state**

In the plan-state object (the one with `ck`/`wp`/`wrap`, ~line 574-579), add:

```js
    spz: parseInt(document.getElementById('spritzRate').value, 10) || 0,
    injp: parseInt(document.getElementById('injectionPct').value, 10) || 0,
    fat: parseFloat(document.getElementById('fatCap').value) || 0,
    np: parseInt(document.getElementById('loadCount').value, 10) || 1,
    wind: parseInt(document.getElementById('windMph').value, 10) || 0,
```

- [ ] **Step 5: Hydrate the inputs from a shared plan URL**

In the hydration block (near `if(plan.wp!=null)...`, ~line 885), add:

```js
  if(plan.spz!=null) document.getElementById('spritzRate').value=plan.spz;
  if(plan.injp!=null) document.getElementById('injectionPct').value=plan.injp;
  if(plan.fat!=null) document.getElementById('fatCap').value=plan.fat;
  if(plan.np!=null) document.getElementById('loadCount').value=plan.np;
  if(plan.wind!=null) document.getElementById('windMph').value=plan.wind;
```

(The `plan.wrap` hydration already handles the new `boat` button via the generic `.wrap-toggle button` loop — no change needed.)

- [ ] **Step 6: Add a boat case to the stall-note text**

In the `stallNote` assignment (~line 695), add a `boat` branch after the `paper` branch:

```js
  else if (wrap === 'boat') stallNote = 'Internal reaches ' + wrapAtDisp + ': build a foil boat now (bottom sealed, top open) for bark plus speed. Leave until pull temp.';
```

- [ ] **Step 7: Verify the page builds and validates**

Run: `npm run build` then `node scripts/validate.mjs`
Expected: build succeeds; validate passes (no broken tokens/links; brisket page has all required `<head>` elements — unchanged by this task).
Then `git restore` the CRLF-only build noise (metros + smoke-weather pages), leaving only `dist/` untracked and the source file staged.

- [ ] **Step 8: Commit**

```bash
git add _src/tools/brisket-calculator.html
git commit -m "feat(#141): brisket calculator — spritz/injection/fat-cap/load/wind + foil-boat wrap"
```

---

## Task 4: Pork-shoulder calculator — full modifier UI

**Files:**
- Modify: `_src/tools/pork-shoulder-calculator.html` (wrap toggle; advanced controls; `spCompute` call; `_lastPhysicsParams`; plan-state; hydration; stall-note text)

**Interfaces:**
- Consumes: Task 1 engine params + Task 2 plan keys (same as Task 3).
- Produces: nothing consumed downstream.

**Before editing:** read `_src/tools/pork-shoulder-calculator.html` and locate the same anchors used in the brisket file (`cookerType` select, `waterPan` checkbox, `.wrap-toggle` group, the `spCompute({...})` call, `_lastPhysicsParams`, the plan-state object, and the hydration block). Element IDs and the wrap `pork-butt` kmKey may differ — match the file's own conventions. Pork butt is bone-in; do NOT add or alter any existing bone-in control.

- [ ] **Step 1: Add the "Foil Boat" wrap button** to the pork `.wrap-toggle` group (after `paper`, before `none`):

```html
          <button data-wrap="boat" type="button" aria-pressed="false">Foil Boat<br><small style="font-weight:400;font-size:.8rem">Bark + speed</small></button>
```

(If the pork page's wrap toggle uses different markup/labels, keep its markup style but add the `data-wrap="boat"` button.)

- [ ] **Step 2: Add the advanced modifier controls** after the water-pan group:

```html
      <div class="form-group full-width">
        <label for="spritzRate">Spritz / mop (times per hour)</label>
        <input type="number" id="spritzRate" min="0" max="6" step="1" value="0" inputmode="numeric">
      </div>
      <div class="form-group full-width">
        <label for="injectionPct">Injection (% of weight)</label>
        <input type="number" id="injectionPct" min="0" max="25" step="1" value="0" inputmode="numeric">
      </div>
      <div class="form-group full-width">
        <label for="fatCap">Fat cap thickness (in)</label>
        <input type="number" id="fatCap" min="0" max="1" step="0.25" value="0" inputmode="decimal">
      </div>
      <div class="form-group">
        <label for="loadCount">Pieces on the smoker</label>
        <input type="number" id="loadCount" min="1" max="12" step="1" value="1" inputmode="numeric">
      </div>
      <div class="form-group">
        <label for="windMph">Wind (mph)</label>
        <input type="number" id="windMph" min="0" max="40" step="1" value="0" inputmode="numeric">
      </div>
```

- [ ] **Step 3: Pass params into `spCompute` and `_lastPhysicsParams`** — add these five lines to BOTH the `spCompute({...})` call and the `_lastPhysicsParams` object:

```js
    spritzesPerHour: parseInt(document.getElementById('spritzRate').value, 10) || 0,
    injectionPct: parseInt(document.getElementById('injectionPct').value, 10) || 0,
    fatCapInches: parseFloat(document.getElementById('fatCap').value) || 0,
    nPieces: parseInt(document.getElementById('loadCount').value, 10) || 1,
    windMph: parseInt(document.getElementById('windMph').value, 10) || 0,
```

- [ ] **Step 4: Mirror into the plan-URL state object:**

```js
    spz: parseInt(document.getElementById('spritzRate').value, 10) || 0,
    injp: parseInt(document.getElementById('injectionPct').value, 10) || 0,
    fat: parseFloat(document.getElementById('fatCap').value) || 0,
    np: parseInt(document.getElementById('loadCount').value, 10) || 1,
    wind: parseInt(document.getElementById('windMph').value, 10) || 0,
```

- [ ] **Step 5: Hydrate from a shared plan URL:**

```js
  if(plan.spz!=null) document.getElementById('spritzRate').value=plan.spz;
  if(plan.injp!=null) document.getElementById('injectionPct').value=plan.injp;
  if(plan.fat!=null) document.getElementById('fatCap').value=plan.fat;
  if(plan.np!=null) document.getElementById('loadCount').value=plan.np;
  if(plan.wind!=null) document.getElementById('windMph').value=plan.wind;
```

- [ ] **Step 6: Add a boat branch to the pork stall-note text** (match the file's existing `wrap === 'paper'` note wording):

```js
  else if (wrap === 'boat') stallNote = 'Internal reaches ' + wrapAtDisp + ': build a foil boat now (bottom sealed, top open) for bark plus speed. Leave until pull temp.';
```

If the pork page has no `wrapAtF`/stall-note switch of this shape, adapt to its actual note logic — the goal is that selecting "Foil Boat" produces a sensible wrap instruction, not a crash or an empty note.

- [ ] **Step 7: Build + validate + restore build noise** (as Task 3 Step 7).

- [ ] **Step 8: Commit**

```bash
git add _src/tools/pork-shoulder-calculator.html
git commit -m "feat(#141): pork-shoulder calculator — spritz/injection/fat-cap/load/wind + foil-boat wrap"
```

---

## Task 5: Rib calculator — wrap-boat + spritz + load + wind

**Files:**
- Modify: `_src/tools/rib-calculator.html` (wrap toggle; advanced controls; `spCompute`/`_lastPhysicsParams`; plan-state; hydration; stall-note text)

**Interfaces:**
- Consumes: Task 1 engine params (`spritzesPerHour`, `nPieces`, `windMph`, `wrapMethod:'boat'`) + Task 2 plan keys (`spz`/`np`/`wind`).
- Produces: nothing downstream.

**Rationale for reduced set:** injection and fat cap are not standard rib techniques and the rib page has no such controls — Stage A adds only spritz, load count, wind, and the boat wrap to ribs. Do NOT add injection or fat-cap controls here.

**Before editing:** read `_src/tools/rib-calculator.html` and locate its wrap toggle, `spCompute`/`spResolve` call sites, plan-state object, and hydration block. Confirm the rib cuts pass `hasStall: true` — do not change `hasStall`.

- [ ] **Step 1: Add the "Foil Boat" wrap button** to the rib `.wrap-toggle` group (after `paper`, before `none`), matching the file's markup:

```html
          <button data-wrap="boat" type="button" aria-pressed="false">Foil Boat<br><small style="font-weight:400;font-size:.8rem">Bark + speed</small></button>
```

- [ ] **Step 2: Add the reduced advanced controls** after the appropriate form group (e.g. water-pan or cooker):

```html
      <div class="form-group full-width">
        <label for="spritzRate">Spritz / mop (times per hour)</label>
        <input type="number" id="spritzRate" min="0" max="6" step="1" value="0" inputmode="numeric">
      </div>
      <div class="form-group">
        <label for="loadCount">Racks on the smoker</label>
        <input type="number" id="loadCount" min="1" max="12" step="1" value="1" inputmode="numeric">
      </div>
      <div class="form-group">
        <label for="windMph">Wind (mph)</label>
        <input type="number" id="windMph" min="0" max="40" step="1" value="0" inputmode="numeric">
      </div>
```

- [ ] **Step 3: Pass params into `spCompute` and `_lastPhysicsParams`** (both sites):

```js
    spritzesPerHour: parseInt(document.getElementById('spritzRate').value, 10) || 0,
    nPieces: parseInt(document.getElementById('loadCount').value, 10) || 1,
    windMph: parseInt(document.getElementById('windMph').value, 10) || 0,
```

- [ ] **Step 4: Mirror into the plan-URL state object:**

```js
    spz: parseInt(document.getElementById('spritzRate').value, 10) || 0,
    np: parseInt(document.getElementById('loadCount').value, 10) || 1,
    wind: parseInt(document.getElementById('windMph').value, 10) || 0,
```

- [ ] **Step 5: Hydrate from a shared plan URL:**

```js
  if(plan.spz!=null) document.getElementById('spritzRate').value=plan.spz;
  if(plan.np!=null) document.getElementById('loadCount').value=plan.np;
  if(plan.wind!=null) document.getElementById('windMph').value=plan.wind;
```

- [ ] **Step 6: Add a boat branch to the rib stall-note text** (match the file's existing wrap-note wording, if present):

```js
  else if (wrap === 'boat') stallNote = 'Wrap in a foil boat now (bottom sealed, top open) for bark plus speed.';
```

If the rib page renders wrap notes differently, adapt to its actual logic so "Foil Boat" yields a sensible instruction.

- [ ] **Step 7: Build + validate + restore build noise** (as Task 3 Step 7).

- [ ] **Step 8: Commit**

```bash
git add _src/tools/rib-calculator.html
git commit -m "feat(#141): rib calculator — spritz/load/wind + foil-boat wrap"
```

---

## Task 6: Integration — full suite, inline-script budget, docs

**Files:**
- Modify (only if needed): `tests/browser-smoke.spec.js` (inline-script byte budget, ~line 338)
- Modify (only if it makes a load-bearing wrap/stall claim): `llms.txt`

**Interfaces:**
- Consumes: all prior tasks merged on the branch.
- Produces: a green branch ready for the PR review loop.

- [ ] **Step 1: Full build + validate**

Run: `npm run validate`
Expected: PASS. `git restore` the CRLF build noise afterward.

- [ ] **Step 2: Run the JS/TS test suites**

Run: `npx vitest run --root worker` and `node --test scripts/plan-url.test.js`
Expected: all PASS.

- [ ] **Step 3: Run browser-smoke and check the inline-script budget**

Run: `npx playwright test tests/browser-smoke.spec.js`
Expected: PASS. If the inline-script-budget assertion (~line 338) fails because the enlarged partial pushed a page over the cap, read the actual byte count from the failure message and raise the constant to the next multiple of 2000 above the reported actual (mirrors the M1 raise 100000→108000). Do not raise it speculatively — only if the test actually fails, and only to clear the reported overage.

If bumped:

```bash
git add tests/browser-smoke.spec.js
git commit -m "test(#141): raise inline-script budget for the enlarged stall engine + modifier UI"
```

- [ ] **Step 4: Reconcile `llms.txt`**

Run: `grep -in "wrap\|foil\|paper\|stall\|spritz\|inject" llms.txt`
If `llms.txt` states a specific wrap-time reduction or stall duration that this change contradicts (e.g. a flat "foil saves 10%" fact that now differs by variant), update the Key Facts line to reflect that butcher paper (~0.45×) and foil boat (~0.70×) suppress the stall partially versus foil's full truncation. If no such claim exists, make no change.

If changed:

```bash
git add llms.txt
git commit -m "docs(#141): note wrap-variant stall suppression in llms.txt"
```

- [ ] **Step 5: Final verification**

Run: `npm run validate` once more (clean tree except intended commits).
Expected: PASS. Branch is ready for the PR review loop.

---

## Self-Review

**Spec coverage (§7):** §7.1 wrap variants → Task 1 (`SP_WRAP_FACTOR`, residual dwell) + Tasks 3/4/5 (boat button). §7.2 spritz → Task 1 (`spSpritzFactor`, unwrapped-only) + UI. §7.3 injection → Task 1 (`Xw` in `spStall`) + Tasks 3/4 UI. §7.4 fat cap → Task 1 (`Lc` in `spStall`) + Tasks 3/4 UI. §7.5 salt/rub → intentionally omitted (spec says ignore; below noise floor). Load-count/wind UI → Tasks 3/4/5 (engine already accepts them). Ambient/dewpoint/altitude + forecast auto-fill → deferred to Stage B (issue #141), engine already accepts `ambientF`/`ambientRh`/`altitudeM`.

**Deferred and noted:** index.html (legacy boolean `inj`/`bone` + `inj` key collision → needs its own migration), turkey (no stall), cook-time coordinator. All keep working because every new engine param defaults to a no-op.

**Placeholder scan:** every code step shows the exact code; UI tasks name exact IDs, param names, and plan keys. The two runtime-dependent steps (inline-budget bump, llms.txt) are gated on a concrete test failure / grep match with a concrete action.

**Type consistency:** engine param names (`spritzesPerHour`, `injectionPct`, `fatCapInches`, `nPieces`, `windMph`) are identical across Task 1 (engine), the UI wiring (Tasks 3-5), and the test helpers. Plan-URL keys (`injp`/`fat`/`spz`/`np`/`wind`) are identical across Task 2 (validators), the plan-state objects, and the hydration blocks. `SP_WRAP_FACTOR` keys (`none`/`foil`/`paper`/`boat`) match the `wrapMethod` values and the `data-wrap` button attributes.
