# Best Smoke Days — Implementation Plan

## Status

**Shipped 2026-05-15.** All 19 sequence steps merged to `main` across PRs #33–#51. v1 verification sweep green (see Step 19 in README). 22 features F1–F22 delivered; F17 weekly article cron, F18 BreadcrumbList schema, F19 seasonal pages, F20 NaN-score guard + microclimate disclaimer test, F21 Sentry + status page, F22 methodology + FAQ pages. Real editorial copy for `_src/seasonal/*.html` is the only follow-up Monty has on his plate; the placeholder content shipped is SEO-valid in the meantime.

## Context

Monty wants to add a phone-first, weather-aware "Best Smoke Days" feature to **pitmaster.tools**. Source of truth for scope is `F:\Downloads\BEST_SMOKE_DAYS_BUILD_PLAN.md` (22 features F1–F22, strict TDD, Cloudflare stack). The build plan was written greenfield and mandates Astro + Tailwind + pnpm — but the existing site is already a Cloudflare Worker with a custom Node.js templating engine (`build.js` injects `<!-- INJECT:name -->` partials from `_partials/` into pages in `_src/`). User directive: **"Keep the existing site and make the new functionality fit the look and feel."**

Resolution: extend the existing repo (`H:\Code\pitmaster.tools`) rather than build a parallel Astro app. The current `wrangler.jsonc` already declares a single Worker with an `ASSETS` binding pointing at `dist/` — adding `/api/*` handlers, KV, D1, and cron triggers is one config edit, not a re-platform. Path A keeps look-and-feel automatic (same partials, same tokens, same fonts), preserves the build plan's Cloudflare topology literally, and avoids a duplicate design system.

Stack deltas from build plan:
- **No Astro, no Tailwind, no pnpm** — keep `build.js` and CSS partials. Frontend stays vanilla JS (matches all 13 existing calculators).
- **TypeScript only inside `worker/`** — compiled by Wrangler. `_partials/*.js` stays plain JS.
- **Vitest + Miniflare** for worker tests; **Playwright** (already in repo) for e2e. TDD methodology preserved literally.

**Astro migration considered and rejected for v1.** Converting all 18 pages to Astro would be 2-3 weeks of work plus SEO/parity verification risk, delaying Best Smoke Days delivery. The build plan's "Astro non-negotiable" clause was written assuming greenfield; the user explicitly chose to keep the current stack. Astro migration may be revisited as a separate project after Best Smoke Days ships.

## Critical files (existing, reused)

- `H:\Code\pitmaster.tools\build.js` — static site builder, leave untouched
- `H:\Code\pitmaster.tools\wrangler.jsonc` — extend with KV/D1/triggers/main
- `H:\Code\pitmaster.tools\_partials\smoke-physics.js` — **reuse `wetBulb_F` and `SP_COOKER_RH`** for F2 stall-risk (port to TS in `packages/shared`); leave the rest untouched (cook-time physics, not weather)
- `H:\Code\pitmaster.tools\_partials\site-base.css`, `site-header.css`, `site-header.js`, `site-utils.js` — auto-applied via `<!-- INJECT -->` on every new page
- `H:\Code\pitmaster.tools\CLAUDE.md` — JSON-LD on tool pages is mandatory; new pages must comply
- `H:\Code\pitmaster.tools\playwright.config.js` — extend with smoke-weather specs

## Repo additions

