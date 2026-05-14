-- 0001_init.sql — initial Best Smoke Days schema.
--
-- Tables:
--   subscribers       — MailerLite-synced subscribers, used by F14 cron.
--   metros            — 50 top metros for F16 SEO pages + F14 routing.
--   events            — append-only audit log for /api/status and Sentry
--                       enrichment; capped by retention policy.
--   mailerlite_retry  — durable retry queue when MailerLite returns 5xx.

CREATE TABLE IF NOT EXISTS subscribers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT    NOT NULL UNIQUE,
  zip             TEXT    NOT NULL,
  cut             TEXT,
  cooker          TEXT,
  timezone        TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  unsubscribed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_subscribers_timezone
  ON subscribers (timezone)
  WHERE unsubscribed_at IS NULL;

-- Note: subscribers.email already has a UNIQUE constraint, which creates
-- an implicit covering index. A second explicit index would be redundant.

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

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL CHECK (kind IN ('forecast', 'subscribe', 'unsubscribe', 'send', 'error')),
  payload     TEXT,             -- JSON-encoded event body; redacted upstream
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_created_at ON events (created_at);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events (kind);

CREATE TABLE IF NOT EXISTS mailerlite_retry (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  request_kind    TEXT    NOT NULL CHECK (request_kind IN ('subscribe', 'unsubscribe', 'send')),
  request_payload TEXT    NOT NULL, -- JSON body to replay on retry
  idempotency_key TEXT    NOT NULL UNIQUE,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_status     INTEGER,
  last_error      TEXT,
  next_attempt_at INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mailerlite_retry_next
  ON mailerlite_retry (next_attempt_at);
