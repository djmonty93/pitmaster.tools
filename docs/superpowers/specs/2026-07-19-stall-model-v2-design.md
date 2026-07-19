# Stall Model Specification — `_partials/smoke-physics.js` v2

**Issue:** #138 (cook-time engine models stall direction opposite to the scoring engine and BBQ science)
**Status:** Design approved (owner-authored spec). Multi-milestone. Milestone 1 = new physics core, backward-compatible, no new UI inputs.
**Related:** #134, PR #137 (prose-side stall-direction fixes already merged).

> **Status of the numbers:** the structure is derived from drying and heat-transfer theory. The calibration constants (Section 10) are back-fitted against aggregated pitmaster reports and the owner's 3–4 h kamado observation, not measured data. Treat every constant as a placeholder with a calibration plan attached (Section 12). The architecture should survive recalibration; the constants will not.

---

## 0. Integration constraints & milestone decomposition (grounding)

Facts verified against the current codebase (cited), which constrain how the v2 core lands without breaking the live site:

- **UIs already know the cooker type.** Each calculator has a `#cookerType` `<select>` and today maps it via `SP_COOKER_RH[cookerType] → rh`, then passes `rh` to `spCompute` (e.g. `_src/tools/turkey-smoking-calculator.html:594-611`, `_src/pages/index.html:430-431`). So the new mass-balance model can take `cookerType` (already in hand) + optional ambient; **no new UI control is required for the core fix.**
- **`wetBulb_F` (Stull) is pinned by a parity test and reused by scoring.** `worker/tests/unit/physics-parity.test.ts` extracts `wetBulb_F` from `_partials/smoke-physics.js` (raw text) and asserts it matches the TS port `packages/shared/src/physics.ts` within 0.01 °F. The scoring engine keeps its own copy (`_partials/weather-score-shared.js:17,141-142`). **Resolution:** the v2 core adds its own psychrometric stack (`pSat`/`humidityRatio`/`wetBulbC`, Sections 3–4); the legacy `wetBulb_F(Tdb, rh)` stays in the file untouched so the parity test and scoring path are unaffected. Do not delete it.
- **Consumers of the result object.** The 4 calculators read `t1h, t2h, t3h, totalH, T_wb, L` and place timeline markers from `t1h/t2h` (`_src/tools/brisket-calculator.html:668-671,721-736`, `rib-calculator.html:990-1015`, `pork-shoulder-calculator.html:801-846`, `pages/index.html:1369-1380`). v2 must keep these fields and add `T_plat`. Timing (t1+t2+t3=total) must stay internally consistent.
- **Existing behavioral tests must stay green:** `tests/browser-smoke.spec.js` pins wrapped-vs-unwrapped stall timelines and re-solve usability (lines ~458-667). These assert *structure* (labels, counts, remaining>0), not exact hours, so recalibration is allowed but the wrap exit and phase structure must survive.
- **Existing cut keys** (`SP_KM`, `smoke-physics.js:26-40`): brisket-flat, brisket-packer, pork-butt, spare-ribs, baby-back-ribs, pork-loin, whole-chicken, spatchcock-chicken, chicken-thighs, whole-turkey, turkey-breast, fish, lamb-shoulder. Milestone 1 maps these to the Section 9 params; new cuts in Section 9 not yet used by any UI are added to the table but not wired.

### Milestones

