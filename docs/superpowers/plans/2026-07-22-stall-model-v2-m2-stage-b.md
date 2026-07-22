# Stall Model v2 — Milestone 2 (Stage B: weather-aware inputs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let the three stall calculators (brisket, pork shoulder, ribs) take real ambient conditions — manual ambient temp / dewpoint / altitude inputs, plus a one-click "use my local weather" that pulls today's Best Smoke Days forecast — feeding the engine's already-present `ambientF` / `ambientRh` / `altitudeM` / `windMph` params.

**Architecture:** The engine (`_partials/smoke-physics.js`) needs NO changes — M1 already threads `ambientF`/`ambientRh`/`altitudeM` through `spPitWetBulbF`, and Stage A added `windMph`. Stage B is: (1) new manual UI inputs wired through the Stage A pattern; (2) a new shared browser partial `_partials/forecast-autofill.js` that fetches `/api/forecast` and maps a forecast day to `{ambientF, ambientRh, windMph}`; (3) a "Use my local weather" button per calculator; (4) a privacy-policy disclosure for the zip/forecast data flow.

**Tech Stack:** Vanilla ES5-style browser JS inlined via `<!-- INJECT:<file>.js:script -->`. Tests: `node --test` (plan-url) and a Function-wrap unit test for the pure forecast-mapping fn (same trick as `smoke-physics.test.ts`); Playwright browser-smoke; `npm run validate`.

## Global Constraints

- **Engine is frozen for Stage B.** Do NOT modify `_partials/smoke-physics.js` physics. You MAY read its helpers (`spPSat`, `spF2C`) — they are in scope on every calculator page since the engine is inlined there.
- **Forecast field names are AUTHORITATIVE from the shared type, not assumed.** Before mapping a forecast day, Task 1 MUST read the client-facing `ForecastResponse`/`WeatherDay` type (search `worker/src` / the `@shared` types module) and use the EXACT day field names. Confirmed-present client fields (consumed today by `_partials/smoke-weather-app.js`): `tempHighF`, `tempLowF`, `dewPointMeanF`, `gustMphMax`. Fields to VERIFY before use: `windMphMean`, `rhMean`. If `windMphMean`/`rhMean` are absent from the client type, use the fallbacks in Task 1.
- **RH is derived from dewpoint**, never assumed: `RH = 100 · spPSat(spF2C(dewpointF)) / spPSat(spF2C(tempF))`, clamped to `[1, 100]`. (`spPSat` takes °C; both helpers are on the page.)
- **`/api/forecast` facts:** `GET /api/forecast?zip&cut&cooker&days`. Zip defaults to Cloudflare edge `request.cf.postalCode` when omitted (so a fetch with no zip still returns a location-based forecast in production). Response is a `ForecastResponse` with a per-day array. The saved user zip lives in `localStorage['pitmaster_zip']` (set by the smoke-weather app).
- **Privacy (mandatory, project rule):** the forecast fetch sends the user's zip (or relies on IP-based `postalCode`) to our API. `_src/legal/privacy-policy.html` currently discloses only the units localStorage + third-party approximate location — it does NOT mention `pitmaster_zip` or the forecast data flow. Task 5 adds that disclosure. Reading an existing `pitmaster_zip` does not itself add storage; the calculators must NOT write `pitmaster_zip` (leave zip ownership with the weather app).
- **Privacy-respecting default:** the forecast fetch is triggered ONLY by an explicit button click, never automatically on page load — no silent geolocation.
- **Scope:** brisket, pork shoulder, rib calculators only. index.html / turkey / coordinator stay untouched (consistent with Stage A).
- **Windows build noise:** `npm run build` rewrites ~51 CRLF-only files (`_partials/metros-list.html`, `_src/smoke-weather/*.html`). `git restore` them; never `git add .`.
- **Validation gate:** `npm run validate` must pass before merge.
- **Unit defaults (project rule — cross-tool consistency):** temp inputs honor the existing `pitmaster_tu` (°F/°C) preference the calculators already read; do not invent a new unit toggle.

---

## File Structure

