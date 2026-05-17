# Pitmaster.tools — Complete Refactor Plan

## Context

Pitmaster.tools is a static-HTML BBQ calculator site with a Cloudflare Worker backend (D1 + KV + cron + Sender.net + Sentry). Authoring is painful: 70 source HTML files share ~5,075 lines of duplicated boilerplate (nav block, OG/Twitter meta, consent script, favicons, common inline CSS, localStorage init). A working `_src → build.js → dist` pipeline already injects CSS/JS partials but has no HTML-partial or variable-substitution support. There is no GitHub Actions CI — `validate.ps1` runs locally pre-merge. Tool pages are 700–1,700 lines each, most of it inline `<style>` and `<script>`. The worker is already cleanly split (router + handlers/ + crons/ + lib/), so backend work is minor.

Goal: ship the refactor in three stages, lowest-risk first, with main always green.

- **Stage 1 — Dedupe** inside the existing `build.js`. Highest value, lowest risk. Deletes ~5,000 lines.
- **Stage 2 — SSG go/no-go** decision, data-driven, only after Stage 1 lives in prod.
- **Stage 3 — Restructure** (`_src/` folder reorg, CSS consolidation, lint/format in CI).

**Binding constraints from the user:**
- Keep zero-runtime-deps build: `dist/` stays plain HTML, no client-side framework JS.
- Don't break URLs or SEO: sitemap paths, canonicals, schema JSON-LD all preserved.
- CLAUDE.md `<head>`-order rules must survive the refactor.

---

## Reuse — existing utilities (don't duplicate)