- **Milestone 1 — physics core (this issue).** Stages 1–4 + 6: mass-balance humidity (`SP_AIR_EXCHANGE`), psychrometric wet-bulb solver, plateau temperature, dwell, additive assembly, and the phase-boundary-at-`T_plat` bug fix. Backward-compatible API: UIs pass `cookerType` + default ambient (70 °F / 50 % RH, sea level); legacy `rh` accepted as fallback. Wrap exit (already present) retained. Cut params for existing cuts only. Preserve `wetBulb_F`. New unit-test suite (Section 11); browser-smoke stays green. Expose `T_plat`; fix the two false "165 °F" labels (brisket, rib) and the `phWb` plateau displays. **Stop here for review/merge.**
- **Milestone 2 — weather-aware inputs & richer modifiers.** Wire real ambient (temp/dewpoint/altitude, ideally from the Best Smoke Days forecast), water pan, spritz rate, injection %, fat cap, load count → new UI controls; butcher-paper/foil-boat wrap variants (Section 5). Each needs new UI + policy/privacy review where it stores anything.
- **Milestone 3 — calibration & telemetry (Section 12).** Mostly out of code scope: cook-logging harness and the user-telemetry intake form. Deferred; tracked separately.

Everything below Section 1 is the owner-authored spec, reproduced verbatim.

---

## 0.1 Resolved open items (owner decisions — supersede Sections 3.3 / 9 / 10 / 11 where noted)

Verification of the owner spec reproduced Sections 5–6 exactly and Section 4 only under an unstated surface-area assumption (~0.47 m² for a 14 lb brisket). The owner resolved it as follows; all values re-verified against the pipeline.

**1. Surface area is geometric and pinned — never fitted.** `ṁ_evap = C_evap·A·ΔT/100` is degenerate: `C_evap` and `A` only appear as a product, and no data separates them until pit humidity is measured directly. So `A` is fixed from geometry (a measurable fact about the meat) and `SP_EVAP_C` absorbs all transport uncertainty. This keeps `n_pieces`, weight-scaling, and trim effects physically meaningful.

**2. No new scaling parameter.** Reuse the same `n` that drives `Lc`: since volume ∝ mass and thickness ∝ m^n, the two dominant faces give

```
A = A_ref · (weight / weight_ref) ^ (1 − n)
```

Brisket (n=0.22) → A ∝ m^0.78 (grows in plane, faster); pork butt (n=0.33) → A ∝ m^0.67 (isotropic). **Verified:** brisket 14→28 lb raises A by 1.717× (target 1.72); butt 8→16 lb by 1.591× (target 1.59).

**3. `A_ref` table** (box/ellipsoid geometry × rugosity for surface irregularity). This is the new authoritative per-cut area column; it joins the Section 9 table.

| Cut | weight_ref (lb) | A_ref (m²) | rugosity |
|---|---|---|---|
| Brisket, packer | 14 | 0.36 | 1.20 |
| Brisket, flat | 7 | 0.23 | 1.20 |
| Brisket, point | 6 | 0.19 | 1.20 |
| Pork butt / shoulder | 8 | 0.22 | 1.20 |
| Beef chuck roast | 4 | 0.16 | 1.20 |
| Beef short rib (plate) | 4 | 0.17 | 1.30 |
| Beef back rib | 3 | 0.19 | 1.55 |
| Pork spare rib | 3.5 | 0.26 | 1.50 |
| Pork baby back | 2 | 0.17 | 1.50 |
| Pork belly | 5 | 0.20 | 1.15 |
| Pork loin | 4 | 0.17 | 1.10 |
| Whole chicken | 4.5 | 0.13 | 1.15 |
| Turkey, whole | 14 | 0.29 | 1.15 |
| Turkey breast | 7 | 0.17 | 1.10 |
| Tri-tip | 2.5 | 0.12 | 1.15 |
| Prime rib | 12 | 0.21 | 1.15 |
| Lamb shoulder | 5 | 0.17 | 1.20 |
| Salmon fillet | 2 | 0.15 | 1.10 |

A 3.5 lb spare rack (A_ref 0.26) has more surface than an 8 lb butt (0.22): the high surface-to-mass ratio is a second, independent route to "ribs barely stall."