- `_partials/forecast-autofill.js` — NEW browser partial. Pure `spForecastToAmbient(day)` → `{ambientF, ambientRh, windMph}` (+ nulls when a field is missing), and a thin `spUseLocalForecast(opts)` that fetches `/api/forecast`, picks the target day, maps it, and hands the result to a caller-supplied `apply` callback. UMD-style export so it's unit-testable. (Task 1)
- `worker/tests/unit/forecast-autofill.test.ts` — unit test for the pure `spForecastToAmbient` mapping (Function-wrap trick). (Task 1)
- `_src/tools/brisket-calculator.html`, `_src/tools/pork-shoulder-calculator.html`, `_src/tools/rib-calculator.html` — ambient temp/dewpoint/altitude inputs + "Use my local weather" button + INJECT the new partial; brisket also gets plan-URL keys. (Tasks 2–4)
- `_partials/plan-url.js` + `scripts/plan-url.test.js` — new brisket plan keys `ambt`/`ambdp`/`alt`. (Task 2)
- `_src/legal/privacy-policy.html` — disclose the zip storage + forecast data flow. (Task 5)
- `tests/browser-smoke.spec.js` — inline-script budget bump if needed; button-present smoke assertion. (Task 6)

---

## Task 1: Forecast-autofill shared partial + pure mapping + test

**Files:**
- Create: `_partials/forecast-autofill.js`
- Create: `worker/tests/unit/forecast-autofill.test.ts`

**Interfaces:**
- Produces (browser globals, mirroring `smoke-physics.js` style — plain `function` decls, no bundler):
  - `spForecastToAmbient(day)` → `{ ambientF: number|null, ambientRh: number|null, windMph: number|null, dewPointF: number|null }`. Pure. `day` is one entry of the forecast response's day array. (`dewPointF` is a passthrough of the day's `dewPointMeanF` so the UI can fill its dewpoint field and re-derive RH through the one manual path.)
  - `spUseLocalForecast(opts)` → `Promise<void>`. `opts = { cooker?, cut?, onApply(ambient), onError(msg), onStart?() }`. Fetches `/api/forecast?...`, picks day[0], maps via `spForecastToAmbient`, calls `onApply` with the mapped object (dropping null fields), or `onError` with a short message on any failure.
- Also exports the same names on `module.exports` under a UMD guard so the test can `require`/Function-wrap it.

- [ ] **Step 1: Confirm the forecast day shape**

Search the shared types for the client `ForecastResponse` / day type and record the exact field names:
Run: `grep -rn "ForecastResponse\|tempHighF\|dewPointMeanF\|windMphMean\|rhMean\|interface .*Day\|type .*Day" worker/src worker/tsconfig*.json` and read the type definition file it points to (follow the `@shared` path alias in `worker/tsconfig.json` if needed).
Record: the day array property name on `ForecastResponse` (e.g. `days` / `forecast`), and which of `windMphMean` / `rhMean` exist on the day. This determines the fallbacks below.

- [ ] **Step 2: Write the failing unit test**

Create `worker/tests/unit/forecast-autofill.test.ts` (Function-wrap trick like `smoke-physics.test.ts`; the partial also needs `spPSat`/`spF2C`, so the test wraps BOTH sources — prepend `smoke-physics.js` source so `spPSat`/`spF2C` are in scope):

