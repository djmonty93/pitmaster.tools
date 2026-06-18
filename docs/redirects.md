# Redirects — Cloudflare edge config

How pitmaster.tools issues redirects, and the exact rules that force every
canonicalization to a **single-hop `301`**. For the old→new URL table see
[redirect-map.md](./redirect-map.md).

## Where redirects come from

The site is a Cloudflare Worker with **Workers Assets** (`assets` in
`wrangler.jsonc`). Two things matter:

1. **Workers Assets serves static files *before* the Worker's `fetch` handler.**
   So the `www → apex` 301 in `worker/src/index.ts` is bypassed for every real
   page — it only runs for non-asset paths (`/api/*`). Before the edge rules,
   `www.pitmaster.tools/<page>` served a `200` (duplicate content), not a
   redirect.
2. **Assets `html_handling` emits `307` (temporary)** for `.html`→clean-URL and
   trailing-slash normalization. Google won't consolidate a 307, so these
   showed up in Search Console as "Redirect error" / "Page with redirect".

The fix is **Cloudflare Wildcard Redirect Rules** (zone `pitmaster.tools`),
which run at the edge *before* Assets and issue `301`s.

> The zone's plan does **not** entitle `regex_replace` (needs Business / WAF
> Advanced), and a dynamic redirect target allows at most one `regex_replace`
> anyway. So these use **Wildcard** match + `${N}` placeholders, not dynamic
> regex expressions.

## The rules (in order — first match wins)

Wildcard `*` is greedy and matches `/`, so the two `index` rules MUST sit above
the general `*.html` rule, otherwise `/smoke-weather/index.html` would collapse
to `/smoke-weather/index` (a 404).

| # | Request URL (Wildcard) | Target URL (Wildcard) | Status |
|---|---|---|---|
| 1 | `https://pitmaster.tools/index.html` | `https://pitmaster.tools/` | 301 |
| 2 | `https://pitmaster.tools/*/index.html` | `https://pitmaster.tools/${1}/` | 301 |
| 3 | `https://pitmaster.tools/*.html` | `https://pitmaster.tools/${1}` | 301 |
| 4 | `https://www.pitmaster.tools/*.html` | `https://pitmaster.tools/${1}` | 301 |
| 5 | `https://www.pitmaster.tools/*` | `https://pitmaster.tools/${1}` | 301 |

All rules: **Preserve query string = on.** Rule 3 is the one that clears the 7
GSC "Redirect error" tool URLs.

### Why it's loop-safe
- Rule outputs (`/brisket-calculator`, `/smoke-weather/`, `/`) match no rule →
  Assets serves `200` → terminates in one hop.
- `/smoke-weather/` and `/smoke-weather/metros/` never match (no `.html`), so
  Assets' directory-slash redirect is untouched — no fight, no loop.
- No generic trailing-slash-strip rule exists, by design (it would loop against
  the directory redirect).

## Applying / editing

The connected Cloudflare MCP token is read-only and scoped to a different
account, so these were applied **manually** in the dashboard:
**Cloudflare → `pitmaster.tools` → Rules → Redirect Rules**. Zone id:
`ceccfce40337e697d91c0679416eaf81`.

## Verification

After any change, confirm each canonicalization is a single hop ending in a
live `200`:

```bash
probe() { printf '### %s\n' "$1"; curl -sILk --max-time 20 "$1" \
  | grep -iE '^(HTTP/|location:)' | sed 's/\r$//'; printf '\n'; }

# The 7 must each be: 301 -> /<tool> -> 200
for t in brisket pork-shoulder rib meat-per-person cook-time-coordinator \
         catering charcoal; do
  probe "https://pitmaster.tools/${t}-calculator.html" 2>/dev/null || true
done

# Loop-safety: each must be a plain 200 (no redirect)
probe "https://pitmaster.tools/smoke-weather/"
probe "https://pitmaster.tools/smoke-weather/metros/"
probe "https://pitmaster.tools/"
probe "https://pitmaster.tools/brisket-calculator"
```

(The tool slugs aren't all `<word>-calculator` — `meat-per-person` and
`cook-time-coordinator` differ — so verify against the real 7 in
[redirect-map.md](./redirect-map.md).)
