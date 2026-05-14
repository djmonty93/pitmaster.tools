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
    expect(idx).toContain('idx_subscribers_timezone');
    expect(idx).toContain('idx_events_created_at');
    expect(idx).toContain('idx_articles_slug');
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
});