```ts
import { describe, expect, it } from 'vitest';
import physicsSource from '../../../_partials/smoke-physics.js?raw';
import autofillSource from '../../../_partials/forecast-autofill.js?raw';

function load(): any {
  // eslint-disable-next-line no-new-func
  return new Function(
    physicsSource + '\n;' + autofillSource +
      '\n; return { spForecastToAmbient };'
  )();
}
const A = load();

describe('spForecastToAmbient', () => {
  it('maps temp (mean of high/low), derives RH from dewpoint, and reads wind', () => {
    // 80F high / 60F low -> ambient 70F; dewpoint 60F -> RH ~ 71% at 70F.
    const day = { tempHighF: 80, tempLowF: 60, dewPointMeanF: 60, windMphMean: 8, gustMphMax: 15 };
    const a = A.spForecastToAmbient(day);
    expect(a.ambientF).toBe(70);
    expect(a.ambientRh).toBeGreaterThan(60);
    expect(a.ambientRh).toBeLessThan(80);
    expect(a.windMph).toBe(8);
  });
  it('RH is 100% when dewpoint equals temperature', () => {
    const a = A.spForecastToAmbient({ tempHighF: 70, tempLowF: 70, dewPointMeanF: 70, windMphMean: 0 });
    expect(a.ambientRh).toBeGreaterThan(98);
    expect(a.ambientRh).toBeLessThanOrEqual(100);
  });
  it('returns null for a field the forecast omits (no crash)', () => {
    const a = A.spForecastToAmbient({ tempHighF: 75, tempLowF: 55 });
    expect(a.ambientF).toBe(65);
    expect(a.ambientRh).toBeNull();   // no dewpoint -> cannot derive RH
  });
});
```

If Step 1 found the wind field is named differently (or absent), adjust the fixture's wind key and the implementation together; if absent entirely, `windMph` maps to `null` and the wind expectation becomes `expect(a.windMph).toBeNull()`.

- [ ] **Step 3: Run the test — verify it fails**

Run: `npx vitest run --root worker tests/unit/forecast-autofill.test.ts`
Expected: FAIL (`spForecastToAmbient is not defined`).

- [ ] **Step 4: Implement `_partials/forecast-autofill.js`**

```js
/* forecast-autofill.js — map a Best Smoke Days forecast day onto the stall
   engine's ambient inputs, and (browser) fetch it on demand. Inlined via
   INJECT:forecast-autofill.js:script AFTER smoke-physics.js (needs spPSat/spF2C).
   Privacy: the fetch sends the user's zip / relies on edge geo-IP; it runs only
   on an explicit user action (see the calculators' "Use my local weather"
   button). Never writes pitmaster_zip. */
(function (root) {
  'use strict';

  /* Pure: forecast day -> ambient inputs. Null for any field the day omits so
     the caller can skip it and keep the engine default. RH is derived from
     dewpoint via the Buck pSat already in smoke-physics (spPSat/spF2C). */
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
    // Wind: prefer the day mean; fall back only if the confirmed field exists.
    var w = (typeof day.windMphMean === 'number') ? day.windMphMean : null;
    if (w != null) out.windMph = Math.round(w);
    return out;
  }

  /* Browser: fetch today's forecast and apply it. opts.onApply(ambient) gets
     the mapped object with null fields removed; opts.onError(msg) on any
     failure. Reads a saved zip if present but never writes one. */
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
        var days = data && (data.days || data.forecast);   // Task 1 Step 1 confirms the key
        var day = days && days.length ? days[0] : null;
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
```

Use the actual day-array key confirmed in Step 1 (replace `data.days || data.forecast` with the real property; keep the `||` only if genuinely unsure). If Step 1 confirmed a different wind field name, update the `day.windMphMean` read to match.

- [ ] **Step 5: Run the test — verify it passes**

Run: `npx vitest run --root worker tests/unit/forecast-autofill.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add _partials/forecast-autofill.js worker/tests/unit/forecast-autofill.test.ts
git commit -m "feat(#141): forecast->ambient mapping helper (Stage B) with unit test"
```

---

## Task 2: Brisket — ambient inputs + local-weather button + plan-URL

**Files:**
- Modify: `_src/tools/brisket-calculator.html` (ambient controls near the Stage A modifier block ~249-270; INJECT the partial after `plan-url.js:script` ~545; `spModifierInputs()`/`calculate()`/`_lastPhysicsParams`/`planState()`/hydration; a button + handler)
- Modify: `_partials/plan-url.js` (add `ambt`/`ambdp`/`alt` validators) + `scripts/plan-url.test.js`

**Interfaces:**
- Consumes: `spUseLocalForecast`/`spForecastToAmbient` (Task 1); engine params `ambientF`/`ambientRh`/`altitudeM` (already accepted).
- Produces: nothing downstream.