```
H:\Code\pitmaster.tools\
  _src\smoke-weather\
    index.html               # F8 verdict landing (default route)
    methodology.html         # F22
    faq.html, disclosures.html, status.html
    [generated metro pages]  # F16 — produced by scripts\generate-metros.js
  _src\seasonal\
    winter.html, summer.html, fall.html, spring.html   # F19 placeholders
  _partials\
    smoke-weather.css        # extends existing --amber tokens; adds score color stops
    smoke-weather-app.js     # client: zip prompt, fetch /api/forecast, render, localStorage
    weather-score-shared.js  # pure JS scoring (mirror of TS); IIFE export for browser
  packages\shared\
    physics.ts               # TS port of wetBulb_F + SP_COOKER_RH (parity-tested vs JS)
    scoring.ts               # pure TS scoring; canonical, mirrored to weather-score-shared.js
    types.ts                 # Cut, Cooker, WeatherDay, ScoreResult, etc.
  worker\
    src\
      index.ts               # router: /api/* + fall-through to env.ASSETS.fetch(request)
      handlers\forecast.ts, subscribe.ts, unsubscribe.ts, preferences.ts, status.ts, articles.ts
      lib\weather\openMeteo.ts, nws.ts, adapter.ts   # F1 data, F20 failover
      lib\mailerlite\client.ts, retry.ts             # F14
      lib\affiliate\rules.ts                         # F15 (data-driven JSON)
      lib\cache\kv.ts                                # F13 stale-while-error
      crons\fridayEmail.ts, weeklyArticle.ts         # F14, F17
    migrations\0001_init.sql, 0002_metros_seed.sql, 0003_articles.sql
    tests\unit\**, tests\integration\**
    tsconfig.json, vitest.config.ts
  scripts\
    generate-metros.js       # writes 50 _src\smoke-weather\<slug>.html before build.js
    seed-metros.ts           # pushes metros + content to D1 via wrangler
  tests\e2e\                 # Playwright specs against wrangler dev
```

`package.json` root scripts: `test` (vitest), `test:e2e` (playwright), `dev:worker` (wrangler dev), `build:metros` (node scripts/generate-metros.js), `build` (build:metros && node build.js), `deploy` (wrangler deploy).

## Feature → location map

| Feature | Location |
|---|---|
| F1 cut scoring | `packages/shared/scoring.ts` + mirror `_partials/weather-score-shared.js` |
| F2 stall risk | `packages/shared/scoring.ts` (uses `physics.wetBulb_F`) |
| F3 confidence label | `scoring.ts` attaches `confidence: 'high'|'medium'|'low'` per day index |
| F4 dew-point tooltip | `_partials/smoke-weather-app.js` render |
| F5 hourly view | `handlers/forecast.ts` returns hourly array; client renders on `<details>` open |
| F6 wind gust modeling | `scoring.ts` internal; client conditional display |
| F7 cooker toggle | client `localStorage` key `pitmaster_cooker`; sent as query param |
| F8 verdict landing | `_src/smoke-weather/index.html` |
| F9 zip memory | `localStorage` key `pitmaster_zip` (matches existing `pitmaster_tu`/`pitmaster_wu`) |
| F10 geo-IP | worker reads `request.cf.country` + `postalCode`; returns default zip in initial render |
| F11 colors | new CSS vars `--score-red`, `--score-yellow`, `--score-green`, `--score-ideal` in `smoke-weather.css` |
| F12 mobile/perf | inlined CSS via existing `<!-- INJECT -->` already yields sub-100KB |
| F13 KV cache | `lib/cache/kv.ts` with `weather:v1:${zip}:${dayBucket}` and stale-while-error |
| F14 Friday email | `crons/fridayEmail.ts`; cron `0 * * * 5` hourly Fri UTC + per-subscriber tz gate; D1 idempotency key |
| F15 affiliate rules | `lib/affiliate/rules.ts` (JSON-driven); FTC disclosure injected by partial |
| F16 metro pages | `scripts/generate-metros.js` writes 50 HTML files before `build.js` runs |
| F17 weekly articles | `crons/weeklyArticle.ts` writes to D1 `articles` table; worker route `/articles/:slug` renders from row (no commit-on-cron) |
| F18 schema | per-page JSON-LD via existing convention |
| F19 seasonal | static HTML in `_src/seasonal/` |
| F20 failure modes | each row gets a failing test → fix |
| F21 status + Sentry | `_src/smoke-weather/status.html` reads `/api/status` JSON; `@sentry/cloudflare` in worker `index.ts` |
| F22 methodology/FAQ/disclosures | static HTML in `_src/smoke-weather/` |

## smoke-physics.js reconciliation

The existing `smoke-physics.js` is a **cook-time** engine (heat transfer through a cut at given pit conditions). The new score is a **weather suitability** engine. They are **complementary, not overlapping**.

