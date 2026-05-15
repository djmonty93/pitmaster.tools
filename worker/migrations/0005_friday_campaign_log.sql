-- 0005_friday_campaign_log.sql — region-scoped Friday cron idempotency.
--
-- Replaces the per-subscriber send log used in v1 of the Friday cron.
-- One row per (region, send_date) — the cron iterates regions instead
-- of subscribers, so the idempotency key is keyed on the region the
-- campaign was scheduled for, not on any individual subscriber.
--
-- Status state machine:
--   sending → sent    (trigger succeeded)
--   sending → failed  (trigger threw non-retryable error; terminal)
--   sending → queued  (trigger threw retryable error; re-claimable)
--   queued  → sending (cron re-claimed on a subsequent invocation)
--
-- The cron NEVER goes straight to 'queued' — the INSERT lands at
-- 'sending' so the row itself acts as the claim lock. ON CONFLICT only
-- transitions the row when the existing status is 'queued' (waiting for
-- retry) or 'sending' with a stale attempted_at (caller crashed
-- mid-trigger). attempted_at on each transition surfaces last-touch
-- timing to /api/status.

CREATE TABLE IF NOT EXISTS friday_campaign_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  region       TEXT    NOT NULL CHECK (region IN (
                  'northeast', 'southeast', 'midwest',
                  'south_central', 'mountain', 'pacific'
                )),
  send_date    TEXT    NOT NULL,  -- YYYY-MM-DD in the region's anchor tz
  status       TEXT    NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempted_at INTEGER NOT NULL,
  UNIQUE (region, send_date)
);

CREATE INDEX IF NOT EXISTS idx_friday_campaign_log_send_date
  ON friday_campaign_log (send_date);
