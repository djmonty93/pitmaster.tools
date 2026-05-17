-- 0001_init.sql — Best Smoke Days complete schema (greenfield squash).
--
-- Tables:
--   subscribers          — Sender.net-synced subscribers, used by Friday cron.
--   metros               — 50 top metros for SEO pages + regional routing.
--   events               — append-only audit log for /api/status and Sentry
--                          enrichment; capped by retention policy.
--   sender_retry         — durable retry queue when Sender.net returns 5xx.
--   articles             — weekly article archive (F17).
--   friday_campaign_log  — region-scoped Friday cron idempotency.

-- ---------------------------------------------------------------------------
-- subscribers
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS subscribers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT    NOT NULL UNIQUE,
  zip             TEXT    NOT NULL,
  -- cut / cooker mirror the Cut / Cooker enums in packages/shared/src/types.ts.
  -- Keep these in lockstep when adding new cuts or cookers.
  cut             TEXT    CHECK (cut IS NULL OR cut IN (
                            'brisket-flat', 'brisket-packer', 'pork-butt',
                            'spare-ribs', 'baby-back-ribs', 'pork-loin',
                            'whole-chicken', 'spatchcock-chicken', 'chicken-thighs',
                            'whole-turkey', 'turkey-breast', 'fish', 'lamb-shoulder'
                          )),
  cooker          TEXT    CHECK (cooker IS NULL OR cooker IN (
                            'offset', 'pellet', 'kamado', 'kettle', 'electric'
                          )),
  timezone        TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  unsubscribed_at INTEGER,
  region          TEXT    CHECK (region IS NULL OR region IN (
                            'northeast', 'southeast', 'midwest',
                            'south_central', 'mountain', 'pacific'
                          ))
);

CREATE INDEX IF NOT EXISTS idx_subscribers_timezone
  ON subscribers (timezone)
  WHERE unsubscribed_at IS NULL;

-- Note: subscribers.email already has a UNIQUE constraint, which creates
-- an implicit covering index. A second explicit index would be redundant.

-- Region is the dominant filter for Friday cron and group-membership
-- queries. Partial index so the planner reaches it for active rows.
CREATE INDEX IF NOT EXISTS idx_subscribers_region
  ON subscribers (region)
  WHERE unsubscribed_at IS NULL;

-- ---------------------------------------------------------------------------
-- metros
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS metros (
  slug          TEXT    NOT NULL PRIMARY KEY,
  name          TEXT    NOT NULL,
  state         TEXT    NOT NULL,
  zip           TEXT    NOT NULL,
  latitude      REAL    NOT NULL,
  longitude     REAL    NOT NULL,
  timezone      TEXT    NOT NULL,
  population    INTEGER NOT NULL,
  description   TEXT
);

CREATE INDEX IF NOT EXISTS idx_metros_state ON metros (state);

