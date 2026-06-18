# Redirect map — canonical URLs

Single source of truth for every redirecting URL on pitmaster.tools and the
live `200` page it resolves to. **Every redirect below is a single-hop `301`**
(except the trailing-slash case, noted) issued by Cloudflare Wildcard Redirect
Rules in front of Workers Assets. See the redirect-architecture memory for how
the rules are configured and why.

**Canonical form of every page:** apex host, `https`, clean URL (no `.html`),
no `index`, no trailing slash — except true directory indexes
(`/smoke-weather/`, `/smoke-weather/metros/`) which keep their trailing slash.

Rules for authors:
- Internal links, `llms.txt`, `sitemap.xml`, canonicals, and `og:url` must
  point at the **final destination**, never a redirecting form.
- `sitemap.xml` must never list a redirecting URL.

## Explicit old → new (the 15 GSC "Page with redirect" URLs)

| Old (redirecting) | New (final 200) | Rule |
|---|---|---|
| `http://pitmaster.tools/` | `https://pitmaster.tools/` | http→https |
| `http://www.pitmaster.tools/` | `https://pitmaster.tools/` | http + www→apex |
| `https://www.pitmaster.tools/index` | `https://pitmaster.tools/` | www + index |
| `https://www.pitmaster.tools/about.html` | `https://pitmaster.tools/about` | www + .html |
| `https://pitmaster.tools/index` | `https://pitmaster.tools/` | bare index |
| `https://pitmaster.tools/index.html` | `https://pitmaster.tools/` | root index.html |
| `https://pitmaster.tools/smoke-weather/index.html` | `https://pitmaster.tools/smoke-weather/` | subdir index.html |
| `https://pitmaster.tools/about/` | `https://pitmaster.tools/about` | trailing slash (Assets 307 — see note) |
| `https://pitmaster.tools/about.html` | `https://pitmaster.tools/about` | .html |
| `https://pitmaster.tools/tools.html` | `https://pitmaster.tools/tools` | .html |
| `https://pitmaster.tools/brine-calculator.html` | `https://pitmaster.tools/brine-calculator` | .html |
| `https://pitmaster.tools/dry-rub-calculator.html` | `https://pitmaster.tools/dry-rub-calculator` | .html |
| `https://pitmaster.tools/bbq-cost-calculator.html` | `https://pitmaster.tools/bbq-cost-calculator` | .html |
| `https://pitmaster.tools/turkey-smoking-calculator.html` | `https://pitmaster.tools/turkey-smoking-calculator` | .html |
| `https://pitmaster.tools/brisket-yield-calculator.html` | `https://pitmaster.tools/brisket-yield-calculator` | .html |

## The 7 GSC "Redirect error" URLs (now single-hop 301)

All `https://pitmaster.tools/<tool>.html` → `https://pitmaster.tools/<tool>`,
covered by the general `.html` rule: `brisket-calculator`,
`pork-shoulder-calculator`, `rib-calculator`, `meat-per-person`,
`cook-time-coordinator`, `catering-calculator`, `charcoal-calculator`.

## General rules (apply to any URL, not just the ones above)

| Pattern | → | Status |
|---|---|---|
| `https://pitmaster.tools/<path>.html` | `https://pitmaster.tools/<path>` | 301 |
| `https://pitmaster.tools/index.html` | `https://pitmaster.tools/` | 301 |
| `https://pitmaster.tools/<dir>/index.html` | `https://pitmaster.tools/<dir>/` | 301 |
| `https://www.pitmaster.tools/<path>` | `https://pitmaster.tools/<path>` | 301 |
| `http://…` | `https://…` | 301 |
| `https://pitmaster.tools/<flat>/` (trailing slash) | `https://pitmaster.tools/<flat>` | 307 (Workers Assets) |

**Note on the trailing-slash case:** `/about/` → `/about` is still a `307`
issued by Workers Assets, not a Redirect Rule. A generic edge "strip trailing
slash" rule is intentionally NOT added because it would fight Assets' directory
redirect for `/smoke-weather/` and create a loop. Don't link to flat paths with
a trailing slash; the canonical has none.
