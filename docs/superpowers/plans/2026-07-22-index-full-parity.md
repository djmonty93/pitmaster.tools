# Homepage calculator — full stall-modifier parity (#141) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Bring the flagship homepage calculator (`_src/pages/index.html`) to full parity with the dedicated brisket/pork/rib calculators: migrate its crude boolean injection (`inj → ×0.95` scale) to the engine's real `injectionPct`, add the Stage A modifiers (fat cap, spritz, load count, wind, foil-boat wrap), and add the Stage B weather-aware ambient inputs (temp/dew-point/altitude, °C-aware) + "Use my local weather" forecast button — all fed through the existing `spCompute`/`spResolve` path, and all gated to the cuts where they actually matter.

**Architecture:** index computes stall-cut timing via `getPhysicsResult()` → `spCompute()` (returns null for flat-time/two-phase cuts, which use `cookHrs`). The engine already accepts every param (M1 ambient + M2 modifiers). The work is: new advanced-panel controls, a `readStallModifiers()` helper mirroring the dedicated calcs' `spModifierInputs()`, threading those params through `getPhysicsResult`/`render`/`_lastPhysicsParams`, per-cut visibility gating via `onMeatChange()`, plan-URL persistence with injection back-compat, and reusing the #144 °C-aware ambient pattern (index uses `state.tu`).

**Tech Stack:** Vanilla ES5-style inline browser JS. Verify with `npm run validate`, `node --test scripts/plan-url.test.js`, `npx playwright test tests/browser-smoke.spec.js`.

## Global Constraints

