import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handlePreferences } from '../../src/handlers/preferences';
import { signToken } from '../../src/lib/auth/token';
import { applyMigrations } from '../helpers/d1';
import { buildContext, TEST_SUBSCRIBER_TOKEN_SECRET } from '../helpers/routeContext';

interface E {
  SMOKE_DB: D1Database;
}

const DB = (env as unknown as E).SMOKE_DB;

beforeAll(async () => {
  await applyMigrations(DB);
});

let validToken = '';

beforeEach(async () => {
  await DB.prepare(`DELETE FROM subscribers`).run();
  await DB.prepare(
    `INSERT INTO subscribers (email, zip, cut, cooker, timezone, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind('me@example.com', '30303', 'brisket-flat', 'offset', 'America/New_York', Date.now())
    .run();
  validToken = await signToken('me@example.com', TEST_SUBSCRIBER_TOKEN_SECRET);
});

describe('GET /api/preferences', () => {
  it('returns the subscriber row when email + token validate', async () => {
    const res = await handlePreferences(
      buildContext(
        new Request(
          `https://x/api/preferences?email=me@example.com&token=${validToken}`,
          { method: 'GET' }
        )
      )
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

  it("reports subscribed:false when unsubscribed_at is set", async () => {
    await DB.prepare(`UPDATE subscribers SET unsubscribed_at = ? WHERE email = ?`)
      .bind(Date.now(), 'me@example.com')
      .run();
    const res = await handlePreferences(
      buildContext(
        new Request(
          `https://x/api/preferences?email=me@example.com&token=${validToken}`,
          { method: 'GET' }
        )
      )
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { subscribed: boolean }).toMatchObject({ subscribed: false });
  });

  it('400s when ?email or ?token is missing', async () => {
    const missingBoth = await handlePreferences(
      buildContext(new Request('https://x/api/preferences', { method: 'GET' }))
    );
    expect(missingBoth.status).toBe(400);

    const missingToken = await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences?email=me@example.com', { method: 'GET' })
      )
    );
    expect(missingToken.status).toBe(400);
  });

  it('401s when the token does not validate (both malformed and wrong-but-valid-format collapse to the same response)', async () => {
    // Malformed token shape, valid email.
    const malformed = await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences?email=me@example.com&token=garbage', {
          method: 'GET',
        })
      )
    );
    expect(malformed.status).toBe(401);
    expect(await malformed.json()).toMatchObject({ error: 'invalid_credentials' });

    // Well-formed but wrong-secret token.
    const wrongSig = await signToken('me@example.com', 'wrong-secret');
    const mismatched = await handlePreferences(
      buildContext(
        new Request(
          `https://x/api/preferences?email=me@example.com&token=${wrongSig}`,
          { method: 'GET' }
        )
      )
    );
    expect(mismatched.status).toBe(401);
    expect(await mismatched.json()).toMatchObject({ error: 'invalid_credentials' });
  });

  it('cannot be used as an enumeration oracle — unknown email still requires a valid token', async () => {
    // A token signed for a real email won't validate against an
    // arbitrary other email, so adversaries can't probe existence.
    const otherToken = await signToken('attacker@example.com', TEST_SUBSCRIBER_TOKEN_SECRET);
    const res = await handlePreferences(
      buildContext(
        new Request(
          `https://x/api/preferences?email=me@example.com&token=${otherToken}`,
          { method: 'GET' }
        )
      )
    );
    expect(res.status).toBe(401);
  });

  it('does NOT leak zip in the GET response', async () => {
    const res = await handlePreferences(
      buildContext(
        new Request(
          `https://x/api/preferences?email=me@example.com&token=${validToken}`,
          { method: 'GET' }
        )
      )
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['zip']).toBeUndefined();
  });
});

describe('PATCH /api/preferences', () => {
  it('updates cut alone without touching cooker (token valid)', async () => {
    const res = await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'me@example.com', token: validToken, cut: 'pork-butt' }),
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

  it('401s on a PATCH whose token does not match the email', async () => {
    const wrongToken = await signToken('attacker@example.com', TEST_SUBSCRIBER_TOKEN_SECRET);
    const res = await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'me@example.com',
            token: wrongToken,
            cut: 'pork-butt',
          }),
        })
      )
    );
    expect(res.status).toBe(401);
    const row = await DB.prepare(`SELECT cut FROM subscribers WHERE email = ?`)
      .bind('me@example.com')
      .first<{ cut: string }>();
    expect(row?.cut).toBe('brisket-flat'); // unchanged
  });

  it('400s when PATCH body has no field changes', async () => {
    const res = await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'me@example.com', token: validToken }),
        })
      )
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'no_changes' });
  });

  it('404s when PATCH targets an email with no row (after token validates)', async () => {
    const otherToken = await signToken('nobody@example.com', TEST_SUBSCRIBER_TOKEN_SECRET);
    const res = await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'nobody@example.com',
            token: otherToken,
            cut: 'fish',
          }),
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
          body: JSON.stringify({
            email: 'me@example.com',
            token: validToken,
            cooker: 'microwave',
          }),
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
          body: JSON.stringify({ email: 'me@example.com', token: validToken, cut: null }),
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
