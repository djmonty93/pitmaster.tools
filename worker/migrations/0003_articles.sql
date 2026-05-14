-- 0003_articles.sql — weekly article archive (F17).
--
-- The Step 13 cron writes one row per week per article kind; the
-- /articles/:slug worker route reads them. Keeping articles in D1 (not
-- as committed HTML) avoids cron-driven git commits while keeping the
-- response indexable — the worker emits a `<!doctype html>` shell.

CREATE TABLE IF NOT EXISTS articles (
  slug         TEXT    PRIMARY KEY,
  kind         TEXT    NOT NULL,            -- 'weekly-summary' | 'metro-roundup' | …
  metro_slug   TEXT,                        -- nullable; FK to metros.slug when set
  title        TEXT    NOT NULL,
  body_html    TEXT    NOT NULL,
  body_text    TEXT    NOT NULL,            -- plaintext for length validation / Friday email
  hero_band    TEXT    NOT NULL,            -- 'red'|'yellow'|'green'|'ideal'
  published_at INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_articles_slug ON articles (slug);
CREATE INDEX IF NOT EXISTS idx_articles_published_at ON articles (published_at);
CREATE INDEX IF NOT EXISTS idx_articles_metro_slug
  ON articles (metro_slug)
  WHERE metro_slug IS NOT NULL;
