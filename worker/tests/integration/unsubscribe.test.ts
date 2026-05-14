import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleUnsubscribe } from '../../src/handlers/unsubscribe';
import { signToken } from '../../src/lib/auth/token';
import { applyMigrations } from '../helpers/d1';
import { installFetchStub, jsonResponse, type FetchStub } from '../helpers/fetchStub';
import { buildContext, TEST_SUBSCRIBER_TOKEN_SECRET } from '../helpers/routeContext';

interface E {
  SMOKE_DB: D1Database;
}

const DB = (env as unknown as E).SMOKE_DB;

beforeAll(async () => {
  await applyMigrations(DB);
});

let stub: FetchStub | null = null;
let validToken = '';

beforeEach(async () => {
  await DB.prepare(`DELETE FROM subscribers`).run();
  await DB.prepare(`DELETE FROM mailerlite_retry`).run();
  const now = Date.now();
  await DB.prepare(
    `INSERT INTO subscribers (email, zip, cut, cooker, timezone, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind('gone@example.com', '30303', null, null, 'America/New_York', now)
    .run();
  validToken = await signToken('gone@example.com', TEST_SUBSCRIBER_TOKEN_SECRET);
});
afterEach(() => {
  stub?.restore();
  stub = null;
});

function buildReq(body: unknown): Request {
  return new Request('https://x/api/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/unsubscribe', () => {
  it('calls MailerLite + sets unsubscribed_at on D1 when token is valid', async () => {
    stub = installFetchStub([
      { match: 'connect.mailerlite.com', respond: () => jsonResponse(204, undefined) },
    ]);
    const before = Date.now();
    const res = await handleUnsubscribe(
      buildContext(buildReq({ email: 'gone@example.com', token: validToken }))
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({ status: 'sent' });
    const row = await DB.prepare(
      `SELECT unsubscribed_at FROM subscribers WHERE email = ?`
    )
      .bind('gone@example.com')
      .first<{ unsubscribed_at: number | null }>();
    expect(row?.unsubscribed_at).toBeGreaterThanOrEqual(before);
  });

  it('401s on a token that does not match the email — D1 row untouched', async () => {
    stub = installFetchStub([]); // no fetch should happen
    const wrongToken = await signToken('someone-else@example.com', TEST_SUBSCRIBER_TOKEN_SECRET);
    const res = await handleUnsubscribe(
      buildContext(buildReq({ email: 'gone@example.com', token: wrongToken }))
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_token' });
    const row = await DB.prepare(
      `SELECT unsubscribed_at FROM subscribers WHERE email = ?`
    )
      .bind('gone@example.com')
      .first<{ unsubscribed_at: number | null }>();
    expect(row?.unsubscribed_at).toBeNull();
  });

  it('queues a 5xx and still marks the D1 row unsubscribed (when token valid)', async () => {
    stub = installFetchStub([
      { match: 'connect.mailerlite.com', respond: () => jsonResponse(502, {}) },
    ]);
    const res = await handleUnsubscribe(
      buildContext(buildReq({ email: 'gone@example.com', token: validToken }))
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({ status: 'queued' });
    const row = await DB.prepare(
      `SELECT unsubscribed_at FROM subscribers WHERE email = ?`
    )
      .bind('gone@example.com')
      .first<{ unsubscribed_at: number | null }>();
    expect(row?.unsubscribed_at).not.toBeNull();
    const retry = await DB.prepare(
      `SELECT request_kind FROM mailerlite_retry WHERE idempotency_key = ?`
    )
      .bind('unsubscribe:gone@example.com')
      .first<{ request_kind: string }>();
    expect(retry?.request_kind).toBe('unsubscribe');
  });

  it('treats MailerLite 404 (subscriber not found) as soft success', async () => {
    stub = installFetchStub([
      { match: 'connect.mailerlite.com', respond: () => jsonResponse(404, {}) },
    ]);
    const res = await handleUnsubscribe(
      buildContext(buildReq({ email: 'gone@example.com', token: validToken }))
    );
    expect(res.status).toBe(200);
    const row = await DB.prepare(
      `SELECT unsubscribed_at FROM subscribers WHERE email = ?`
    )
      .bind('gone@example.com')
      .first<{ unsubscribed_at: number | null }>();
    expect(row?.unsubscribed_at).not.toBeNull();
  });

  it('400s on schema-invalid body (bad email shape, missing token, bad token format)', async () => {
    stub = installFetchStub([]);
    const cases: Array<unknown> = [
      { email: 'not-an-email', token: validToken },
      { email: 'gone@example.com' /* no token */ },
      { email: 'gone@example.com', token: 'too-short' },
    ];
    for (const c of cases) {
      const res = await handleUnsubscribe(buildContext(buildReq(c)));
      expect(res.status).toBe(400);
    }
  });
});