**Before editing:** read the brisket file's Stage A additions (the `spModifierInputs()` helper, the `spCompute`/`_lastPhysicsParams`/`planState()` sites, hydration block, and how it reads the `pitmaster_tu` temp-unit preference) and follow that exact pattern.

- [ ] **Step 1: plan-url.js — add ambient validators (TDD)**

In `scripts/plan-url.test.js`, extend the round-trip modifier test (or add one) to include `ambt: 70, ambdp: 55, alt: 500` and assert clamps:
```js
test('round-trips + clamps Stage B ambient keys (ambt/ambdp/alt)', () => {
  assert.deepEqual(decodePlanParams(encodePlanParams({ ambt: 70, ambdp: 55, alt: 500 })), { ambt: 70, ambdp: 55, alt: 500 });
  assert.equal(decodePlanParams('ambt=999').ambt, 250);   // ceiling
  assert.equal(decodePlanParams('ambt=-99').ambt, -40);   // floor
  assert.equal(decodePlanParams('ambdp=999').ambdp, 120); // ceiling
  assert.equal(decodePlanParams('alt=99999').alt, 15000); // ceiling
  assert.equal(decodePlanParams('ambt=abc').ambt, undefined);
});
```
Run `node --test scripts/plan-url.test.js` → FAIL. Then add to `VALIDATORS` (after the Stage A keys):
```js
    ambt: function (v) { return clampNum(v, -40, 250, true); },  // ambient temp °F
    ambdp: function (v) { return clampNum(v, -40, 120, true); }, // ambient dewpoint °F
    alt:  function (v) { return clampNum(v, 0, 15000, true); }   // altitude (ft)
```
(add a trailing comma to the previous last entry). Run the test → PASS.

- [ ] **Step 2: Add the ambient inputs + local-weather button (HTML)**

After the Stage A modifier controls (before `meatThickness`), add — note the temp/dewpoint labels show the active unit via the page's existing unit handling; keep the raw input in °F/°C consistent with how the calculator's other temp fields work (read the file to match):

```html
      <div class="form-group full-width">
        <button type="button" id="useLocalWeather" class="opt-check" style="cursor:pointer">📍 Use my local weather</button>
        <span id="weatherMsg" style="font-size:.8rem;color:var(--text-muted)"></span>
      </div>
      <div class="form-group">
        <label for="ambientTemp">Ambient temp (°F)</label>
        <input type="number" id="ambientTemp" min="-40" max="250" step="1" placeholder="70" inputmode="numeric">
      </div>
      <div class="form-group">
        <label for="ambientDew">Ambient dew point (°F)</label>
        <input type="number" id="ambientDew" min="-40" max="120" step="1" placeholder="auto" inputmode="numeric">
      </div>
      <div class="form-group">
        <label for="altitudeFt">Altitude (ft)</label>
        <input type="number" id="altitudeFt" min="0" max="15000" step="100" value="0" inputmode="numeric">
      </div>
```

INJECT the partial after the plan-url injection (~line 545):
```html
<!-- INJECT:forecast-autofill.js:script -->
```

- [ ] **Step 3: Read the inputs → engine params**

Extend `spModifierInputs()` (or add alongside it) so both `calculate()` and `planState()` share clamped/derived ambient values. Compute:
- `ambientF` = clamp(parseInt ambientTemp, -40, 250); if blank leave the field OUT of the spCompute call (so the engine default 70 applies) — i.e. only pass `ambientF` when the input is non-empty.
- `ambientRh` = derived from dewpoint + ambient temp using the on-page `spPSat`/`spF2C`: `Math.min(100, Math.max(1, Math.round(100*spPSat(spF2C(dp))/spPSat(spF2C(tempF)))))`, computed only when BOTH ambient temp and dewpoint are provided; else omit `ambientRh` (engine default 50).
- `altitudeM` = `Math.round(clamp(alt,0,15000) * 0.3048)`; if alt is 0/blank, omit.

Add `ambientF`/`ambientRh`/`altitudeM` to BOTH the `spCompute({...})` call and the `_lastPhysicsParams` object (only the keys that are set — build them conditionally, or pass `undefined` which the engine treats as default via its `!= null`/`||` guards; verify `spPitWetBulbF` uses `o.ambientF != null ? ... : 70` so `undefined` is safe — it does).

