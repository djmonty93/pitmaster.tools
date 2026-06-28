# Guide images

Owner-supplied static images for the Guides section. `build.js` copies this
whole `img/` tree to `dist/img/`, so a file here at `img/guides/foo.jpg` serves
at `https://pitmaster.tools/img/guides/foo.jpg`.

Two kinds of images, two different sources:

- **Heroes and inline figures are owner-supplied** (AI-generated or stock). The
  committed `.jpg` files are 1×1 placeholders so the build/link-validator pass;
  replace each with a real 16:9 photo at the same path. The CSS holds the box via
  `aspect-ratio`, so any 16:9 source avoids layout shift.
- **Product-card photos come from Amazon, by ASIN — never created by the owner.**
  They are pulled from the **Amazon Creators API** for the ASIN on the card and
  resolved at build time. Until Creators API access is available, every product
  card shows the shared neutral placeholder `guides/products/_pending.svg`; no
  per-product files are committed. (See `_partials/guide-affiliate.js` for the
  `window.__pmProductImages` swap hook the build pipeline will populate.)

## Specs (owner-supplied images only)

| File | Use | Size | Format |
|---|---|---|---|
| `guides/<slug>.jpg` | article hero | 1200×675 (16:9) | JPG ~80% |
| `guides/<slug>-<n>.jpg` | inline figure | 1200×675 (16:9) | JPG ~80% |

Product thumbnails are **not** in this table — they are Amazon-sourced by ASIN.

Alt text lives in the page HTML (specific, no "image of", ≤125 chars). The hero
alt must match the `Article.image` in the page's JSON-LD.

## Prompts for the current sample guides

### managing-the-stall (Techniques)
- **`guides/managing-the-stall.jpg`** (hero) — *Photorealistic close-up of a whole beef brisket resting on the grates of an offset smoker, deep mahogany bark, a temperature probe inserted into the thick flat, thin blue smoke in the background, warm early-morning light, shallow depth of field. No text, no logos. 16:9.*
- **`guides/managing-the-stall-wrapped.jpg`** (figure) — *Photorealistic overhead shot of a brisket being wrapped in pink unwaxed butcher paper on a wooden cutting board, hands mid-wrap, rustic backyard setting, natural light. No text. 16:9.*
- product cards (instant-read thermometer `B08X1Q2YBC`, butcher paper `B07BF9XW9N`): Amazon-sourced by ASIN, no owner image needed.

### how-to-wrap-a-brisket (Techniques, scheduled)
- **`guides/how-to-wrap-a-brisket.jpg`** (hero) — *Photorealistic close-up of a brisket wrapped tightly in pink butcher paper, resting on a wooden board, soft natural light, shallow depth of field. No text, no logos. 16:9.*
- product card (butcher paper `B07BF9XW9N`): Amazon-sourced by ASIN.