- **Reuse `wetBulb_F`** verbatim — port to `packages/shared/physics.ts` for F2.
- **Reuse `SP_COOKER_RH`** constants as the cooker→pit-humidity table.
- **Do not reuse `spPhase`/`spCompute`** — those need cut weight and target temp, irrelevant to weather scoring.
- **Parity guard**: a Vitest spec re-runs both implementations on 20 fixed inputs and asserts agreement to 0.01°F. Catches drift if either side is edited.

## Sequence (build-plan steps, Path A adjustments)

1. **Setup**: add `worker/`, `packages/shared/`, root `package.json` deps (`wrangler`, `vitest`, `@cloudflare/workers-types`, `miniflare`, `zod`, `@sentry/cloudflare`); npm scripts above; vitest config; tsconfig with `paths` pointing worker at shared package.
2. **Weather adapter**: Open-Meteo primary + NWS failover; Vitest mocks fetch; tests assert failover triggers on first 5xx/timeout/malformed.
3. **Scoring engine (F1/F2/F6/F7)**: pure TS, table-driven cut × cooker weights. Mirror to `weather-score-shared.js`; build check asserts both produce identical output on shared fixture set.
4. **KV caching (F13)**: stale-while-error wrapper around adapter; Miniflare KV in tests.
5. **D1 migrations**: `subscribers`, `metros`, `events`, `mailerlite_retry`, `articles`. Add indexes: `idx_subscribers_timezone`, `idx_events_created_at`, `idx_articles_slug`. Tests apply migrations against Miniflare D1 and assert schema.
6. **MailerLite client**: tests stub fetch; 5xx pushes to retry queue; idempotent subscribe; tag-based segmentation (not group-per-region).
7. **Worker endpoints**: `/api/forecast`, `/api/subscribe`, `/api/unsubscribe`, `/api/preferences`, `/api/status`, `/articles/:slug`. Router falls through to `env.ASSETS.fetch(request)` for everything else.
8. **One-screen verdict (F8/F9/F10/F11/F12)**: `_src/smoke-weather/index.html` uses existing header/footer partials so look-and-feel is automatic. Component-test the client renderer; Playwright e2e against `wrangler dev`.
9. **Detail/hourly view (F3/F4/F5)**: progressive disclosure via `<details>`; e2e covers tap-to-expand.
10. **Affiliate rules (F15)**: JSON config + renderer; FTC disclosure partial injected on every placement.
11. **Friday cron (F14)**: cron schedule `0 * * * 5` (hourly each Friday UTC). Handler computes each subscriber's local hour; sends only when local hour is 6. D1 idempotency table prevents double-send on retry.
12. **Top-metro pages (F16)**: `scripts/generate-metros.js` reads 50-metro array and emits HTML before `build.js`; content tests validate non-empty 300-word body per metro.
13. **Weekly article cron (F17)**: template-driven (no LLM polish in v1 — defer Anthropic API until template output proves inadequate); writes article row to D1; route serves with `<!doctype html>` matching site shell.
14. **Schema markup (F18)**: JSON-LD per `CLAUDE.md` convention on every new page.
15. **Seasonal (F19)**: 4 static HTML files with placeholder copy (real copy supplied later by Monty).
16. **F20 failure-mode sweep**: each scenario gets a failing test, then a fix. Includes: Open-Meteo down, NWS down, non-US zip, invalid zip, null forecast day, NaN score, MailerLite 5xx on subscribe, MailerLite 5xx on Friday send, KV/D1 outage, geo-IP wrong location, microclimate disclaimer.
17. **Status + Sentry (F21)**: `@sentry/cloudflare` in `index.ts`; `SENTRY_DSN` env var; `/status` page reads JSON from worker.
18. **Methodology/FAQ/disclosures (F22)**: static HTML; link from `_partials/site-header.js` footer block.
19. **Final pass**: full Playwright suite vs `wrangler dev --remote`; Lighthouse mobile ≥95; existing `validate.ps1` still green.

## Defaults committed (no user sign-off — reasonable calls)

