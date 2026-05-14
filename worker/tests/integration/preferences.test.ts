import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handlePreferences } from '../../src/handlers/preferences';
import { applyMigrations } from '../helpers/d1';
import { buildContext } from '../helpers/routeContext';

interface E {
  SMOKE_DB: D1Database;
}

const DB = (env as unknown as E).SMOKE_DB;

beforeAll(async () => {
  await applyMigrations(DB);
});

beforeEach(async () => {
  await DB.prepare(`DELETE FROM subscribers`).run();
  await DB.prepare(
    `INSERT INTO subscribers (email, zip, cut, cooker, timezone, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind('me@example.com', '30303', 'brisket-flat', 'offset', 'America/New_York', Date.now())
    .run();
});

describe('GET /api/preferences', () => {
  it('returns the subscriber row for the given email', async () => {
    const res = await handlePreferences(
      buildContext(new Request('https://x/api/preferences?email=me@example.com', { method: 'GET' }))
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      email: 'me@example.com',
      cut: 'brisket-flat',
      cooker: 'offset',
      timezone: 'America/New_York',
      subscribed: true,
    });
  });

  it("reports unsubscribed:false when unsubscribed_at is set", async () => {
    await DB.prepare(`UPDATE subscribers SET unsubscribed_at = ? WHERE email = ?`)
      .bind(Date.now(), 'me@example.com')
      .run();
    const res = await handlePreferences(
      buildContext(new Request('https://x/api/preferences?email=me@example.com', { method: 'GET' }))
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { subscribed: boolean }).toMatchObject({ subscribed: false });
  });

  it('400s when ?email is missing or malformed', async () => {
    const missing = await handlePreferences(
      buildContext(new Request('https://x/api/preferences', { method: 'GET' }))
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: 'missing_email' });

    const bad = await handlePreferences(
      buildContext(new Request('https://x/api/preferences?email=not-an-email', { method: 'GET' }))
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_email' });
  });

  it('404s when no row matches', async () => {
    const res = await handlePreferences(
      buildContext(new Request('https://x/api/preferences?email=nobody@example.com', { method: 'GET' }))
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });

  it('does NOT leak zip in the GET response', async () => {
    const res = await handlePreferences(
      buildContext(new Request('https://x/api/preferences?email=me@example.com', { method: 'GET' }))
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['zip']).toBeUndefined();
  });
});

describe('PATCH /api/preferences', () => {
  it('updates cut alone without touching cooker', async () => {
    const res = await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'me@example.com', cut: 'pork-butt' }),
        })
      )
    );
    expect(res.status).toBe(200);
    const row = await DB.prepare(`SELECT cut, cooker FROM subscribers WHERE email = ?`)
      .bind('me@example.com')
      .first<{ cut: string; cooker: string }>();
    expect(row?.cut).toBe('pork-butt');
    expect(row?.cooker).toBe('offset');
  });

  it('400s when PATCH body has no changes', async () => {
    const res = await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'me@example.com' }),
        })
      )
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'no_changes' });
  });

  it('404s when PATCH targets an email with no row', async () => {
    const res = await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'nobody@example.com', cut: 'fish' }),
        })
      )
    );
    expect(res.status).toBe(404);
  });

  it('400s on schema-invalid PATCH (bad cooker)', async () => {
    const res = await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'me@example.com', cooker: 'microwave' }),
        })
      )
    );
    expect(res.status).toBe(400);
  });

  it('allows setting cut to null (no preference)', async () => {
    const res = await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'me@example.com', cut: null }),
        })
      )
    );
    expect(res.status).toBe(200);
    const row = await DB.prepare(`SELECT cut FROM subscribers WHERE email = ?`)
      .bind('me@example.com')
      .first<{ cut: string | null }>();
    expect(row?.cut).toBeNull();
  });
});
