# Authoring a Guide (AI agent checklist)

This is the canonical procedure for creating a **guide article** under `/guides/`. Follow it
exactly. Guides are hand-authored, humanized editorial pages with Amazon affiliate product cards,
date-gated so they can be written up front and published gradually. The supporting machinery lives in
`scripts/guides-lib.js`, `scripts/generate-guides.js`, and the guide gate in `build.js`.

> TL;DR order of operations: **topic → draft → humanize → dual review (Codex + Claude) → images →
> wire the page → `npm run build` + `npm run validate` + `npm test` → PR.** The humanization gate is a
> hard prerequisite to the code-review gate, not a substitute for it.

---

## 1. Where guides live & how URLs work

- Source: `_src/guides/<category>/<slug>.html` → URL `https://pitmaster.tools/guides/<category>/<slug>`
  (directory path = URL; **no `permalink`** needed).
- Hubs: `_src/guides/index.html` → `/guides/` and `_src/guides/<category>/index.html` → `/guides/<category>/`.
- Categories are defined once in `scripts/guides-lib.js` (`CATEGORIES`). Current slugs: `techniques`,
  `gear`, `wood-and-smoke`, `prep-and-seasoning`, `cuts-and-selection`, `food-safety`.
- **Adding a guide to an existing category:** drop a new `<slug>.html` in that category folder. Nothing
  else to register — `generate-guides.js` discovers it and adds it to the nav, hub, sitemap, and llms.
- **Adding a new category:** add it to `CATEGORIES` in `guides-lib.js`, create
  `_src/guides/<newcat>/index.html` (a category hub with `<!-- INJECT:guides-cat-<newcat>-grid.html -->`),
  then author guides under it.

## 2. Scheduled publishing — the `published` date IS the go-live gate

- A guide is **live** when its frontmatter `published="YYYY-MM-DD"` is today-or-earlier (UTC); otherwise
  it is **scheduled** and withheld from `dist/`, the nav, hubs, `sitemap.xml`, and `llms.txt`.
- To publish gradually: give each guide a future, staggered `published` date (e.g. Mon/Wed/Fri) and
  merge them all. `.github/workflows/publish.yml` rebuilds + deploys daily, so each goes live on its
  date with no further action.
- A **live guide must not link to a scheduled guide** (the target isn't built yet → broken link →
  validation fails). `generate-guides.js` prints a warning if it detects this.
- Pin the date for local testing with `GUIDES_TODAY=YYYY-MM-DD npm run build`.

## 3. Frontmatter (top of file)

```html
<!-- meta:
  title="<≤60 rendered chars, ends with | Pitmaster Tools>"
  description="<≤160 rendered chars>"
  canonical="https://pitmaster.tools/guides/<category>/<slug>"
  og_title="<can be longer/richer than title>"
  og_desc="<optional; falls back to description>"
  og_type="article"
  published="YYYY-MM-DD"   <!-- go-live date; future = scheduled -->
  modified="YYYY-MM-DD"
-->
```
Use the literal `&` in `title`/`description` (the build HTML-encodes it). Title/og_title may use the
sitewide `—` em-dash convention; **body prose may not** (see §7).

## 4. `<head>` — exact INJECT order (enforced by `scripts/validate.mjs`)

```
<!-- INJECT:head-meta.html -->
<!-- INJECT:head-og.html -->
<!-- INJECT:head-article.html -->     <!-- article pages only: published/modified/author -->
<!-- INJECT:head-favicons.html -->
<!-- INJECT:consent-init.html -->
<!-- 2–3 literal JSON-LD <script> blocks (see §5) -->
<!-- INJECT:site-header.css -->
<!-- INJECT:site-base.css -->
<!-- INJECT:guide-affiliate.css -->
```

## 5. JSON-LD — write LITERAL values (no `{{tokens}}`)

**Critical:** `build.js` substitutes `{{TOKENS}}` only inside injected *partials*, never the page body.
A `{{TOKEN}}` typed in the page survives to `dist/` and fails `validate.mjs`. Hardcode every value.

Leaf guides need **`Article`** + **`BreadcrumbList`** (+ optional **`FAQPage`** only if the body has a
real FAQ). Hubs need **`CollectionPage`** + **`BreadcrumbList`**. This is enforced by
`scripts/validate-schema.test.js`. Breadcrumb for a leaf guide is 4 levels: Home → Guides → Category →
Title. `Article.image` must match the hero `<img>` and be a real file (see §6).

## 6. Images — responsive, ≥1 per guide

Two sources, do not mix them up:

- **Heroes & inline figures are owner-supplied** (AI-generated or stock). Location: committed tree
  `img/guides/<slug>.jpg` (hero), `img/guides/<slug>-<n>.jpg` (figures). `build.js` copies `img/` →
  `dist/img/`. **Do not use `public/`** (gitignored). **Every owner `<img>` must resolve to a real
  file** or `validate.mjs` fails (it checks `src`). If final art isn't ready, commit a valid placeholder
  and record the prompt/spec in `img/guides/README.md`.