- [ ] **Step 4: Wire the button**

```js
document.getElementById('useLocalWeather').addEventListener('click', function () {
  var msg = document.getElementById('weatherMsg');
  spUseLocalForecast({
    cooker: document.getElementById('cookerType').value,
    cut: 'brisket-packer',
    onStart: function () { msg.textContent = 'Loading…'; },
    onApply: function (a) {
      if (a.ambientF != null) document.getElementById('ambientTemp').value = a.ambientF;
      if (a.dewPointF != null) document.getElementById('ambientDew').value = a.dewPointF;
      if (a.windMph != null) document.getElementById('windMph').value = a.windMph;
      msg.textContent = 'Loaded local conditions.';
      calculate();
    },
    onError: function (m) { msg.textContent = m; }
  });
});
```
The button fills the manual temp/dewpoint/wind fields and recomputes, so RH is derived through the SAME `spModifierInputs()` path as manual entry — one code path, no separate RH branch. (`spForecastToAmbient` returns `dewPointF` for exactly this.)

- [ ] **Step 5: plan-URL state + hydration**

Add to `planState()`: `ambt`, `ambdp`, `alt` from the (clamped) input values (omit when blank/zero as appropriate). Add to the hydration block: set `ambientTemp`/`ambientDew`/`altitudeFt` from `plan.ambt`/`plan.ambdp`/`plan.alt` when present.

- [ ] **Step 6: Build + validate + commit**

`npm run build` && `node scripts/validate.mjs` (restore CRLF noise; stage only `_src/tools/brisket-calculator.html`, `_partials/plan-url.js`, `scripts/plan-url.test.js`). Confirm `dist/tools/brisket-calculator.html` contains `useLocalWeather` and the forecast-autofill script (via validate, since `dist/` reads are blocked).
```bash
git commit -m "feat(#141): brisket ambient inputs + local-weather autofill (Stage B)"
```

---

## Task 3: Pork shoulder — ambient inputs + local-weather button

**Files:** Modify `_src/tools/pork-shoulder-calculator.html`.

Mirror Task 2 Steps 2–4 on the pork file (read it first; match its inline-clamp style from Stage A — pork has no plan-URL, so SKIP the plan-URL state/hydration parts). Add the three ambient inputs + the "Use my local weather" button + INJECT `forecast-autofill.js:script` after the pork page's existing `:script` injects. Pass `cut: 'pork-butt'`, `cooker: <cookerType value>` to `spUseLocalForecast`. Wire `ambientF`/`ambientRh`/`altitudeM` into BOTH the `spCompute` call and `_lastPhysicsParams`, derived the same way (RH from dewpoint via `spPSat`/`spF2C`; omit blanks so engine defaults apply).

- [ ] Build + validate; restore CRLF noise; stage only the pork file.
- [ ] Commit: `feat(#141): pork-shoulder ambient inputs + local-weather autofill (Stage B)`

---

## Task 4: Ribs — ambient inputs + local-weather button

**Files:** Modify `_src/tools/rib-calculator.html`.

