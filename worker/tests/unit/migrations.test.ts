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
      expect.arrayContaining(['articles', 'events', 'mailerlite_retry', 'metros', 'subscribers'])
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
        'idx_metros_state',
        'idx_events_created_at',
        'idx_events_kind',
        'idx_mailerlite_retry_next',
        'idx_articles_published_at',
        'idx_articles_metro_slug',
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

  it('mailerlite_retry idempotency_key is UNIQUE', async () => {
    const now = Date.now();
    await DB.prepare(
      `INSERT INTO mailerlite_retry (request_kind, request_payload, idempotency_key, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind('subscribe', '{}', 'idem-1', now, now)
      .run();
    await expect(
      DB.prepare(
        `INSERT INTO mailerlite_retry (request_kind, request_payload, idempotency_key, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind('subscribe', '{}', 'idem-1', now, now)
        .run()
    ).rejects.toThrow();
  });

  it('mailerlite_retry rejects unknown request_kind values', async () => {
    const now = Date.now();
    await expect(
      DB.prepare(
        `INSERT INTO mailerlite_retry (request_kind, request_payload, idempotency_key, next_attempt_at, created_at)
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
