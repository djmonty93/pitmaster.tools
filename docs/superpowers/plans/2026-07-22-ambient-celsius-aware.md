# Ambient inputs °C-aware (issue #144) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the Stage B ambient temp / dew-point inputs on the brisket, pork-shoulder, and rib calculators honor the `pitmaster_tu` (°F/°C) preference the rest of each calculator already respects, instead of being hardcoded °F.

**Architecture:** Each calculator already stores `state.tu` ('F'|'C'), converts its resolve "current temp" input at read (`state.tu==='C' ? v*9/5+32 : v`), and reconverts the weight field on unit toggle. This plan applies the same three behaviors to the two ambient temperature fields (`#ambientTemp`, `#ambientDew`): (1) convert the entered value from the display unit to °F at read before clamping; (2) unit-aware labels updated on the temp toggle; (3) reconvert the entered ambient values on toggle. The forecast auto-fill (always °F) and brisket's plan-URL (canonical °F) map into/out of the display unit. Engine and `forecast-autofill.js` are unchanged.

**Tech Stack:** Vanilla ES5-style inline browser JS. Verify with `npm run validate`, `node --test scripts/plan-url.test.js`, `npx playwright test tests/browser-smoke.spec.js`.

## Global Constraints

- **Canonical unit is °F everywhere except the input display.** The engine params (`ambientF`, and the derived `ambientRh`/`ambientDewF`) stay °F. Brisket plan-URL keys `ambt`/`ambdp` stay °F (validators unchanged: `ambt` -40..250, `ambdp` -40..120). Only the on-screen input value is shown in the active unit.
- **Wind is unaffected** (mph, no unit toggle). Altitude is unaffected (feet).
- **Do not touch** `_partials/smoke-physics.js`, `_partials/forecast-autofill.js`, or `_partials/plan-url.js` (no validator change needed — keys remain °F).
- **Do not touch** the existing `#currentTemp` resolve input (out of scope; its convert-at-read behavior is pre-existing).
- **Conversion rounding:** display values are integers. C→F: `Math.round(c*9/5+32)`. F→C: `Math.round((f-32)*5/9)`.
- **Blank stays blank → engine default.** A blank ambient field must still yield `undefined` (engine defaults 70°F/50%RH); conversion applies only to non-blank, finite values.
- **Windows build noise:** `git restore` the ~51 CRLF-churned generated files after build; never `git add .`.
- Validation gate `npm run validate` must pass.

---

## Task 1: Brisket — °C-aware ambient inputs

**Files:** Modify `_src/tools/brisket-calculator.html` — ambient input labels (~278-283), `spModifierInputs()` ambient reads (~622-633), the `#tempToggle` click handler (~926-935), the forecast `onApply` (~969-972), and the plan hydration block (~1019+).

- [ ] **Step 1: Unit-aware labels.** Change the two ambient labels to carry a unit span:
```html
<label for="ambientTemp">Ambient temp (<span class="amb-unit">&#xB0;F</span>)</label>
...
<label for="ambientDew">Ambient dew point (<span class="amb-unit">&#xB0;F</span>)</label>
```

- [ ] **Step 2: Convert at read in `spModifierInputs()`.** The entered value is in the display unit; convert to °F before clamping. Replace the ambient temp + dewpoint read blocks with:
```js
  var rawTemp = document.getElementById('ambientTemp').value;
  var tempNum = Number(rawTemp);
  if (rawTemp !== '' && isFinite(tempNum)) {
    var tempFin = state.tu === 'C' ? (tempNum * 9 / 5 + 32) : tempNum;
    ambientF = Math.min(250, Math.max(-40, Math.round(tempFin)));
  }
  var rawDew = document.getElementById('ambientDew').value;
  var dewNum = Number(rawDew);
  if (rawDew !== '' && isFinite(dewNum)) {
    var dewFin = state.tu === 'C' ? (dewNum * 9 / 5 + 32) : dewNum;
    var dp = Math.min(120, Math.max(-40, Math.round(dewFin)));
    ambientDewF = dp;
    var tForRh = (ambientF != null) ? ambientF : 70;
    ambientRh = Math.min(100, Math.max(1, Math.round(100 * spPSat(spF2C(dp)) / spPSat(spF2C(tForRh)))));
  }
```
(Altitude read is unchanged. The `return` object is unchanged — it already exposes `ambientF`/`ambientRh`/`ambientDewF`/`altitudeM`/`altitudeFt`.)