**4. Constant change:** `SP_EVAP_C: 0.22 → 0.28` to hold the Section 4 table with the geometric A_ref=0.36. **Verified:** reproduces the dry-cooker wet-bulb column within ~1 °F (offset 97.4/spec 97, kamado 106.6/107, electric 109.3/110). This is fitting a constant to the earlier inferred table (itself unmeasured) — it only removes internal inconsistency; **only a pit hygrometer resolves it for real** (Section 12, Tier 2).

**5. Sensitivity — the real reason not to over-engineer `A`.** ±25 % error on `A` shifts wet-bulb by <0.5 °F (offset) rising to ~4 °F (electric), and dwell by <1 % (offset) to ~4 % (kamado/electric). `A` is load-bearing **only for sealed cookers**, where the meat term rivals the ambient term; in an offset the ambient term dominates and the meat is a rounding error. Consequence: **no shape model, no taper parameter** — geometric ±15 % is adequate. Test 19 (below) is the guardrail that keeps a future refactor from quietly making `A` load-bearing everywhere.

**6. Two additions worth building in M1/M2:**
- *Dimension override* (optional): accept length/width/thickness and compute `A` and `Lc` directly instead of from weight. Costs nothing; it's what a serious user wants once they see the model reason about thickness.
- *Trim state*: heavily-trimmed → `A × 1.05` (more exposed muscle) **and** apply the trim mass loss to `weight` before scaling (removing a layer, not shrinking the cut). Small but a real, expected input.

**7. Water-pan clamp (Section 3.4 fix) & M1 inclusion.** The spec's "clamp to 92 % of `W_sat(T_pit)`" is undefined above 100 °C (at a 225 °F pit `pSat > pAtm`). **Resolution:** drop that clamp; instead cap the *solved* wet-bulb at `T_pit − 5 °F` (consistent with the `T_plat` clamp) — bisection is already bounded to `[0, T_db]`, so this only prevents the near-singularity value, not a crash. Water pan ships in **Milestone 1** (owner decision): model area `SP_PAN_AREA ≈ 0.25 m²` for a full pan (**verified:** electric + 0.25 m² pan → T_wb 132.2 °F vs spec 133). Needs a water-pan control on the 4 calculators.

**8. Added tests (extend Section 11):**
- **17.** `A` scales as `m^(1−n)`: brisket 14→28 lb ×1.72 ±0.02; butt 8→16 lb ×1.59 ±0.02.
- **18.** `A_ref/weight_ref` ordering sane: highest for baby back, lowest for prime rib (surface-to-mass sanity).
- **19.** (keep this one) Perturbing `A` ±25 % moves offset dwell <1 % and kamado dwell <5 % — pins the sensitivity claim.
- **20.** `SP_EVAP_C · A_ref` for a 14 lb packer reproduces the Section 4 wet-bulb column within ~1.5 °F across all seven cookers.

**Weakest point (owner):** the rugosity factors are eyeballed; 1.5 for rib racks is close to a guess, and ribs are where `A_ref` is proportionally largest — so on a kamado that guess does real work. Flagged in Section 13.

**Revised Milestone 1 scope:** Stages 1–4 + 6 **plus the water pan** (Stage 5 pan branch + clamp fix + one UI control). Spritz, injection, fat cap, dewpoint/ambient inputs, load-count, and butcher-paper/foil-boat variants remain Milestone 2.

---

## 1. Why the current model breaks

| Symptom | Root cause |
|---|---|
| Kamado and electric show zero stall | `T_plat` slope of 1.20 on wet-bulb is ~3x too steep |
| Plateau spans 150 to 225 °F | Input RH range of 4 to 45% spans 68 °F of wet-bulb; the real spread across cookers is ~13 °F |
| Ambient weather can't be an input | RH is assigned per cooker rather than computed |
| Water pan is inexpressible | Same |
| Phase boundary hardcoded at 150 while `T_plat` is computed | Bug, independent of physics |

The fix is one architectural change: **compute pit humidity from a mass balance instead of assigning it.**

---

## 2. Pipeline