Mirror Task 2 Steps 2–4 on the rib file (read it first; ribs have no plan-URL, SKIP those parts). Add the three ambient inputs + button + INJECT the partial. Pass `cut: 'spare-ribs'` (or the rib page's current rib key), `cooker: <cookerType value>`. Wire `ambientF`/`ambientRh`/`altitudeM` into BOTH the `spCompute` call and `_lastPhysicsParams`.

- [ ] Build + validate; restore CRLF noise; stage only the rib file.
- [ ] Commit: `feat(#141): rib ambient inputs + local-weather autofill (Stage B)`

---

## Task 5: Privacy-policy disclosure

**Files:** Modify `_src/legal/privacy-policy.html`.

The forecast fetch sends the user's zip (or relies on IP-based edge `postalCode`) to `/api/forecast`. The current policy (around lines 81, 95) discloses only the consent cookie + unit-preference localStorage. Add disclosure of: (a) the `pitmaster_zip` localStorage entry (a US zip the user enters to get local forecasts), and (b) that when the user requests local weather, their zip — or, if none is saved, their approximate location derived from their IP address — is sent to the site's weather API to fetch a forecast.

- [ ] Read `_src/legal/privacy-policy.html` and find the first-party-storage paragraph (~81) and the local-storage paragraph (~95).
- [ ] Add a sentence to the storage paragraph naming the saved-zip entry, e.g.: *"If you use the local-weather features, we also store the ZIP code you enter (`pitmaster_zip`) in your browser so future visits can prefill your local forecast."*
- [ ] Add a sentence covering the data flow, e.g.: *"When you request a local forecast, that ZIP code — or, if you have not entered one, an approximate location derived from your IP address — is sent to our weather service to retrieve conditions for your area. We do not store this request server-side beyond ordinary short-lived caching."* (Adjust wording to match the page's voice; keep it accurate to the `/api/forecast` behavior.)
- [ ] This is a `noindex` legal page — confirm its `<head>` still carries `robots: noindex, follow` and it stays out of `sitemap.xml` (it already is; make no sitemap change).
- [ ] `npm run build` && `node scripts/validate.mjs`; restore CRLF noise; stage only `_src/legal/privacy-policy.html`.
- [ ] Commit: `docs(#141): privacy-policy — disclose saved-zip storage and forecast data flow`

---

## Task 6: Integration

**Files:** possibly `tests/browser-smoke.spec.js`.

- [ ] `npm run validate` (build + validate). Restore CRLF noise.
- [ ] `npx vitest run --root worker` (whole suite incl. the new `forecast-autofill.test.ts`) and `node --test scripts/plan-url.test.js` — all green; report counts.
- [ ] `npx playwright test tests/browser-smoke.spec.js`. If the inline-script budget (~line 338) fails (the new partial is inlined on 3 calculators), raise the constant to the next multiple of 2000 above the reported actual, and commit `test(#141): raise inline-script budget for forecast-autofill partial`. GOTCHA: a stale server on port 4173 makes Playwright false-fail — check `Get-NetTCPConnection -LocalPort 4173`, don't fight it beyond one retry.
- [ ] Optional smoke assertion: if browser-smoke has a per-calculator check, confirm the `#useLocalWeather` button exists and clicking it (with fetch mocked/failing) shows the manual-entry fallback message rather than throwing. Only add if the existing spec structure makes it cheap.
- [ ] `grep -in "wrap\|foil\|paper\|stall\|spritz\|inject\|ambient\|dewpoint\|forecast" llms.txt` — update only if a load-bearing claim now contradicts; else no change.
- [ ] Final `npm run validate`; clean tree except intended commits.

---

## Self-Review

**Spec coverage:** M2 "real ambient (temp/dewpoint/altitude, ideally from the Best Smoke Days forecast)" → Tasks 2–4 (manual temp/dewpoint/altitude) + Task 1/2–4 (forecast auto-fill). "policy/privacy review where it stores anything" → Task 5. Engine already supports the params (M1), so no engine task.

**Deferred (noted):** index.html / turkey / coordinator (consistent with Stage A). Altitude auto-fill is not attempted — the forecast has no altitude, so altitude stays manual (documented in Task 1 constraint).

**Placeholder scan:** Task 1 ships complete code + tests. Tasks 2–4 give exact control HTML, the button handler, and the derivation formula; per-file placement is pattern-matched against Stage A (which the implementer reads first). The one runtime-gated step (budget bump) is concrete.

**Type consistency:** `spForecastToAmbient`/`spUseLocalForecast` names identical across Task 1 (partial + test) and Tasks 2–4 (callers). Plan-URL keys `ambt`/`ambdp`/`alt` consistent across Task 2 (validators + test) and brisket state/hydration. Engine param names `ambientF`/`ambientRh`/`altitudeM` match M1's `spPitWetBulbF` reads. The Task 4 note resolves the RH-vs-dewpoint round-trip by passing `dewPointF` through so manual and auto-fill share one derivation path.
