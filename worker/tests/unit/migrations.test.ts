import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../helpers/d1';

interface Env {
  SMOKE_DB: D1Database;
}

const DB = (env as unknown as Env).SMOKE_DB;

beforeAll(async () => {
  await applyMigrations(DB);
});

describe('D1 migrations — schema', () => {
  it('creates all expected tables', async () => {
    const res = await DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`
    ).all<{ name: string }>();
    const tables = res.results.map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'articles',
        'events',
        'friday_campaign_log',
        'sender_retry',
        'metros',
        'subscribers',
      ])
    );
  });

  it('creates the required indexes', async () => {
    const res = await DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    ).all<{ name: string }>();
    const idx = res.results.map((r) => r.name);
    // Full expected set — assert each so a dropped index is caught here
    // instead of silently regressing a query path.
    expect(idx).toEqual(
      expect.arrayContaining([
        'idx_subscribers_timezone',
        'idx_subscribers_region',
        'idx_metros_state',
        'idx_events_created_at',
        'idx_events_kind',
        'idx_sender_retry_next',
        'idx_articles_published_at',
        'idx_articles_metro_slug',
        'idx_friday_campaign_log_send_date',
      ])
    );
    // PRIMARY KEY / UNIQUE columns get implicit indexes — asserting an
    // explicit `idx_articles_slug` or `idx_subscribers_email` would
    // re-introduce duplicates.
    expect(idx).not.toContain('idx_articles_slug');
    expect(idx).not.toContain('idx_subscribers_email');
  });

  it('subscribers email is UNIQUE', async () => {
    const now = Date.now();
    await DB.prepare(
      `INSERT INTO subscribers (email, zip, timezone, created_at) VALUES (?, ?, ?, ?)`
    )
      .bind('a@example.com', '20001', 'America/New_York', now)
      .run();
    await expect(
      DB.prepare(
        `INSERT INTO subscribers (email, zip, timezone, created_at) VALUES (?, ?, ?, ?)`
      )
        .bind('a@example.com', '94102', 'America/Los_Angeles', now)
        .run()
    ).rejects.toThrow();
  });

  it('metros are seeded with 50 rows', async () => {
    const res = await DB.prepare('SELECT COUNT(*) AS c FROM metros').first<{ c: number }>();
    expect(res?.c).toBe(50);
  });

  it('every seeded metro has a valid timezone and US zip', async () => {
    const res = await DB.prepare(
      `SELECT slug, timezone, zip FROM metros WHERE timezone IS NULL OR timezone NOT LIKE 'America/%' OR zip NOT GLOB '[0-9][0-9][0-9][0-9][0-9]'`
    ).all<{ slug: string }>();
    expect(res.results).toEqual([]);
  });

  it('seeded metro slugs are url-safe and unique', async () => {
    const res = await DB.prepare('SELECT slug FROM metros').all<{ slug: string }>();
    const slugs = res.results.map((r) => r.slug);
    // 50 unique slugs, each lowercase a-z0-9 with `-` as the only separator.
    expect(new Set(slugs).size).toBe(50);
    const bad = slugs.filter((s) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s));
    expect(bad).toEqual([]);
  });

  it('articles table accepts and round-trips a row', async () => {
    const now = Date.now();
    await DB.prepare(
      `INSERT INTO articles (slug, kind, title, body_html, body_text, hero_band, published_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        '2026-w20-summary',
        'weekly-summary',
        'Best Smoke Days, Week 20',
        '<p>It looks good.</p>',
        'It looks good.',
        'green',
        now,
        now
      )
      .run();
    const row = await DB.prepare(
      `SELECT slug, kind, hero_band FROM articles WHERE slug = ?`
    )
      .bind('2026-w20-summary')
      .first<{ slug: string; kind: string; hero_band: string }>();
    expect(row?.hero_band).toBe('green');
  });

  it('sender_retry idempotency_key is UNIQUE', async () => {
    const now = Date.now();
    await DB.prepare(
      `INSERT INTO sender_retry (request_kind, request_payload, idempotency_key, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind('subscribe', '{}', 'idem-1', now, now)
      .run();
    await expect(
      DB.prepare(
        `INSERT INTO sender_retry (request_kind, request_payload, idempotency_key, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind('subscribe', '{}', 'idem-1', now, now)
        .run()
    ).rejects.toThrow();
  });

  it('sender_retry rejects unknown request_kind values', async () => {
    const now = Date.now();
    await expect(
      DB.prepare(
        `INSERT INTO sender_retry (request_kind, request_payload, idempotency_key, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind('bogus', '{}', 'idem-bogus', now, now)
        .run()
    ).rejects.toThrow();
  });

  it('events rejects unknown kind values', async () => {
    await expect(
      DB.prepare(`INSERT INTO events (kind, payload, created_at) VALUES (?, ?, ?)`)
        .bind('not-a-kind', '{}', Date.now())
        .run()
    ).rejects.toThrow();
  });

  it('subscribers rejects unknown cut or cooker values', async () => {
    const now = Date.now();
    await expect(
      DB.prepare(
        `INSERT INTO subscribers (email, zip, cut, timezone, created_at) VALUES (?, ?, ?, ?, ?)`
      )
        .bind('bad-cut@example.com', '20001', 'rocket', 'America/New_York', now)
        .run()
    ).rejects.toThrow();
    await expect(
      DB.prepare(
        `INSERT INTO subscribers (email, zip, cooker, timezone, created_at) VALUES (?, ?, ?, ?, ?)`
      )
        .bind('bad-cooker@example.com', '20001', 'microwave', 'America/New_York', now)
        .run()
    ).rejects.toThrow();
  });

  it('subscribers allows NULL cut and cooker (no preference yet)', async () => {
    const now = Date.now();
    await DB.prepare(
      `INSERT INTO subscribers (email, zip, timezone, created_at) VALUES (?, ?, ?, ?)`
    )
      .bind('no-prefs@example.com', '20001', 'America/New_York', now)
      .run();
    const row = await DB.prepare(
      `SELECT cut, cooker FROM subscribers WHERE email = ?`
    )
      .bind('no-prefs@example.com')
      .first<{ cut: string | null; cooker: string | null }>();
    expect(row?.cut).toBeNull();
    expect(row?.cooker).toBeNull();
  });

  it('articles.metro_slug rejects values that do not exist in metros', async () => {
    // D1 enables foreign_keys by default. Inserting an unknown metro_slug
    // should fail with a FOREIGN KEY constraint error.
    const now = Date.now();
    await expect(
      DB.prepare(
        `INSERT INTO articles (slug, kind, metro_slug, title, body_html, body_text, hero_band, published_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          'bad-metro-ref',
          'metro-roundup',
          'not-a-real-metro',
          't',
          '<p>x</p>',
          'x',
          'green',
          now,
          now
        )
        .run()
    ).rejects.toThrow();
  });

  it('subscribers.region accepts the six regional values and NULL', async () => {
    const now = Date.now();
    const cases: Array<[string, string | null]> = [
      ['ne@x.com', 'northeast'],
      ['se@x.com', 'southeast'],
      ['mw@x.com', 'midwest'],
      ['sc@x.com', 'south_central'],
      ['mt@x.com', 'mountain'],
      ['pa@x.com', 'pacific'],
      ['nullreg@x.com', null],
    ];
    for (const [email, region] of cases) {
      await DB.prepare(
        `INSERT INTO subscribers (email, zip, timezone, region, created_at) VALUES (?, ?, ?, ?, ?)`
      )
        .bind(email, '20001', 'America/New_York', region, now)
        .run();
    }
  });

  it('subscribers.region rejects unknown region values', async () => {
    const now = Date.now();
    await expect(
      DB.prepare(
        `INSERT INTO subscribers (email, zip, timezone, region, created_at) VALUES (?, ?, ?, ?, ?)`
      )
        .bind('bad-region@x.com', '20001', 'America/New_York', 'antarctica', now)
        .run()
    ).rejects.toThrow();
  });

  it('friday_campaign_log enforces UNIQUE (region, send_date)', async () => {
    const now = Date.now();
    await DB.prepare(
      `INSERT INTO friday_campaign_log (region, send_date, status, attempted_at) VALUES (?, ?, ?, ?)`
    )
      .bind('southeast', '2026-05-15', 'queued', now)
      .run();
    // Same region + same date — must collide.
    await expect(
      DB.prepare(
        `INSERT INTO friday_campaign_log (region, send_date, status, attempted_at) VALUES (?, ?, ?, ?)`
      )
        .bind('southeast', '2026-05-15', 'sent', now)
        .run()
    ).rejects.toThrow();
    // Different region same date — allowed.
    await DB.prepare(
      `INSERT INTO friday_campaign_log (region, send_date, status, attempted_at) VALUES (?, ?, ?, ?)`
    )
      .bind('midwest', '2026-05-15', 'queued', now)
      .run();
  });

  it('friday_campaign_log rejects unknown status or region values', async () => {
    const now = Date.now();
    await expect(
      DB.prepare(
        `INSERT INTO friday_campaign_log (region, send_date, status, attempted_at) VALUES (?, ?, ?, ?)`
      )
        .bind('northeast', '2026-05-22', 'pending', now)
        .run()
    ).rejects.toThrow();
    await expect(
      DB.prepare(
        `INSERT INTO friday_campaign_log (region, send_date, status, attempted_at) VALUES (?, ?, ?, ?)`
      )
        .bind('antarctica', '2026-05-22', 'queued', now)
        .run()
    ).rejects.toThrow();
  });

  it("friday_campaign_log accepts 'sending' as a status (claim-lock state)", async () => {
    // The cron INSERTs at 'sending' atomically so the row itself is
    // the claim lock; the CHECK must allow it.
    const now = Date.now();
    await DB.prepare(
      `INSERT INTO friday_campaign_log (region, send_date, status, attempted_at) VALUES (?, ?, ?, ?)`
    )
      .bind('mountain', '2026-06-12', 'sending', now)
      .run();
    const row = await DB.prepare(
      `SELECT status FROM friday_campaign_log WHERE region = ? AND send_date = ?`
    )
      .bind('mountain', '2026-06-12')
      .first<{ status: string }>();
    expect(row?.status).toBe('sending');
  });

  it('articles rejects unknown kind or hero_band values', async () => {
    const now = Date.now();
    await expect(
      DB.prepare(
        `INSERT INTO articles (slug, kind, title, body_html, body_text, hero_band, published_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind('bad-kind', 'mystery', 't', '<p>x</p>', 'x', 'green', now, now)
        .run()
    ).rejects.toThrow();
    await expect(
      DB.prepare(
        `INSERT INTO articles (slug, kind, title, body_html, body_text, hero_band, published_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind('bad-band', 'weekly-summary', 't', '<p>x</p>', 'x', 'plaid', now, now)
        .run()
    ).rejects.toThrow();
  });
});

describe('splitStatements helper', () => {
  it('strips line comments and splits on `;`', async () => {
    const { splitStatements } = await import('../helpers/d1');
    const sql = `-- header\nCREATE TABLE t (a INT);\n-- mid\nINSERT INTO t VALUES (1);\n`;
    expect(splitStatements(sql)).toEqual(['CREATE TABLE t (a INT)', 'INSERT INTO t VALUES (1)']);
  });

  it('strips inline -- comments so embedded `;` does not split a statement', async () => {
    const { splitStatements } = await import('../helpers/d1');
    // The comment contains a semicolon; the splitter must drop the
    // comment entirely before splitting, not after.
    const sql = `CREATE TABLE t (\n  k TEXT, -- 'a; b' inline note\n  v INT\n);`;
    expect(splitStatements(sql)).toEqual(['CREATE TABLE t (\n  k TEXT, \n  v INT\n)']);
  });

  it('does not split on `;` inside a single-quoted string literal', async () => {
    const { splitStatements } = await import('../helpers/d1');
    const sql = `INSERT INTO events (kind, payload) VALUES ('err', '{"msg":"a;b"}');`;
    expect(splitStatements(sql)).toEqual([
      `INSERT INTO events (kind, payload) VALUES ('err', '{"msg":"a;b"}')`,
    ]);
  });

  it("handles SQLite-escaped quotes ('') inside string literals", async () => {
    const { splitStatements } = await import('../helpers/d1');
    // `'don''t; stop'` is the single literal "don't; stop" — the `;`
    // sits inside the string and must not split.
    const sql = `INSERT INTO t (v) VALUES ('don''t; stop');`;
    expect(splitStatements(sql)).toEqual([`INSERT INTO t (v) VALUES ('don''t; stop')`]);
  });

  it('does not strip `--` that lives inside a string literal', async () => {
    const { splitStatements } = await import('../helpers/d1');
    // `'a--b'` is a literal value containing `--`. A naïve pre-pass
    // regex strip would corrupt it to `'a` and break the statement.
    const sql = `INSERT INTO t (v) VALUES ('a--b');`;
    expect(splitStatements(sql)).toEqual([`INSERT INTO t (v) VALUES ('a--b')`]);
  });
});
