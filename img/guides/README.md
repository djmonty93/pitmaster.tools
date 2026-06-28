# Guide images

Owner-supplied static images for the Guides section. `build.js` copies this
whole `img/` tree to `dist/img/`, so a file here at `img/guides/foo.jpg` serves
at `https://pitmaster.tools/img/guides/foo.jpg`.

The `.jpg` files currently committed are **1×1 placeholders** so the build and
link-validator pass. Replace each one with a real photo (AI-generated or stock)
at the spec below — same filename, same path. Heroes/figures are 16:9; the CSS
holds the box via `aspect-ratio`, so any 16:9 source avoids layout shift.

## Specs

| File | Use | Size | Format |
|---|---|---|---|
| `guides/<slug>.jpg` | article hero | 1200×675 (16:9) | JPG ~80% |
| `guides/<slug>-<n>.jpg` | inline figure | 1200×675 (16:9) | JPG ~80% |
| `guides/products/<name>.jpg` | product card thumbnail | 480×480 (square) | JPG ~80% |

Alt text lives in the page HTML (specific, no "image of", ≤125 chars). The hero
alt must match the `Article.image` in the page's JSON-LD.

## Prompts for the current sample guides

### managing-the-stall (Techniques)
- **`guides/managing-the-stall.jpg`** (hero) — *Photorealistic close-up of a whole beef brisket resting on the grates of an offset smoker, deep mahogany bark, a temperature probe inserted into the thick flat, thin blue smoke in the background, warm early-morning light, shallow depth of field. No text, no logos. 16:9.*
- **`guides/managing-the-stall-wrapped.jpg`** (figure) — *Photorealistic overhead shot of a brisket being wrapped in pink unwaxed butcher paper on a wooden cutting board, hands mid-wrap, rustic backyard setting, natural light. No text. 16:9.*
- **`guides/products/instant-read-thermometer.jpg`** — *Clean product photo of a handheld instant-read digital meat thermometer on a plain white background, slight shadow, probe extended. Square.*
- **`guides/products/butcher-paper.jpg`** — *Clean product photo of a roll of pink unwaxed butcher paper on a plain white background, slight shadow. Square.*

### how-to-wrap-a-brisket (Techniques, scheduled)
- **`guides/how-to-wrap-a-brisket.jpg`** (hero) — *Photorealistic close-up of a brisket wrapped tightly in pink butcher paper, resting on a wooden board, soft natural light, shallow depth of field. No text, no logos. 16:9.*
- reuses **`guides/products/butcher-paper.jpg`**.