-- Seed: 50 top US BBQ-relevant metros.
-- Latitude/longitude/zip values were sourced from the city's primary
-- post office; timezone is the IANA name. Population is the metro-area
-- estimate, used only for the editorial ordering of SEO pages.
INSERT OR IGNORE INTO metros (slug, name, state, zip, latitude, longitude, timezone, population) VALUES
  ('new-york-ny',         'New York',         'NY', '10001', 40.7506, -73.9971, 'America/New_York',    19867000),
  ('los-angeles-ca',      'Los Angeles',      'CA', '90001', 33.9731, -118.2479, 'America/Los_Angeles', 13201000),
  ('chicago-il',          'Chicago',          'IL', '60601', 41.8857, -87.6228, 'America/Chicago',      9509000),
  ('dallas-fort-worth-tx','Dallas–Fort Worth','TX', '75201', 32.7831, -96.8067, 'America/Chicago',      7637000),
  ('houston-tx',          'Houston',          'TX', '77001', 29.7621, -95.3831, 'America/Chicago',      7122000),
  ('washington-dc',       'Washington',       'DC', '20001', 38.9047, -77.0163, 'America/New_York',     6385000),
  ('miami-fl',            'Miami',            'FL', '33101', 25.7752, -80.2086, 'America/New_York',     6166000),
  ('philadelphia-pa',     'Philadelphia',     'PA', '19102', 39.9523, -75.1638, 'America/New_York',     6228000),
  ('atlanta-ga',          'Atlanta',          'GA', '30303', 33.7525, -84.3888, 'America/New_York',     6089000),
  ('boston-ma',           'Boston',           'MA', '02108', 42.3581, -71.0636, 'America/New_York',     4895000),
  ('phoenix-az',          'Phoenix',          'AZ', '85001', 33.4502, -112.0759, 'America/Phoenix',     4946000),
  ('san-francisco-ca',    'San Francisco',    'CA', '94102', 37.7791, -122.4194, 'America/Los_Angeles', 4750000),
  ('riverside-ca',        'Riverside',        'CA', '92501', 33.9806, -117.3755, 'America/Los_Angeles', 4651000),
  ('detroit-mi',          'Detroit',          'MI', '48226', 42.3314, -83.0457, 'America/Detroit',      4392000),
  ('seattle-wa',          'Seattle',          'WA', '98101', 47.6101, -122.3343, 'America/Los_Angeles', 4018000),
  ('minneapolis-mn',      'Minneapolis',      'MN', '55401', 44.9854, -93.2738, 'America/Chicago',      3690000),
  ('san-diego-ca',        'San Diego',        'CA', '92101', 32.7174, -117.1628, 'America/Los_Angeles', 3338000),
  ('tampa-fl',            'Tampa',            'FL', '33602', 27.9477, -82.4584, 'America/New_York',     3194000),
  ('denver-co',           'Denver',           'CO', '80202', 39.7506, -105.0000, 'America/Denver',      2964000),
  ('baltimore-md',        'Baltimore',        'MD', '21202', 39.2904, -76.6122, 'America/New_York',     2848000),
  ('st-louis-mo',         'St. Louis',        'MO', '63101', 38.6273, -90.1979, 'America/Chicago',      2820000),
  ('charlotte-nc',        'Charlotte',        'NC', '28202', 35.2271, -80.8431, 'America/New_York',     2660000),
  ('orlando-fl',          'Orlando',          'FL', '32801', 28.5384, -81.3789, 'America/New_York',     2674000),
  ('san-antonio-tx',      'San Antonio',      'TX', '78205', 29.4241, -98.4936, 'America/Chicago',      2550000),
  ('portland-or',         'Portland',         'OR', '97204', 45.5152, -122.6784, 'America/Los_Angeles', 2502000),
  ('sacramento-ca',       'Sacramento',       'CA', '95814', 38.5816, -121.4944, 'America/Los_Angeles', 2363000),
  ('pittsburgh-pa',       'Pittsburgh',       'PA', '15222', 40.4406, -79.9959, 'America/New_York',     2370000),
  ('las-vegas-nv',        'Las Vegas',        'NV', '89101', 36.1716, -115.1391, 'America/Los_Angeles', 2266000),
  ('cincinnati-oh',       'Cincinnati',       'OH', '45202', 39.1031, -84.5120, 'America/New_York',     2256000),
  ('kansas-city-mo',      'Kansas City',      'MO', '64108', 39.0997, -94.5786, 'America/Chicago',      2192000),
  ('columbus-oh',         'Columbus',         'OH', '43215', 39.9612, -82.9988, 'America/New_York',     2122000),
  ('indianapolis-in',     'Indianapolis',     'IN', '46204', 39.7684, -86.1581, 'America/Indianapolis', 2074000),
  ('cleveland-oh',        'Cleveland',        'OH', '44113', 41.4993, -81.6944, 'America/New_York',     2058000),
  ('austin-tx',           'Austin',           'TX', '78701', 30.2672, -97.7431, 'America/Chicago',      2295000),
  ('nashville-tn',        'Nashville',        'TN', '37203', 36.1627, -86.7816, 'America/Chicago',      2027000),
  ('virginia-beach-va',   'Virginia Beach',   'VA', '23451', 36.8529, -75.9780, 'America/New_York',     1799000),
  ('providence-ri',       'Providence',       'RI', '02903', 41.8240, -71.4128, 'America/New_York',     1676000),
  ('milwaukee-wi',        'Milwaukee',        'WI', '53202', 43.0389, -87.9065, 'America/Chicago',      1573000),
  ('jacksonville-fl',     'Jacksonville',     'FL', '32202', 30.3322, -81.6557, 'America/New_York',     1605000),
  ('oklahoma-city-ok',    'Oklahoma City',    'OK', '73102', 35.4676, -97.5164, 'America/Chicago',      1450000),
  ('raleigh-nc',          'Raleigh',          'NC', '27601', 35.7796, -78.6382, 'America/New_York',     1413000),
  ('memphis-tn',          'Memphis',          'TN', '38103', 35.1495, -90.0490, 'America/Chicago',      1335000),
  ('richmond-va',         'Richmond',         'VA', '23219', 37.5407, -77.4360, 'America/New_York',     1310000),
  ('louisville-ky',       'Louisville',       'KY', '40202', 38.2527, -85.7585, 'America/New_York',     1284000),
  ('new-orleans-la',      'New Orleans',      'LA', '70112', 29.9511, -90.0715, 'America/Chicago',      1271000),
  ('hartford-ct',         'Hartford',         'CT', '06103', 41.7637, -72.6851, 'America/New_York',     1213000),
  ('salt-lake-city-ut',   'Salt Lake City',   'UT', '84111', 40.7608, -111.8910, 'America/Denver',      1257000),
  ('birmingham-al',       'Birmingham',       'AL', '35203', 33.5186, -86.8104, 'America/Chicago',      1115000),
  ('buffalo-ny',          'Buffalo',          'NY', '14202', 42.8864, -78.8784, 'America/New_York',     1130000),
  ('tulsa-ok',            'Tulsa',            'OK', '74103', 36.1540, -95.9928, 'America/Chicago',      1015000);

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL CHECK (kind IN ('forecast', 'subscribe', 'unsubscribe', 'send', 'error')),
  payload     TEXT,             -- JSON-encoded event body; redacted upstream
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_created_at ON events (created_at);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events (kind);

