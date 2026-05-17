import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleUnsubscribe } from '../../src/handlers/unsubscribe';
import { signToken } from '../../src/lib/auth/token';
import { applyMigrations } from '../helpers/d1';
import { installFetchStub, jsonResponse, type FetchStub } from '../helpers/fetchStub';
import { buildContext, TEST_SUBSCRIBER_TOKEN_SECRET } from '../helpers/routeContext';

interface E {
  SMOKE_DB: D1Database;
  WEATHER_KV: KVNamespace;
}

const DB = (env as unknown as E).SMOKE_DB;
const KV = (env as unknown as E).WEATHER_KV;

beforeAll(async () => {
  await applyMigrations(DB);
});

async function seedGroupIds() {
  await KV.put('sender_group_id:pitmaster_all', '1');
  await KV.put('sender_group_id:pitmaster_northeast', '2');
  await KV.put('sender_group_id:pitmaster_southeast', '3');
  await KV.put('sender_group_id:pitmaster_midwest', '4');
  await KV.put('sender_group_id:pitmaster_south_central', '5');
  await KV.put('sender_group_id:pitmaster_mountain', '6');
  await KV.put('sender_group_id:pitmaster_pacific', '7');
}

let stub: FetchStub | null = null;
let validToken = '';

beforeEach(async () => {
  await DB.prepare(`DELETE FROM subscribers`).run();
  await DB.prepare(`DELETE FROM sender_retry`).run();
  await seedGroupIds();
  const now = Date.now();
  await DB.prepare(
    `INSERT INTO subscribers (email, zip, cut, cooker, timezone, region, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind('gone@example.com', '30303', null, null, 'America/New_York', 'southeast', now)
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

/**
 * Happy-path stub: getSubscriberByEmail returns sub_42, every group
 * DELETE returns 200. `/groups/` match must come first because
 * substring matcher picks the first hit and the GET hits
 * `api.sender.net/v2/subscribers/<email>`.
 */
const happyPathHits = () => [
  { match: '/groups/', respond: () => jsonResponse(200, { data: {} }) },
  {
    match: 'api.sender.net',
    respond: () => jsonResponse(200, { data: { id: 'sub_42' } }),
  },
];

describe('POST /api/unsubscribe', () => {
  it('looks up subscriber id, removes from every pitmaster_* group, sets unsubscribed_at on D1', async () => {
    stub = installFetchStub(happyPathHits());
    const before = Date.now();
    const res = await handleUnsubscribe(
      buildContext(buildReq({ email: 'gone@example.com', token: validToken }))
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({ status: 'sent' });

    const row = await DB.prepare(`SELECT unsubscribed_at FROM subscribers WHERE email = ?`)
      .bind('gone@example.com')
      .first<{ unsubscribed_at: number | null }>();
    expect(row?.unsubscribed_at).toBeGreaterThanOrEqual(before);

    // 7 DELETE calls: pitmaster_all + 6 regional. removeBbqGroups
    // doesn't know which regional group the subscriber was in, so
    // it issues DELETE for all of them — 404s on non-member calls
    // are swallowed by the client.
    const removeCalls = stub.calls.filter(
      (c) => c.method === 'DELETE' && c.url.includes('/groups/')
    );
    expect(removeCalls).toHaveLength(7);
  });

  it('401s on a token that does not match the email — D1 row untouched, no Sender call', async () => {
    stub = installFetchStub([]);
    const wrongToken = await signToken('someone-else@example.com', TEST_SUBSCRIBER_TOKEN_SECRET);
    const res = await handleUnsubscribe(
      buildContext(buildReq({ email: 'gone@example.com', token: wrongToken }))
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_token' });
    const row = await DB.prepare(`SELECT unsubscribed_at FROM subscribers WHERE email = ?`)
      .bind('gone@example.com')
      .first<{ unsubscribed_at: number | null }>();
    expect(row?.unsubscribed_at).toBeNull();
  });

  it('queues a 5xx on group removal and still marks the D1 row unsubscribed', async () => {
    stub = installFetchStub([
      { match: '/groups/', respond: () => jsonResponse(502, {}) },
      {
        match: 'api.sender.net',
        respond: () => jsonResponse(200, { data: { id: 'sub_42' } }),
      },
    ]);
    const res = await handleUnsubscribe(
      buildContext(buildReq({ email: 'gone@example.com', token: validToken }))
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({ status: 'queued' });
    const row = await DB.prepare(`SELECT unsubscribed_at FROM subscribers WHERE email = ?`)
      .bind('gone@example.com')
      .first<{ unsubscribed_at: number | null }>();
    expect(row?.unsubscribed_at).not.toBeNull();
    const retry = await DB.prepare(
      `SELECT request_kind FROM sender_retry WHERE idempotency_key = ?`
    )
      .bind('unsubscribe:gone@example.com')
      .first<{ request_kind: string }>();
    expect(retry?.request_kind).toBe('unsubscribe');
  });

  it('queues a 401 on getSubscriber (revoked key etc.) — does NOT treat as "not found"', async () => {
    // Regression for [P2] pass-9: getSubscriberByEmail already
    // swallows 404 → null; anything else reaching the handler is a
    // distinct failure (revoked key, account issue) and must NOT be
    // treated as "subscriber not in Sender". Otherwise the
    // handler skips group removal and reports success while the
    // user remains in pitmaster_* groups receiving the digest.
    stub = installFetchStub([
      { match: 'api.sender.net', respond: () => jsonResponse(401, { error: 'unauthorized' }) },
    ]);
    const res = await handleUnsubscribe(
      buildContext(buildReq({ email: 'gone@example.com', token: validToken }))
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({ status: 'queued' });
    // D1 still flagged so the user sees immediate effect.
    const row = await DB.prepare(`SELECT unsubscribed_at FROM subscribers WHERE email = ?`)
      .bind('gone@example.com')
      .first<{ unsubscribed_at: number | null }>();
    expect(row?.unsubscribed_at).not.toBeNull();
    // Retry queue carries the unsubscribe payload so a future drain
    // (after key rotation or upstream recovery) can finish group
    // removal.
    const retry = await DB.prepare(
      `SELECT request_kind FROM sender_retry WHERE idempotency_key = ?`
    )
      .bind('unsubscribe:gone@example.com')
      .first<{ request_kind: string }>();
    expect(retry?.request_kind).toBe('unsubscribe');
  });

  it('treats Sender 404 (subscriber not in Sender) as soft success — D1 still marked', async () => {
    stub = installFetchStub([
      { match: 'api.sender.net', respond: () => jsonResponse(404, {}) },
    ]);
    const res = await handleUnsubscribe(
      buildContext(buildReq({ email: 'gone@example.com', token: validToken }))
    );
    expect(res.status).toBe(200);
    const row = await DB.prepare(`SELECT unsubscribed_at FROM subscribers WHERE email = ?`)
      .bind('gone@example.com')
      .first<{ unsubscribed_at: number | null }>();
    expect(row?.unsubscribed_at).not.toBeNull();
    // No DELETE calls when MailerLite doesn't know the subscriber.
    const removeCalls = stub.calls.filter((c) => c.method === 'DELETE');
    expect(removeCalls).toHaveLength(0);
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

  it('enqueues a retry on a non-retryable group-removal failure (does NOT silently report sent)', async () => {
    // Regression for the [P2] pass-5 finding: a 4xx mid-removal used
    // to be swallowed, the response said 'sent', and the subscriber
    // could remain on a regional automation despite D1 saying they
    // were unsubscribed. Now any failure surfaces via the retry queue
    // and the response says 'queued'.
    stub = installFetchStub([
      // First /groups/ DELETE returns 400 (terminal). Subsequent calls
      // never happen because removeBbqGroups iterates and one throws.
      { match: '/groups/', respond: () => jsonResponse(400, { error: 'bad' }) },
      {
        match: 'api.sender.net',
        respond: () => jsonResponse(200, { data: { id: 'sub_42' } }),
      },
    ]);
    const res = await handleUnsubscribe(
      buildContext(buildReq({ email: 'gone@example.com', token: validToken }))
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({ status: 'queued' });
    const retryRow = await DB.prepare(
      `SELECT request_kind, request_payload FROM sender_retry WHERE idempotency_key = ?`
    )
      .bind('unsubscribe:gone@example.com')
      .first<{ request_kind: string; request_payload: string }>();
    expect(retryRow?.request_kind).toBe('unsubscribe');
    const payload = JSON.parse(retryRow!.request_payload) as {
      stage: string;
      subscriberId: string;
    };
    expect(payload.stage).toBe('remove_groups');
    expect(payload.subscriberId).toBe('sub_42');
    // D1 still marked unsubscribed — the row was claimed by the
    // original handler before the queue replay finishes the
    // MailerLite-side cleanup.
    const row = await DB.prepare(`SELECT unsubscribed_at FROM subscribers WHERE email = ?`)
      .bind('gone@example.com')
      .first<{ unsubscribed_at: number | null }>();
    expect(row?.unsubscribed_at).not.toBeNull();
  });

  it('queues a 5xx on the getSubscriber lookup and still marks D1 unsubscribed', async () => {
    stub = installFetchStub([
      { match: 'api.sender.net', respond: () => jsonResponse(503, {}) },
    ]);
    const res = await handleUnsubscribe(
      buildContext(buildReq({ email: 'gone@example.com', token: validToken }))
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({ status: 'queued' });
    const row = await DB.prepare(`SELECT unsubscribed_at FROM subscribers WHERE email = ?`)
      .bind('gone@example.com')
      .first<{ unsubscribed_at: number | null }>();
    expect(row?.unsubscribed_at).not.toBeNull();
  });
});
