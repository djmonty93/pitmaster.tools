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

## Tooling rules

- Never commit directly to `main`; everything goes through a feature branch + PR.
- Every PR runs two review loops (`/review` locally, `/claude:review` on the PR)
  and must update `README.md` as its final commit before merge — see
  `docs/best-smoke-days-plan.md` § "PR review discipline".
- Before merging changes that touch HTML, `sitemap.xml`, `wrangler.jsonc`, or
  local asset links: run `.\validate.ps1` (Windows PowerShell).
- See `CLAUDE.md` for required `<head>` elements, analytics IDs, and Schema
  rules on tool pages.
