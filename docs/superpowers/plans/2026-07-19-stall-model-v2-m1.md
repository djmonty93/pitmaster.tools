# Stall Model v2 — Milestone 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cook-time stall engine in `_partials/smoke-physics.js` with the v2 two-axis physics (mass-balance humidity → wet-bulb → plateau temperature + additive dwell, plus water pan), fixing issue #138, while keeping all four calculators working.

**Architecture:** Pure functions added to the existing browser-global `_partials/smoke-physics.js` (no module system — plain function declarations, tested by `new Function(source)` extraction, mirroring `worker/tests/unit/physics-parity.test.ts`). The legacy Stull `wetBulb_F` stays untouched (pinned by the parity test + reused by scoring). `spCompute`/`spResolve` are rewritten to be **additive** (`total = baseline diffusion cook + stall dwell`) with the phase boundary at `T_plat` (not the hardcoded 150 — the bug). Baseline diffusion timing (`spPhase`, `SP_KM`, `spGetL`/`L`) is **unchanged** to preserve calibrated totals; the new geometric half-thickness `Lc` and surface area `A` feed **only** the stall physics.

**Tech Stack:** Vanilla ES5-style JS (browser IIFE-free global script), Vitest (`vitest run --root worker`), Playwright (`playwright test`), Node build/validate (`npm run validate`).

## Global Constraints

- **Never commit to `main`.** Work on branch `fix/138-stall-model-v2` (already created). Feature branch → PR → merge.
- **Preserve `wetBulb_F(Tdb_F, rh)` verbatim** in `_partials/smoke-physics.js` — `worker/tests/unit/physics-parity.test.ts` extracts it as raw text and asserts ≤0.01 °F vs `packages/shared/src/physics.ts`. Do not rename, reformat, or alter its body.
- **`spCompute`/`spResolve` result shape must keep** `t1h, t2h, t3h, totalH, T_wb, L, error` (consumed by 4 calculators) and **add** `T_plat` (number, or `null` when no stall) and `dwellH`.
- **All internal psychrometrics in SI** (kPa, °C, humidity ratio kg/kg); convert at the °F boundary only. Stall temperature/dwell math (`spPlateauTempF`, `spStallDwellH`) operate in °F as the spec tables do.
- **Constants (spec §10 + §0.1), exact values:** `SP_EVAP_C = 0.28`, `SP_PAN_C = 1.6`, `SP_PAN_AREA = 0.25`, `SP_PLAT_A = 0.68`, `SP_PLAT_B = 0.20`, `SP_STALL_K = 287`, `SP_XW_REF = 0.71`, `SP_PLAT_FADE = 15`, `SP_WIND_C = 0.05`. Drop `SP_STALL_END`. Keep `SP_STALL_START = 150` (wrap-trigger default only).
- **`npm run validate` and `npm test` must pass; the existing `tests/browser-smoke.spec.js` stall specs must stay green** (they assert timeline structure, not exact hours).
- **SEO/head rules unaffected** — no `<head>` changes. Water-pan control is a non-persistent checkbox (no `localStorage`, so no privacy-policy change).
- Convert relative dates to absolute in any note. Today = 2026-07-19.

---

## File Structure

- **Modify** `_partials/smoke-physics.js` — add psychrometric primitives, cut/air-exchange tables, geometry, mass-balance wet-bulb, plateau/dwell, and rewrite `spCompute`/`spResolve`. (Tasks 1–5.)
- **Create** `worker/tests/unit/smoke-physics.test.ts` — the new Vitest unit suite (spec §11 tests 1–20). Grows across Tasks 1–5.
- **Modify** `_src/tools/brisket-calculator.html`, `_src/tools/pork-shoulder-calculator.html`, `_src/tools/rib-calculator.html`, `_src/pages/index.html` — pass `cookerType` + water-pan into the engine, display `T_plat`, fix the false "165 °F" labels, add the water-pan checkbox. (Task 6.)
- **Verify only** `worker/tests/unit/physics-parity.test.ts`, `tests/browser-smoke.spec.js` — must stay green. (Tasks 5, 7.)

Reference (do not edit unless noted): current engine `_partials/smoke-physics.js:1-226`; spec `docs/superpowers/specs/2026-07-19-stall-model-v2-design.md`.

---

### Task 1: Psychrometric primitives + test harness

**Files:**
- Modify: `_partials/smoke-physics.js` (insert helpers after the `wetBulb_F` block, ~line 14)
- Create: `worker/tests/unit/smoke-physics.test.ts`

**Interfaces:**
- Produces: `spF2C(f)`, `spC2F(c)`, `spPSat(TC)`, `spPAtm(altM)`, `spHumidityRatio(TC, rh, pKpa)`, `spWetBulbC(TdbC, W, pKpa)` — all pure, SI. `loadPhysics()` test helper returning the file's globals.

