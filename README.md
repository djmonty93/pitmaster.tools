# pitmaster.tools

Free BBQ calculators and the [Best Smoke Days](#best-smoke-days) weather feature,
served by a Cloudflare Worker over the existing static-site bundle.

## Repo layout

```
pitmaster.tools/
  _src/                  HTML pages (recursed into subdirs at build time)
  _partials/             CSS/JS partials injected by build.js
  build.js               static-site builder (CommonJS; terser + csso minify partials, MINIFY=0 to skip)
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
npm test                 # test:scripts (node --test) then vitest in worker/ via Miniflare
npm run test:scripts     # node --test scripts/generate-metros.test.js
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
  5-digit ZIP + url-safe slugs), `events`, `sender_retry`, and
  `articles`. Enum-shaped columns use `CHECK` constraints; `articles.metro_slug`
  references `metros.slug`. Apply with
  `wrangler d1 migrations apply SMOKE_DB`. Unit tests run them against
  an in-memory Miniflare D1 via a quote-aware `splitStatements` helper
  in `worker/tests/helpers/d1.ts` (handles `;` and `--` inside string
  literals, SQLite's `''` escape).
- **Step 6.** Sender.net client + retry queue under
  `worker/src/lib/sender/`. `client.ts` calls the Sender API
  (`POST /v2/subscribers`, `PATCH /v2/subscribers/{email}`) with Bearer
  auth and
  `AbortController` timeouts. Failures are mapped to `SenderError`
  with a `shouldRetry` rule (5xx, timeout, network, and 408/425/429
  retry; 400/422 + malformed body do not). Every error message is run
  through the shared `lib/redact.ts` so Bearer tokens and emails never
  reach `sender_retry.last_error`. `retry.ts` enqueues retryable
  failures onto `sender_retry` (UNIQUE idempotency key,
  duplicate-safe `ON CONFLICT DO UPDATE` that refreshes payload +
  clamps `next_attempt_at` down + preserves `attempts`); `drain()`
  replays due rows in FIFO order with doubling backoff
  (1m, 2m, 4m, … capped at 6 h), parks rows after 10 attempts, and
  writes an `events` audit row on every drop or park. `tags.ts`
  validates metro slugs and writes segmentation as Sender.net subscriber
  custom fields (`bbq_zip`, `bbq_city`, `bbq_state`, `bbq_region`,
  `bbq_cut_pref`, `bbq_cooker_pref`, `bbq_timezone`, `bbq_signup_date`).
  Group membership is set to `pitmaster_all` plus one of six regional
  groups (`pitmaster_<region>`). No colon-prefixed tag strings are emitted. The `request_kind`
  CHECK constraint allows `'subscribe' | 'unsubscribe' | 'digest_trigger'`,
  but in practice only `'subscribe'` and `'unsubscribe'` are enqueued
  by their handlers on retryable Sender failures; `drain()` replays only
  these two kinds via its `WHERE request_kind IN ('subscribe', 'unsubscribe')`
  filter, leaving `'digest_trigger'` reserved for future use. `SENDER_API_TOKEN` belongs in
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
  - `POST /api/subscribe` — subscribes via Sender.net, writes a row to
    `subscribers`, queues onto `sender_retry` on transient
    failures (D1 row still created so the cron can resume), surfaces
    4xx for caller-side rejections.
  - `POST /api/unsubscribe` — removes the subscriber from
    `pitmaster_all` and each `pitmaster_<region>` group (group-scoped;
    account status remains `active` so portfolio sites can still email).
    Verifies request via HMAC token. On retryable Sender.net failures
    (5xx, timeout, network errors, 408/425/429), enqueues on `sender_retry`
    for the drain cron to replay; response includes `status: 'queued'`.
    Sets D1 `subscribers.unsubscribed_at` to the current epoch ms.
  - `GET /api/preferences?email=` and `PATCH /api/preferences` —
    read/update cut and cooker. GET deliberately omits `zip` so a
    leaked URL doesn't dump the subscriber's home zip; PATCH builds
    the SET clause dynamically so a single-field update can't blow
    away the other field.
  - `GET /api/status` — operational JSON for the status page (Step
    17): Sender.net retry queue depth (queued / parked / next),
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
- **Step 11 (#44).** Friday cron (F14) — portfolio-aware regional digest.
  `worker/src/crons/fridayEmail.ts` triggers per-region Sender.net
  automations at Fri 06:00 local in each anchor timezone; cron schedule
  `0 10-14 * * 5` covers five UTC windows (ET/CT/MT/PT DST + PT standard time) and is idempotent
  per `(region, send_date)` via the new `friday_campaign_log` table
  (migration `0005`). Sender.net custom fields gain the `bbq_` prefix
  so this account can host sibling sites (powersizing.com,
  overlanding.tools); D1 columns stay unprefixed. `worker/src/lib/regions/`
  maps state → region (six regions, 50 states + DC; MO sits in
  south_central on the KC BBQ axis). `worker/src/lib/sender/groups.ts`
  manages BBQ-scoped group membership (`pitmaster_all` +
  `pitmaster_<region>`) without disturbing sibling-site groups on the
  same subscriber. `subscribe`/`unsubscribe` were rewritten to derive
  region from the zip's state and assign/remove the right groups.
  See `docs/portfolio-email-architecture.md` for the full multi-tenant
  rationale and `docs/sender-setup.md` for the operator runbook
  (including the existing-subscribers backfill warning baked into the
  migration header).
- **Step 12 (#45).** Top-metro pages (F16). `scripts/generate-metros.js`
  emits 50 SEO-optimized landing pages under `_src/smoke-weather/<slug>.html`
  — one per metro from `worker/migrations/0002_metros_seed.sql`. Each
  page reuses the canonical `<!-- INJECT -->` partial directives so
  header/footer/CSS/JS auto-wire at build time, pre-fills the ZIP input
  with the metro's anchor zip, and carries region-aware editorial body
  (≥300 plain-text words; BBQ heritage, regional climate, cooker fit,
  per-metro distinctiveness note). The `METRO_NOTE` map keeps every
  page uniquely worded — no two same-state metros share intro content.
  `scripts/generate-metros.test.js` (Node-builtin `node:test`) covers
  three-way parity (`METROS` ↔ SQL seed ↔ `sitemap.xml`), JSON-LD
  pair, INJECT presence, ZIP prefill, 300-word floor, same-state
  intro uniqueness, sweep idempotency. New `npm run test:scripts`
  script; `npm test` chains it before the worker vitest run.
  `validate.ps1` auto-discovers every `dist/smoke-weather/*.html`
  so generated and hand-authored siblings get the same link + INJECT
  validation. Stale-page guard: `GENERATED_MARKER` is the first line
  of every emitted file; a sweep removes any marker-bearing file
  before re-emission, so removing a metro from `METROS` also removes
  the dist page on the next build.
- **Step 13.** Weekly article cron (F17). `worker/src/crons/weeklyArticle.ts`
  fires on `0 12 * * 1` (Mondays 12:00 UTC) and writes one
  `weekly-summary` row to the D1 `articles` table; `/articles/:slug`
  renders it as `<!doctype html>` with the canonical/OG/JSON-LD shape
  from Step 7. Slug shape is `weekly-summary-<isoYear>-w<NN>` keyed by
  ISO 8601 week so the Thursday-belongs-to-this-year rule works
  across the year boundary. Template-only per the plan's "Defaults
  committed" — body covers all six regions by anchor city
  (New York, Atlanta, Chicago, Kansas City, Denver, Los Angeles) for
  national-coverage SEO and includes the FTC affiliate disclosure
  inline. Hero band is derived from the UTC month so summer reads as
  `ideal`, shoulder seasons `green`/`yellow`, deep winter `red`.
  Idempotent: re-runs in the same ISO week UPDATE the existing row,
  bumping `updated_at` while keeping `published_at` stable, so
  manual re-invocations and Cloudflare's scheduled-handler retries
  are both safe. 12 vitest specs in
  `worker/tests/unit/crons/weeklyArticle.test.ts` cover ISO-week math
  (including 2027-01-01 → 2026-W53 and 2024-12-30 → 2025-W01),
  zero-padded slug shape, ≥300-word content floor, anchor-city
  presence in `body_text`, idempotency invariants, and seasonal
  hero-band selection.
- **Step 14.** Schema markup (F18). Two pieces:
  (1) Metro pages now emit a third JSON-LD block — a 3-level
  `BreadcrumbList` (Home → Best Smoke Days → Metro) on top of the
  existing `WebApplication` + `FAQPage` graph from `CLAUDE.md`. Helps
  Google show the page hierarchy in SERPs and sitelinks. Generated
  centrally in `scripts/generate-metros.js` so all 50 metros (and
  future metros) inherit automatically.
  (2) New `scripts/validate-schema.test.js` (chained via
  `npm run test:scripts`) walks `_src/**.html` and asserts every
  non-exempt page carries the CLAUDE.md `WebApplication` +
  `FAQPage` pair. Exempt set is pinned at six entries
  (`404`, `privacy-policy`, `terms-of-service`,
  `smoke-weather/disclosures`, `about`, `tools`) — each with an
  inline justification, and a second test asserts the set hasn't
  silently drifted. New informational pages added later
  (methodology, faq, status) must either ship with the required
  schema or claim an exemption in the same PR.
- **Step 15.** Seasonal pages (F19). Four static HTML files under
  `_src/seasonal/` — `winter.html`, `spring.html`, `summer.html`,
  `fall.html` — placeholder editorial pages that Monty will overwrite
  with final copy later. Each carries the full CLAUDE.md
  `<head>` shape plus three JSON-LD blocks (WebApplication +
  FAQPage + 3-level BreadcrumbList: Home → Best Smoke Days →
  Season). Cross-linked from each other in a "Other seasons" list
  and from the live `/smoke-weather/` forecast link. `validate.ps1`
  auto-discovers `dist/seasonal/*.html` (parallel to the existing
  smoke-weather sweep) so a future seasonal page picks up the same
  link + INJECT validation; sitemap.xml lists all four with monthly
  changefreq and 0.6 priority. The schema validator from Step 14
  catches missing JSON-LD on these pages automatically.
- **Step 16.** F20 failure-mode sweep. Audit + close known gaps the plan
  flagged. Existing tests already covered Open-Meteo down, NWS down,
  both-down, invalid zip, unknown zip, geo-IP fallback, Sender.net 5xx
  on subscribe, Sender.net 5xx on Friday send, and KV outage. Two
  gaps closed in this step:
  (1) **NaN score guard.** `clamp()` in both `packages/shared/src/scoring.ts`
  and the JS mirror `_partials/weather-score-shared.js` now returns `lo`
  for non-finite inputs (NaN, ±Infinity). The adapter's zod schema
  rejects malformed WeatherDays in production, but if one slips through,
  the API never returns a NaN score — the affected penalty branch
  contributes 0 instead, and the final `Math.round` always produces a
  finite integer. 3 new vitest specs in
  `worker/tests/unit/weather/scoring.test.ts` pin the invariant against
  fully-NaN, Infinity, and single-field-NaN WeatherDays. The
  scoring-parity test re-runs the JS mirror through the same 4500+ cases
  so the two implementations stay locked.
  (2) **Microclimate disclaimer guard.** New
  `scripts/validate-disclaimers.test.js` asserts the verdict landing
  carries the `sw-disclaimer` wrapper and the required text fragments
  ("microclimate", "step outside"). Catches accidental removal during
  refactors. Chained from `test:scripts`.
- **Step 17.** Status page + Sentry (F21). Two pieces:
  (1) **Sentry wrapper.** The worker entry now exports through
  `withSentry()` from `@sentry/cloudflare`. Options are built by
  `worker/src/lib/observability/sentryOptions.ts`. Policy: missing
  `SENTRY_DSN` keeps the SDK disabled so dev / test / CI never ship
  events; `SENTRY_ENVIRONMENT` defaults to `production`;
  `tracesSampleRate` is pinned at 0.1 (free-tier compromise). 6
  vitest specs in `tests/unit/observability/sentryOptions.test.ts`
  pin the disabled-without-DSN guarantee, the environment override,
  and the sample-rate constant.
  (2) **Status page.** New `_src/smoke-weather/status.html` (`noindex,
  follow`) reads `/api/status` on load and renders Sender.net retry
  queue depth, subscriber counts, and the last 10 redacted error
  events. Pure client JS, `textContent`-only DOM updates so any odd
  character in a redacted summary can't escape into markup. Added to
  the schema-validator EXEMPT_PAGES set (operational dashboard, not a
  tool placement); sitemap entry uses `monthly` changefreq and 0.4
  priority. Provision the DSN via
  `wrangler secret put SENTRY_DSN` (free hobby project on Sentry).
- **Step 18.** Methodology + FAQ pages (F22). Two new static HTML
  files under `_src/smoke-weather/`:
  - `methodology.html` — explains the 0-100 score calculation
    (five weather signals, wet-bulb stall model, cooker-specific
    wind sensitivity, data sources, confidence labels). 6 FAQ
    entries in JSON-LD cover the most common methodology questions
    so they're eligible for Google rich results.
  - `faq.html` — 8 user-facing FAQ entries on cost, signup,
    score swings, supported cuts/cookers, international coverage,
    unsubscribe, and data handling.
  Both pages carry full CLAUDE.md head + WebApplication +
  FAQPage + BreadcrumbList JSON-LD and pass the Step 14 schema
  validator without exemption.
  Plan said "link from the footer block" — done by extending
  `scripts/generate-metros.js` footer template with Methodology +
  FAQ + Disclosures links, which propagates to all 50 metro pages
  on next regeneration. `/smoke-weather/index.html` footer updated by
  hand. Both new pages cross-link to each other, to disclosures, and
  to the verdict landing. Sitemap entries at 0.6 priority.
- **Step 19.** Final pass. End-to-end verification sweep before v1
  ship:
  - `npm test` — 922 worker tests across 29 files pass (Vitest +
    Miniflare; covers Open-Meteo/NWS failover, KV stale-while-error,
    D1 migrations, Sender.net client + retry queue, all worker
    handlers, both crons, scoring engine + JS-mirror parity, region
    routing, Sentry options, F20 NaN guards, weekly article cron).
  - `npm run test:scripts` — 22 Node-builtin tests pass
    (generate-metros parity, schema validator, microclimate
    disclaimer guard).
  - `npm run test:e2e` — 36 Playwright specs pass against
    `wrangler dev` (verdict landing, detail view, browser smoke,
    affiliate cards, consent banner behavior).
  - `npm run typecheck` — clean.
  - `validate.ps1` — clean (HTML head shape, INJECT resolution,
    link resolution, sitemap XML validity across 77 dist pages).
  - **Manual pre-deploy** (not automated):
    - Lighthouse mobile ≥95 against the deployed preview URL
      (target ≥95 across PWA/Perf/A11y/Best-Practices/SEO).
    - Google Rich Results test on `/smoke-weather/`,
      `/smoke-weather/methodology`, one metro page, and one
      `/articles/:slug` article.
    - Sentry DSN provisioned via `wrangler secret put SENTRY_DSN`
      before deploy.
    - Sender.net secrets (`SENDER_API_TOKEN` + token-secret + region
      trigger URLs) provisioned via `wrangler secret put`.

## DNS setup — Sender.net sending domain

Best Smoke Days emails ship from `pete@mail.pitmaster.tools`. Configure
the sending domain in Sender.net first (Dashboard → Settings →
Sending Domains → Add domain), then add the records Sender.net
gives you to Cloudflare DNS for `pitmaster.tools`:

| Record                                | Type   | Target / Value                                 |
| ------------------------------------- | ------ | ---------------------------------------------- |
| `mail.pitmaster.tools`                | CNAME  | (from Sender UI)                               |
| `pitmaster._domainkey.pitmaster.tools`| TXT    | (DKIM public key from Sender UI)               |
| `pitmaster.tools` SPF                 | TXT    | `v=spf1 include:_spf.sender.net -all`          |
| `_dmarc.pitmaster.tools`              | TXT    | `v=DMARC1; p=quarantine; rua=mailto:dmarc@pitmaster.tools` |

After Cloudflare propagation (usually < 5 min), click "Verify" in the
Sender.net domain UI. Once verified, every regional automation can
send from this domain.

Code-side, set the from-address envs (optional; only consumed if
`POST /v2/message/send` is wired in a handler):

```bash
wrangler secret put SENDER_FROM_EMAIL    # pete@mail.pitmaster.tools
wrangler secret put SENDER_FROM_NAME     # Pitmaster Tools
wrangler secret put SENDER_REPLY_TO      # pete@mail.pitmaster.tools
```

The envs are surfaced into `Env` for future use — the regional
automation templates are still the canonical place to set the from
address per send. See `docs/sender-setup.md` for the operator
checklist and `docs/portfolio-email-architecture.md` for why this
matters at portfolio scale.

## SEO maintenance

Audit + fix loop for SEO/GEO/AEO: `/claude-rank:rank-audit` (scans titles,
descs, schema, robots.txt, sitemap, AI bot coverage, citability, etc).
Conventions enforced by the audit live in `CLAUDE.md` § "SEO conventions":

- Titles ≤60 rendered chars, descriptions ≤160 rendered chars — entity-decoded
  (`&amp;` counts as 1 char, not 5).
- `robots.txt` carries explicit allow lines for the 13 major AI/SEO crawlers
  (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, Bytespider, Applebot-Extended,
  Amazonbot, cohere-ai, Diffbot, FacebookBot, meta-externalagent, CCBot, anthropic-ai).
- `sitemap.xml` lists only indexable URLs — `noindex` pages (privacy, terms,
  disclosures, status, 404) are excluded.
- Metro page titles/descs are templated in `scripts/generate-metros.js`. Edit
  the template, then `npm run build` regenerates all 50.
- `llms.txt` is the canonical machine-readable tool index — keep it in sync
  with new tools and any load-bearing fact in the calculators.

## Tooling rules

- Never commit directly to `main`; everything goes through a feature branch + PR.
- Every PR runs two review loops (`/review` locally, `/claude:review` on the PR)
  and must update `README.md` as its final commit before merge — see
  `docs/best-smoke-days-plan.md` § "PR review discipline".
- Before merging changes that touch HTML, `sitemap.xml`, `wrangler.jsonc`, or
  local asset links: run `.\validate.ps1` (Windows PowerShell).
- See `CLAUDE.md` for required `<head>` elements, analytics IDs, SEO
  conventions, and Schema rules on tool pages.