- **Product-card photos come from Amazon by ASIN — never created by the owner.** They are pulled from the
  **Amazon Creators API** for the card's ASIN and resolved at build time (server-side auth, so not
  client JS). Write the card thumbnail as
  `<img class="product-card__img" data-asin="<ASIN>" src="/img/guides/products/_pending.svg" width="120" height="120" loading="lazy" alt="…">`.
  Until Creators API access is available, leave the shared `_pending.svg` placeholder; the build
  pipeline / `window.__pmProductImages` hook in `_partials/guide-affiliate.js` swaps in the real Amazon
  image once live. Do **not** commit per-product photo files.
- Specs (owner images): hero/figure 1200×675 (16:9) JPG ~80%. Always set explicit `width`/`height`.
  Hero `loading="eager" fetchpriority="high"`; everything below the fold `loading="lazy"`.
- Wrap heroes/figures in `<figure class="guide-hero">` / `<figure class="guide-figure">`; the CSS holds
  the box via `aspect-ratio` for zero CLS. Alt text: specific, no "image of", ≤125 chars.

## 7. Body structure & affiliate placements

Order inside `<main>`:
1. `<nav class="breadcrumb">` (Home → Guides → Category → Title)
2. `.page-hero` with the `<h1>`
3. `<figure class="guide-hero">` hero image
4. `<div class="guide-prose">` containing:
   - `.lede` opening
   - `<!-- INJECT:guide-affiliate-notice.html -->` **(only if the page has affiliate links)** — the
     prominent Amazon-required disclaimer banner, placed above the first product reference.
   - prose with 1–2 inline tool links, inline `.guide-figure`s as needed
   - product card(s) + adjacent disclosure (below)
   - optional FAQ
   - `.guide-related` block
5. `<!-- INJECT:site-footer.html -->`
6. `<!-- INJECT:guide-affiliate.js:script -->` (last; assembles affiliate hrefs)

**Affiliate links** use the runtime renderer: write `<a class="amz" data-asin="<ASIN>">…</a>` with **no
`href`** (the Amazon tag lives only in `_partials/guide-affiliate.js`). Each product card / link group
needs an adjacent `<p class="affiliate-disclosure">…<a href="/disclosures">…</a></p>`. Card markup
pattern:

```html
<aside class="product-grid">
  <div class="product-card">
    <img class="product-card__img" data-asin="<ASIN>" src="/img/guides/products/_pending.svg" width="120" height="120" loading="lazy" alt="…">
    <div class="product-card__body">
      <h3 class="product-card__name">…</h3>
      <p class="product-card__why">…</p>
      <a class="product-card__cta amz" data-asin="<ASIN>">Check price on Amazon</a>
    </div>
  </div>
  <p class="affiliate-disclosure">We may earn a commission on purchases made through links on this page, at no extra cost to you. <a href="/disclosures">See our affiliate disclosure</a>.</p>
</aside>
```

## 8. Humanization gate (before any code review)

The prose must read as written by a person, not a model. Two perspectives review, then **you (Claude)
rewrite**:
1. Run the `humanize` skill over the draft.
2. Get an independent Codex review of the prose (voice/AI-tells only).
3. Rewrite incorporating both, and iterate until both judge it human.

Hard rules and judgment:
- **Remove em dashes (—) and connector en dashes from body prose** — rewrite with commas, periods, or
  colons. (Numeric-range en dashes like `160–170°F` are fine and match sitewide style; em dashes in
  `<title>`/meta also match sitewide convention — leave those.)
- Cut marketing clichés, inflated absolutes ("the single best…"), product-copy ("pays for itself"),
  mechanical rule-of-three triads, false ranges, filler transitions, vague authority ("the
  competition standard").
- **Keep the voice.** Do not flatten prose into clinical fact-bullets — soulless writing is itself an AI
  tell. Preserve opinions, varied rhythm, first person where it fits, and relatable specifics.

## 9. SEO conventions (also see CLAUDE.md)

- `<title>` ≤60 rendered chars, end with ` | Pitmaster Tools`. `<meta description>` ≤160.
- Link out to 1–2 relevant calculators/tools and 1–2 related guides (only **live** ones).
- `generate-guides.js` handles sitemap/llms entries — don't hand-edit the `<!-- GUIDES:START/END -->`
  blocks.

## 10. Validate before PR

```
npm run build       # runs build:metros, build:guides, build.js (gates by date)
npm run validate    # head order, INJECT resolution, no unresolved {{tokens}}, all local href/src resolve
npm test            # incl. validate-schema.test.js (Article/BreadcrumbList) + generate-guides.test.js
```
All three must pass. Then commit on a feature branch and open a PR (Codex → Claude review → merge).

### Common pitfalls
- `{{token}}` left in the page body → build ships it → `validate.mjs` fails. Hardcode JSON-LD values.
- `<img>`/link to a file that doesn't exist (or to a still-scheduled guide) → `validate.mjs` fails.
- Forgetting `head-article.html` or the dates on an `og_type="article"` page → unresolved article tokens.
- Putting images in `public/` (gitignored) instead of `img/`.
- Build noise: `npm run build` rewrites the 50 generated metro pages with CRLF on Windows — `git restore`
  them, never `git add .`.
