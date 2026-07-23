# Stall Model v2 — Milestone 3: Cook-log Telemetry & Calibration (umbrella design)

**Status:** Design approved (owner-authored via brainstorming, 2026-07-22). Roadmap spec for four independently-planned sub-projects. **Build deferred** — this document freezes the interfaces; each sub-project gets its own spec → plan → PR later.

**Parent:** `docs/superpowers/specs/2026-07-19-stall-model-v2-design.md` §12 (Calibration plan, Tier 3) and §0.1 line 25 ("Milestone 3 — calibration & telemetry. Mostly out of code scope … Deferred; tracked separately"). Issue #141 code work is complete (M1 + M2 Stage A/B + #144 + index parity); this is the separately-tracked remainder.

---

## 1. Goal & scope

The stall-model constants are fitted to anecdote (parent spec §7 status note, §13). Tier 3 replaces them with data-fitted values by:

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
| `emailOptional` | string? | Opt-in only (§7). |
| `consentAt` | integer | Epoch seconds; required. |

**Observed series** (from the probe log, sub-project B): `Array<{ tMin: number; coreF: number; pitF?: number }>` — minutes from cook start.

**Derived observations** (extracted by B): `plateauF_observed`, `dwellHr_observed`, `wrapAtMin?`.

**Weather** (attached by C, delayed): `ambientF`, `dewPointF`, `altitudeM`, `era5FetchedAt`.

A cook row moves through statuses: `pending_parse` → `pending_weather` → `ready` (see §3, §5).

---

## 3. Sub-project A — Intake surface

- **Page** `submit-cook.html`: an indexable tool page carrying the full `<head>` requirements (project `CLAUDE.md`). Contains an upload control for a probe export file **and** a manual-entry fieldset (upload preferred, manual fallback), the §2 metadata fields, one **required** consent checkbox, and an **optional** email field.
- **Route** `POST /api/cook-log`, modeled on `worker/src/handlers/pinImage.ts`: same-site `Origin` allowlist, exact content-type check, a size cap (cook logs are small — target ≤1 MB), a `WEATHER_KV` per-IP soft rate-limit, and a Cloudflare WAF rate-limit rule as the authoritative control (operator step, as with `/api/pin-image`).
- **Storage:** raw uploaded file → **R2** (content-addressed, mirroring the pin-image dedupe pattern); canonical metadata row → **D1** `cook_logs` (§7), created with status `pending_parse`. On submit, the worker synchronously invokes B's parser; on success it stores the derived observations and advances to `pending_weather`, else it flags a parse error for later manual review.
- **Shippable alone:** begins accumulating the data moat with no downstream code present. Manual-entry submissions skip `pending_parse` and land at `pending_weather` directly (their observations come from the form, not a file).

## 4. Sub-project B — Log normalizer

- **Pure functions, no I/O** — the TDD core. Lives in `worker/src/lib/cooklog/` so both the worker (A's parse step) and the Node harness (D) import it.
- **Adapter interface:** `detect(headers) => boolean` and `parse(rows) => Array<{ tMin, coreF, pitF? }>`.
- **Named v1 adapters** (owner decision — commit to the list now): Thermoworks, FireBoard, MEATER, Combustion, Inkbird, plus a generic-CSV fallback (`timestamp + temperature column(s)`). A submitted file is matched against adapters in order; first `detect` wins; no match → parse error surfaced to A.
- **Extractors:** `plateauF` (temperature of the longest near-flat core-temp segment) and `dwellHr` (its duration) from the canonical series; `wrapAtMin` if a wrap discontinuity is present.

## 5. Sub-project C — Weather reanalysis join

- Queued/offline enrichment. For each `pending_weather` cook older than the ERA5 lag window, call **Open-Meteo Archive** (`https://archive-api.open-meteo.com/v1/archive`, hourly `temperature_2m` + `dewpoint_2m`) at the cook's ZIP → lat/lon over its `[start, end]` window, average across the cook duration, write `ambientF`/`dewPointF`/`altitudeM` back to the row, and flip status to `ready`.
- **ERA5 lag:** the archive trails real time by roughly five days, so C only processes cooks whose end time is older than that window — a freshly submitted cook is joined on a delay, never synchronously at submit.
- Reuses the existing `worker/src/lib/weather/` error and retry patterns (same vendor family as the live forecast, `openMeteo.ts`). Runs on a **cron** trigger alongside the existing scheduled handlers in `worker/src/index.ts`.

## 6. Sub-project D — Calibration harness

- Local **Node script** `scripts/fit-constants.mjs`, dev-only tooling in the vein of `scripts/render-pins.mjs` / `scripts/generate-metros.js`. Never runs in the worker.
- Pulls `ready` cooks (D1 export/dump), imports B's extractors and `_partials/smoke-physics.js`, and runs a regression that minimizes the error between `plateauF_observed` / `dwellHr_observed` and the model's predicted plateau/dwell over `SP_STALL_K`, `SP_PLAT_A/B`, `SP_EVAP_C`.
- **Output:** a fit report — per-constant proposed value, residuals, and `n` cooks — printed and written under `docs/`. The owner reviews it and hand-edits constants into `smoke-physics.js` behind the normal PR + test gate (the existing `smoke-physics.test.ts` / `physics-parity.test.ts` suites must stay green). The harness **never** auto-commits or mutates the shipped constants.

---

## 7. Storage & privacy

- **D1:** new `cook_logs` table (migration), one row per submission carrying the §2 fields, the derived observations, the weather columns, `status`, and `consentAt`.
- **R2:** raw uploaded files, content-addressed (dedupe + immutable, mirroring `pinImage.ts`). A lifecycle rule can expire raw files once parsed if desired.
- **Location:** ZIP is stored for the weather join. (A future tightening could snap to grid cell before storage; not v1.)
- **Optional email** (owner decision): opt-in only, for contributor attribution / follow-up. Stored only when provided.
- **`privacy-policy.html` MUST be updated in the sub-project A change** (project rule: any new first-party storage updates the privacy policy in the same change). It discloses: cook-data + ZIP storage and purpose; the optional-email opt-in and its purpose; and a deletion path via `contact@pitmaster.tools`. Consent timestamp is recorded per row.

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

- B: exact column signatures for each named adapter (needs a real export sample per brand).
- B: near-flat segment definition for `plateauF` (slope threshold + minimum duration).
- C: whether a dedicated `COOK_BUCKET` R2 binding is warranted vs. reusing `PIN_BUCKET`.
- D: regression method (grid search vs. least-squares) and the loss weighting between plateau-temp error and dwell error.
