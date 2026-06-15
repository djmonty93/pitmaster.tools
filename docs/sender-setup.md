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

## 4. Per-region weekly digest

The Friday cron (`worker/src/crons/fridayEmail.ts`) fires hourly Fri UTC and, for each
region whose anchor tz is now Fri 06:00 local, POSTs to that region's
`SENDER_DIGEST_TRIGGER_URL_<REGION>` secret. A missing secret dark-disables that region
(useful for staging one region first).

### ⚠️ Verify the trigger model in your dashboard BEFORE building all six

What the worker actually sends (`client.ts` `triggerWeeklyDigest` + `request`):

- **One parameterless call per region** — body is `{"tag":"<region>:<YYYY-MM-DD>"}`, with
  **no subscriber email**. The design assumes one call broadcasts to the whole
  `pitmaster_<region>` group (audience filter). *This assumption is unverified against
  sender.net's docs — confirm it before relying on it.*
- **The trigger URL must be on `api.sender.net`.** The client host-validates every request and
  throws `malformed` for any other host, and always attaches `Authorization: Bearer <token>`
  and `Content-Type: application/json`.

In the dashboard, create one "API Call Is Made" automation and check:

- **(a)** Is the generated trigger URL's host `api.sender.net`? (required by the worker)
- **(b)** Does hitting that URL **send to everyone in the audience filter**, or does it require a
  subscriber **email** in the body to enroll one contact? (sender.net automations are normally
  per-subscriber workflows.)

### Path A — API-triggered automations (only if (a) = api.sender.net AND (b) = broadcasts to audience)

Six automations, one per region:

1. **Start trigger:** "API Call Is Made".
2. **Audience filter:** subscriber is in group `pitmaster_<region>`.
3. **Content:** the weekly digest template.
4. Copy the trigger URL into the matching secret:

| Region | Secret name |
|---|---|
| northeast | `SENDER_DIGEST_TRIGGER_URL_NORTHEAST` |
| southeast | `SENDER_DIGEST_TRIGGER_URL_SOUTHEAST` |
| midwest | `SENDER_DIGEST_TRIGGER_URL_MIDWEST` |
| south_central | `SENDER_DIGEST_TRIGGER_URL_SOUTH_CENTRAL` |
| mountain | `SENDER_DIGEST_TRIGGER_URL_MOUNTAIN` |
| pacific | `SENDER_DIGEST_TRIGGER_URL_PACIFIC` |

### Path B — native scheduled campaigns (if (b) = per-subscriber, or the API-trigger broadcast isn't supported)

If a single API call can't broadcast to a group, the cron's model doesn't fit. Instead, skip
the automations and create **six recurring weekly campaigns** in the dashboard — one per
`pitmaster_<region>` group, each scheduled to the region's local Friday-morning send time.
Leave the `SENDER_DIGEST_TRIGGER_URL_*` secrets unset (every region dark-disables, so the cron
is a no-op) and sender.net owns scheduling. Trade-off: send times are set in the dashboard, not
driven by the worker's per-region tz logic, and there's no per-(region,send_date) idempotency
ledger — but it requires no code change. (Making the cron loop per-subscriber against a
per-subscriber trigger is the other option, but it's a code change and gives up the
"no per-subscriber loop" scaling win.)

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
