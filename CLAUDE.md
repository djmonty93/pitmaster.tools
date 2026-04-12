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
<script>  <!-- Google Consent Mode v2 default -->
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('consent', 'default', {
    'ad_storage': 'denied',
    'analytics_storage': 'denied',
    'wait_for_update': 500
  });
</script>
<!-- Load gtag.js only after consent is accepted or an existing accepted consent cookie is detected -->
<!-- Schema ld+json (tool pages only — WebApplication + FAQPage) -->
<style>…</style>
```

**Rules:**
- The consent-default `<script>` block must appear before any consent-gated analytics loader.
- Do not include a static `<script async src="https://www.googletagmanager.com/gtag/js?...">` tag in HTML. Load GA dynamically only after consent is accepted, or when an existing `pitmaster_consent=accepted` cookie is detected.
- Do not load AdSense before consent for the same reason.
- Keep any consent-gated analytics loader before the main `<style>` block only if it does not fetch external resources until consent has been granted.
- `og:image` always points to `/og-image.png` — do not vary per page.
- Schema (`WebApplication` + `FAQPage`) is required on tool pages; omit on legal pages.
- Never omit OG or Twitter tags even on `noindex` pages.

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

## Validation

- Run `powershell -ExecutionPolicy Bypass -File .\validate.ps1` before merging changes that touch HTML, `sitemap.xml`, `wrangler.jsonc`, or local asset links.
- `validate.ps1` is the repo-standard check for:
  - `favicon.ico` presence
  - `sitemap.xml` XML validity
  - `wrangler.jsonc` JSON validity
  - local `href` and `src` target resolution across the main HTML pages

## Policy consistency

- If site behavior adds or changes first-party storage such as cookies or `localStorage`, update `privacy-policy.html` in the same change.

## Git workflow

- Never commit directly to `main`.
- All changes go on a feature branch → PR → merge.
