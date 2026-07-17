# Image / Visual Strategy — beat the competition on polish

_Planning doc, 2026-07-17. Goal: add photographic imagery that enhances UX/UI and makes
pitmaster.tools look more premium than every direct competitor — without regressing the
site's speed or breaking the brand system._

## 1. Competitive read (why this wins)

Direct-calculator competitors are visually threadbare; content authorities have great
photography but aren't tool-first. **Nobody owns "fast calculator tool + premium food
photography."** That's the open lane.

| Site | Type | Image usage | Weakness we exploit |
|------|------|-------------|---------------------|
| meatsmokingcalculator.com | direct calc | generic stock **fire/flame** clip-art + literal `Placeholder-image.png` cards | looks cheap / unfinished |
| smokedright.com | direct calc | **one** Unsplash smoker hero; text-only tool cards | flat, no depth |
| brisketcookingtimecalculator.com / miniwebtool | direct calc | little to no imagery | utilitarian |
| smokedbbqsource.com | content authority | pro hero + consistent 768×492 recipe thumbnails, warm brown/gold tones | not a tool; slower |
| amazingribs.com | content authority | founder is a pro food photographer; heavy imagery | not a tool; cluttered |

**Our position:** keep the calculator instant, wrap it in on-brand, appetizing photography
that reads as authoritative — matching the content sites' polish while staying tool-first.

## 2. Non-negotiable guardrails (from project rules + current architecture)

1. **Self-hosted only.** No third-party image CDN — the consent/CSP model forbids external
   fetches (same rule that self-hosts fonts). Every image is committed locally.
2. **Live under `og/`.** `build.js` recursively copies `og/` → `dist/og/` (`build.js:452`).
   New photos go in **`og/img/`** and ship automatically — no `build.js` change needed.
   (Root-level assets would each need adding to `STATIC_ASSETS`; avoid that path.)
3. **Zero-CLS, protect LCP.** The site is currently fast and text-only. Every image must ship
   with explicit `width`/`height`, modern formats (**AVIF + WebP + fallback** via `<picture>`),
   `loading="lazy"` everywhere **except** the one above-the-fold hero, which gets
   `fetchpriority="high"` and no lazy. Add `srcset`/`sizes` for the hero. None of these
   patterns exist yet — they're built once as a reusable partial.
4. **Stay on-brand.** Ember/amber/gold on warm cream (`--ember #B02C1A`, `--amber #ED7818`,
   `--gold #FAB746`, `--paper #EFE3CB`). Generate via `image-router` MCP with a **locked prompt
   style** (warm low-and-slow lighting, cream/ember tones, no text baked in) so photos feel like
   one set, not stock grab-bag. This is the house style already used for the pins.
5. **Don't decorate the inputs.** Keep the calculator form itself clean and fast. Imagery goes
   in hero / context / result zones, never wrapping form fields.
6. **Validate.** `npm run validate` after every stage (link + head checks). Spot-check mobile
   LCP so the hero doesn't regress. No new client storage → `privacy-policy.html` untouched.

## 3. Staged rollout (stop after each stage for review)

### Stage 1 — Homepage hero + the 12 calculator heroes (highest ROI, low risk)
The pages with the most traffic and the most obvious "looks premium now" payoff.

- **Homepage** (`_src/pages/index.html`): one appetizing brisket/smoke hero paired with the
  calculator card (side-by-side desktop, stacked mobile). This is the LCP image →
  `fetchpriority="high"`, `srcset`, explicit dimensions.
- **Each of the 12 calculators** (`_src/tools/*`): one cut-specific hero band matched to the
  tool — brisket, ribs, pork shoulder, turkey, brine, dry-rub, etc. The subject set already
  exists conceptually as the per-slug OG art (`og/<slug>.png`); reuse that visual language at
  landscape crop for on-page use.
- Build a reusable responsive-image include (a `_partials/` snippet or build token) so every
  page emits the same `<picture>` markup with AVIF/WebP/fallback + dimensions + lazy rules.
- **Deliverables:** ~13 hero images (3 formats each) under `og/img/`, one partial, edits to
  index + 12 tool pages. This alone leapfrogs every direct competitor.

### Stage 2 — Smoke-weather + metro pages (biggest SEO surface)
50 metro pages + the smoke-weather landing are currently text + gauge only.

- **Do NOT generate 50 unique city photos** (heavy to produce, heavy to ship). Instead: a small
  **shared set of seasonal / atmospheric mood images** (e.g. 4 seasons × a smoker-at-dawn look)
  reused across metros, selected by the page's season/context. One smoke-weather landing hero.
- Keeps payload small (browser-cached across the 50 pages) while making the whole metro network
  feel designed instead of templated.

### Stage 3 — Polish
- Tools-hub (`tools.html`) card thumbnails, so the hub reads like a visual gallery not a link list.
- Light "how it works" / doneness / wood-type reference imagery where it aids comprehension.
- Refresh/expand OG art if any hero becomes the new signature shot.

## 4. Production pipeline (per image)

1. Generate with `image-router` MCP using the locked brand prompt (subject varies, style fixed).
2. Download → crop to the needed aspect (hero landscape ~16:9/3:2; card ~768×492).
3. Encode **AVIF + WebP + JP/PNG fallback** at 1× and 2× for the hero; optimize (target hero
   < ~120 KB AVIF, cards smaller).
4. Commit under `og/img/` → auto-ships to `dist/og/img/`.
5. Reference via the shared `<picture>` partial. Run `npm run validate`; check LCP.

## 5. Housekeeping (do first, tiny)

- **Resolve the 7 orphaned root PNGs** (`brisket-hero.png`, `home-hero.png`, `home-desktop.png`,
  `home-mobile.png`, `leaderboard.png`, `metro-hero.png`, `weather-hero.png`): they ship nowhere
  and only add repo noise. Either promote the good ones into `og/img/` with proper markup or
  delete them. Recommend delete unless they're the intended Stage-1 source art.
- Remove the stray `nul` file in repo root (Windows artifact).

## 6. Open decision

**Image sourcing:** recommend **AI-generated via `image-router`** (already your house style for
pins/OG, gives total brand-palette control, no licensing). Alternative is licensed stock, which
is faster but harder to keep on-palette and consistent. Proceeding on the AI-gen assumption
unless you say otherwise.