- `H:\Code\pitmaster.tools\build.js` (94 lines) — keep as orchestrator, extend.
- `H:\Code\pitmaster.tools\_partials\` — already holds CSS/JS partials; new `.html` partials land here.
- `H:\Code\pitmaster.tools\scripts\generate-metros.js` — emits metros before build.js; reuse hook point.
- `H:\Code\pitmaster.tools\worker\src\` — already split into `router.ts`, `handlers/`, `crons/`, `lib/`. No work in Stage 3.
- `H:\Code\pitmaster.tools\validate.ps1` — `Test-LocalLinks`, `Test-XmlFile`, `Test-JsonFile`, `ConvertFrom-Jsonc` exist. Extend, don't replace.
- `scripts/validate-schema.test.js` + `scripts/validate-disclaimers.test.js` — keep; must stay green against `dist/`.

---

## Stage 1 — Dedupe via extended `build.js`

### Deliverables
- New HTML partials in `_partials/`: `head-meta.html`, `head-og.html`, `head-favicons.html`, `consent-init.html`, `site-header.html`, `site-footer.html`.
- Extended `build.js`:
  - New placeholder form `<!-- INJECT:name.html -->` emits raw HTML (no `<style>`/`<script>` wrap) — distinguished by `.html` extension in the existing regex.
  - Per-page frontmatter via leading HTML comment: `<!-- meta: title="…" description="…" canonical="…" og_title="…" og_desc="…" -->`. Parsed once at top of file, stripped from output.
  - `{{TITLE}}` / `{{DESCRIPTION}}` / `{{CANONICAL}}` / `{{OG_TITLE}}` / `{{OG_DESC}}` substitution **scoped to injected partial bodies only** — never the page body — to avoid collision with inline JS/JSON-LD.
- Head order enforced by `head-meta.html` itself (the partial owns structure; pages declare values only).
- JSON-LD blocks stay inline in each tool page (per-page content) between `head-favicons` and `consent-init` injects.
- `.github/workflows/ci.yml` — typecheck, test, build+validate, e2e.
- `scripts/validate.mjs` — cross-platform Node port of `validate.ps1` rules, called from CI; `validate.ps1` stays for local Windows use, both call the same Node validator.

### Ordered steps
1. **Pilot: `_src\privacy-policy.html`** (181 lines, noindex, no schema, no component CSS). Author all six new partials. Convert page. Byte-diff `dist/privacy-policy.html` against pre-change baseline — only acceptable diff is whitespace collapse.
2. **Extend `build.js`** (`H:\Code\pitmaster.tools\build.js`):
   - Update regex in `injectPartials` (line 41) to match `.html` extension and emit content verbatim.
   - Add `parseFrontmatter(html) → {vars, body}` that consumes the leading `<!-- meta: … -->` comment.
   - Add `substituteVars(content, vars)` running over each injected partial's body before insertion.
3. **Second pilot: `_src\brisket-calculator.html`** — exercises schema. Confirm `scripts/validate-schema.test.js` still passes (schema content unchanged).
4. **Rollout by risk tier**:
   - Legal (3 files): `privacy-policy`, `terms-of-service`, `smoke-weather/disclosures`.
   - Static (4 files): `about`, `tools`, `index`, `404`.
   - Tool calculators (10 files): `meat-per-person`, `cook-time-coordinator`, `bbq-cost-calculator`, `brine-calculator`, `charcoal-calculator`, `dry-rub-calculator`, `brisket-calculator`, `brisket-yield-calculator`, `pork-shoulder-calculator`, `rib-calculator`, `turkey-smoking-calculator`.
   - Seasonal + smoke-weather hand-authored pages.
   - Each tier is one PR.
5. **Update `scripts\generate-metros.js`** — change emitted template to use new `<!-- INJECT:head-meta.html -->` form with metro-specific values; `GENERATED_MARKER` stays first; `generate-metros.test.js` parity check rebased to new baseline.
6. **Extend `validate.ps1`** (and the new `scripts/validate.mjs`):
   - `Test-HeadOrder`: regex-extract `<head>...</head>` from each built dist file, assert ordering: `charset → viewport → title → description → robots → canonical → og:title → og:description → og:type → og:url → og:image → og:image:width → og:image:height → og:image:alt → twitter:card → twitter:title → twitter:description → twitter:image → link rel=icon (×2) → consent default script → JSON-LD (if any) → INJECT styles`.
   - `Test-ConsentBeforeAnalytics`: assert `gtag('consent', 'default'` precedes any `googletagmanager.com` / `adsbygoogle` reference per file.
   - `Test-UnresolvedTokens`: scan `dist/**/*.html` for `{{` and fail if found.
   - Existing `Test-LocalLinks`, `Test-XmlFile`, `Test-JsonFile` unchanged.
7. **`.github/workflows/ci.yml`** — single workflow, triggers `pull_request` + `push: main`, runs on `ubuntu-latest`:
   - `typecheck`: `npm run typecheck`.
   - `test`: `npm test` (node:test + vitest).
   - `build-validate`: `npm run build && node scripts/validate.mjs`.
   - `e2e`: `npx playwright install --with-deps chromium && npm run test:e2e`.
   - All share `actions/setup-node@v4` with `cache: npm`.

### Verification
- After each tier PR: `npm run build`, then `git diff dist/` shows only whitespace.
- `validate.ps1` (and `scripts/validate.mjs`) green locally.
- `ci.yml` green on the PR.
- Playwright e2e green.

### Risks
- **Head-order drift** — `Test-HeadOrder` is mandatory before merging tier 1.
- **Token leakage** — `{{X}}` could collide with JSON-LD or inline JS. Mitigated by scoping substitution to partial bodies only + `Test-UnresolvedTokens`.
- **Metro test churn** — `generate-metros.test.js` baseline must be updated atomically with the template change.

---

## Stage 2 — SSG go/no-go decision

Evaluate **after Stage 1 lives in prod for ~2 weeks**. Data-driven only.

### Signals to ADOPT an SSG
- Need for layout inheritance — shared *body* structure (sidebar, related-tools, FAQ scaffold) still duplicates >300 lines per tool page after Stage 1.
- Need for data files — e.g., `data/calculators.json` driving nav dropdown, sitemap, related-tools widget, tools.html grid.
- Need for asset hashing / cache-busting once `site-base.css` grows past ~30KB.
- New content types planned (blog, programmatic SEO beyond metros, tag/category pages).

### Signals to STOP at Stage 1
- Page sizes drop the targeted ~5,000 lines and the authoring workflow feels ergonomic.
- No new content types planned.
- Build time stays under 1s for ~70 pages.

### If GO: adopt Eleventy v3, not Astro
- Zero-runtime-JS by default (Astro requires explicit opt-out for islands — violates the constraint by temptation).
- Node-only, no bundler chain.
- Nunjucks templates are closer to the current placeholder model than JSX.
- Migration path that doesn't churn `dist/`:
  1. Add `.eleventy.js` with `input: '_src'`, `output: 'dist'`, `passthroughCopy` for static assets.
  2. Convert *one* partial at a time from `<!-- INJECT:... -->` to `{% include %}`. Run both pipelines in parallel during transition; bytewise-diff outputs.
  3. Decommission `build.js` only after all pages migrated and CI green for two weeks.

---

## Stage 3 — Architectural restructure

### Deliverables
- `_src/` folder reorg:
  - `_src/pages/` — `index`, `about`, `tools`, `404`.
  - `_src/tools/` — 11 calculators.
  - `_src/legal/` — `privacy-policy`, `terms-of-service`.
  - Keep `_src/seasonal/`, `_src/smoke-weather/`.
- URL preservation via `permalink` frontmatter field (extends Stage 1 frontmatter) so `_src/tools/brisket-calculator.html` still emits to `dist/brisket-calculator.html`. `_redirects` left alone.
- CSS consolidation:
  - Audit inline `<style>` blocks across all tool pages — `~60%` of rules are duplicated focus-visible / unit-toggle / wrap-toggle patterns. Move those into `site-base.css`.
  - Leave genuinely page-unique rules inline.
- Lint/format chain:
  - Prettier (root `.prettierrc`, `printWidth: 100`, `singleQuote: true`).
  - eslint for `worker/**/*.ts` and `scripts/**/*.js`.
  - stylelint for `_partials/*.css`.
  - Explicitly **exclude** `_src/**/*.html` from Prettier to keep git blame clean on hand-tuned HTML.
  - `npm run lint` script; new `lint` job in `ci.yml`.
- Worker code: no work — `router.ts` + `handlers/` + `crons/` + `lib/` already clean. Only add `tsconfig.strict: true` if not already on.

### Ordered steps
1. Add `permalink` frontmatter support to `build.js`. Verify `dist/` unchanged.
2. Move files into `pages/`, `tools/`, `legal/`. Update `validate.ps1` + `scripts/validate.mjs` source-path globs (dist paths unchanged).
3. Confirm `sitemap.xml` byte-identical post-move.
4. Extract shared inline CSS into `site-base.css`; delete duplicated rules from per-page `<style>` blocks. One tool PR at a time.
5. Add Prettier + eslint + stylelint configs; format pass on `worker/` + `scripts/` only.
6. Wire `lint` job into `ci.yml`.

### Verification
- `git diff dist/` after each step shows only intended changes.
- `sitemap.xml` byte-identical (or regenerated identically).
- Lighthouse mobile score within ±1 of pre-refactor baseline on `index.html` and one tool page.
- CI green.

### Risks
- **Canonical drift** during the file move — `Test-LocalLinks` + `Test-HeadOrder` cover it together.
- **Stylelint churn** — limit to `--fix`-safe rules; configure to ignore property-order debates.
- **Prettier touching HTML** — excluded by config.

---

## Critical files

| Stage | File | Action |
|-------|------|--------|
| 1 | `H:\Code\pitmaster.tools\build.js` | Extend: HTML partial form, frontmatter, var substitution. |
| 1 | `H:\Code\pitmaster.tools\_partials\` | Add `head-meta.html`, `head-og.html`, `head-favicons.html`, `consent-init.html`, `site-header.html`, `site-footer.html`. |
| 1 | `H:\Code\pitmaster.tools\_src\privacy-policy.html` | Pilot conversion. |
| 1 | `H:\Code\pitmaster.tools\_src\brisket-calculator.html` | Second pilot (schema-bearing). |
| 1 | `H:\Code\pitmaster.tools\scripts\generate-metros.js` | Update emitted template to new INJECT form. |
| 1 | `H:\Code\pitmaster.tools\validate.ps1` | Add `Test-HeadOrder`, `Test-ConsentBeforeAnalytics`, `Test-UnresolvedTokens`. |
| 1 | `H:\Code\pitmaster.tools\scripts\validate.mjs` (new) | Cross-platform port of validate.ps1 for CI. |
| 1 | `H:\Code\pitmaster.tools\.github\workflows\ci.yml` (new) | typecheck, test, build-validate, e2e. |
| 2 | `H:\Code\pitmaster.tools\.eleventy.js` (new, if GO) | Eleventy config mirroring build.js outputs. |
| 3 | `H:\Code\pitmaster.tools\_src\pages\` / `tools\` / `legal\` (new dirs) | File move; preserved by `permalink` frontmatter. |
| 3 | `H:\Code\pitmaster.tools\_partials\site-base.css` | Absorb duplicated inline CSS rules. |
| 3 | `H:\Code\pitmaster.tools\.prettierrc`, `.eslintrc`, `.stylelintrc` (new) | Lint/format configs. |

---

## End-to-end verification

After each stage:
1. `npm run build` — exits 0.
2. `git diff dist/` — only intended changes (mostly whitespace during dedupe).
3. `npm run typecheck` — green.
4. `npm test` — node:test + vitest both green.
5. `npm run test:e2e` — Playwright smoke + smoke-weather suites green.
6. `powershell -ExecutionPolicy Bypass -File .\validate.ps1` — green; same rules also run via `node scripts/validate.mjs` in CI.
7. Open `dist/index.html`, `dist/brisket-calculator.html`, `dist/privacy-policy.html` in a browser; verify nav, calculators, consent banner, ad slot behavior.
8. After production deploy: spot-check sitemap URLs return 200 and canonical/OG tags match pre-refactor.

## Sequencing summary

- **Stage 1**: ~1–2 weeks. Highest value, lowest risk.
- **Stage 2 decision**: 1 day, after Stage 1 has been live ~2 weeks.
- **Stage 3**: 3–5 days, independent of the Stage 2 verdict.