```
ambient (T, RH or dewpoint, altitude)
  └─> [1] pit humidity mass balance ──┐
        cooker air exchange           │  (iterate 3x: evap flux
        meat evaporative flux         │   depends on T_wb which
        water pan flux                │   depends on flux)
  └─> [2] pit wet-bulb T_wb ──────────┘
  └─> [3] plateau temperature T_plat  (T_wb, thickness, pit temp)
  └─> [4] stall dwell                 (thickness, driving force, water content)
  └─> [5] modifiers                   (wrap, spritz, inject, pan, load)
  └─> [6] assembly                    total = baseline + dwell
```

Internal units are SI. Convert at the API boundary only. Mixing °F into psychrometric relations is the fastest route to sign errors.

---

## 3. Stage 1 — Pit humidity mass balance

**This replaces the per-cooker RH table entirely.**

```
W_pit = W_ambient + (ṁ_evap · n_pieces + ṁ_pan) / ṁ_air
```

All fluxes in kg/h; `W` is humidity ratio (kg water per kg dry air).

### 3.1 Ambient humidity ratio

```js
// Buck equation, kPa, T in °C. Accurate to ~0.1% below 100 °C;
// degrades above, acceptable for our range.
function pSat(T) {
  return 0.61121 * Math.exp((18.678 - T / 234.5) * (T / (257.14 + T)));
}

function pAtm(altitudeM) {
  return 101.325 * Math.pow(1 - 2.25577e-5 * altitudeM, 5.2559);
}

function humidityRatio(T, rh, p) {
  const pv = (rh / 100) * pSat(T);
  return 0.621945 * pv / (p - pv);
}
```

Prefer **dewpoint** as the user-facing input over RH. Weather APIs supply it, it is conserved under heating, and it removes the "what does 20% RH at 225 °F even mean" problem.

### 3.2 Cooker air exchange, `ṁ_air`

Driven by combustion air demand plus draft. This is the only place cooker type enters.

| Cooker | `ṁ_air` (kg dry air/h) | Basis |
|---|---|---|
| Offset / stick burner | 40 | Stick fire, large excess air, tall stack draft |
| Drum (UDS) | 14 | Charcoal, chimney effect, moderate vents |
| Pellet | 18 | Forced-draft combustion fan |
| Kettle | 10 | Charcoal, natural draft, vents partly closed |
| Kamado | 4 | Sealed ceramic, minimal charcoal burn rate |
| Electric / propane cabinet | 3 | No combustion air demand, vent leakage only |
| Pellet, high-smoke mode | 26 | Elevated fan duty |

**Wind correction** (offsets, kettles, drums only; sealed cookers unaffected):

```
ṁ_air_effective = ṁ_air · (1 + 0.05 · windMph)
```

Wind also drops actual pit temperature. Handle that in the pit-temp input, not here, or you will double-count.

### 3.3 Meat evaporative flux, `ṁ_evap`

Circular: evaporation depends on wet-bulb, wet-bulb depends on evaporation. Fixed-point iterate.

```
ṁ_evap = h_m · A_surf · (W_sat(T_surf) − W_pit)
```

For a calculator, collapse to:

```
ṁ_evap = C_evap · A_surf_m2 · (T_pit_C − T_wb_C) / 100
```

with `C_evap = 0.22 kg/(h·m²·100K)`. Three iterations from `T_wb = 40 °C` converge to under 0.2 °C. Do not iterate to convergence; cap at 4 passes.

`n_pieces` multiplies this. **A pit loaded with eight briskets is a materially more humid pit than one running a single brisket**, which is why commercial cooks behave differently from backyard cooks. This term captures it.

### 3.4 Water pan flux, `ṁ_pan`

A pan sitting at wet-bulb evaporates slowly and self-limits. A pan in direct radiant view of the fire can approach boiling.

```
ṁ_pan = C_pan · A_pan_m2 · (T_pit_C − T_wb_C) / 100     // C_pan = 1.6
```

