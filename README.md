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
  (`POST /api/subscribers`, `PUT /api/subscribers/:email`) with Bearer
  auth, an `Idempotency-Key` whose value is a SHA-256 hash of the
  lowercased email (PII never leaks into proxy logs or D1), and
  `AbortController` timeouts. Failures are mapped to `MailerLiteError`
  with a `shouldRetry` rule (5xx, timeout, network, and 408/425/429
  retry; 400/422 + malformed body do not). Every error message is run
  through the shared `lib/redact.ts` so Bearer tokens and emails never
  reach `mailerlite_retry.last_error`. `retry.ts` enqueues retryable
  failures onto `mailerlite_retry` (UNIQUE idempotency key,
  duplicate-safe `ON CONFLICT DO UPDATE` that refreshes payload +
  clamps `next_attempt_at` down + preserves `attempts`); `drain()`
  replays due rows in FIFO order with doubling backoff
  (1m, 2m, 4m, … capped at 6 h), parks rows after 10 attempts, and
  writes an `events` audit row on every drop or park. `tags.ts`
  validates metro slugs and emits `metro:`/`cut:`/`cooker:`
  segmentation as MailerLite subscriber custom fields. The campaign
  send path is owned by Step 11 (Friday cron); Step 6 reserves the
  `send` kind in the schema and `drain()`'s SQL filter excludes
  `send` rows entirely, so any pre-existing rows wait untouched in
  the queue for Step 11 to claim. `MAILERLITE_API_KEY` belongs in
  `wrangler secret put`; `.dev.vars.example` documents the local form.
- **Step 7.** Worker router (`worker/src/router.ts`) + handlers
  (`worker/src/handlers/`) for the public API:
  - `GET /api/health` — health probe.
  - `GET /api/forecast?zip=&cut=&cooker=&days=` — F1/F8 scored
    forecast. Resolves zip via `lib/geo/zipGeocoder.ts` (fast path: D1
    metros exact zip match; slow path: Open-Meteo geocoding cached in
    KV for 30 days); fetches forecast via the Step 4 cache wrapper;
    runs the Step 3 scorer per day. Falls back to
    `request.cf.postalCode` when `zip` is omitted (F10 geo-IP).
  - `POST /api/subscribe` — subscribes to MailerLite, writes a row to
    `subscribers`, queues onto `mailerlite_retry` on transient
    failures (D1 row still created so the cron can resume), surfaces
    4xx for caller-side rejections.
  - `POST /api/unsubscribe` — flips MailerLite status, sets
    `subscribers.unsubscribed_at`. 5xx queues; 4xx treated as soft
    success.
  - `GET /api/preferences?email=` and `PATCH /api/preferences` —
    read/update cut and cooker. GET deliberately omits `zip` so a
    leaked URL doesn't dump the subscriber's home zip; PATCH builds
    the SET clause dynamically so a single-field update can't blow
    away the other field.
  - `GET /api/status` — operational JSON for the status page (Step
    17): mailerlite retry queue depth (queued / parked / next),
    subscriber counts, and the last 10 redacted error events from the
    `events` table. `Cache-Control: no-store`.
  - `GET /articles/:slug` — renders an article row from D1 as a full
    HTML page (with the canonical/og/twitter/JSON-LD shape required
    by `CLAUDE.md`). HTML-escapes the title and uses a custom
    JSON-LD escaper that replaces `<`, `>`, `&`, U+2028, U+2029 with
    their `\uXXXX` form so a hostile title can't break out of the
    `<script>` block.
  All non-matching paths fall through to `env.ASSETS.fetch` so the
  static-site bundle still serves. A blanket try/catch at the worker
  entrypoint maps any unhandled error to a 500 JSON envelope;
  Sentry will hook this in Step 17.

## Tooling rules

- Never commit directly to `main`; everything goes through a feature branch + PR.
- Every PR runs two review loops (`/review` locally, `/claude:review` on the PR)
  and must update `README.md` as its final commit before merge — see
  `docs/best-smoke-days-plan.md` § "PR review discipline".
- Before merging changes that touch HTML, `sitemap.xml`, `wrangler.jsonc`, or
  local asset links: run `.\validate.ps1` (Windows PowerShell).
- See `CLAUDE.md` for required `<head>` elements, analytics IDs, and Schema
  rules on tool pages.
