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

  **Auth model.** `/api/unsubscribe` and `/api/preferences`
  (GET + PATCH) require an HMAC-SHA256 token tied to the email
  (`worker/src/lib/auth/token.ts`). `/api/subscribe` issues the token
  in its response (`token: <64 hex chars>`); subsequent calls send it
  alongside the email. Without this auth check anyone could
  mass-unsubscribe arbitrary emails or enumerate subscriber prefs.
  The signing secret is the `SUBSCRIBER_TOKEN_SECRET` env binding —
  rotate via `wrangler secret put` to invalidate all live tokens.

  **Cache-Control.** `/api/forecast` is `public, max-age=300` ONLY
  when the zip came from an explicit query param; the geo-IP fallback
  path (zip from `request.cf.postalCode`) sets `private, max-age=60`
  so a CDN edge doesn't serve visitor A's metro forecast to visitor B
  with the same bare URL. `/api/status` is always `no-store`.
  `/articles/:slug` is `public, max-age=300` on a 200 hit and 60s on
  the 404 page.

  **body_html sanitization.** Article body HTML is rendered through
  a defensive `sanitizeBodyHtml` pass that strips `<script>`,
  `<iframe>`, `<object>`, `<embed>`, `<link>`, `<meta>`, `<style>`,
  any `on*="..."` event handlers, and `javascript:` / `data:` URLs in
  `href`/`src`. The article writer (Step 13) is still trusted, but
  this prevents a single bad row from becoming stored XSS on a
  marketing page.
- **Step 8.** Verdict landing page (F8/F9/F10/F11/F12) at
  `_src/smoke-weather/index.html`. Reuses every site partial
  (`site-header.css`, `site-base.css`, `site-utils.js`, header nav,
  footer, cookie banner) so the look-and-feel matches the rest of the
  calculator suite automatically. New partials:
  `_partials/smoke-weather.css` (band color stops, day-card grid,
  verdict hero) and `_partials/smoke-weather-app.js` (vanilla-JS client:
  reads zip / cut / cooker, persists to `localStorage` keys
  `pitmaster_zip` / `pitmaster_cut` / `pitmaster_cooker`, fetches
  `/api/forecast`, renders verdict + 7-day cards with band colors and
  confidence pills). Geo-IP first-paint is delegated to the worker —
  the client sends the request without a zip and the worker fills it
  from `request.cf.postalCode`; the resolved zip is stored only on the
  geo-IP path so a user-supplied zip is never overwritten by a
  normalized echo. The form uses `novalidate` so the JS validator runs
  on short-zip submits instead of being short-circuited by HTML5
  pattern checks. Page weight is ~71 KB inlined (well under the F12
  sub-100 KB target). e2e coverage: `tests/smoke-weather-verdict.spec.js`
  (Playwright on a 390×844 viewport) covers the success path, zip
  persistence, 503 error rendering, and the no-network short-zip
  rejection. `validate.ps1` now includes `smoke-weather/index.html` in
  its checked set.
- **Step 9.** Detail / hourly view (F3/F4/F5) layered onto the verdict
  landing. Each day card now exposes a confidence-pill tooltip
  (F3 — `title` + visually-hidden `.sw-sr-only` span so screen
  readers and mouse hoverers get the same explanation), a dew-point
  row pinned to the 60 °F stall threshold the scoring engine uses
  (F4 — same dual title/SR-only wiring), and a `<details>` element
  that lazy-renders the per-hour table on first open (F5). The lazy
  fill is guarded by a `data-hourly-pending` flag so toggling
  open/closed/open is idempotent, and a 7-day forecast pays ~170
  fewer rows on initial paint. Hour labels are produced by string
  slicing the ISO timestamp so the same renderer handles Open-Meteo
  (`2026-05-15T08:00`, no offset) and NWS
  (`2026-05-15T08:00:00-05:00`, with offset) without timezone-shifting
  the display. The hourly `<table>` lives inside a
  `.hourly-table-scroll` wrapper that owns the horizontal overflow,
  preserving native table semantics for assistive tech on narrow
  phones. e2e coverage in `tests/smoke-weather-detail.spec.js`:
  tap-to-expand lazy render, NWS-offset timestamp formatting,
  empty-hourly fallback copy, and the dual tooltip + SR-only
  wirings on both confidence pill and dew-point row.
- **Step 10.** Affiliate rules (F15). `/api/forecast` now attaches a
  single deterministic product recommendation keyed on
  (cut, cooker, best-day band). The rule table lives in
  `worker/src/lib/affiliate/rules.ts` — ordered most-specific-first,
  with a catch-all so every combination produces a placement. The
  rule engine is pure: no D1, no KV, no network at runtime; adding or
  removing a product is one line plus a test. The shared
  `AffiliateRecommendation` type carries `disclosureRequired: true` as
  a literal so the policy can't be flipped on the wire. The client
  renderer (`_partials/smoke-weather-app.js` → `renderAffiliateCard`)
  paints a card beneath the 7-day grid with the FTC disclosure
  inline; outbound merchant links carry
  `rel="sponsored nofollow noopener" target="_blank"` per Google's
  link-attribute guidance, and a `^https?://` guard prevents a
  misconfigured rule from producing a `javascript:`/`data:`
  clickthrough. The disclosure text links to a new
  `/smoke-weather/disclosures` legal page (`noindex, follow`,
  excluded from sitemap per site convention) that explains scoring
  independence from affiliate revenue, the product selection rule,
  and the `rel="sponsored nofollow noopener"` policy. Public CDN
  caching is still safe — cut/cooker are URL params so the same URL
  always yields the same product. Coverage:
  `worker/tests/unit/affiliate/rules.test.ts` (12 unit specs
  exhaustive across cuts × cookers × bands plus rule-table
  well-formedness),
  `worker/tests/integration/forecast.test.ts` (2 specs — recommendation
  present + disclosureRequired true; recommendation varies by cooker),
  `tests/smoke-weather-verdict.spec.js` (3 e2e specs — card render with
  disclosure, hidden-slot when no recommendation, `javascript:` URI
  neutralized). `validate.ps1` now checks `smoke-weather/disclosures.html`.

## Tooling rules

- Never commit directly to `main`; everything goes through a feature branch + PR.
- Every PR runs two review loops (`/review` locally, `/claude:review` on the PR)
  and must update `README.md` as its final commit before merge — see
  `docs/best-smoke-days-plan.md` § "PR review discipline".
- Before merging changes that touch HTML, `sitemap.xml`, `wrangler.jsonc`, or
  local asset links: run `.\validate.ps1` (Windows PowerShell).
- See `CLAUDE.md` for required `<head>` elements, analytics IDs, and Schema
  rules on tool pages.