- **URL prefix**: `/smoke-weather/...` (`/smoke-weather/index.html` is the F8 landing); `/articles/:slug` for F17.
- **MailerLite segmentation**: tags (`metro:kansas-city-mo`, `cut:brisket`, `cooker:offset`) instead of 50 groups — simpler, identical capability.
- **F14 cron strategy**: single hourly Friday trigger + per-subscriber tz gate. Avoids 24 separate crons.
- **F17 content polish**: template-only in v1, no Anthropic API. Add later if quality demands.
- **Sentry**: free hobby project; `SENTRY_DSN` added to `.env.example`.
- **wrangler compatibility_date**: keep current `2026-04-12`.
- **Frontend framework**: none (vanilla JS, matches all 13 existing calculators).

## Risks

- **smoke-physics.js drift**: parity test (step 1) is the guard. If it ever fails, fix the TS port, never silently update fixtures.
- **MailerLite rate limits** (~120 req/min on free tier): batch Friday sends with `waitUntil` throttling. Documented in `.env.example` and `lib/mailerlite/client.ts`.
- **Worker bundle size**: adding `@sentry/cloudflare` + zod + MailerLite client must stay under the 10 MB Worker limit. Treeshake aggressively; verify via `wrangler deploy --dry-run --outdir`.
- **F17 served from D1**: deviates from the build plan's implicit "static page per article." Indexability holds (HTML served with `Content-Type: text/html` is crawlable); avoids the operational mess of cron-driven git commits.
- **CSP**: existing `_headers` `connect-src 'self'` is fine since `/api/*` is same-origin.
- **Build coordination**: `npm run build` must run `generate-metros.js` *before* `build.js` — single npm script chains them; no race.

## PR review discipline (mandatory on every PR)

Every PR for any feature/step in this plan goes through two review loops before merge. Do not skip.

1. **Local review loop**
   - Run `/review` (the `review` skill) against the local branch.
   - Read every finding. Fix all of them — code, tests, docs, security, type safety, anti-patterns from `CLAUDE.md`.
   - Re-run `/review`. Repeat until the skill returns clean (no actionable findings).
   - Only then push.

2. **PR review loop (after push, before merge)**
   - Open the PR.
   - Run `/claude:review` (the `claude:review` skill) against the PR.
   - Address every finding with code changes or a justified, in-PR reply explaining why a finding is not actionable.
   - Re-run `/claude:review`. Repeat until clean.

3. **README.md update (last commit on the PR, before merge)**
   - Update `H:\Code\pitmaster.tools\README.md` to reflect the new feature, env vars, deploy steps, and any new npm scripts introduced by the PR.
   - This commit is mandatory and must be the final commit on the branch before merge.
   - If the PR introduces nothing user-facing or developer-facing worth documenting, write that justification in the PR description — do not silently skip.

4. **Merge** only after: both review loops clean + README updated + CI green + manual smoke (per Verification below).

## Verification

End-to-end check before declaring done:

1. **Unit**: `npm run test` — all Vitest specs green, including scoring fixture suite and physics parity test.
2. **Integration**: Miniflare-driven specs cover Open-Meteo→NWS failover, KV stale-while-error, D1 migrations apply cleanly, MailerLite retry queue path.
3. **E2E**: `npm run test:e2e` — Playwright drives `wrangler dev`; primary flow (zip → weekend verdict → tap day → hourly) green on mobile viewport; affiliate disclosure visible on every placement.
4. **Manual smoke** (after deploy to a preview): open `/smoke-weather` on phone, confirm look-and-feel matches existing calculators (header, colors, fonts, card radius, shadow). Try non-US zip, expired KV simulation (block Open-Meteo), Friday email subscribe.
5. **Performance**: Lighthouse mobile ≥95; first load <100KB; Worker p50 <200ms cold, <50ms warm.
6. **Schema**: Google Rich Results test on `/smoke-weather/`, `/smoke-weather/methodology`, one metro page, one article — all valid.
7. **Existing site untouched**: run existing `validate.ps1`; all 13 calculator pages still pass.
