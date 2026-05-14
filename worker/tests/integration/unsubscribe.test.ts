import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleUnsubscribe } from '../../src/handlers/unsubscribe';
import { applyMigrations } from '../helpers/d1';
import { installFetchStub, jsonResponse, type FetchStub } from '../helpers/fetchStub';
import { buildContext } from '../helpers/routeContext';

interface E {
  SMOKE_DB: D1Database;
}

const DB = (env as unknown as E).SMOKE_DB;

beforeAll(async () => {
  await applyMigrations(DB);
});

let stub: FetchStub | null = null;
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
  it('calls MailerLite + sets unsubscribed_at on D1', async () => {
    stub = installFetchStub([
      { match: 'connect.mailerlite.com', respond: () => jsonResponse(204, undefined) },
    ]);
    const before = Date.now();
    const res = await handleUnsubscribe(
      buildContext(buildReq({ email: 'gone@example.com' }))
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

  it('queues a 5xx and still marks the D1 row unsubscribed', async () => {
    stub = installFetchStub([
      { match: 'connect.mailerlite.com', respond: () => jsonResponse(502, {}) },
    ]);
    const res = await handleUnsubscribe(
      buildContext(buildReq({ email: 'gone@example.com' }))
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
      buildContext(buildReq({ email: 'gone@example.com' }))
    );
    // Non-retryable 4xx falls through to the D1 mark — same 200 shape.
    expect(res.status).toBe(200);
    const row = await DB.prepare(
      `SELECT unsubscribed_at FROM subscribers WHERE email = ?`
    )
      .bind('gone@example.com')
      .first<{ unsubscribed_at: number | null }>();
    expect(row?.unsubscribed_at).not.toBeNull();
  });

  it('400s on schema-invalid body', async () => {
    stub = installFetchStub([]);
    const res = await handleUnsubscribe(
      buildContext(buildReq({ email: 'not-an-email' }))
    );
    expect(res.status).toBe(400);
  });
});
