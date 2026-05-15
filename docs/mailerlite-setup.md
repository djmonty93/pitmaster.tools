# MailerLite Operator Setup

Step-by-step setup for the portfolio-aware MailerLite integration.
Pair with `docs/portfolio-email-architecture.md` for the conceptual
overview.

## 1. Create the groups

In the MailerLite dashboard, create these seven groups under the
shared portfolio account:

- `pitmaster_all`
- `pitmaster_northeast`
- `pitmaster_southeast`
- `pitmaster_midwest`
- `pitmaster_south_central`
- `pitmaster_mountain`
- `pitmaster_pacific`

Group IDs are auto-assigned by MailerLite. The worker resolves them by
name and caches the lookup in KV — no manual ID config required.

## 2. Create the custom fields

Add these custom fields to the account:

| Field key            | Type   |
| -------------------- | ------ |
| `bbq_zip`            | Text   |
| `bbq_city`           | Text   |
| `bbq_state`          | Text   |
| `bbq_region`         | Text   |
| `bbq_cut_pref`       | Text   |
| `bbq_cooker_pref`    | Text   |
| `bbq_timezone`       | Text   |
| `bbq_signup_date`    | Date   |

These are populated by the subscribe handler at `/api/subscribe` and
read by the regional automation templates.

## 3. Create the six regional automations

For each region, create an automation in the dashboard:

- Trigger: **API** (manual trigger via `/api/automations/:id/run`)
- Audience: **Subscribers in group `pitmaster_<region>`**
- Email template: weekly digest body using `{$if:bbq_cut_pref="..."}`
  merge tags to vary content by stored preference
- From: `pete@mail.pitmaster.tools` (configurable via
  `MAILERLITE_FROM_EMAIL`)
- Reply-to: `pete@mail.pitmaster.tools` (configurable via
  `MAILERLITE_REPLY_TO`)

After creating each automation, copy the automation id into the
corresponding Wrangler secret:

```bash
wrangler secret put MAILERLITE_AUTOMATION_NORTHEAST_ID
wrangler secret put MAILERLITE_AUTOMATION_SOUTHEAST_ID
wrangler secret put MAILERLITE_AUTOMATION_MIDWEST_ID
wrangler secret put MAILERLITE_AUTOMATION_SOUTH_CENTRAL_ID
wrangler secret put MAILERLITE_AUTOMATION_MOUNTAIN_ID
wrangler secret put MAILERLITE_AUTOMATION_PACIFIC_ID
```

A missing id makes that region dark — the cron skips it with
`status=skipped, reason=no-automation-id`.

## 4. Configure per-group unsubscribe

The default MailerLite footer unsubscribes account-wide. For
portfolio-aware unsubscribe (BBQ unsubscribe leaves
`powersizing_*` / `overlanding_*` groups intact):

1. Edit each regional automation's email template.
2. Replace the default `{$unsubscribe}` merge tag with the per-group
   unsubscribe link:
   `<a href="{$unsubscribe_from_group:pitmaster_all}">Unsubscribe from
   Best Smoke Days</a>`
3. Save the template.

The webhook handler (when implemented in a future step) reads the
group-scoped unsubscribe event from MailerLite's webhook payload and
calls `removeBbqGroups()` so D1 stays in sync.

## 5. Set up the sending domain

See README "DNS setup" for the Cloudflare CNAME + SPF/DKIM/DMARC
records `mail.pitmaster.tools` needs. After DNS is verified in the
MailerLite dashboard, set the from-address envs:

```bash
wrangler secret put MAILERLITE_FROM_EMAIL    # e.g. pete@mail.pitmaster.tools
wrangler secret put MAILERLITE_FROM_NAME     # e.g. Pitmaster Tools
wrangler secret put MAILERLITE_REPLY_TO      # e.g. pete@mail.pitmaster.tools
```

## 6. Backfilling existing subscribers into the regional groups

If the migration `0004_add_region.sql` is applied to a database that
already has subscriber rows, those subscribers' MailerLite records do
NOT automatically pick up the new `pitmaster_*` group memberships —
the SQL migration only backfills the D1 `region` column. Without this
step, existing subscribers are excluded from the Friday digest.

Production was empty when PR #44 merged, so this is defensive
documentation rather than an immediate task. Run this only if you are
applying to a populated environment.

### Step 0 — Resolve NULL-region subscribers

The migration's SQL backfill JOINs against `metros.zip`. Subscribers
whose zip is NOT in the seeded metros set end up with `region = NULL`.
The Friday cron iterates regions; a NULL-region row gets
`pitmaster_all` only and never enters a regional group, so they miss
the weekly digest until they resubscribe (re-runs the geocoder).

Before doing the group backfill, resolve every NULL-region row:

```bash
# Count NULL-region active rows. If 0, skip this section.
wrangler d1 execute SMOKE_DB --command \
  "SELECT COUNT(*) FROM subscribers WHERE region IS NULL AND unsubscribed_at IS NULL;"

# Dump the (email, zip) pairs that need resolution.
wrangler d1 execute SMOKE_DB --command \
  "SELECT email, zip FROM subscribers WHERE region IS NULL AND unsubscribed_at IS NULL;"
```

For each row, derive the region by calling open-meteo (the same path
the subscribe handler uses):

```bash
# Geocode the zip (replace 12345 with the actual zip).
curl -s "https://geocoding-api.open-meteo.com/v1/search?postal_code=12345&country=US&count=1" \
  | jq -r '.results[0].admin1'
```

Map the admin1 (state name) → 2-letter code → region using the table
in `worker/src/lib/regions/index.ts` (`stateToRegion()`). Then update:

```bash
wrangler d1 execute SMOKE_DB --command \
  "UPDATE subscribers SET region = 'southeast' WHERE email = 'user@example.com' AND region IS NULL;"
```

Verify the count drops to zero before proceeding to "Manual backfill"
below. If you skip this step the Friday cron will run, succeed for
every region, and silently exclude these subscribers from the audience.

### Manual backfill (operator)

For each row in `subscribers`:

1. Read `email` and `region` from D1
   (`wrangler d1 execute SMOKE_DB --command "SELECT id, email, region FROM subscribers WHERE region IS NOT NULL"`).
2. Look up the MailerLite subscriber id with
   `GET https://connect.mailerlite.com/api/subscribers/<email>`.
3. POST the subscriber to `pitmaster_all`:
   `POST /api/subscribers/<id>/groups/<pitmaster_all_id>`
4. POST the subscriber to their regional group:
   `POST /api/subscribers/<id>/groups/<pitmaster_<region>_id>`

The group ids resolve via `GET /api/groups`. Group memberships are
idempotent on the MailerLite side, so re-running this loop is safe.

### Why this isn't automated

The migration is pure SQL and can't reach out to the MailerLite API.
A dedicated worker route (e.g. `POST /api/admin/backfill-groups`)
would let an operator trigger the loop in production, but the
empty-table starting state didn't justify the additional surface area
for v1. If portfolio scale grows past hand-running curl loops, the
admin route is the next logical step — wire it up before the next
populated-DB migration.

## 7. Verify

After all of the above:

```bash
# Trigger a test send (dry-run during off-Friday hours just exercises
# the cron path without sending — the local-tz gate filters every region).
wrangler dev --test-scheduled

# Then send a real test to a single test subscriber by:
#   - Adding yourself to pitmaster_all + pitmaster_<your_region>
#   - Calling POST /api/automations/<id>/run via curl with the same
#     idempotency key the cron uses
```

`/api/status` (Step 17, future) will surface the `friday_campaign_log`
table and last-send timestamps per region.
