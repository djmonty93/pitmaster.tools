-- 0003_articles.sql — weekly article archive (F17).
--
-- The Step 13 cron writes one row per week per article kind; the
-- /articles/:slug worker route reads them. Keeping articles in D1 (not
-- as committed HTML) avoids cron-driven git commits while keeping the
-- response indexable — the worker emits a `<!doctype html>` shell.

CREATE TABLE IF NOT EXISTS articles (
  slug         TEXT    NOT NULL PRIMARY KEY,
  kind         TEXT    NOT NULL CHECK (kind IN ('weekly-summary', 'metro-roundup', 'seasonal')),
  metro_slug   TEXT REFERENCES metros(slug),   -- nullable; FK to metros.slug when set
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
