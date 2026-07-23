# Stall Model v2 — Milestone 3: Cook-log Telemetry & Calibration (umbrella design)

**Status:** Design approved (owner-authored via brainstorming, 2026-07-22), then revised the same day after parallel probe-export format research (Appendix A) — the research changed the canonical interface (§2, channel model) and the v1 adapter list (§4, five brands → three groundable). Roadmap spec for four independently-planned sub-projects. **Build deferred** — this document sets the interfaces; each sub-project gets its own spec → plan → PR later. (Sub-project B's core — generic-CSV adapter + `extractStall` — is already implemented on branch `feat/m3-b-log-normalizer`.)

**Parent:** `docs/superpowers/specs/2026-07-19-stall-model-v2-design.md` §12 (Calibration plan, Tier 3) and its §0 Milestones ("Milestone 3 — calibration & telemetry. Mostly out of code scope … Deferred; tracked separately"). Issue #141 code work is complete (M1 + M2 Stage A/B + #144 + index parity); this is the separately-tracked remainder.

---

## 1. Goal & scope

The stall-model constants are fitted to anecdote (parent spec's "Status of the numbers" note and §13 Known weaknesses). Tier 3 replaces them with data-fitted values by:

1. Collecting real cook logs from users (probe-thermometer exports + cook metadata).
2. Enriching each cook with historical weather at its coordinates and time window.
3. Back-fitting the model constants against the observed plateau temperature and dwell.

The constants in scope (all in `_partials/smoke-physics.js`): `SP_STALL_K` (287), `SP_PLAT_A` (0.68), `SP_PLAT_B` (0.20), `SP_EVAP_C` (0.28), and — data permitting — `SP_AIR_EXCHANGE`.

### Non-goals

- **No auto-recalibration.** User data never changes the shipped constants automatically. A human reviews the fit and hand-edits `smoke-physics.js` behind the normal PR/test gate.
- **No live model updates** from the intake stream.
- **No user accounts / auth.** Submissions are anonymous (email optional, see §7).
- **Tier 1 / Tier 2 are out of code scope** (owner's own six-cook log; owner's pit hygrometer). Parent spec §12.

---

## 2. Canonical cook record (frozen interface)

Every sub-project reads or writes this shape. It is the load-bearing contract between A, B, C, and D and must not drift without updating this spec.

**Metadata** (from the intake form, sub-project A):

| Field | Type | Notes |
|---|---|---|
| `cut` | string | An `SP_KM` key (`brisket-flat`, `pork-butt`, …). |
| `weightLbs` | number | |
| `thicknessIn` | number? | Optional measured thickness; else derived from weight as today. |
| `cookerType` | string | `SP_AIR_EXCHANGE` key. |
| `wrap` | enum | `none` \| `foil` \| `paper` \| `boat`. |
| `wrapAtCoreF` | number? | Core temp at wrap, if wrapped. |
| `spritzCount` | number? | |
| `injectionPct` | number? | |
| `fatCapIn` | number? | |
| `pieces` | number? | Default 1. |
| `zip` | string | Coarse location for the weather join (§7 privacy). |
| `cookStartedAt` | integer | Epoch seconds anchoring the cook — the absolute reference the weather join needs (§5), since B's `ParsedLog` carries only relative `tMin`. A reads it from the raw export's first absolute timestamp for wall-clock formats (FireBoard/ThermoWorks/generic) or the `Created:` line (Combustion). **Manual** submissions capture the cook's date/time in the form — a user submits days after cooking, so submission time would yield the wrong historical-weather window. |
| `durationMin` | number? | Total cook length in minutes. Required for **manual** submissions (which have no series to derive `max(tMin)` from, §5); for file uploads it's derived from the series. |
| `emailOptional` | string? | Opt-in only (§7). |
| `consentAt` | integer | Epoch seconds; required. |
| `probeMapping` | object? | Channel → role map (see below); only needed for user-labeled formats. |

**Normalized probe log** (B's parse output — the intermediate). Format research (Appendix A) proved a flat `{tMin, coreF, pitF}` cannot be produced directly, because **most exports do not label which probe is the food vs the pit** — only Combustion self-identifies. So an adapter emits a channel-oriented shape and a separate reducer collapses it:

```
ParsedLog {
  format: string;                 // adapter id that parsed it
  channels: ParsedChannel[];
}
ParsedChannel {
  id: string;                     // stable channel id (port number or column index)
  label: string;                  // as written in the file ("Probe 2", "Traeger", "VirtualCoreTemperature")
  role: 'core' | 'ambient' | 'surface' | 'unknown';
  samples: Array<{ tMin: number; tempF: number }>;   // always normalized to minutes-from-start and °F
}
```

- **Fixed-role formats** (Combustion): the adapter sets `role` directly from the virtual-temperature columns — no user input needed.
- **User-labeled formats** (FireBoard, ThermoWorks, and any generic CSV): every channel is `role: 'unknown'`. A **single** unknown channel (e.g. a single-probe ThermoWorks BlueDOT export) is taken as the core with no mapping — `toCookSamples` uses the sole channel directly. Only when **two or more** unknown channels must be disambiguated is a mapping required: a label heuristic proposes a default (`pit`/`grill`/`ambient`/`smoker`/cooker-brand → ambient; `brisket`/`pork`/`meat`/`food`/`internal` → core), and the authoritative choice is the user's `probeMapping` captured in A's UI (§3).

**Observed series** (reduced): `toCookSamples(parsedLog, probeMapping?) => Array<{ tMin, coreF, pitF? }>` picks the core channel (and optional pit) and yields the flat series the extractors consume.

**Derived observations**: `plateauF_observed`, `dwellHr_observed`, and (uploads only) `wrapAtMin?` — extracted by B from the reduced series for file uploads; for manual submissions `plateauF_observed` and `dwellHr_observed` come directly from the form fields (§3), and `wrapAtMin` is simply absent.

**Weather** (attached by C, delayed): `ambientF`, `dewPointF`, `altitudeM`, `era5FetchedAt`.

A cook row moves through statuses: `pending_parse` → `pending_weather` → `ready` (see §3, §5).

---

## 3. Sub-project A — Intake surface

- **Page** `submit-cook.html`: an indexable tool page carrying the full `<head>` requirements (project `CLAUDE.md`). Contains an upload control for a probe export file **and** a manual-entry fieldset (upload preferred, manual fallback), the §2 metadata fields, one **required** consent checkbox, and an **optional** email field.
- **Route** `POST /api/cook-log`, modeled on `worker/src/handlers/pinImage.ts`: same-site `Origin` allowlist, exact content-type check, a size cap (cook logs are small — target ≤1 MB), a `WEATHER_KV` per-IP soft rate-limit, and a Cloudflare WAF rate-limit rule as the authoritative control (operator step, as with `/api/pin-image`).
- **Probe mapping step:** when the parsed log has multiple `role: 'unknown'` channels (FireBoard / ThermoWorks / multi-probe generic CSV — see §2), A must show the parsed channel labels and let the user confirm which is the food (core) probe and, optionally, which is the pit. The label heuristic pre-selects a default so the common case is one click. Fixed-role formats (Combustion) skip this step. The resulting `probeMapping` is stored on the row.
- **Storage:** raw uploaded file → **R2** (content-addressed, mirroring the pin-image dedupe pattern); canonical metadata row → **D1** `cook_logs` (§7), created with status `pending_parse`. On submit, the worker synchronously invokes B's parser. On success it stores the parsed channels; the observations are then derived — directly for fixed-role formats, or **after** the probe-mapping step above for user-labeled ones — and the row advances to `pending_weather`. A parse failure flags the row for later manual review.
- **Shippable alone:** begins accumulating the data moat with no downstream code present. Manual-entry submissions skip `pending_parse` and land at `pending_weather` directly: their derived observations (`plateauF_observed`, `dwellHr_observed`), `durationMin`, and `cookStartedAt` come straight from the form fields — the coarse points a user reads off their own cook (stall temperature, stall duration, total cook time, and the date they cooked) — which a file upload instead derives via B.

## 4. Sub-project B — Log normalizer

- **Pure functions, no I/O** — the TDD core. Lives in `worker/src/lib/cooklog/` so both the worker (A's parse step) and the Node harness (D) import it.
- **Adapter interface** (revised from format research — Appendix A):
  ```
  LogAdapter {
    name: string;
    detect(rawText: string): boolean;     // sees raw text, not a pre-parsed header
    parse(rawText: string): ParsedLog;    // channel-oriented (§2), samples normalized to tMin + °F
  }
  ```
  `detect` takes the raw file text because formats differ in **preamble** (Combustion has a 9-line banner before the header; FireBoard/ThermoWorks start at the header), **delimiter** (Combustion/FireBoard comma, Inkbird tab), and **header shape** — a pre-parsed `headers[]` can't sniff those. Each adapter owns its own preamble-skip, delimiter, decimal-separator, **timestamp decoding** (elapsed-seconds vs `MM/DD/YY HH:MM:SS` local-clock — see Appendix A), and **unit → °F** conversion, so `ParsedLog.channels[].samples` is always `{tMin, tempF}`. When a format carries **no unit in the file** (FireBoard), the adapter takes values as °F — a documented **known limitation**: a FireBoard export recorded in °C is mis-read, and honoring it needs a user-declared unit, which is deferred to a future A-level enhancement (the file gives the adapter nothing to detect). Adapters are tried in order; first `detect` wins; no match → parse error surfaced to A.
- **v1 adapter list** (revised — the original five did not survive format research; see Appendix A for evidence and the two removals):
  - **`combustion`** — CONFIRMED from two real exports; fixed-role, °C, elapsed-seconds, 10-line preamble (9 metadata + 1 blank).
  - **`fireboard`** — CONFIRMED from the official sample CSV; user-labeled channels, local clock, unit not in file.
  - **`thermoworks`** — CONFIRMED from official screenshots (2018 BBQ-app format only; RFX/Cloud unconfirmed and out of v1); numbered probes, unit in header suffix, local clock.
  - **`generic-csv`** — fallback for `time + temperature column(s)` (already built).
  - **Dropped: `meater`** — no file export exists at all (only a shareable graph image); structured data is available only via a live JSON API, a different ingest path, deferred as a possible future non-file source.
  - **Deferred: `inkbird`** — CSV exists but per-probe single files and the exact BBQ header was not found in any source; build once a real IBBQ-4T export is supplied. Do not fabricate its columns.
- **Extractors:** `plateauF` (temperature of the longest near-flat core-temp segment) and `dwellHr` (its duration) from the reduced series; `wrapAtMin` if a wrap discontinuity is present.

## 5. Sub-project C — Weather reanalysis join

- Queued/offline enrichment. For each `pending_weather` cook older than the ERA5 lag window, call **Open-Meteo Archive** (`https://archive-api.open-meteo.com/v1/archive`, hourly `temperature_2m` + `dewpoint_2m`) at the cook's ZIP → lat/lon over its window — `[cookStartedAt, cookStartedAt + durationMin·60]` (§2's absolute anchor plus the cook length: `max(tMin)` for uploads, the form value for manual submissions) — average across the cook duration, write `ambientF`/`dewPointF`/`altitudeM` plus `era5FetchedAt` (§2) back to the row, and flip status to `ready`.
- **ERA5 lag:** the archive trails real time by roughly five days, so C only processes cooks whose end time is older than that window — a freshly submitted cook is joined on a delay, never synchronously at submit.
- Reuses the existing `worker/src/lib/weather/` error and retry patterns (same vendor family as the live forecast, `openMeteo.ts`). Runs on a **cron** trigger alongside the existing scheduled handlers in `worker/src/index.ts`.

## 6. Sub-project D — Calibration harness

- Local **Node script** `scripts/fit-constants.mjs`, dev-only tooling in the vein of `scripts/render-pins.mjs` / `scripts/generate-metros.js`. Never runs in the worker.
- Pulls `ready` cooks (D1 export/dump), imports B's extractors and `_partials/smoke-physics.js`, and runs a regression that minimizes the error between `plateauF_observed` / `dwellHr_observed` and the model's predicted plateau/dwell over `SP_STALL_K`, `SP_PLAT_A/B`, `SP_EVAP_C` (and `SP_AIR_EXCHANGE` if the data supports it, per §1).
- **Output:** a fit report — per-constant proposed value, residuals, and `n` cooks — printed and written under `docs/`. The owner reviews it and hand-edits constants into `smoke-physics.js` behind the normal PR + test gate (the existing `smoke-physics.test.ts` / `physics-parity.test.ts` suites must stay green). The harness **never** auto-commits or mutates the shipped constants.

---

## 7. Storage & privacy

- **D1:** new `cook_logs` table (migration), one row per submission carrying the §2 fields, the derived observations, the weather columns, `status`, and `consentAt`.
- **R2:** raw uploaded files, content-addressed (dedupe + immutable, mirroring `pinImage.ts`). A lifecycle rule can expire raw files once parsed if desired.
- **Location:** ZIP is stored for the weather join. (A future tightening could snap to grid cell before storage; not v1.)
- **Optional email** (owner decision): opt-in only, for contributor attribution / follow-up. Stored only when provided.
- **`_src/legal/privacy-policy.html` MUST be updated in the sub-project A change** (project rule: any new first-party storage updates the privacy policy in the same change). It discloses: cook-data + ZIP storage and purpose; the optional-email opt-in and its purpose; and a deletion path via `contact@pitmaster.tools`. Consent timestamp is recorded per row.

---

## 8. Build order

Each sub-project is planned and shipped separately (its own spec → plan → PR):

**B → A → C → D.**

- **B first** — pure and TDD-able, and A's synchronous parse step depends on it.
- **A** — ships the intake funnel and starts collecting data.
- **C** — enriches accumulated cooks with weather.
- **D** — fits constants once enough `ready` cooks exist.

Nothing here changes the shipped stall model; §6's human gate is the only path from user data to a constant change.

---

## 9. Open items to resolve at each sub-project's own brainstorming

- B: column signatures — RESOLVED for `combustion` / `fireboard` / `thermoworks` (Appendix A); still open for `inkbird` (needs a real IBBQ-4T file).
- B: `plateauF` segment definition — v1 pinned as "longest span with core rise-rate < 5 °F/hr for ≥ 0.5 hr" (implemented in `extract.ts`); revisit thresholds against real cooks in D.
- B: the food/pit label heuristic vocabulary (§2) — refine against real FireBoard/ThermoWorks channel labels as they arrive.
- C: whether a dedicated `COOK_BUCKET` R2 binding is warranted vs. reusing `PIN_BUCKET`.
- D: regression method (grid search vs. least-squares) and the loss weighting between plateau-temp error and dwell error.

---

## Appendix A — Confirmed probe-export formats (research 2026-07-22)

Grounded by five parallel research passes. Facts are labeled CONFIRMED (a real exported file, official doc, or source code was seen) or INFERRED; a brand whose format could not be fully confirmed is marked PARTIAL. **Adapters must be built only against CONFIRMED headers; do not fabricate the rest.**

### combustion — CONFIRMED (two real exports + parser source)
- Preamble: **9 metadata lines + 1 blank line**, then the header on line 11. Skip the first 10 lines. Lines include `CSV version: 4`, `Sample Period: <ms>`, `Created: YYYY-MM-DD HH:MM:SS` (wall-clock origin).
- Header (verbatim): `Timestamp,SessionID,SequenceNumber,T1,T2,T3,T4,T5,T6,T7,T8,VirtualCoreTemperature,VirtualSurfaceTemperature,VirtualAmbientTemperature,EstimatedCoreTemperature,PredictionSetPoint,VirtualCoreSensor,VirtualSurfaceSensor,VirtualAmbientSensor,PredictionState,PredictionMode,PredictionType,PredictionValueSeconds` (iOS appends a trailing `,Notes`). **Key columns by name, not index.**
- `Timestamp` = **elapsed seconds** since start (Android decimals, iOS ints). `tMin = Timestamp / 60`.
- Roles: `VirtualCoreTemperature` → core, `VirtualAmbientTemperature` → ambient, `VirtualSurfaceTemperature` → surface. `EstimatedCoreTemperature` is a prediction, not measured — ignore for observations.
- Units: values are **°C** — CONFIRMED from the sample rows; that the export is *always* °C regardless of app display is INFERRED (no unit indicator in the file). Convert to °F.
- Pin to `CSV version: 4`; treat a version bump as a re-verify trigger.
- Sources: real files + parser at `github.com/mschinis/combustion-inc-analyser` (`ExampleCSV/`, `Models/CookTimelineRow.swift`); official app note `combustion.inc/pages/product-release-notes`.

### fireboard — CONFIRMED (official sample CSV)
- No preamble; header is line 1: `Time,<label1>,<label2>,…` — temp columns are **user-assigned probe names** (up to 6), **not** fixed roles. Empty cell = probe not yet reading.
- `Time` = `MM/DD/YY HH:MM:SS`, 24-hour, **naive local** (no TZ). `new Date()` won't reliably parse this — write a dedicated parser.
- Roles: **unknown** — no food/pit flag in the file. Use the label heuristic + user `probeMapping`.
- Units: **not in the file** (°F/°C is a user/account setting) — v1 takes values as °F (known limitation, §4); a user-declared unit is deferred.
- Sources: `fireboard.io/static/FireBoard-SampleSession.csv`; `docs.fireboard.io/app/sessions.html`. (JSON API carries an explicit `degreetype` 1=°C/2=°F and ISO-UTC timestamps — different model, not the CSV.)

### thermoworks — CONFIRMED (official screenshots, 2018 BBQ-app format)
- No preamble; header is line 1. Multi-probe (Signals): `Probe1 -°F, Probe 2 -°F, Probe 3 -°F, Probe 4 -°F, Time` (`Time` **last**). Single-probe (BlueDOT): `Time, Temp -°F` (`Time` **first**). **Column order varies — locate `Time` by name.**
- Unit is embedded in each temp header as a `-°F` / `-°C` suffix — read it per column. Match temp columns with e.g. `^Probe\s*\d+\s*-\s*°?[FC]$` or `^Temp\s*-\s*°?[FC]$`.
- `Time` = `M/D/YY H:MM` local wall-clock, minute cadence (accept optional seconds / 4-digit year defensively).
- Roles: **unknown** — probes are by physical port, no food/pit designation. Use heuristic + user `probeMapping`.
- **Not confirmed:** RFX / ThermoWorks-Cloud / current-app exports — no real sample found; out of v1.
- Sources: `help.thermoworks.com/knowledge-base/thermoworks-bbq-app/` (Signals + BlueDOT Excel screenshots).

### meater — CONFIRMED: no file export
- The app produces only an **in-app graph shareable as an image** — no CSV/TSV/JSON download. Structured data exists solely via the **public JSON REST API** (`temperature.internal`/`temperature.ambient`, °C, `updated_at` epoch — **current reading only, no history**) or a reverse-engineered private API. **No file adapter is possible.** A live-API ingest is a separate future path, not part of the file-upload normalizer.
- Sources: `support.meater.com/hc/en-us/articles/36518839665563-Viewing-Previous-Cooks`; `github.com/apption-labs/meater-cloud-public-rest-api`.

### inkbird — PARTIAL: mechanism confirmed, header not found
- CSV export exists but is **per-probe single-channel files** (no combined multi-probe export); channel identity is the filename/probe-name, not a column. The app's export engine uses a `Time` / value / separate `Unit` column convention, **tab-delimited**, with a decimal-separator that is **dot (Inkbird Pro) or comma (Engbird)** depending on app/locale. The **exact BBQ temperature header was not found in any source** — do not build until a real IBBQ-4T export is supplied.
- Sources: `inkbird.com/products/wifi-grill-thermometer-ibbq-4t`; `community.inkbird.com` threads; sibling-format parser `github.com/the-butcher/ARANET4_VIS` (`DelimitedParserInkbird.ts`).
