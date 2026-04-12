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
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,…">  <!-- same SVG favicon on every page -->
<script>  <!-- Google Consent Mode v2 default — MUST come before the GA4 async tag -->
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('consent', 'default', {
    'ad_storage': 'denied',
    'analytics_storage': 'denied',
    'wait_for_update': 500
  });
</script>
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-SJJVV37EWE"></script>
<script>
  gtag('js', new Date());
  gtag('config', 'G-SJJVV37EWE');
</script>
<!-- Schema ld+json (tool pages only — WebApplication + FAQPage) -->
<style>…</style>
```

**Rules:**
- The consent-default `<script>` block must appear **before** the GA4 async `<script>` tag.
- Both blocks must appear **before** the `<style>` block.
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

## Git workflow

- Never commit directly to `main`.
- All changes go on a feature branch → PR → merge.
