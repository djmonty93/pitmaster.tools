-- 0004_add_region.sql — portfolio-aware regional segmentation.
--
-- Adds `region` to subscribers. Six values + NULL match the regions
-- enum in worker/src/lib/regions/index.ts. NULL is allowed only as a
-- transitional state (column added, subscribe handler not yet
-- rewritten); production writes always populate region.
--
-- D1 column stays unprefixed; the `bbq_*` prefix lives only on the
-- MailerLite side. See docs/portfolio-email-architecture.md.
--
-- !!! OPERATOR NOTE — non-empty subscribers table !!!
-- This SQL only backfills the D1 `region` column; it does NOT add the
-- existing MailerLite subscriber records to `pitmaster_all` or
-- `pitmaster_<region>`. If you are applying this migration to a
-- database that already has subscribers, run the post-migration
-- group backfill described in docs/mailerlite-setup.md
-- ("Backfilling existing subscribers into the regional groups")
-- BEFORE the Friday cron is enabled, or those subscribers will be
-- excluded from the weekly digest. Production was empty at PR-#44
-- merge time so this was a one-line no-op in practice; the note
-- exists so a future deploy to a populated environment doesn't lose
-- subscribers from the audience.
--
-- !!! OPERATOR NOTE — zips not in metros table !!!
-- The backfill below resolves region via `metros.zip` JOIN. Subscribers
-- whose zip is NOT in the seeded metros set (anything outside the ~25
-- anchor zips) will end up with region=NULL. The Friday cron iterates
-- regions and queries `WHERE region = ?` — a NULL-region row gets
-- pitmaster_all only and NO regional group, so they miss the weekly
-- digest until they happen to resubscribe (which re-runs the geocoder
-- and resolves region from open-meteo). For a populated migration,
-- verify with:
--   SELECT COUNT(*) FROM subscribers WHERE region IS NULL AND unsubscribed_at IS NULL;
-- If the count is > 0, run the "Resolve NULL-region subscribers"
-- runbook in docs/mailerlite-setup.md BEFORE enabling the cron.

ALTER TABLE subscribers
  ADD COLUMN region TEXT
  CHECK (region IS NULL OR region IN (
    'northeast', 'southeast', 'midwest', 'south_central', 'mountain', 'pacific'
  ));

-- Best-effort backfill for subscribers whose zip happens to match a
-- seeded metro row. Anything else stays NULL until the subscribe
-- handler rewrites the row. Production is empty/tiny at the time this
-- migration lands so a one-shot UPDATE is fine; if subscriber volume
-- grows before this is applied, batch-paginate via scripts/.
UPDATE subscribers
SET region = (
  SELECT CASE m.state
    WHEN 'CT' THEN 'northeast' WHEN 'MA' THEN 'northeast' WHEN 'ME' THEN 'northeast'
    WHEN 'NH' THEN 'northeast' WHEN 'NJ' THEN 'northeast' WHEN 'NY' THEN 'northeast'
    WHEN 'PA' THEN 'northeast' WHEN 'RI' THEN 'northeast' WHEN 'VT' THEN 'northeast'
    WHEN 'AL' THEN 'southeast' WHEN 'DC' THEN 'southeast' WHEN 'DE' THEN 'southeast'
    WHEN 'FL' THEN 'southeast' WHEN 'GA' THEN 'southeast' WHEN 'KY' THEN 'southeast'
    WHEN 'MD' THEN 'southeast' WHEN 'MS' THEN 'southeast' WHEN 'NC' THEN 'southeast'
    WHEN 'SC' THEN 'southeast' WHEN 'TN' THEN 'southeast' WHEN 'VA' THEN 'southeast'
    WHEN 'WV' THEN 'southeast'
    WHEN 'IA' THEN 'midwest' WHEN 'IL' THEN 'midwest' WHEN 'IN' THEN 'midwest'
    WHEN 'KS' THEN 'midwest' WHEN 'MI' THEN 'midwest' WHEN 'MN' THEN 'midwest'
    WHEN 'ND' THEN 'midwest' WHEN 'NE' THEN 'midwest' WHEN 'OH' THEN 'midwest'
    WHEN 'SD' THEN 'midwest' WHEN 'WI' THEN 'midwest'
    -- MO sits in south_central on purpose: KC BBQ aligns with TX/OK/AR.
    WHEN 'AR' THEN 'south_central' WHEN 'LA' THEN 'south_central'
    WHEN 'MO' THEN 'south_central' WHEN 'OK' THEN 'south_central'
    WHEN 'TX' THEN 'south_central'
    WHEN 'AZ' THEN 'mountain' WHEN 'CO' THEN 'mountain' WHEN 'ID' THEN 'mountain'
    WHEN 'MT' THEN 'mountain' WHEN 'NM' THEN 'mountain' WHEN 'NV' THEN 'mountain'
    WHEN 'UT' THEN 'mountain' WHEN 'WY' THEN 'mountain'
    WHEN 'AK' THEN 'pacific' WHEN 'CA' THEN 'pacific' WHEN 'HI' THEN 'pacific'
    WHEN 'OR' THEN 'pacific' WHEN 'WA' THEN 'pacific'
    ELSE NULL
  END
  FROM metros m WHERE m.zip = subscribers.zip
)
WHERE region IS NULL;

-- Region is the dominant filter for Friday cron and group-membership
-- queries. Partial index so the planner reaches it for active rows.
CREATE INDEX IF NOT EXISTS idx_subscribers_region
  ON subscribers (region)
  WHERE unsubscribed_at IS NULL;