Cap the result so `W_pit` never exceeds `W_sat(T_pit)` (physically impossible) and clamp to 92% of saturation to avoid the wet-bulb solver hunting near the singularity.

---

## 4. Stage 2 — Wet-bulb solver

Standard ASHRAE psychrometric relation, solved by bisection.

```js
function wetBulbC(Tdb, W, p) {
  let lo = 0, hi = Tdb;
  for (let i = 0; i < 40; i++) {
    const Twb = (lo + hi) / 2;
    const Ws = 0.621945 * pSat(Twb) / (p - pSat(Twb));
    const Wcalc =
      ((2501 - 2.326 * Twb) * Ws - 1.006 * (Tdb - Twb)) /
      (2501 + 1.86 * Tdb - 4.186 * Twb);
    if (Wcalc > W) hi = Twb; else lo = Twb;
  }
  return (lo + hi) / 2;
}
```

40 bisection steps is overkill and still costs nothing. Do not Newton-solve this; the derivative is badly behaved near saturation.

### Reference outputs at 225 °F pit, 70 °F / 50% RH ambient, sea level, single 14 lb brisket

| Cooker | `ṁ_air` | `W_pit` | `T_wb` (°F) |
|---|---|---|---|
| Offset | 40 | 0.0096 | 97 |
| Pellet | 18 | 0.0119 | 100 |
| Kettle | 10 | 0.0148 | 102 |
| Drum | 14 | 0.0128 | 101 |
| Kamado | 4 | 0.0253 | 107 |
| Electric | 3 | 0.0311 | 110 |
| Electric + water pan | 3 | 0.081 | 133 |

**The whole dry-to-humid span across cookers is 13 °F of wet-bulb.** Adding a water pan moves it more than changing cooker type does. That is the correct behavior and the current model cannot express it.

---

## 5. Stage 3 — Plateau temperature

The core plateau sits **above** wet-bulb, not at it, because bark formation leaves the surface unsaturated and the surface floats between wet-bulb and dry-bulb. It sits **below** the surface by the conduction gradient, which grows with thickness.

```
T_plat = T_wb + (T_pit − T_wb) · (A − B · Lc)

A = 0.68, B = 0.20, Lc = conduction half-thickness in inches
```

Clamp: `T_plat = clamp(T_plat, T_wb + 5, T_pit − 5)`.

### Why this shape

- Rises with wet-bulb: humid pit, shallower stall. Matches the drying literature.
- Falls with thickness: thicker meat, bigger internal gradient, core further below the surface.
- The `(T_pit − T_wb)` factor makes the gradient shrink as driving force falls, which is what keeps the plateau inside a narrow band instead of fanning out.

### Sanity check across meats

| Cut | `Lc` | Pit | `T_wb` | `T_plat` | Reported | Verdict |
|---|---|---|---|---|---|---|
| Brisket, offset | 1.25 | 225 | 97 | 152 | 150-160 | pass |
| Brisket, kamado | 1.25 | 225 | 107 | 158 | 150-165 | pass |
| Pork butt | 1.50 | 250 | 100 | 157 | 155-165 | pass |
| Spare ribs | 0.60 | 250 | 100 | 184 | weak/absent stall | pass |
| Beef short rib | 1.60 | 275 | 102 | 162 | stalls hard | pass |
| Whole chicken | 0.80 | 325 | 100 | 217 | no stall | pass |
| Turkey breast | 1.30 | 325 | 105 | 197 | no stall at 325 | pass |
| Turkey breast | 1.30 | 225 | 100 | 153 | mild stall at 225 | pass |
| Pork loin | 1.10 | 250 | 100 | 168 | mild/absent | pass |

Ribs falling out naturally as "barely stalls" is the strongest evidence the thickness term has the right sign. It was not fitted to ribs.

---

## 6. Stage 4 — Stall dwell

```
dwell_h = K · Lc² · (Xw / Xw_ref) / (T_pit − T_wb)

K = 287, Xw_ref = 0.71
```