-- ---------------------------------------------------------------------------
-- sender_retry
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sender_retry (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  request_kind    TEXT    NOT NULL CHECK (request_kind IN ('subscribe', 'unsubscribe', 'digest_trigger')),
  request_payload TEXT    NOT NULL, -- JSON body to replay on retry
  idempotency_key TEXT    NOT NULL UNIQUE,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_status     INTEGER,
  last_error      TEXT,
  next_attempt_at INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sender_retry_next
  ON sender_retry (next_attempt_at);

-- ---------------------------------------------------------------------------
-- articles
-- ---------------------------------------------------------------------------

-- Weekly article archive (F17).
-- The weekly cron writes one row per week per article kind; the
-- /articles/:slug worker route reads them. Keeping articles in D1 (not
-- as committed HTML) avoids cron-driven git commits while keeping the
-- response indexable — the worker emits a `<!doctype html>` shell.

CREATE TABLE IF NOT EXISTS articles (
  slug         TEXT    NOT NULL PRIMARY KEY,
  kind         TEXT    NOT NULL CHECK (kind IN ('weekly-summary', 'metro-roundup', 'seasonal')),
  -- Nullable FK to metros.slug. ON DELETE SET NULL matches the nullable
  -- column intent: dropping a metro should null the archive entry, not
  -- error or cascade-delete published articles.
  metro_slug   TEXT REFERENCES metros(slug) ON DELETE SET NULL,
  title        TEXT    NOT NULL,
  body_html    TEXT    NOT NULL,
  body_text    TEXT    NOT NULL,               -- plaintext for length validation / Friday email
  hero_band    TEXT    NOT NULL CHECK (hero_band IN ('red', 'yellow', 'green', 'ideal')),
  published_at INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Note: articles.slug is the PRIMARY KEY, so an explicit idx_articles_slug
-- would just duplicate the implicit PK index. Keep the two non-PK indexes only.
CREATE INDEX IF NOT EXISTS idx_articles_published_at ON articles (published_at);
CREATE INDEX IF NOT EXISTS idx_articles_metro_slug
  ON articles (metro_slug)
  WHERE metro_slug IS NOT NULL;

-- ---------------------------------------------------------------------------
-- friday_campaign_log
-- ---------------------------------------------------------------------------

-- Region-scoped Friday cron idempotency.
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
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  region          TEXT    NOT NULL CHECK (region IN (
                    'northeast', 'southeast', 'midwest',
                    'south_central', 'mountain', 'pacific'
                  )),
  send_date       TEXT    NOT NULL,  -- YYYY-MM-DD in the region's anchor tz
  status          TEXT    NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempted_at    INTEGER NOT NULL,
  next_attempt_at INTEGER,          -- when set + status='failed', cron defers re-attempts until this epoch ms (used to honor Sender's Retry-After header)
  UNIQUE (region, send_date)
);

CREATE INDEX IF NOT EXISTS idx_friday_campaign_log_send_date
  ON friday_campaign_log (send_date);
