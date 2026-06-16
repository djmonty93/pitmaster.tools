# Sender.net setup

Operator-side configuration the worker assumes exists. Run through this checklist after first issuing the `SENDER_API_TOKEN`.

## 1. API token

1. Sender dashboard → **Settings → API access tokens → Create**.
2. Name it (e.g. `pitmaster-prod` / `pitmaster-staging`). Scope: full.
3. Copy the token into the worker secret `SENDER_API_TOKEN` via `wrangler secret put SENDER_API_TOKEN`.

## 2. Custom subscriber fields

Subscribers → **Fields** → create the following eight fields. The `Key` column must match exactly — the worker emits `{$bbq_*}` payload tokens that resolve by key.

| Key | Type |
|---|---|
| `bbq_zip` | Text |
| `bbq_city` | Text |
| `bbq_state` | Text |
| `bbq_region` | Text |
| `bbq_cut_pref` | Text |
| `bbq_cooker_pref` | Text |
| `bbq_timezone` | Text |
| `bbq_signup_date` | Date |

## 3. Groups

Create seven groups by name. IDs are auto-assigned and cached in Cloudflare KV on first lookup (prefix `sender_group_id:`). The worker resolves group IDs by name.

- `pitmaster_all`
- `pitmaster_northeast`
- `pitmaster_southeast`
- `pitmaster_midwest`
- `pitmaster_south_central`
- `pitmaster_mountain`
- `pitmaster_pacific`

If a group is renamed or deleted/recreated, invalidate the KV cache:

```bash
wrangler kv:key delete --binding WEATHER_KV "sender_group_id:<old-name>"
```

## 4. Per-region weekly digest (worker-built campaigns)

The Friday cron (`worker/src/crons/fridayEmail.ts`) fires hourly Fri UTC and, for each
region whose anchor tz is now Fri 06:00 local, **builds the HTML digest in the worker**
(the region's metros with Fri/Sat/Sun/Mon smoke scores) and **sends it as a Sender.net
campaign** to the `pitmaster_<region>` group:

1. Resolve the `pitmaster_<region>` group id (`resolveGroupId`, KV-cached).
2. `createCampaign` → `POST /v2/campaigns` with subject, from-address, HTML, and
   `groups: [<region group id>]`.
3. `sendCampaign` → `POST /v2/campaigns/<id>/send`.

One send broadcasts to the whole group — no per-subscriber loop. Scores assume a single
default profile (pork butt on an offset), disclosed in the email footer. The digest is
idempotent per (region, send_date) via the `friday_campaign_log` claim, with Cloudflare
scheduled-handler auto-retry on transient failures (5xx / 429 Retry-After honored).

### ⚠️ Preconditions — verify BEFORE enabling real sends

1. **Account tier.** The Sender.net Campaigns API (`/v2/campaigns/*`) is typically a
   **paid-tier** feature. Confirm the account can create and send campaigns via API, or
   the cron will fail every region.
2. **Authenticated sending domain.** Set `SENDER_FROM_EMAIL` (and `SENDER_FROM_NAME`,
   `SENDER_REPLY_TO`) to an address on your authenticated domain (§5). An **unset
   `SENDER_FROM_EMAIL` dark-disables the whole digest** — the global "not configured yet"
   / kill-switch state — and writes one `not-configured` warning event per (region, date).
   There is no per-region toggle in this model (a future enabled-regions list could add
   one for staging).
3. **API contract.** The exact create/send payload field names and paths were not
   confirmable against the live docs (they render client-side). The wire shape is
   centralized in `worker/src/lib/sender/client.ts` (`campaignCreateBody` + the
   `createCampaign`/`sendCampaign` paths) so confirming it against the live API — and the
   unsubscribe merge tag (`{$unsubscribe}`) used in `digestEmail.ts` — is a one-file change.
4. **Re-send idempotency.** The cron persists the created `campaign_id` on the
   `friday_campaign_log` row and reuses it on any reclaim/retry, so at most **one campaign
   is ever created** per (region, send_date) — a lost send response or a failed post-send
   write can never create a *second distinct* campaign. The residual is that a retry calls
   `sendCampaign` on the **same** campaign again: confirm Sender either rejects re-sending an
   already-sent campaign or is otherwise safe, so a retry can't double-broadcast the same
   campaign.

No per-region trigger URLs or dashboard automations are involved any more; the worker owns
the content, scheduling (per-region tz), and idempotency.

## 5. Sending domain

**The worker has no dependency on the sending domain.** It never sends mail itself —
sender.net does, using whatever "from" address you configure on the campaign/automation
in the sender.net dashboard. The `SENDER_FROM_EMAIL`, `SENDER_FROM_NAME`, `SENDER_REPLY_TO`
secrets are declared in `Env` but **unused by any handler today** (reserved for a future
`POST /v2/message/send` path).

So the domain choice is yours and is made entirely in sender.net:

- **The apex `pitmaster.tools` is fine** — there is no requirement to send from
  `mail.pitmaster.tools`. A dedicated subdomain is only an *optional* deliverability-isolation
  practice (keeps marketing-mail reputation separate from any apex mail, and matters more once
  multiple portfolio sites share one sender.net account — see
  `portfolio-email-architecture.md` §"Shared sender reputation").
- **Whatever domain you pick must be authenticated:** add sender.net's DKIM CNAME records and
  a DMARC record, and ensure SPF authorizes sender.net.
  - ⚠️ **SPF merge:** `pitmaster.tools` already sends mail (`contact@pitmaster.tools`), so an
    SPF TXT record likely already exists. A domain may have **only one** SPF record — add
    sender.net's `include:` into the existing record; do **not** create a second SPF TXT.

## 6. Webhooks (optional)

Sender's webhooks require the Standard plan or above. If/when wired, the worker handler verifies HMAC-SHA256 of the raw body against the per-webhook signing secret. Topics of interest: subscriber unsubscribed, bounced, reported spam.

## 7. Rate limits

Sender returns `429` with a `Retry-After: <seconds>` header on rate-limit. The worker treats 429 as retryable and the retry queue prefers `Retry-After` over the default exponential backoff when present (capped at `MAX_BACKOFF_MS` = 6 h in the retry queue — the parser itself no longer caps at 1 h). The Friday digest cron also honors `Retry-After` — a region that returns 429 with `Retry-After: <N>` will be skipped until `now + N` on subsequent hourly cron invocations within the send window. Free-tier limits are not publicly published — read `X-RateLimit-Remaining` on responses to monitor headroom.