`Xw` is the **water** mass fraction of the cut, not total moisture, since fat contributes no latent heat.

### Weight enters through thickness only

This is the counterintuitive and important part. Two briskets of equal thickness, one twice as long, have twice the water and twice the evaporating surface. Rate scales with area, mass scales with area, duration is unchanged.

**An 18 lb brisket does not stall 50% longer than a 12 lb brisket.** It stalls maybe 10% longer, because briskets grow in length and width far more than in thickness. Get this right and you will be more accurate than every competing calculator.

```
Lc = Lc_ref · (weight / weight_ref) ^ n
```

| Cut family | `n` | Rationale |
|---|---|---|
| Brisket, flat cuts, ribs, belly | 0.22 | Grow mostly in plane |
| Pork butt, chuck, roasts | 0.33 | Roughly isotropic |
| Poultry, whole | 0.33 | Isotropic |

### Dwell across cookers, 14 lb brisket at 225 °F

| Cooker | `T_wb` | Driving | Dwell |
|---|---|---|---|
| Offset | 97 | 128 | 3.50 h |
| Pellet | 100 | 125 | 3.59 h |
| Kettle | 102 | 123 | 3.65 h |
| Kamado | 107 | 118 | 3.80 h |
| Electric | 110 | 115 | 3.90 h |
| Electric + pan | 133 | 92 | 4.87 h |

Every cooker stalls. Humid stalls longer and shallower. The kamado lands at 3.8 h inside the reported 3–4 h. No cliff, no inversion, no vanish at backyard humidity.

---

## 7. Stage 5 — Modifiers

Applied multiplicatively to dwell, or as exits.

### 7.1 Wrap (exit)

| Wrap | Effect |
|---|---|
| None | dwell as computed |
| Foil | dwell truncated at wrap time; surface saturates, evaporation stops |
| Butcher paper | dwell × 0.45 from wrap time; permeable, partial suppression |
| Foil boat | dwell × 0.70; bottom sealed, top exposed |

Wrap is a hard exit, not a point on the humidity curve. Model it as truncation of remaining dwell, not as a humidity change.

### 7.2 Spritz / mop

Liquid applied to the surface re-saturates it and re-arms evaporation. Adds cool liquid mass that must also be driven off.

```
dwell × (1 + 0.06 · spritzes_per_hour)
```

Capped at ×1.5. Applies only while unwrapped.

### 7.3 Injection

Adds free water to the interior, raising `Xw`.

```
Xw_effective = Xw + injectionPct / 100
```

A 10% injection into a brisket takes `Xw` from 0.71 to 0.81, extending dwell about 14%.

### 7.4 Fat cap

An untrimmed fat cap insulates and does not evaporate. Model as an increase in effective conduction path on the capped face.

```
Lc_effective = Lc + 0.5 · fatCapInches
```

Lowers `T_plat` and lengthens dwell. Both directionally correct.

### 7.5 Salt / rub

Bound water lowers water activity slightly, reducing evaporation rate at the same wet-bulb. Small effect. `dwell × 1.03` for heavy rubs, or ignore. Opinion: ignore it, it is below the model's noise floor.

---

## 8. Stage 6 — Assembly

Keep the additive restructure. It is right, and for a better reason than "it removes the cliff": during a genuine plateau the core is not climbing, so the diffusion clock is genuinely paused. Additive is more physical, not just better behaved.

```js
const t1    = spPhase(pit, tStart, T_plat);   // was hardcoded 150 — BUG
const t2    = dwell * fade;
const t3    = spPhase(pit, T_plat, tTarget);
const total = t1 + t2 + t3;
```

### The 150 bug

The current code computes `T_plat` and then hardcodes 150 in both phase boundaries and in `spResolve`'s proration denominator. For the kettle row, the model claims a 190 °F plateau while modeling the phases around 150 °F. Test (b) passes because nothing pins the boundary to `T_plat`.

