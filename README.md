# pitmaster.tools

Free BBQ calculators and the [Best Smoke Days](#best-smoke-days) weather feature,
served by a Cloudflare Worker over the existing static-site bundle.

## Repo layout

```
pitmaster.tools/
  _src/                  HTML pages (recursed into subdirs at build time)
  _partials/             CSS/JS partials injected by build.js
  build.js               static-site builder (CommonJS, no deps)
  scripts/
    generate-metros.js   emits Best Smoke Days metro pages before build.js
  worker/                Cloudflare Worker — TypeScript, tested with Vitest + Miniflare
    src/index.ts         entry; serves /api/* and falls through to ASSETS
    src/lib/weather/     Open-Meteo + NWS adapter with failover
    tests/               unit + integration
    vitest.config.mts
    tsconfig.json
  packages/shared/       cross-cutting TS shared by worker and (mirrored to) browser
  wrangler.jsonc         Worker config (assets binding + future KV/D1/crons)
  tsconfig.json          repo-root TS config with @shared/* path mapping
```

## Local development

```sh
npm install
npm run build            # generate-metros → build.js → dist/
npm run dev:worker       # wrangler dev — Worker + static assets at localhost
npm test                 # vitest in worker/ via Miniflare
npm run typecheck        # tsc --noEmit for worker/ and packages/shared/
npm run test:e2e         # playwright; auto-spawns `wrangler dev` per playwright.config.js
```

Configure secrets for `wrangler dev` in `.dev.vars` (copy `.dev.vars.example`).
Production secrets go through `wrangler secret put`.

## Deploy

```sh
npm run build
npm run deploy
```

`wrangler deploy` uploads the bundled Worker plus everything in `dist/` to the
`pitmastertools` Cloudflare project.

## Best Smoke Days

A phone-first, weather-aware companion to the calculators. Live URL:
`https://pitmaster.tools/smoke-weather/`. The build plan lives at
`docs/best-smoke-days-plan.md`; features are tracked F1–F22 inside.

Implementation is shipping in 19 step-sized PRs so each piece can be reviewed,
verified, and rolled back independently.

- **Step 1 (#33).** Scaffolding — Worker entry, shared TS package, Vitest +
  Miniflare wiring, recursing `build.js`, `npm run build:metros` placeholder.
- **Step 2.** Weather adapter under `worker/src/lib/weather/` — Open-Meteo
  primary client + NWS failover, AbortController timeouts, zod-validated
  responses tolerant to Open-Meteo null cells and NWS missing dewpoints
  (Magnus formula fallback), origin-pinned second hop. 38 specs.
- **Step 4.** KV cache with stale-while-error (`worker/src/lib/cache/`) — wraps
  the Step 2 adapter, key shape `weather:v1:<zip>:<utc-day>`, fresh 30 min /
  stale 6 h, secret-redacted telemetry, JSON round-trip caveats pinned by tests.
- **Step 3.** Scoring engine in `packages/shared/src/scoring.ts` (F1/F2/F6/F7).
  Pure function: cut × cooker × WeatherDay → 0-100 score, banded
  red/yellow/green/ideal. Mirrored to `_partials/weather-score-shared.js`
  for client-side re-score on cut/cooker toggle without a worker hop.
  Parity guards: physics-parity test pins `wetBulbF` to the JS source at
  0.01 °F across 20 inputs; scoring-parity test pins TS ↔ JS scorers
  identical across 13 cuts × 5 cookers × 8 scenarios.
- **Step 5.** D1 migrations in `worker/migrations/` — `subscribers`,
  `metros` (seeded with 50 US metros, validated for IANA timezone +
  5-digit ZIP + url-safe slugs), `events`, `mailerlite_retry`, and
  `articles`. Enum-shaped columns use `CHECK` constraints; `articles.metro_slug`
  references `metros.slug`. Apply with
  `wrangler d1 migrations apply SMOKE_DB`. Unit tests run them against
  an in-memory Miniflare D1 via a quote-aware `splitStatements` helper
  in `worker/tests/helpers/d1.ts` (handles `;` and `--` inside string
  literals, SQLite's `''` escape).
- **Step 6.** MailerLite client + retry queue under
  `worker/src/lib/mailerlite/`. `client.ts` calls Connect API
  (`POST /api/subscribers`, `PUT /api/subscribers/:email`,
  `POST /api/campaigns/:id/actions/send`) with Bearer auth, an
  `Idempotency-Key` derived from the email (lowercased) or campaign +
  filter, and `AbortController` timeouts. Failures are mapped to
  `MailerLiteError` with a `shouldRetry` rule (5xx + timeout + 429
  retry; 400/422 + malformed body do not). `retry.ts` enqueues
  retryable failures onto `mailerlite_retry` (UNIQUE idempotency key,
  duplicate-safe `ON CONFLICT DO UPDATE` that picks the earlier
  `next_attempt_at`); `drain()` replays due rows in FIFO order with
  exponential backoff (1m, 2m, 4m, … capped at 6 h), parks rows after
  8 attempts, and drops rows whose payload corrupted to non-JSON.
  `tags.ts` normalises `metro:`/`cut:`/`cooker:` segmentation into
  MailerLite subscriber custom fields. `MAILERLITE_API_KEY` belongs in
  `wrangler secret put`; `.dev.vars.example` documents the local form.

## Tooling rules

- Never commit directly to `main`; everything goes through a feature branch + PR.
- Every PR runs two review loops (`/review` locally, `/claude:review` on the PR)
  and must update `README.md` as its final commit before merge — see
  `docs/best-smoke-days-plan.md` § "PR review discipline".
- Before merging changes that touch HTML, `sitemap.xml`, `wrangler.jsonc`, or
  local asset links: run `.\validate.ps1` (Windows PowerShell).
- See `CLAUDE.md` for required `<head>` elements, analytics IDs, and Schema
  rules on tool pages.