- [ ] **Step 3: Reconvert ambient values + relabel on the temp toggle.** In the `#tempToggle` click handler, AFTER computing `val` (the new unit) and BEFORE `state.tu = val;`, convert the two ambient field values from the old unit to the new, then update the labels. Insert:
```js
  var toC = (val === 'C');   // switching to Celsius
  ['ambientTemp', 'ambientDew'].forEach(function (id) {
    var el = document.getElementById(id);
    var n = Number(el.value);
    if (el.value !== '' && isFinite(n)) {
      el.value = toC ? Math.round((n - 32) * 5 / 9) : Math.round(n * 9 / 5 + 32);
    }
  });
  Array.prototype.forEach.call(document.querySelectorAll('.amb-unit'), function (s) {
    s.textContent = toC ? '°C' : '°F';
  });
```
(Place this inside the existing `if (val === state.tu) return;`-guarded handler so it only runs on an actual change. The handler's existing `state.tu = val;`, active-button toggle, `localStorage.setItem`, and `calculate()` remain.)

- [ ] **Step 4: Forecast `onApply` → display unit.** The forecast returns °F. Set the fields in the active display unit. Replace the `ambientTemp`/`ambientDew` assignments in `onApply` with:
```js
      document.getElementById('ambientTemp').value = (a.ambientF != null) ? (state.tu === 'C' ? Math.round((a.ambientF - 32) * 5 / 9) : a.ambientF) : '';
      document.getElementById('ambientDew').value  = (a.dewPointF != null) ? (state.tu === 'C' ? Math.round((a.dewPointF - 32) * 5 / 9) : a.dewPointF) : '';
```
(The `windMph` assignment is unchanged.)

- [ ] **Step 5: Hydration → display unit (ordering matters).** The plan keys `ambt`/`ambdp` are canonical °F. They must be applied AFTER `state.tu` is set from `plan.tu`. In the hydration block, ensure the `plan.tu` line runs first (it already does, ~1019), then set the ambient fields converting °F→display unit:
```js
  if(plan.ambt!=null) document.getElementById('ambientTemp').value = (state.tu === 'C' ? Math.round((plan.ambt - 32) * 5 / 9) : plan.ambt);
  if(plan.ambdp!=null) document.getElementById('ambientDew').value = (state.tu === 'C' ? Math.round((plan.ambdp - 32) * 5 / 9) : plan.ambdp);
```
Replace any existing `plan.ambt`/`plan.ambdp` hydration lines with these. (`plan.alt` hydration is unchanged.)

- [ ] **Step 6: Verify.** `npm run build` && `node scripts/validate.mjs` pass; `node --test scripts/plan-url.test.js` still 34/34 (no plan-url change, but confirm). Manually trace: enter 68 in °F → engine ambientF≈68; toggle to °C → field shows 20, label °C, engine still ≈68 (20°C); a shared URL with `ambt=68` hydrated in °C mode shows 20. `git restore` CRLF noise; stage only `_src/tools/brisket-calculator.html`. Commit: `fix(#144): make brisket ambient temp/dew-point inputs °C-aware`

---

## Task 2: Pork shoulder + ribs — °C-aware ambient inputs

**Files:** Modify `_src/tools/pork-shoulder-calculator.html` and `_src/tools/rib-calculator.html`.

Apply the SAME five changes as Task 1 to each file, adapted to its structure (pork/rib inline the ambient derivation rather than using a `spModifierInputs()` helper, and have NO plan-URL — so SKIP Task-1 Step 5 hydration for both). Read each file's ambient reads, its `#tempToggle` handler, and its forecast `onApply` first.

- [ ] **Step 1 (both):** unit-aware labels (`<span class="amb-unit">°F</span>` in the ambient temp + dew-point labels).
- [ ] **Step 2 (both):** convert the ambient temp + dew-point at read from `state.tu` display unit to °F before clamping (same code as Task 1 Step 2, adapted to each file's variable names; keep the blank-guard and `ambientRh` derivation identical). Confirm each file exposes `state.tu` — if a file tracks the unit differently, use its actual unit state variable.
- [ ] **Step 3 (both):** in each file's `#tempToggle` click handler, reconvert the two ambient field values old→new unit and update `.amb-unit` labels (same snippet as Task 1 Step 3), guarded so it runs only on an actual unit change.
- [ ] **Step 4 (both):** forecast `onApply` sets `ambientTemp`/`ambientDew` in the display unit (same conversion as Task 1 Step 4). `windMph` unchanged.
- [ ] **Step 5:** (skip — no plan-URL on pork/rib.)
- [ ] **Step 6:** `npm run build` && `node scripts/validate.mjs` pass. `git restore` CRLF noise; stage only the two calculator files. Commit: `fix(#144): make pork-shoulder + rib ambient inputs °C-aware`

---

## Self-Review

**Coverage:** #144 asks for convert-at-read (Step 2), relabel on toggle (Steps 1+3), reconvert on toggle (Step 3), forecast → display unit (Step 4), and canonical-°F plan-URL with hydrate conversion (Step 5, brisket only). All present.

**Consistency:** the conversion direction (C→F `*9/5+32`, F→C `(f-32)*5/9`) and rounding are identical across all three files and match the existing `#currentTemp` (`:893`) and `weightToggle` (`:946`) patterns. The engine/plan-URL canonical unit stays °F everywhere. Blank-guard preserved (no 0/NaN to the engine). `state.tu` is read consistently; if any file names its unit state differently the implementer adapts.

**Out of scope (noted):** input `min`/`max` attributes stay °F-valued (soft hints; JS clamps post-conversion in °F, so a °C entry is still bounded correctly); `#currentTemp` is untouched.