### Fade band (keep)

```
fade = clamp((tTarget − T_plat) / 15, 0, 1)
```

Under the new calibration this rarely fires for brisket or butt, and correctly fires for ribs, poultry, and loin, where the plateau genuinely overtakes the target. That is the right division of labor: the fade band should be the *poultry and ribs* branch, not the *kamado* branch.

### `spResolve` (mid-cook re-estimate)

```js
remainingDwell = dwell * clamp((T_plat - currentF) / (T_plat - tStart), 0, 1);
```

Prorate against the phase-1 span, not against a literal 150.

---

## 9. Cut reference table

| Cut | `Lc_ref` (in) | `weight_ref` (lb) | `Xw` | `n` | Target °F |
|---|---|---|---|---|---|
| Brisket, packer | 1.25 | 14 | 0.71 | 0.22 | 203 |
| Brisket, flat | 1.00 | 7 | 0.73 | 0.22 | 203 |
| Brisket, point | 1.40 | 6 | 0.68 | 0.22 | 205 |
| Pork butt / shoulder | 1.50 | 8 | 0.72 | 0.33 | 203 |
| Beef chuck roast | 1.40 | 4 | 0.72 | 0.33 | 205 |
| Beef short rib (plate) | 1.60 | 4 | 0.70 | 0.25 | 205 |
| Beef back rib | 0.80 | 3 | 0.71 | 0.25 | 200 |
| Pork spare rib | 0.60 | 3.5 | 0.72 | 0.22 | 198 |
| Pork baby back | 0.50 | 2 | 0.73 | 0.22 | 198 |
| Pork belly | 0.90 | 5 | 0.55 | 0.22 | 200 |
| Pork loin | 1.10 | 4 | 0.74 | 0.33 | 145 |
| Whole chicken | 0.80 | 4.5 | 0.74 | 0.33 | 165 |
| Turkey, whole | 1.50 | 14 | 0.74 | 0.33 | 165 |
| Turkey breast | 1.30 | 7 | 0.75 | 0.33 | 160 |
| Tri-tip | 0.90 | 2.5 | 0.73 | 0.25 | 135 |
| Prime rib | 1.80 | 12 | 0.68 | 0.33 | 130 |
| Lamb shoulder | 1.30 | 5 | 0.72 | 0.33 | 203 |
| Salmon fillet | 0.45 | 2 | 0.68 | 0.22 | 140 |

Low-target cuts (loin, tri-tip, prime rib, salmon) will nearly always resolve to zero stall via the fade band, correctly.

---

## 10. Constants

| Name | Value | Units | Confidence |
|---|---|---|---|
| `SP_EVAP_C` | 0.22 | kg/(h·m²·100K) | Low |
| `SP_PAN_C` | 1.6 | kg/(h·m²·100K) | Low |
| `SP_PLAT_A` | 0.68 | — | Medium |
| `SP_PLAT_B` | 0.20 | per inch | Low |
| `SP_STALL_K` | 287 | °F·h/in² | Medium |
| `SP_XW_REF` | 0.71 | — | High |
| `SP_PLAT_FADE` | 15 | °F | Arbitrary |
| `SP_WIND_C` | 0.05 | per mph | Low |

Drop `SP_STALL_END`. Add the `ṁ_air` table as `SP_AIR_EXCHANGE`.

`SP_PLAT_A` and `SP_STALL_K` are the two that move results most. Calibrate those first.

---

## 11. Test plan

Replacing the current spec set.

**Unit, deterministic:**
1. `pSat(100) ≈ 101.3 kPa` within 1%
2. `wetBulbC` round-trips: saturated air gives `T_wb == T_db` within 0.1 °C
3. Wet-bulb monotonic increasing in `W` at fixed `T_db`
4. `W_pit` monotonic decreasing in `ṁ_air`
5. Humidity iteration converges in ≤ 4 passes for all cooker/ambient combinations in the fixture grid

