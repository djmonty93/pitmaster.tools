# Portfolio Email Architecture

This document describes the multi-site Sender.net architecture used by
pitmaster.tools and intended to scale to additional calculator sites
(powersizing.com, overlanding.tools, compost.tools, ...). The
architecture is portfolio-aware from day one: pitmaster.tools is just
the first tenant.

## Naming conventions

### Groups: `<site_prefix>_<scope>`

Group membership drives campaign audience filtering. Every subscriber
belongs to at least two groups:

- `<site>_all` — every subscriber for the site
- `<site>_<scope>` — a segment within the site (e.g. region)

For Best Smoke Days (pitmaster.tools):

| Group                       | Membership                                            |
| --------------------------- | ----------------------------------------------------- |
| `pitmaster_all`             | every BBQ subscriber                                  |
| `pitmaster_northeast`       | CT, MA, ME, NH, NJ, NY, PA, RI, VT                    |
| `pitmaster_southeast`       | AL, FL, GA, KY, MS, NC, SC, TN, VA, WV, DC, DE, MD    |
| `pitmaster_midwest`         | IA, IL, IN, KS, MI, MN, ND, NE, OH, SD, WI            |
| `pitmaster_south_central`   | AR, LA, MO, OK, TX                                    |
| `pitmaster_mountain`        | AZ, CO, ID, MT, NM, NV, UT, WY                        |
| `pitmaster_pacific`         | AK, CA, HI, OR, WA                                    |

Note on MO: Missouri sits in `south_central` rather than `midwest`
because Kansas City BBQ culture aligns more closely with TX/OK/AR than
with Iowa/Wisconsin/Minnesota. This is an intentional opinionated
choice.

### Subscriber fields: `<site_prefix>_<field>`

Custom field keys carry the same prefix to prevent collisions when
multiple sites share a Sender.net account.

| Field name           | Type   | Purpose                                          |
| -------------------- | ------ | ------------------------------------------------ |
| `bbq_zip`            | text   | 5-digit US zip                                   |
| `bbq_city`           | text   | Geocoder display name (e.g. "Atlanta, Georgia")  |
| `bbq_state`          | text   | 2-letter US state code                           |
| `bbq_region`         | text   | One of the six region slugs above                |
| `bbq_cut_pref`       | text   | Preferred BBQ cut (brisket-packer, etc.)         |
| `bbq_cooker_pref`    | text   | Preferred cooker (offset, pellet, ...)           |
| `bbq_timezone`       | text   | IANA timezone (e.g. "America/Chicago")           |
| `bbq_signup_date`    | date   | YYYY-MM-DD of first subscribe                    |

D1 columns stay unprefixed (`region`, `cut`, `cooker`, ...). The
Sender.net client adapter (`worker/src/lib/sender/tags.ts`) maps
between the two shapes.

## Adding a new site to the portfolio

1. Pick a `<site_prefix>` (one underscore-delimited word, e.g. `powersizing`).
2. Create the corresponding groups in the Sender dashboard:
   - `<site>_all`
   - One `<site>_<scope>` group per segment (region, calculator type, ...)
3. Create the per-site custom fields prefixed `<site>_*`.
4. Configure the per-site sending domain (see "Sending domains" below).
5. Set the per-site `SENDER_FROM_EMAIL` / `SENDER_FROM_NAME` (the cron
   builds + sends campaigns; an unset from-email dark-disables the digest).
6. Add a regions/groups module in the new site's worker that mirrors
   `worker/src/lib/regions/` and `worker/src/lib/sender/groups.ts`.
7. The Sender.net group-id KV cache key prefix is shared
   (`sender_group_id:<group_name>`) — no per-site collision because
   group names already carry the site prefix.

## Per-region campaign delivery

The Friday digest cron (`worker/src/crons/fridayEmail.ts`) fires
hourly Fri UTC across the anchor-timezone Friday-6am windows. For each
region whose anchor tz says it is now Fri 06:00 local, the cron
**builds the HTML digest itself** (the region's metros with Fri/Sat/Sun/Mon
smoke scores — see `worker/src/lib/digest/buildRegionDigest.ts` and
`worker/src/lib/render/digestEmail.ts`), then **creates and sends a
Sender.net campaign** targeting the `pitmaster_<region>` group by id:

