# Pitmaster Tools — Project Rules

## Required `<head>` elements on every page

Every HTML file must include **all** of the following in `<head>`, in this order:

```html
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>…</title>
<meta name="description" content="…">
<meta name="robots" content="index, follow">              <!-- noindex, follow for legal pages -->
<link rel="canonical" href="https://pitmaster.tools/…">
<meta property="og:title" content="…">
<meta property="og:description" content="…">
<meta property="og:type" content="website">
<meta property="og:url" content="https://pitmaster.tools/…">
<meta property="og:image" content="https://pitmaster.tools/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="…">
<meta name="twitter:description" content="…">
<link rel="icon" href="favicon.ico" sizes="any">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,…">  <!-- same SVG favicon fallback on every page -->
<script>  <!-- Google Consent Mode v2 default — region-scoped (INJECT:consent-init.html) -->
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  // EEA/UK/CH: deny everything until explicit consent (GDPR).
  gtag('consent', 'default', {
    'ad_storage': 'denied', 'analytics_storage': 'denied',
    'ad_user_data': 'denied', 'ad_personalization': 'denied',
    'region': ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','IS','LI','NO','GB','CH'],
    'wait_for_update': 500
  });
  // Rest of world: analytics granted by default; ads denied until accept.
  gtag('consent', 'default', {
    'analytics_storage': 'granted', 'ad_storage': 'denied',
    'ad_user_data': 'denied', 'ad_personalization': 'denied'
  });
</script>
<!-- gtag.js loads on every non-rejected page view (see _partials/site-utils.js); cookieless inside the EEA/UK/CH, full measurement elsewhere. A stored reject suppresses gtag.js entirely. -->
<!-- Schema ld+json (tool pages only — WebApplication + FAQPage) -->
<style>…</style>
```

**Analytics/consent model:** region-scoped Consent Mode v2 (advanced mode), per `docs/analytics-consent-playbook.md`. The whole engine lives in `_partials/consent-init.html` (the two `consent default` calls above) + `_partials/site-utils.js` (`loadAnalytics`/`loadAds`/`initConsentBanner`). Goal: measure the bulk of (non-EEA) traffic to close the GSC→GA4 gap while staying GDPR-defensible.

**Rules:**
- The consent-default `<script>` block (`INJECT:consent-init.html`) must appear before any analytics loader. Both `consent default` calls are required: the region-scoped EEA/UK/CH deny, then the worldwide analytics-granted fallback.
- Do not include a static `<script async src="https://www.googletagmanager.com/gtag/js?...">` tag in HTML. GA loads dynamically via `loadAnalytics()` on every page view **except** when the visitor has a stored `pitmaster_consent=rejected` cookie (then gtag.js never loads and `_ga*` cookies are purged). Region scoping (cookieless vs full) is handled by Consent Mode, not by withholding the script.
- Do not load AdSense before explicit accept, in any region.
- Keep the analytics loader logic in `site-utils.js`; it must not fetch ad origins before consent (ad-domain preconnect is gated inside `loadAds`).
- `og:image`/`og:type` defaults: non-calculator pages use the shared `/og-image.png` (1200×630) and `og:type=website` — do not vary per page. **Calculator pages are the exception** (see Pinterest Rich Pins below): they set `og_type="article"` and get a per-page vertical `/og/<slug>.png` (1000×1500). `head-og.html` is token-driven; `build.js` `resolveVar` supplies the website/`og-image.png`/1200×630 defaults so every non-calculator page stays byte-identical.
- Schema (`WebApplication` + `FAQPage`) is required on tool pages; omit on legal pages.
- Never omit OG or Twitter tags even on `noindex` pages.

### Pinterest Rich Pins (calculator pages)

- A calculator opts into Article Rich Pins with a single frontmatter line `og_type="article"` plus `published="YYYY-MM-DD"` / `modified="YYYY-MM-DD"`, and injects `<!-- INJECT:head-article.html -->` right after `head-og.html`. `build.js` derives `og:image` = `https://pitmaster.tools/og/<slug>.png` (1000×1500) and a prefilled `pin_href`; all are overridable via explicit frontmatter (`og_image`, `og_image_w/h`, `og_image_alt`, `pin_desc`). If `og/<slug>.png` is missing at build time it falls back to `/og-image.png` (1200×630), so the build never references a missing image.
- Per-page pin images live in `og/<slug>.png`, generated locally and committed. `build.js` copies `og/` → `dist/og/`. Regenerate with `npm run pins:render` (edit `pins.json` for copy). This launches headless Chromium and is a **local/offline dev step only — never run it in build or deploy**; `playwright` is a devDependency.
- The "Save to Pinterest" control: calculator result modals get a JS-injected link (`_partials/pinterest-save.js`, loaded via the tool footer) that builds the pin description from the live result; the static chart page uses `<!-- INJECT:pinterest-save.html -->` (build-time `{{PIN_HREF}}`).