- [ ] **Step 1: Write the failing test** (`worker/tests/unit/smoke-physics.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import smokePhysicsSource from '../../../_partials/smoke-physics.js?raw';

// The partial is a plain browser script (no exports). Wrap the whole source in a
// Function scope and hand back the globals we test — same trick as physics-parity.test.ts.
export function loadPhysics(): any {
  // eslint-disable-next-line no-new-func
  return new Function(
    smokePhysicsSource +
      '\n; return { spF2C, spC2F, spPSat, spPAtm, spHumidityRatio, spWetBulbC,' +
      ' spLc, spSurfaceArea, spPitWetBulbF, spPlateauTempF, spStallDwellH, spFade,' +
      ' spStall, spCompute, spResolve, wetBulb_F,' +
      ' SP_AIR_EXCHANGE, SP_CUT, SP_EVAP_C, SP_STALL_K, SP_STALL_START }; '
  )();
}

const P = loadPhysics();

describe('psychrometric primitives', () => {
  it('pSat(100 C) ~= 101.3 kPa within 1%', () => {
    expect(Math.abs(P.spPSat(100) - 101.3) / 101.3).toBeLessThan(0.01);
  });
  it('wetBulbC round-trips: saturated air gives T_wb == T_db within 0.1 C', () => {
    const p = P.spPAtm(0);
    const Wsat = P.spHumidityRatio(30, 100, p); // 30 C, 100% RH
    expect(Math.abs(P.spWetBulbC(30, Wsat, p) - 30)).toBeLessThan(0.1);
  });
  it('wetBulbC monotonic increasing in W at fixed T_db', () => {
    const p = P.spPAtm(0);
    const lo = P.spWetBulbC(40, 0.005, p);
    const hi = P.spWetBulbC(40, 0.020, p);
    expect(hi).toBeGreaterThan(lo);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root worker tests/unit/smoke-physics.test.ts`
Expected: FAIL — `spPSat is not defined` (the return statement references names the file does not yet declare).

- [ ] **Step 3: Add the primitives** to `_partials/smoke-physics.js`, immediately after the `wetBulb_F` function (after line 14, before the `SP_COOKER_RH` comment):

```js
/* ── Temperature conversions ────────────────────────────────────────────────*/
function spF2C(f) { return (f - 32) * 5 / 9; }
function spC2F(c) { return c * 9 / 5 + 32; }

/* ── Psychrometrics (SI: kPa, °C, humidity ratio W in kg water / kg dry air) ─
   pSat: Buck equation. wetBulbC: ASHRAE relation solved by bisection (stable
   near saturation, where a Newton step is not). */
function spPSat(T) { return 0.61121 * Math.exp((18.678 - T / 234.5) * (T / (257.14 + T))); }
function spPAtm(altM) { return 101.325 * Math.pow(1 - 2.25577e-5 * (altM || 0), 5.2559); }
function spHumidityRatio(T, rh, p) {
  var pv = (rh / 100) * spPSat(T);
  return 0.621945 * pv / (p - pv);
}
function spWetBulbC(Tdb, W, p) {
  var lo = 0, hi = Tdb, Twb, Ws, Wc, i;
  for (i = 0; i < 40; i++) {
    Twb = (lo + hi) / 2;
    Ws = 0.621945 * spPSat(Twb) / (p - spPSat(Twb));
    Wc = ((2501 - 2.326 * Twb) * Ws - 1.006 * (Tdb - Twb)) / (2501 + 1.86 * Tdb - 4.186 * Twb);
    if (Wc > W) hi = Twb; else lo = Twb;
  }
  return (lo + hi) / 2;
}
```

- [ ] **Step 4: Run test to verify it passes** (Task 2/3 names in the `return` are not yet declared, so the harness still throws)

Run: `npx vitest run --root worker tests/unit/smoke-physics.test.ts`
Expected: still FAIL — `spLc is not defined`. **This is expected**: the harness return list is forward-declared for later tasks. To confirm Task 1 in isolation, temporarily trim the `return { ... }` list to only the Task-1 names, run (Expected: PASS, 3 tests), then restore the full list before committing.

- [ ] **Step 5: Commit**

```bash
git add _partials/smoke-physics.js worker/tests/unit/smoke-physics.test.ts
git commit -m "feat(physics): SI psychrometric primitives for stall v2 (#138)"
```

---

### Task 2: Cut table + geometry (Lc and surface area)

**Files:**
- Modify: `_partials/smoke-physics.js` (add `SP_CUT`, `SP_CUT_DEFAULT`, `spLc`, `spSurfaceArea` after `SP_KM`, ~line 40)
- Modify: `worker/tests/unit/smoke-physics.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: `SP_CUT` (per-cut `{LcRef,wRef,Xw,n,ARef}`), `spLc(kmKey, weightLbs, thicknessIn)` → conduction half-thickness (in), `spSurfaceArea(kmKey, weightLbs)` → area (m²). These feed Tasks 3–4 only; **do not** touch `spGetL`/`L` (baseline diffusion thickness stays as-is).

- [ ] **Step 1: Write the failing test** (append to the file)

```ts
describe('cut geometry', () => {
  it('A scales as m^(1-n): brisket 14->28 lb ~1.72x', () => {
    const r = P.spSurfaceArea('brisket-packer', 28) / P.spSurfaceArea('brisket-packer', 14);
    expect(Math.abs(r - 1.72)).toBeLessThan(0.02);
  });
  it('A scales as m^(1-n): pork butt 8->16 lb ~1.59x', () => {
    const r = P.spSurfaceArea('pork-butt', 16) / P.spSurfaceArea('pork-butt', 8);
    expect(Math.abs(r - 1.59)).toBeLessThan(0.02);
  });
  it('surface-to-mass ordering: baby back highest, prime rib lowest', () => {
    const ratio = (k: string) => P.SP_CUT[k].ARef / P.SP_CUT[k].wRef;
    const keys = Object.keys(P.SP_CUT);
    const byRatio = keys.slice().sort((a, b) => ratio(b) - ratio(a));
    expect(byRatio[0]).toBe('baby-back-ribs');
  });
  it('Lc rises with weight and Lc(ref weight) == LcRef', () => {
    expect(P.spLc('brisket-packer', 14, 0)).toBeCloseTo(1.25, 5);
    expect(P.spLc('brisket-packer', 20, 0)).toBeGreaterThan(1.25);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root worker tests/unit/smoke-physics.test.ts`
Expected: FAIL — `Cannot read properties of undefined (reading 'ARef')` / `spSurfaceArea is not defined`.

- [ ] **Step 3: Add the cut table + geometry** to `_partials/smoke-physics.js`, after the `SP_KM` block (after line 40). Note only the six `hasStall` cuts drive the dwell path; the rest inherit `SP_CUT_DEFAULT` (they never reach the stall branch). `ARef`/`Xw`/`n`/`LcRef` per spec §0.1 + §9.

```js
/* ── Per-cut stall parameters (spec §9 + §0.1) ──────────────────────────────
   LcRef: conduction half-thickness (in) at wRef. ARef: surface area (m²) at
   wRef (geometric, rugosity baked in). Xw: water mass fraction. n: thickness
   scaling exponent (Lc ∝ w^n, A ∝ w^(1−n)). Only stall-bearing cuts need real
   values; non-stall cuts fall through to SP_CUT_DEFAULT and never reach the
   dwell path. These feed plateau/dwell ONLY — baseline diffusion uses spGetL. */
var SP_CUT = {
  'brisket-packer': { LcRef: 1.25, wRef: 14,  Xw: 0.71, n: 0.22, ARef: 0.36 },
  'brisket-flat':   { LcRef: 1.00, wRef: 7,   Xw: 0.73, n: 0.22, ARef: 0.23 },
  'pork-butt':      { LcRef: 1.50, wRef: 8,   Xw: 0.72, n: 0.33, ARef: 0.22 },
  'spare-ribs':     { LcRef: 0.60, wRef: 3.5, Xw: 0.72, n: 0.22, ARef: 0.26 },
  'baby-back-ribs': { LcRef: 0.50, wRef: 2,   Xw: 0.73, n: 0.22, ARef: 0.17 },
  'lamb-shoulder':  { LcRef: 1.30, wRef: 5,   Xw: 0.72, n: 0.33, ARef: 0.17 }
};
var SP_CUT_DEFAULT = { LcRef: 1.25, wRef: 10, Xw: 0.71, n: 0.30, ARef: 0.30 };

function spCutParams(kmKey) { return SP_CUT[kmKey] || SP_CUT_DEFAULT; }

/* Conduction half-thickness (in). thicknessIn override wins. */
function spLc(kmKey, weightLbs, thicknessIn) {
  if (thicknessIn > 0) return thicknessIn;
  var c = spCutParams(kmKey);
  return c.LcRef * Math.pow((weightLbs || c.wRef) / c.wRef, c.n);
}

/* Evaporating surface area (m²). Same n as spLc, opposite role. */
function spSurfaceArea(kmKey, weightLbs) {
  var c = spCutParams(kmKey);
  return c.ARef * Math.pow((weightLbs || c.wRef) / c.wRef, 1 - c.n);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --root worker tests/unit/smoke-physics.test.ts`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add _partials/smoke-physics.js worker/tests/unit/smoke-physics.test.ts
git commit -m "feat(physics): per-cut geometry (Lc, surface area) for stall v2 (#138)"
```

---

### Task 3: Pit humidity mass balance → wet-bulb (with water pan)

**Files:**
- Modify: `_partials/smoke-physics.js` (add `SP_AIR_EXCHANGE`, pan/wind/evap constants, `spPitWetBulbF` after Task-2 code)
- Modify: `worker/tests/unit/smoke-physics.test.ts`

**Interfaces:**
- Consumes: Task 1 psychrometrics, Task 2 `spSurfaceArea`.
- Produces: `SP_AIR_EXCHANGE` (cooker → kg dry air/h), `spPitWetBulbF(o)` where `o = {pitF, cookerType, ambientF, ambientRh, altitudeM, waterPan, nPieces, kmKey, weightLbs, windMph}` → pit wet-bulb (°F). Clamped to `pitF − 5`.

- [ ] **Step 1: Write the failing test**

```ts
const AMB = { ambientF: 70, ambientRh: 50, altitudeM: 0 };
function wb(cookerType: string, extra: any = {}) {
  return P.spPitWetBulbF({ pitF: 225, cookerType, kmKey: 'brisket-packer', weightLbs: 14, ...AMB, ...extra });
}

describe('pit mass balance -> wet-bulb', () => {
  it('reproduces spec §4 table within 1.5 F across cookers', () => {
    const spec: Record<string, number> = { offset: 97, pellet: 100, kettle: 102, drum: 101, kamado: 107, electric: 110 };
    for (const c of Object.keys(spec)) expect(Math.abs(wb(c) - spec[c])).toBeLessThan(1.5);
  });
  it('W_pit rises (wet-bulb rises) as air exchange falls: sealed > open', () => {
    expect(wb('electric')).toBeGreaterThan(wb('kamado'));
    expect(wb('kamado')).toBeGreaterThan(wb('offset'));
  });
  it('humidity iteration is stable (4 passes) and stays below pit-5', () => {
    for (const c of ['offset', 'pellet', 'kettle', 'kamado', 'electric'])
      expect(wb(c)).toBeLessThanOrEqual(220);
  });
  it('water pan raises wet-bulb more than any cooker swap', () => {
    const panSwing = wb('electric', { waterPan: true }) - wb('electric');
    const cookerSwing = wb('electric') - wb('offset');
    expect(panSwing).toBeGreaterThan(cookerSwing);
  });
  it('more pieces raise pit wet-bulb', () => {
    expect(wb('kamado', { nPieces: 8 })).toBeGreaterThan(wb('kamado', { nPieces: 1 }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root worker tests/unit/smoke-physics.test.ts`
Expected: FAIL — `spPitWetBulbF is not defined`.

- [ ] **Step 3: Add the mass balance** to `_partials/smoke-physics.js`, after the Task-2 geometry:

```js
/* ── Cooker air exchange (kg dry air/h) — the only place cooker type enters
   the humidity model (spec §3.2). Higher = drier pit. ────────────────────── */
var SP_AIR_EXCHANGE = {
  'offset': 40, 'drum': 14, 'pellet': 18, 'kettle': 10,
  'kamado': 4, 'electric': 3, 'pellet-hi': 26
};

var SP_EVAP_C = 0.28;   /* kg/(h·m²·100K) — lumped meat mass-transfer coeff */
var SP_PAN_C  = 1.6;    /* kg/(h·m²·100K) — water pan */
var SP_PAN_AREA = 0.25; /* m² — full water pan surface */
var SP_WIND_C = 0.05;   /* per mph — draft boost on open cookers */

/* Pit wet-bulb (°F) from an ambient + cooker mass balance (spec §3–4).
   Fixed-point iterate 4x (evap flux depends on T_wb depends on flux). Final
   T_wb capped at pitF−5 to keep the plateau/dwell math off the singularity. */
function spPitWetBulbF(o) {
  var p = spPAtm(o.altitudeM);
  var Wamb = spHumidityRatio(spF2C(o.ambientF != null ? o.ambientF : 70),
                             (o.ambientRh != null ? o.ambientRh : 50), p);
  var TpitC = spF2C(o.pitF);
  var mAir = SP_AIR_EXCHANGE[o.cookerType] || 18;
  if (o.windMph && (o.cookerType === 'offset' || o.cookerType === 'kettle' || o.cookerType === 'drum')) {
    mAir = mAir * (1 + SP_WIND_C * o.windMph);
  }
  var Asurf = spSurfaceArea(o.kmKey, o.weightLbs);
  var Apan = o.waterPan ? SP_PAN_AREA : 0;
  var nPieces = o.nPieces || 1;
  var capC = spF2C(o.pitF - 5);
  var TwbC = 40, i, mEvap, mPan, Wpit;
  for (i = 0; i < 4; i++) {
    mEvap = SP_EVAP_C * Asurf * (TpitC - TwbC) / 100 * nPieces;
    mPan  = Apan > 0 ? SP_PAN_C * Apan * (TpitC - TwbC) / 100 : 0;
    Wpit = Wamb + (mEvap + mPan) / mAir;
    TwbC = spWetBulbC(TpitC, Wpit, p);
    if (TwbC > capC) TwbC = capC;
  }
  return spC2F(TwbC);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --root worker tests/unit/smoke-physics.test.ts`
Expected: PASS (12 tests total).

- [ ] **Step 5: Commit**

```bash
git add _partials/smoke-physics.js worker/tests/unit/smoke-physics.test.ts
git commit -m "feat(physics): pit humidity mass balance + water pan (#138)"
```

---

### Task 4: Plateau temperature + additive dwell

**Files:**
- Modify: `_partials/smoke-physics.js` (add plateau/dwell constants + `spPlateauTempF`, `spStallDwellH`, `spFade`, `spStall`; delete `SP_STALL_END`)
- Modify: `worker/tests/unit/smoke-physics.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `spPlateauTempF(T_wb, pitF, Lc)` → plateau °F (clamped `[T_wb+5, pitF−5]`); `spStallDwellH(Lc, Xw, pitF, T_wb)` → hours; `spFade(T_plat, tfF)` → 0..1; `spStall(p)` → `{T_wb, T_plat, Lc, dwellH}` where `p` carries `{kmKey, weightLbs, thicknessIn, pitF, tfF, cookerType|rh, ambientF, ambientRh, altitudeM, waterPan, nPieces, windMph}`.

- [ ] **Step 1: Write the failing test**

```ts
function stall(cookerType: string, extra: any = {}) {
  return P.spStall({ kmKey: 'brisket-packer', weightLbs: 14, thicknessIn: 0, pitF: 225,
    tfF: 203, cookerType, ...AMB, ...extra });
}

describe('plateau temperature + dwell', () => {
  it('every cooker produces a nonzero brisket dwell at 225 F (the #138 regression)', () => {
    for (const c of ['offset', 'pellet', 'kettle', 'kamado', 'electric'])
      expect(stall(c).dwellH).toBeGreaterThan(0);
  });
  it('dwell increases as air exchange falls (humid = longer)', () => {
    expect(stall('kamado').dwellH).toBeGreaterThan(stall('offset').dwellH);
  });
  it('plateau temperature increases as air exchange falls (humid = shallower)', () => {
    expect(stall('kamado').T_plat).toBeGreaterThan(stall('offset').T_plat);
  });
  it('plateau temperature decreases as Lc increases', () => {
    const thin = P.spPlateauTempF(107, 225, 0.6);
    const thick = P.spPlateauTempF(107, 225, 1.6);
    expect(thick).toBeLessThan(thin);
  });
  it('brisket dwell lands ~3.5 h dry, ~3.8 h kamado (spec §6)', () => {
    expect(stall('offset').dwellH).toBeGreaterThan(3.2);
    expect(stall('offset').dwellH).toBeLessThan(3.8);
    expect(stall('kamado').dwellH).toBeGreaterThan(3.5);
    expect(stall('kamado').dwellH).toBeLessThan(4.2);
  });
  it('brisket at 225 F has full fade; a high plateau vs low target fades to 0', () => {
    expect(P.spFade(175, 203)).toBe(1);
    expect(P.spFade(205, 203)).toBe(0);
  });
  it('doubling brisket weight raises dwell < 20% (thickness-only scaling)', () => {
    const d14 = stall('offset', { weightLbs: 14 }).dwellH;
    const d28 = stall('offset', { weightLbs: 28 }).dwellH;
    expect(d28 / d14).toBeLessThan(1.20);
  });
  it('A ±25% moves offset dwell <1% and kamado dwell <5% (sensitivity guardrail)', () => {
    // Perturb via nPieces as an A-proxy on the evap term: +25% pieces ~ +25% meat flux.
    const off1 = stall('offset').dwellH, offP = stall('offset', { nPieces: 1.25 }).dwellH;
    const kam1 = stall('kamado').dwellH, kamP = stall('kamado', { nPieces: 1.25 }).dwellH;
    expect(Math.abs(offP - off1) / off1).toBeLessThan(0.02);
    expect(Math.abs(kamP - kam1) / kam1).toBeLessThan(0.06);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root worker tests/unit/smoke-physics.test.ts`
Expected: FAIL — `spStall is not defined`.

- [ ] **Step 3a: Delete `SP_STALL_END`.** In `_partials/smoke-physics.js`, change

```js
var SP_STALL_START = 150;
var SP_STALL_END   = 165;
```
to
```js
var SP_STALL_START = 150; /* wrap-trigger default only; no longer a stall-band edge */
```

- [ ] **Step 3b: Add plateau/dwell** after the mass balance (Task 3):

```js
/* ── Plateau temperature & additive dwell (spec §5–6) ───────────────────────
   Two independent axes: T_plat rises with wet-bulb and falls with thickness;
   dwell = K·Lc²·(Xw/Xw_ref)/(pit−T_wb) rises with wet-bulb. The stall is
   ADDITIVE — total = baseline diffusion cook + dwell — so it can only ever add
   time, and fades to zero as the plateau overtakes the target. */
var SP_PLAT_A = 0.68;
var SP_PLAT_B = 0.20;   /* per inch */
var SP_STALL_K = 287;   /* °F·h/in² */
var SP_XW_REF = 0.71;
var SP_PLAT_FADE = 15;  /* °F */

function spPlateauTempF(T_wb, pitF, Lc) {
  var T = T_wb + (pitF - T_wb) * (SP_PLAT_A - SP_PLAT_B * Lc);
  var lo = T_wb + 5, hi = pitF - 5;
  return Math.min(Math.max(T, lo), hi);
}

function spStallDwellH(Lc, Xw, pitF, T_wb) {
  var drive = pitF - T_wb;
  if (drive <= 0) return 0;
  return SP_STALL_K * Lc * Lc * (Xw / SP_XW_REF) / drive;
}

/* Fade: 1 well below target, ramping to 0 as the plateau reaches the pull temp
   (the poultry/ribs/low-target branch — the meat blows through the plateau). */
function spFade(T_plat, tfF) {
  var f = (tfF - T_plat) / SP_PLAT_FADE;
  return Math.min(Math.max(f, 0), 1);
}

/* Resolve the stall quantities for a set of cook params. T_wb comes from the
   mass balance when cookerType is given, else the legacy Stull path (rh). */
function spStall(p) {
  var c = spCutParams(p.kmKey);
  var Lc = spLc(p.kmKey, p.weightLbs || c.wRef, p.thicknessIn);
  var T_wb = (p.cookerType)
    ? spPitWetBulbF({ pitF: p.pitF, cookerType: p.cookerType,
        ambientF: p.ambientF, ambientRh: p.ambientRh, altitudeM: p.altitudeM,
        waterPan: p.waterPan, nPieces: p.nPieces, kmKey: p.kmKey,
        weightLbs: p.weightLbs, windMph: p.windMph })
    : wetBulb_F(p.pitF, p.rh || 12);
  var T_plat = spPlateauTempF(T_wb, p.pitF, Lc);
  var dwellH = spStallDwellH(Lc, c.Xw, p.pitF, T_wb) * spFade(T_plat, p.tfF);
  return { T_wb: T_wb, T_plat: T_plat, Lc: Lc, dwellH: dwellH };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --root worker tests/unit/smoke-physics.test.ts`
Expected: PASS (20 tests total).

- [ ] **Step 5: Commit**

```bash
git add _partials/smoke-physics.js worker/tests/unit/smoke-physics.test.ts
git commit -m "feat(physics): wet-bulb plateau + additive dwell, drop SP_STALL_END (#138)"
```

---

### Task 5: Rewrite `spCompute` and `spResolve` (additive assembly)

**Files:**
- Modify: `_partials/smoke-physics.js` (replace `spCompute` body ~lines 86-146 and `spResolve` body ~lines 166-213)
- Modify: `worker/tests/unit/smoke-physics.test.ts`

**Interfaces:**
- Consumes: Task 4 `spStall`, existing `SP_KM`, `spGetL`, `spPhase`, `SP_STALL_START`.
- Produces: `spCompute(p)` → `{t1h, t2h, t3h, totalH, T_wb, T_plat, L, dwellH, error}`; `spResolve(p)` → `{remainingH, error}`. Phase boundary is `T_plat` (not 150). `total = spPhase(pit,ti,tf) + dwell`.

- [ ] **Step 1: Write the failing test**

```ts
function compute(extra: any = {}) {
  return P.spCompute({ kmKey: 'brisket-packer', weightLbs: 14, thicknessIn: 0, pitF: 225,
    tiF: 38, tfF: 203, hasStall: true, wrapMethod: 'none', cookerType: 'offset', ...AMB, ...extra });
}

describe('spCompute / spResolve assembly', () => {
  it('phases split at T_plat, not 150', () => {
    const r = compute({ cookerType: 'kamado' });
    // t1 climbs to the plateau; with T_plat ~158 the boundary is well above 150.
    expect(r.T_plat).toBeGreaterThan(150);
    // total == baseline diffusion (ti->tf) + dwell, to 1e-6 h
    const baseline = P.spCompute({ kmKey: 'brisket-packer', weightLbs: 14, pitF: 225, tiF: 38,
      tfF: 203, hasStall: false, cookerType: 'kamado', ...AMB }).totalH;
    expect(Math.abs(r.totalH - (baseline + r.dwellH))).toBeLessThan(1e-6);
  });
  it('brisket totals land 12–20 h across cookers', () => {
    for (const c of ['offset', 'pellet', 'kettle', 'kamado', 'electric']) {
      const t = compute({ cookerType: c }).totalH;
      expect(t).toBeGreaterThan(12);
      expect(t).toBeLessThan(20);
    }
  });
  it('a stall adds time: unwrapped total > baseline no-stall cook', () => {
    const r = compute();
    const baseline = P.spCompute({ kmKey: 'brisket-packer', weightLbs: 14, pitF: 225, tiF: 38,
      tfF: 203, hasStall: false, cookerType: 'offset', ...AMB }).totalH;
    expect(r.totalH).toBeGreaterThan(baseline);
  });
  it('wrapped cook truncates the stall (t2h == 0)', () => {
    expect(compute({ wrapMethod: 'foil' }).t2h).toBe(0);
  });
  it('legacy rh path still resolves (browser-smoke compatibility)', () => {
    const r = P.spResolve({ kmKey: 'brisket-packer', weightLbs: 12, pitF: 250, rh: 4,
      currentF: 155, tfF: 195, hasStall: true, wrapMethod: 'foil', wrapTriggerF: 150 });
    expect(r.error).toBeNull();
    expect(r.remainingH).toBeGreaterThan(0);
  });
  it('spResolve dwell proration: full at start temp, zero at plateau', () => {
    const base = { kmKey: 'brisket-packer', weightLbs: 14, pitF: 225, tiF: 38, tfF: 203,
      hasStall: true, wrapMethod: 'none', cookerType: 'offset', ...AMB };
    const s = P.spStall({ ...base });
    const atStart = P.spResolve({ ...base, currentF: 38 }).remainingH;
    const climbOnly = P.spResolve({ ...base, currentF: 38, hasStall: false }).remainingH;
    // remaining at start == full climb + full dwell
    expect(Math.abs(atStart - (climbOnly + s.dwellH))).toBeLessThan(0.01);
    const atPlateau = P.spResolve({ ...base, currentF: Math.round(s.T_plat) }).remainingH;
    const climbFromPlateau = P.spResolve({ ...base, currentF: Math.round(s.T_plat), hasStall: false }).remainingH;
    expect(Math.abs(atPlateau - climbFromPlateau)).toBeLessThan(0.05); // ~no dwell left
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root worker tests/unit/smoke-physics.test.ts`
Expected: FAIL — assertions about `T_plat`/additive totals fail against the current (pre-rewrite) `spCompute`.

- [ ] **Step 3a: Replace `spCompute`.** Swap the whole current function body (from `function spCompute(p) {` through its closing `}` before `spScaleResult`, ~lines 86-146) with:

```js
function spCompute(p) {
  var Km  = SP_KM[p.kmKey] || 1.70;
  var L   = (p.thicknessIn > 0) ? p.thicknessIn : spGetL(p.kmKey, p.weightLbs || 10);
  var tiF = p.tiF || 38;

  /* No-stall cuts: single diffusion phase. Humidity does not affect timing here
     (baseline uses Km/L), so T_wb is display-only. */
  if (!p.hasStall) {
    var tw0 = (p.cookerType) ? spStall(p).T_wb : wetBulb_F(p.pitF, p.rh || 12);
    var t = spPhase(Km, L, p.pitF, tiF, p.tfF);
    if (!isFinite(t)) return { error: 'Pull temperature exceeds pit temperature.' };
    return { t1h: t, t2h: 0, t3h: 0, totalH: t, T_wb: tw0, T_plat: null, L: L, dwellH: 0, error: null };
  }

  var s = spStall(p);
  if (s.T_wb >= p.pitF) {
    return { error: 'Pit temperature is too low to cook. Raise smoker temperature.' };
  }

  /* Wrapped cook (saturated limit): stall truncated, climb at full pit drive. */
  var wrapActive = (p.wrapMethod === 'foil' || p.wrapMethod === 'paper');
  if (wrapActive) {
    var Twrap = p.wrapTriggerF || SP_STALL_START;
    var t1w = spPhase(Km, L, p.pitF, tiF, Twrap);
    var t3w = spPhase(Km, L, p.pitF, Twrap, p.tfF);
    if (!isFinite(t1w) || !isFinite(t3w)) {
      return { error: 'Pull temperature or wrap trigger temperature exceeds pit temperature.' };
    }
    return { t1h: t1w, t2h: 0, t3h: t3w, totalH: t1w + t3w, T_wb: s.T_wb, T_plat: s.T_plat, L: L, dwellH: 0, error: null };
  }

  /* Plateau overtakes the target: no observable stall, single climb. Guards
     against a negative t3 when T_plat > tfF. */
  if (s.T_plat >= p.tfF) {
    var tAll = spPhase(Km, L, p.pitF, tiF, p.tfF);
    if (!isFinite(tAll)) return { error: 'Pull temperature exceeds pit temperature.' };
    return { t1h: tAll, t2h: 0, t3h: 0, totalH: tAll, T_wb: s.T_wb, T_plat: s.T_plat, L: L, dwellH: 0, error: null };
  }

  /* Unwrapped stall: additive. Phase boundary = T_plat (was hardcoded 150). */
  var t1 = spPhase(Km, L, p.pitF, tiF, s.T_plat);
  var t2 = s.dwellH;
  var t3 = spPhase(Km, L, p.pitF, s.T_plat, p.tfF);
  if (!isFinite(t1) || !isFinite(t3)) {
    return { error: 'Pull temperature exceeds pit temperature.' };
  }
  return { t1h: t1, t2h: t2, t3h: t3, totalH: t1 + t2 + t3, T_wb: s.T_wb, T_plat: s.T_plat, L: L, dwellH: t2, error: null };
}
```

- [ ] **Step 3b: Replace `spResolve`.** Swap the whole current `spResolve` body (~lines 166-213) with:

```js
function spResolve(p) {
  var Km  = SP_KM[p.kmKey] || 1.70;
  var L   = (p.thicknessIn > 0) ? p.thicknessIn : spGetL(p.kmKey, p.weightLbs || 10);
  var tiF = p.tiF || 38;
  var hasStall = !!p.hasStall;
  var wrapMethod = p.wrapMethod || 'none';
  var wrapTriggerF = p.wrapTriggerF || SP_STALL_START;
  var wrapActive = (wrapMethod === 'foil' || wrapMethod === 'paper');

  if (p.currentF >= p.tfF) {
    return { remainingH: 0, error: 'Temperature already at or above pull temperature.' };
  }

  var t;
  if (!hasStall) {
    t = spPhase(Km, L, p.pitF, p.currentF, p.tfF);
  } else if (wrapActive) {
    if (p.currentF < wrapTriggerF) {
      t = spPhase(Km, L, p.pitF, p.currentF, wrapTriggerF)
        + spPhase(Km, L, p.pitF, wrapTriggerF, p.tfF);
    } else {
      t = spPhase(Km, L, p.pitF, p.currentF, p.tfF);
    }
  } else {
    var s = spStall(p);
    if (s.T_wb >= p.pitF) {
      return { remainingH: 0, error: 'Pit temperature is too low to cook. Raise smoker temperature.' };
    }
    if (s.T_plat >= p.tfF || s.dwellH <= 0) {
      t = spPhase(Km, L, p.pitF, p.currentF, p.tfF);
    } else {
      var frac = (s.T_plat - p.currentF) / (s.T_plat - tiF);
      frac = Math.min(Math.max(frac, 0), 1);
      t = spPhase(Km, L, p.pitF, p.currentF, p.tfF) + s.dwellH * frac;
    }
  }

  if (!isFinite(t) || t < 0) {
    return { remainingH: 0, error: 'Cannot calculate: check pit and target temperatures.' };
  }
  return { remainingH: t, error: null };
}
```

- [ ] **Step 4: Run the unit suite + the parity test**

Run: `npx vitest run --root worker tests/unit/smoke-physics.test.ts tests/unit/physics-parity.test.ts`
Expected: PASS — smoke-physics suite green (26 tests) AND physics-parity still green (`wetBulb_F` untouched).

- [ ] **Step 5: Commit**

```bash
git add _partials/smoke-physics.js worker/tests/unit/smoke-physics.test.ts
git commit -m "feat(physics): additive stall assembly, boundary at T_plat (#138)"
```

---

### Task 6: Wire calculators — cookerType, water pan, T_plat labels

**Files:**
- Modify: `_src/tools/brisket-calculator.html`, `_src/tools/pork-shoulder-calculator.html`, `_src/tools/rib-calculator.html`, `_src/pages/index.html`

**Interfaces:**
- Consumes: Task 5 `spCompute`/`spResolve` (now accept `cookerType`, `waterPan`, `ambientF`, `ambientRh`; return `T_plat`).
- Produces: no new engine surface; UI passes `cookerType` (it already computes it) + `waterPan`, and renders `T_plat`.

**Pattern (apply per file):** each calculator currently does `var rh = SP_COOKER_RH[cookerType] || 12;` then passes `rh:` into `spCompute`/`spResolve`. Change each call to also pass `cookerType: cookerType` and `waterPan: <checkbox>.checked`. Keep passing `rh` too (harmless; the engine prefers `cookerType`). Then swap `T_wb`→`T_plat` in the plateau **label** sites and fix the literal `165` labels.

- [ ] **Step 1: Add the water-pan checkbox** to each calculator's advanced/options block, next to the existing Cooker Type control. Use the pattern below (IDs per file: `waterPan`). Example for `_src/tools/brisket-calculator.html` (place after the `cookerType` `<select>` group):

```html
<label class="opt-check"><input type="checkbox" id="waterPan"> Water pan in smoker</label>
```

Repeat with the same `id="waterPan"` in `pork-shoulder-calculator.html`, `rib-calculator.html`, and `_src/pages/index.html` (inside the homepage advanced settings, near `#cookerType` at `index.html:430-431`).

- [ ] **Step 2: Pass `cookerType` + `waterPan` into the engine.** In each file, find the `spCompute({ ... rh: rh, ... })` call(s) and the `spResolve({ ... })` call and add two properties. Brisket example — the compute call currently reads (search `spCompute({`):

```js
  // add these two lines inside every spCompute(...) and spResolve(...) params object:
    cookerType: cookerType,
    waterPan: document.getElementById('waterPan').checked,
```

For files where `cookerType` is read inside the handler (e.g. turkey does `var cookerType = ...`), reuse that variable; where it is not yet read (check each), add `var cookerType = document.getElementById('cookerType').value;` at the top of the calc handler. **rib-calculator** stores `_lastPhysicsParams` for the re-solve — add `cookerType` and `waterPan` there too so the live re-solve matches.

- [ ] **Step 3: Fix the false "165" labels + show `T_plat`.**

`_src/tools/brisket-calculator.html:691` — replace
```js
    wrap === 'none' ? { dot: 'amber', time: stallEnd, day: stallEndDay, label: 'Stall ends', sub: 'Temperature climbs again past ' + fmtTemp(165) } : null,
```
with (uses the engine's plateau temp; falls back if absent)
```js
    wrap === 'none' ? { dot: 'amber', time: stallEnd, day: stallEndDay, label: 'Stall ends', sub: 'Temperature climbs again past ' + fmtTemp(Math.round(physics.T_plat || 165)) } : null,
```

`_src/tools/brisket-calculator.html:733` — the plateau row currently shows wet-bulb; show the plateau temp:
```js
    document.getElementById('phWb').textContent = '~' + (Math.round(state.tu === 'C' ? (physics.T_plat - 32) * 5 / 9 : physics.T_plat)) + (state.tu === 'C' ? '°C' : '°F') + ' plateau';
```

`_src/tools/rib-calculator.html:1015` — replace
```js
        evs.push({ color: 'amber', time: stallEndT,   label: 'Stall ends (~' + fmtTemp(165) + ')',      sub: 'Temperature climbs again toward pull temp' });
```
with
```js
        evs.push({ color: 'amber', time: stallEndT,   label: 'Stall ends (~' + fmtTemp(Math.round(result.T_plat || 165)) + ')', sub: 'Temperature climbs again toward pull temp' });
```

`_src/tools/rib-calculator.html:999-1002` — the "Stall plateau temp" row shows `result.T_wb`; switch to `result.T_plat`:
```js
      var wbF = (result.T_plat != null) ? result.T_plat : result.T_wb;
```

`_src/tools/pork-shoulder-calculator.html:828` — plateau display, mirror brisket Step-3 change (`physics.T_plat` in place of `T_wb_disp`, guarding null). Leave its `Stall ends` sub ("climbs again toward target") — it has no false 165.

`_src/pages/index.html` — its timeline `Stall ends` sub is "Temperature climbs again" (no 165); no label fix needed. Only Steps 1–2 (cookerType + waterPan) apply.

- [ ] **Step 4: Build + validate + run the browser smoke suite**

Run: `npm run validate`
Expected: PASS (build succeeds; head/link/token checks clean).
Run: `npx playwright test tests/browser-smoke.spec.js`
Expected: PASS — the wrapped/unwrapped stall-timeline specs (brisket/homepage/pork ~lines 458-667) stay green; the `Stall ends` items still render.

- [ ] **Step 5: Commit**

```bash
git add _src/tools/brisket-calculator.html _src/tools/pork-shoulder-calculator.html _src/tools/rib-calculator.html _src/pages/index.html
git commit -m "feat(calculators): pass cookerType + water pan, show plateau temp (#138)"
```

---

### Task 7: Full-suite verification + PR

**Files:** none (verification + docs)

- [ ] **Step 1: Full test + validate sweep**

Run: `npm test`
Expected: PASS — `test:scripts` (node --test) + `vitest run --root worker` (includes the new smoke-physics suite AND physics-parity).
Run: `npm run validate`
Expected: PASS.
Run: `npx playwright test`
Expected: PASS (or only pre-existing unrelated skips; the stall specs pass).

- [ ] **Step 2: Sanity-check output deltas** (guards spec §11 test 16 end-to-end). In a scratch Node script, load `_partials/smoke-physics.js` and log `spCompute` totals for a 14 lb brisket at 225 °F across offset/pellet/kettle/kamado/electric; confirm each total ∈ [12, 20] h and the dwell rises then fades (no cooker shows 0 dwell at 225 °F). Record the table in the PR body.

- [ ] **Step 3: Update `llms.txt` if any load-bearing claim changed.** The stall is now modeled per-cooker; if `llms.txt` or a tool page states a fixed "stall 150–165 °F" number that this change contradicts, update it. (Grep `llms.txt` for "stall"/"165"; brisket page prose at `brisket-calculator.html:353` describes the stall qualitatively — leave prose unless it asserts a now-false number.)

- [ ] **Step 4: Open the PR**

```bash
git push -u origin fix/138-stall-model-v2
gh pr create --title "fix: stall model v2 — mass-balance humidity, additive dwell (#138)" --body "$(cat <<'EOF'
Fixes #138. Rebuilds the cook-time stall engine per docs/superpowers/specs/2026-07-19-stall-model-v2-design.md (Milestone 1).

## What changed
- Pit humidity from a cooker air-exchange mass balance (replaces the per-cooker RH table); ASHRAE bisection wet-bulb.
- Two independent axes: plateau temperature rises with wet-bulb & falls with thickness; dwell = K·Lc²·(Xw/Xwref)/(pit−Twb) rises with wet-bulb — additive (total = baseline + dwell), no cliff/inversion.
- Phase boundary now = T_plat (the hardcoded-150 bug). Water pan input. `wetBulb_F` preserved (parity test + scoring).
- New Vitest suite worker/tests/unit/smoke-physics.test.ts (spec §11). Calculators pass cookerType + water pan and display the plateau temp; false "165 °F" labels fixed.

## Verification
- npm test / npm run validate / playwright: green (paste the brisket totals table from Task 7 Step 2).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Run the PR review loop.** Invoke the `pr-review-loop` skill (Codex gate → Claude gate → merge). Do not merge until both return clean on the identical latest commit.

---

## Self-Review

**Spec coverage:** Stage 1 mass balance → Task 3. Stage 2 wet-bulb solver → Task 1. Stage 3 plateau → Task 4. Stage 4 dwell → Task 4. Stage 5 wrap exit → Task 5 (foil/paper truncate; butcher-paper×0.45 / foil-boat / spritz / injection / fat cap deferred to M2 per spec §0.1). Water pan → Tasks 3+6. Stage 6 assembly → Task 5. Cut table §9 + A_ref §0.1 → Task 2. Constants §10 → Tasks 3–4 (Global Constraints). Tests §11 (1–20) → Tasks 1–5. Dimension override / trim / dewpoint / load-count / wind UI → deferred M2 (engine already accepts `nPieces`, `windMph`, `ambientF/Rh`, `thicknessIn`; no UI yet).

**Placeholder scan:** none — every code step shows complete code; UI edits give exact old→new snippets with line anchors.

**Type consistency:** `spStall` returns `{T_wb, T_plat, Lc, dwellH}` used identically in Tasks 4–5; `spCompute` result adds `T_plat`/`dwellH` consumed in Task 6; `SP_CUT` field names (`LcRef,wRef,Xw,n,ARef`) consistent across Tasks 2–4.

**Correction to spec §11 test 15 wording:** the Section-8 proration formula `dwell·clamp((T_plat−currentF)/(T_plat−tStart))` gives **full** remaining dwell at `currentF == tStart` and **zero** at `currentF == T_plat` (test 15's "full at T_plat" is transposed). Task 5 Step 1 pins the formula semantics.

**Deferred-scope callout (no silent caps):** M1 ships foil/paper as full stall truncation (not paper×0.45), and does not add UI for dewpoint, spritz, injection, fat cap, load count, or wind — those are Milestone 2. The engine accepts the params now so M2 is UI-only where possible.