1. `resolveGroupId(...)` → the `pitmaster_<region>` group id (KV-cached).
2. `client.createCampaign(...)` → `POST /v2/campaigns` with the HTML,
   subject, from-address, and `groups: [<region group id>]`.
3. `client.sendCampaign(...)` → `POST /v2/campaigns/<id>/send`.

One campaign send broadcasts to everyone in the group — there is no
per-subscriber loop (the portfolio scaling win). Because the group can't
be personalised per subscriber, every score uses a single default profile
(**pork butt on an offset**), disclosed in the email footer.

**Dark-disable / kill switch:** an unset `SENDER_FROM_EMAIL` skips the
whole digest (the "not configured yet" state) and writes one
`not-configured` warning event per (region, send_date).

> ⚠️ **Unverified API contract.** The exact Sender.net Campaigns API
> payload field names and endpoint paths were not confirmable against the
> live docs (they render client-side) and the Campaigns API is typically a
> paid-tier feature. The wire shape is centralized in
> `worker/src/lib/sender/client.ts` (`campaignCreateBody`) so confirming it
> against the live API is a one-file change. Verify the account tier, the
> authenticated sending domain, and the payload shape before enabling real
> sends — see `docs/sender-setup.md` §4.

| Region          | Anchor timezone        | UTC trigger (DST) | UTC trigger (standard time) |
| --------------- | ---------------------- | ----------------- | --------------------------- |
| northeast       | America/New_York       | 10:00             | 11:00                       |
| southeast       | America/New_York       | 10:00             | 11:00                       |
| midwest         | America/Chicago        | 11:00             | 12:00                       |
| south_central   | America/Chicago        | 11:00             | 12:00                       |
| mountain        | America/Denver         | 12:00             | 13:00                       |
| pacific         | America/Los_Angeles    | 13:00             | 14:00                       |

The cron is idempotent per (region, send_date) — a second tick on the
same Friday is a no-op via the `friday_campaign_log` UNIQUE constraint.

## Per-group unsubscribe

Unsubscribes are group-scoped, not account-scoped: clicking
unsubscribe in a BBQ email removes the subscriber from `pitmaster_all`
and every `pitmaster_<region>` group, but leaves any
`powersizing_*` / `overlanding_*` memberships intact.

The digest email footer carries the per-group unsubscribe link via
Sender's `{$unsubscribe}` merge tag (rendered in
`worker/src/lib/render/digestEmail.ts`); the in-app unsubscribe path uses
our `removeBbqGroups()` helper. Both must resolve to group-scoped removal,
not account-scoped — confirm the merge tag's behavior in the dashboard.

## Shared sender reputation

A single Sender.net account holding multiple sites shares sender
reputation across all sites. A spammy campaign on one site can ding
deliverability for sibling sites. Mitigations:

- **Optional, recommended at multi-site scale:** give each site its own
  sending subdomain (`mail.pitmaster.tools`, `mail.powersizing.com`, ...) so
  Sender signs DKIM per subdomain and one site's reputation can't drag down
  siblings. This is *not* required — a single site can authenticate and send
  from its apex (`pitmaster.tools`); the worker has no dependency on the
  sending domain either way (see `docs/sender-setup.md` §5).
- Campaign cadence per site is operator-controlled (one weekly digest
  per region, no transactional spam).
- Unsubscribe is one-click via the per-group footer.

## D1 schema patterns for portfolio scale

The `subscribers` table is shared across sites in a future world where
they consolidate, but for now each site has its own D1 instance. To
prepare:

- Columns are unprefixed at the D1 level. A future shared table would
  add a `site` column and namespace everything else by that.
- `region` is a foreign-key-ish column constrained by CHECK to the six
  values. A new site adopting different segments adds its own
  per-site CHECK column.
- `friday_campaign_log` is keyed on `(region, send_date)` — a shared
  table would extend to `(site, region, send_date)`.

## Cross-site analytics

Once two or more sites are live, useful queries the operator may want:

- "How many subscribers overlap between pitmaster_all and
  powersizing_all" — query Sender API for subscribers filtered by both groups.
- "Which region has the highest brisket preference rate" — query D1
  `SELECT region, COUNT(*) FROM subscribers WHERE cut = 'brisket-packer'
   GROUP BY region`.
- "How many subscribers got the Friday digest in mountain last week" —
  query Sender automation reports filtered by `pitmaster_mountain`.