## Analytics & AdSense IDs

- GA4 Measurement ID: `G-SJJVV37EWE`
- AdSense Publisher ID: `ca-pub-4265262608577453`
- Ad slot IDs: currently `XXXXXXXXXX` — replace with real IDs from AdSense dashboard when available.

## Site constants

- Domain: `https://pitmaster.tools`
- Cookie name: `pitmaster_consent`
- Contact email: `contact@pitmaster.tools`
- Governing law: Virginia, USA
- Root favicon file: `favicon.ico`

## SEO conventions

- **Title length:** `<title>` content must be ≤60 *rendered* characters (Google SERP truncation point). Count after decoding HTML entities — `&amp;` is 1 char displayed, not 5. The frontmatter `{{TITLE}}` substitution HTML-encodes the value, so a source `&` in `title=` becomes `&amp;` in dist. Source `&amp;` becomes `&amp;amp;` (broken). Use the literal character `&` in source, or just write "and".
- **Description length:** `<meta name="description">` content must be ≤160 *rendered* characters. Same entity-decoding rule.
- **Brand suffix on titles:** End indexable titles with ` | Pitmaster Tools` for brand recall in SERPs. Drop it only when over budget.
- **og:title length is not constrained** — keep richer/longer copy here than in `<title>` if needed (e.g., metro pages keep `— Best Smoke Days` in og_title but not in title).
- **AI bot allowlist:** `robots.txt` must explicitly allow at minimum: GPTBot, PerplexityBot, ClaudeBot, Google-Extended, CCBot, anthropic-ai, Applebot-Extended, Bytespider, Amazonbot, cohere-ai, Diffbot, FacebookBot, meta-externalagent. Explicit allow lines protect against future default-deny shifts in the wildcard rule.
- **sitemap.xml never includes `noindex` pages.** Listing a `noindex` URL sends conflicting signals to crawlers. When adding a new `noindex` page, also remove it from sitemap if present. Current `noindex` set: `404.html`, `privacy-policy.html`, `terms-of-service.html`, `smoke-weather/disclosures.html`, `smoke-weather/status.html`.
- **llms.txt** lives at repo root and lists every public tool URL + a "Key Facts" block. Update it when adding a tool or changing a load-bearing temperature/percentage/duration claim.
- **Metro pages** are generated by `scripts/generate-metros.js` — edit the title/desc templates in the generator (lines around `pageTitle` / `desc`), then run `npm run build:metros` (or `npm run build`) to regenerate all 50.

## Validation

- Run `npm run validate` before merging changes that touch HTML, `sitemap.xml`, `wrangler.jsonc`, or local asset links. This is the authoritative check (`npm run build` + `node scripts/validate.mjs`) and is what CI enforces.
- `npm run validate` checks:
  - `favicon.ico` presence
  - `sitemap.xml` XML validity
  - `wrangler.jsonc` JSON validity
  - local `href` and `src` target resolution, head-meta tokens, INJECT directives, and per-page `<head>` requirements across all built pages
- Note: the older `validate.ps1` scanner is **not** authoritative — it false-positives on JS-constructed `href`s inside `<script>` blocks (e.g. the affiliate-link renderer in `_partials/smoke-weather-app.js`, which trips it on every metro page). Prefer `npm run validate`.
- Do not ship links to planned tools or placeholder local pages. Any internal `href` added to production HTML must resolve to a file that already exists in the branch being merged.

## Policy consistency

- If site behavior adds or changes first-party storage such as cookies or `localStorage`, update `privacy-policy.html` in the same change.

## Cross-tool consistency

- Reuse the same locale-aware first-visit unit default behavior across calculators. If there is no saved `pitmaster_tu` / `pitmaster_wu` preference, metric locales should default to `°C` and `kg`, matching `index.html`.

## Git workflow

- Never commit directly to `main`.
- All changes go on a feature branch → PR → merge.


# AI Context (auto-generated by codesight)

This is a typescript project using raw-http.

The database has 6 models. See .codesight/schema.md for the full schema with fields, types, and relations.
Middleware includes: custom.

High-impact files (most imported, changes here affect many other files):
- worker\tests\helpers\d1.ts (imported by 16 files)
- worker\src\lib\sender\client.ts (imported by 10 files)
- worker\src\index.ts (imported by 9 files)
- worker\src\lib\sender\errors.ts (imported by 9 files)
- worker\src\router.ts (imported by 9 files)
- worker\src\lib\redact.ts (imported by 7 files)
- worker\src\lib\weather\errors.ts (imported by 7 files)
- worker\src\lib\auth\token.ts (imported by 6 files)

Required environment variables (no defaults):
- CI (playwright.config.js)

Read .codesight/wiki/index.md for orientation (WHERE things live). Then read actual source files before implementing. Wiki articles are navigation aids, not implementation guides.
Read .codesight/CODESIGHT.md for the complete AI context map including all routes, schema, components, libraries, config, middleware, and dependency graph.
