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

## 4. Per-region automations

Six automations, one per region. For each:

1. **Start trigger:** "API Call Is Made".
2. **Audience filter:** subscriber is in group `pitmaster_<region>`.
3. **Content:** the weekly digest template.
4. Copy the automation's trigger URL into the matching worker secret:

| Region | Secret name |
|---|---|
| northeast | `SENDER_DIGEST_TRIGGER_URL_NORTHEAST` |
| southeast | `SENDER_DIGEST_TRIGGER_URL_SOUTHEAST` |
| midwest | `SENDER_DIGEST_TRIGGER_URL_MIDWEST` |
| south_central | `SENDER_DIGEST_TRIGGER_URL_SOUTH_CENTRAL` |
| mountain | `SENDER_DIGEST_TRIGGER_URL_MOUNTAIN` |
| pacific | `SENDER_DIGEST_TRIGGER_URL_PACIFIC` |

A missing secret dark-disables that region in the Friday cron — useful when staging onboarding for one region first.

## 5. Sending domain

`mail.pitmaster.tools` via CNAME + SPF/DKIM/DMARC on Cloudflare. The optional `SENDER_FROM_EMAIL`, `SENDER_FROM_NAME`, `SENDER_REPLY_TO` secrets are reserved for the day a handler wires `POST /v2/message/send` (none does today).

## 6. Webhooks (optional)

Sender's webhooks require the Standard plan or above. If/when wired, the worker handler verifies HMAC-SHA256 of the raw body against the per-webhook signing secret. Topics of interest: subscriber unsubscribed, bounced, reported spam.

## 7. Rate limits

Sender returns `429` with a `Retry-After: <seconds>` header on rate-limit. The worker treats 429 as retryable and the retry queue's exponential backoff handles it. Free-tier limits are not publicly published — read `X-RateLimit-Remaining` on responses to monitor headroom.