**Behavioral, the ones that matter:**
6. **Every cooker in the table produces a nonzero dwell for a 14 lb brisket at 225 °F.** This is the regression test for the current bug.
7. Dwell strictly increases as `ṁ_air` decreases (humid longer)
8. `T_plat` strictly increases as `ṁ_air` decreases (humid shallower)
9. `T_plat` strictly decreases as `Lc` increases
10. Ribs at 250 °F produce `fade < 1`; brisket at 225 °F produces `fade == 1`
11. Chicken at 325 °F produces `dwell == 0`
12. Phase boundaries equal `T_plat`, not 150 (assert directly against the constant)
13. Doubling brisket weight increases dwell by less than 20% (the thickness-scaling claim)
14. Water pan increases dwell more than any cooker swap does
15. `spResolve` at `currentF == T_plat` returns full remaining dwell; at `currentF == tStart` returns full dwell
16. Totals land in 12 to 20 h for all brisket configurations

**Fixture grid:** 7 cookers x 4 ambient conditions (cold/dry, cold/humid, hot/dry, hot/humid) x 6 cuts. Snapshot it. Any constant change that shifts a cell more than 10% should require an explicit snapshot update.

---

## 12. Calibration plan

The constants are fitted to anecdote. Here is how to replace them with data, cheapest first.

**Tier 1, your own pit, six cooks, near zero cost.** Log at 1-minute resolution: core temp at fixed probe depth, pit temp, plus ambient temp and dewpoint from a weather API at your coordinates. Record cut, weight, measured thickness, wrap time, spritz count. Fit `T_plat` and dwell. Six points across one cooker pins `SP_STALL_K` and gives a weak read on `SP_PLAT_A`.

**Tier 2, add a pit hygrometer.** A high-temp capacitive RH probe rated to 250 °F, roughly $200 to $400, converts `ṁ_air` from an assumption into a measurement and validates Stage 1 directly. **Highest information per dollar in the whole plan.**

**Tier 3, user telemetry.** This is the version worth building. Wireless probe thermometers already log core temp with timestamps and location. A form that accepts an exported log plus cut, weight, cooker, and wrap time, joined against gridded weather reanalysis, would fit every constant here properly. A few hundred cooks would beat any chamber experiment for this specific question, and it is a defensible content and data moat for the site.

---

## 13. Known weaknesses

Ranked by how much they threaten the output.

1. **The plateau band is inferred from pitmaster reports, not measurements.** Consumer probes at unverified depth in a heterogeneous cut. If real plateaus spread wider than 150 to 170 °F and cooks simply do not notice fast-resolving high plateaus, `SP_PLAT_A` and `SP_PLAT_B` are both wrong. Six-cook log is the cheapest way to find out.
2. **Dripping is unmodeled.** Peer-reviewed work on beef roasting puts 40 to 70% of cooking loss as expelled juice from protein denaturation rather than evaporation, at 180 to 250 °C. That water does no evaporative cooling. If the dripping fraction stays high at 110 °C, `SP_EVAP_C` is overstated and the whole evaporative framework is a partial explanation of the stall at best.
3. **`ṁ_air` values are engineering estimates from combustion air demand, not measurements.** They could be off by 2x, which moves wet-bulb by several °F. Tier 2 calibration fixes this and nothing else will.
4. **Bark is a moving boundary treated as a constant.** `SP_PLAT_A` implicitly encodes a fixed surface saturation fraction. In reality it evolves through the cook, which is likely why real stalls have soft edges rather than the sharp entry and exit this model produces.
5. **Single-node meat.** No spatial resolution, no fat cap geometry, no anisotropy along versus across the grain. Adequate for a calculator, not for the physics.
6. **Altitude affects psychrometrics here but not boiling-point-driven bark behavior.** Denver cooks will be modeled better than now but still imperfectly.