- **Modifiers matter only for STALL cuts.** The predicate: `PHYSICS_KEYS[cut] && D[cut].cookRate !== null && PHYSICS_KEYS[cut].hasStall`. (Stall cuts today: brisket-sliced/pulled, pork-butt-sliced/pulled, beef-ribs, lamb-shoulder, pork-belly, beef-chuck.) Non-stall physics cuts get no dwell so dwell modifiers (injection/spritz/fat cap) are inert; flat-time cuts (ribs/quicksmoke) and two-phase (reverse-sear) skip physics entirely. **Gate all new controls** behind a `#stallModifiers` container that `onMeatChange()` shows only for stall cuts (mirror how `#boneInGroup` and the wrap group are gated), and apply hydration values only when the container is visible (mirror the existing wrap/bone hydration guards at index ~1786-1787).
- **Canonical unit is °F**; only the on-screen ambient input value shows the active unit (`state.tu`). Reuse the exact #144 brisket pattern (convert-at-read, `.amb-unit` labels, toggle reconvert, unconditional final label sync, forecast/hydrate → display unit).
- **Bone-in stays as-is** (`bone` bool, `timeFactor *= 1.10`). It is index-specific, NOT a stall-model param — do not migrate it.
- **Injection migration:** replace the boolean `#injected` yes/no `<select>` with an injection **percent** number input; feed `injectionPct` into `spCompute`; REMOVE `if (inp.inj) timeFactor *= 0.95;`. Plan-URL: write the new `injp` key. **Back-compat:** still DECODE the legacy `inj` bool — on hydration, if `plan.injp == null && plan.inj === 1`, prefill the injection field to `12` (%). Keep `inj` in the `hasAdvancedPlan` detection list.
- **Engine / `smoke-physics.js` / `forecast-autofill.js` / `plan-url.js` validators:** `plan-url.js` already has `injp`/`fat`/`spz`/`np`/`wind`/`ambt`/`ambdp`/`alt` validators and `boat` in the wrap enum (from Stage A/B/#144) — NO plan-url.js change needed. Do not modify the engine or `forecast-autofill.js`.
- **Do not regress non-stall cuts:** flat-time, quicksmoke, and two-phase reverse-sear paths must be byte-unchanged in behavior. The `#stallModifiers` container is hidden for them and its inputs are never read on those paths.
- **Windows build noise:** `git restore` the ~51 CRLF-churned generated files; never `git add .`.
- Validation gate `npm run validate` must pass. Watch the homepage inline-script byte budget in `tests/browser-smoke.spec.js` (~line 338) — the added controls + forecast partial may push it over; bump per Task 4 if it fails.

## Reference implementations (read these — do not reinvent)
- Stage A modifier controls + clamped `spModifierInputs()` + boat wrap: `_src/tools/brisket-calculator.html`.
- Stage B ambient inputs + `spUseLocalForecast` button + INJECT: `_src/tools/brisket-calculator.html` (post-#144, °C-aware).
- The engine params and their defaults: `_partials/smoke-physics.js` `spCompute`/`spPitWetBulbF`/`spStall`.

---

## Task 1: Stage A parity + injection migration + gating infra

**Files:** Modify `_src/pages/index.html`.

**Interfaces produced (used by Task 2):**
- `readStallModifiers()` → object with clamped `{ spritzesPerHour, injectionPct, fatCapInches, nPieces, windMph }` (Task 2 extends it with `ambientF`/`ambientRh`/`altitudeM`).
- `getPhysicsResult(cutKey, cut, wLbs, tempF, wrap, rh, cookerType, waterPan, mods)` — extended signature; `mods` is the `readStallModifiers()` result, spread into the `spCompute` call.
- `#stallModifiers` container + `isStallCut(cutKey)` predicate used by `onMeatChange()`.

- [ ] **Step 1: Add the `#stallModifiers` container with Stage A controls** to the advanced-settings grid (after the existing bone-in/injected area). Replace the boolean `#injected` `<select>` with a percent input, and add fat cap / spritz / load / wind. Wrap them all in a gate-able container:
```html
<div class="form-group" id="stallModifiers" style="display:none; grid-column:1/-1;">
  <div class="advanced-grid">
    <div class="form-group"><label for="injectionPct">Injection (% of weight)</label>
      <input type="number" id="injectionPct" min="0" max="25" step="1" value="0" inputmode="numeric"></div>
    <div class="form-group"><label for="fatCap">Fat cap thickness (in)</label>
      <input type="number" id="fatCap" min="0" max="1" step="0.25" value="0" inputmode="decimal"></div>
    <div class="form-group"><label for="spritzRate">Spritz / mop (times per hour)</label>
      <input type="number" id="spritzRate" min="0" max="6" step="1" value="0" inputmode="numeric"></div>
    <div class="form-group"><label for="loadCount">Pieces on the smoker</label>
      <input type="number" id="loadCount" min="1" max="12" step="1" value="1" inputmode="numeric"></div>
    <div class="form-group"><label for="windMph">Wind (mph)</label>
      <input type="number" id="windMph" min="0" max="40" step="1" value="0" inputmode="numeric"></div>
  </div>
</div>
```
Remove the old `<div class="form-group">…<select id="injected">…</select></div>` block. Add a `boat` option to the `#wrapMethod` select: `<option value="boat">Foil Boat</option>` (after paper, before none).

- [ ] **Step 2: `readStallModifiers()` helper** (clamped, mirroring brisket's `spModifierInputs`):
```js
function readStallModifiers(){
  return {
    spritzesPerHour: Math.min(6, Math.max(0, parseInt(document.getElementById('spritzRate').value,10) || 0)),
    injectionPct: Math.min(25, Math.max(0, parseInt(document.getElementById('injectionPct').value,10) || 0)),
    fatCapInches: Math.min(1, Math.max(0, parseFloat(document.getElementById('fatCap').value) || 0)),
    nPieces: Math.min(12, Math.max(1, parseInt(document.getElementById('loadCount').value,10) || 1)),
    windMph: Math.min(40, Math.max(0, parseInt(document.getElementById('windMph').value,10) || 0))
  };
}
```

- [ ] **Step 3: Thread `mods` through `getPhysicsResult` + `render` + `calc`.**
  - `calc()` (~1659): add `mods: readStallModifiers()` to the `inp` object; keep `inj` removed (see Step 5) — bone-in stays.
  - `getPhysicsResult(...)` (~1345): add a trailing `mods` parameter; spread `spritzesPerHour`/`injectionPct`/`fatCapInches`/`nPieces`/`windMph` from `mods` into the `spCompute({...})` call.
  - `render()` (~1427-1452): pass `inp.mods` to `getPhysicsResult`; **remove `if (inp.inj) timeFactor *= 0.95;`** (injection now lives in the engine); keep `if (inp.boneIn && cut.boneInOk) timeFactor *= 1.10;`. Add the five `mods` fields to `_lastPhysicsParams` so the live re-solve uses them.

- [ ] **Step 4: Per-cut gating in `onMeatChange()`.** Add `function isStallCut(k){ return !!(PHYSICS_KEYS[k] && D[k].cookRate !== null && PHYSICS_KEYS[k].hasStall); }`. In `onMeatChange()`, set `document.getElementById('stallModifiers').style.display = isStallCut(currentCutKey) ? '' : 'none';` (use the same cut variable the function already computes). This keeps injection/fat-cap/etc. hidden for ribs/poultry/two-phase cuts where they're inert.

- [ ] **Step 5: Plan-URL — migrate `inj`→`injp`, add modifiers + boat.**
  - `planState()` (~1617): remove the `inj:` line; add `injp: <clamped injection>`, `fat`, `spz`, `np`, `wind` from `readStallModifiers()` (or read the fields). Keep `bone`. `wrap` already covers boat (the select value).
  - `hasAdvancedPlan` (~1762): add `'injp','fat','spz','np','wind'` to the detection list; KEEP `'inj'` (legacy back-compat).
  - Hydration (~1780): replace the `plan.inj` line. Apply the new keys ONLY when `#stallModifiers` is visible for the hydrated cut (guard like the wrap/bone hydration). Back-compat: after `onMeatChange()`, if the cut is a stall cut, set `injectionPct` from `plan.injp` when present, ELSE from legacy `plan.inj===1 ? 12 : 0`. Set `fat`/`spritzRate`/`loadCount`/`windMph` from `plan.fat`/`plan.spz`/`plan.np`/`plan.wind` when present.

- [ ] **Step 6: Verify.** `npm run build` && `node scripts/validate.mjs` pass; `node --test scripts/plan-url.test.js` still 34/34. Trace: a brisket plan with `injp=15` round-trips and feeds the engine; a legacy `inj=1` link prefills injection to 12%; a chicken cut hides `#stallModifiers`; removing `×0.95` doesn't change a no-injection brisket time. `git restore` CRLF noise; stage only `_src/pages/index.html`. Commit: `feat(#141): homepage — migrate injection to % + Stage A modifiers, gated to stall cuts`

---

## Task 2: Stage B parity — °C-aware ambient inputs + forecast auto-fill

**Files:** Modify `_src/pages/index.html`.

**Consumes:** `readStallModifiers()`, `getPhysicsResult(...,mods)`, `#stallModifiers`, `isStallCut` (Task 1); `spUseLocalForecast`/`spForecastToAmbient` (existing partial).

- [ ] **Step 1: INJECT the forecast helper** — add `<!-- INJECT:forecast-autofill.js:script -->` after the `plan-url.js:script` INJECT (~line 896).

- [ ] **Step 2: Add ambient controls + forecast button** INSIDE the `#stallModifiers` container's grid (so they inherit the stall-cut gating): a `📍 Use my local weather` button (`#useLocalWeather`) + `#weatherMsg` span, and unit-aware ambient temp / dew-point inputs + altitude, exactly like the post-#144 brisket file:
```html
<div class="form-group" style="grid-column:1/-1;">
  <button type="button" id="useLocalWeather" class="opt-check" style="cursor:pointer">📍 Use my local weather</button>
  <span id="weatherMsg" style="font-size:.8rem;color:var(--text-muted)"></span>
</div>
<div class="form-group"><label for="ambientTemp">Ambient temp (<span class="amb-unit">&#xB0;F</span>)</label>
  <input type="number" id="ambientTemp" min="-40" max="250" step="1" placeholder="70" inputmode="numeric"></div>
<div class="form-group"><label for="ambientDew">Ambient dew point (<span class="amb-unit">&#xB0;F</span>)</label>
  <input type="number" id="ambientDew" min="-40" max="120" step="1" placeholder="auto" inputmode="numeric"></div>
<div class="form-group"><label for="altitudeFt">Altitude (ft)</label>
  <input type="number" id="altitudeFt" min="0" max="15000" step="100" value="0" inputmode="numeric"></div>
```

- [ ] **Step 3: Extend `readStallModifiers()`** to also return `ambientF`/`ambientRh`/`altitudeM`, using the #144 brisket derivation verbatim (convert-at-read from `state.tu` to °F; RH from dew-point via `spPSat`/`spF2C`, temp-or-70; altitude ft→m; blank → omit/undefined so engine defaults apply; also return `ambientDewF` for plan-URL). `getPhysicsResult` spreads these into `spCompute`; add them to `_lastPhysicsParams` (Task 1's render change already spreads `mods`, so confirm the new fields flow through).

- [ ] **Step 4: °C-awareness on the temp toggle + init + forecast + hydrate** (reuse #144 brisket pattern, index uses `state.tu`):
  - `#tempToggle` handler: on an actual change, before `state.tu=val`, reconvert the two ambient fields old→new and update `.amb-unit` labels.
  - One unconditional `.amb-unit` sync from the final `state.tu` after the init/hydration block resolves (bidirectional).
  - `#useLocalWeather` click → `spUseLocalForecast({ cooker: <cookerType>, cut: (PHYSICS_KEYS[currentCut] && PHYSICS_KEYS[currentCut].kmKey) || 'brisket-packer', onStart, onApply, onError })`; `onApply` sets `ambientTemp`/`ambientDew` (converted °F→display unit) + `windMph`, then calls `calc()`; disable the button while in flight (onStart) and re-enable in onApply+onError.
  - Hydration: `ambt`/`ambdp` (canonical °F) → display unit, applied after `state.tu` is set and only when `#stallModifiers` is visible; `alt` → `altitudeFt`.

- [ ] **Step 5: Plan-URL ambient keys.** `planState()`: add `ambt`, `ambdp` (from the normalized dew-point, °F canonical), `alt` (raw clamped feet). `hasAdvancedPlan`: add `'ambt','ambdp','alt'`.

- [ ] **Step 6: Verify.** `npm run build` && `node scripts/validate.mjs`; `node --test scripts/plan-url.test.js` 34/34. Trace: ambient temp 68°F→toggle°C→20 with label °C, engine still ~68; forecast button on a brisket cut fills fields + recomputes; ambient hidden on chicken. `git restore` CRLF noise; stage only `_src/pages/index.html`. Commit: `feat(#141): homepage — °C-aware ambient inputs + local-weather forecast (Stage B parity)`

---

## Task 3: Integration

**Files:** possibly `tests/browser-smoke.spec.js`; check `llms.txt`.

- [ ] `npm run validate` (restore CRLF noise after).
- [ ] `npx vitest run --root worker` (whole suite) + `node --test scripts/plan-url.test.js` — report counts; all green.
- [ ] `npx playwright test tests/browser-smoke.spec.js`. The homepage now inlines `forecast-autofill.js` + more controls, so the inline-script-budget assertion (~line 338, the ONE that targets index) may fail — if so, read the actual byte count and raise the constant to the next multiple of 2000 above it; commit `test(#141): raise homepage inline-script budget for stall-modifier + forecast UI`. Port-4173 stale-server gotcha applies (check `Get-NetTCPConnection -LocalPort 4173`; one retry max).
- [ ] Confirm the existing browser-smoke homepage tests still pass (plan hydration, embed, etc.) — the injection control changed from a `<select>` to a number input; if any test references `#injected`, update it.
- [ ] `grep -in "inject\|ambient\|dewpoint\|forecast\|spritz\|fat cap\|wrap" llms.txt` — update only if a load-bearing homepage claim now contradicts; else no change.
- [ ] Final `npm run validate`; clean tree except intended commits.

---

## Self-Review

**Coverage:** injection boolean→% migration + back-compat (Task 1 Steps 1/5); Stage A modifiers fat cap/spritz/load/wind + boat wrap (Task 1); per-cut gating (Task 1 Step 4); Stage B ambient + forecast, °C-aware (Task 2); integration + budget (Task 3). Bone-in intentionally unchanged.

**Risk controls:** all new controls gated behind `#stallModifiers` (hidden → inputs never read on non-stall paths, so flat-time/two-phase/quicksmoke cuts are behavior-unchanged); `×0.95` removed only because injection now enters the engine; `plan-url.js` validators already exist (no schema churn); legacy `inj` still decoded for shared-link back-compat.

**Type consistency:** control ids (`injectionPct`/`fatCap`/`spritzRate`/`loadCount`/`windMph`/`ambientTemp`/`ambientDew`/`altitudeFt`) and engine param names (`injectionPct`/`fatCapInches`/`spritzesPerHour`/`nPieces`/`windMph`/`ambientF`/`ambientRh`/`altitudeM`) match the dedicated calcs. Plan keys (`injp`/`fat`/`spz`/`np`/`wind`/`ambt`/`ambdp`/`alt`) match the existing plan-url.js validators. `getPhysicsResult`'s new `mods` param is defined in Task 1 and only extended (not renamed) in Task 2.
