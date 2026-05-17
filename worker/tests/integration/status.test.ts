import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleStatus } from '../../src/handlers/status';
import { MAX_ATTEMPTS } from '../../src/lib/sender/retry';
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
  await DB.prepare(`DELETE FROM sender_retry`).run();
  await DB.prepare(`DELETE FROM events`).run();
});

describe('GET /api/status', () => {
  it('returns zero counts on a fresh DB', async () => {
    const res = await handleStatus(buildContext(new Request('https://x/api/status')));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      esp_retry: { esp_retry_pending: number; esp_retry_parked: number; nextAttemptAt: number | null };
      subscribers: { total: number; active: number };
      recentErrors: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.esp_retry).toEqual({ esp_retry_pending: 0, esp_retry_parked: 0, nextAttemptAt: null });
    expect(body.subscribers).toEqual({ total: 0, active: 0 });
    expect(body.recentErrors).toEqual([]);
  });

  it('counts subscribers split into total / active', async () => {
    const now = Date.now();
    await DB.prepare(
      `INSERT INTO subscribers (email, zip, timezone, created_at, unsubscribed_at) VALUES (?, ?, ?, ?, ?)`
    )
      .bind('a@x.com', '30303', 'America/New_York', now, null)
      .run();
    await DB.prepare(
      `INSERT INTO subscribers (email, zip, timezone, created_at, unsubscribed_at) VALUES (?, ?, ?, ?, ?)`
    )
      .bind('b@x.com', '30303', 'America/New_York', now, now)
      .run();
    const res = await handleStatus(buildContext(new Request('https://x/api/status')));
    const body = (await res.json()) as { subscribers: { total: number; active: number } };
    expect(body.subscribers).toEqual({ total: 2, active: 1 });
  });

  it('splits queued vs parked rows on the attempts < MAX_ATTEMPTS boundary', async () => {
    const now = Date.now();
    await DB.prepare(
      `INSERT INTO sender_retry
         (request_kind, request_payload, idempotency_key, attempts, last_status, last_error, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`
    )
      .bind('subscribe', '{}', 'k-queued', 2, now + 5000, now)
      .run();
    await DB.prepare(
      `INSERT INTO sender_retry
         (request_kind, request_payload, idempotency_key, attempts, last_status, last_error, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`
    )
      .bind('subscribe', '{}', 'k-parked', MAX_ATTEMPTS, now + 9999999, now)
      .run();
    const res = await handleStatus(buildContext(new Request('https://x/api/status')));
    const body = (await res.json()) as {
      esp_retry: { esp_retry_pending: number; esp_retry_parked: number; nextAttemptAt: number };
    };
    expect(body.esp_retry.esp_retry_pending).toBe(1);
    expect(body.esp_retry.esp_retry_parked).toBe(1);
    expect(body.esp_retry.nextAttemptAt).toBe(now + 5000);
  });

  it('returns the 10 most recent error events, newest first', async () => {
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      await DB.prepare(`INSERT INTO events (kind, payload, created_at) VALUES (?, ?, ?)`)
        .bind('error', JSON.stringify({ kind: 'subscribe', error: `err-${i}` }), now + i)
        .run();
    }
    const res = await handleStatus(buildContext(new Request('https://x/api/status')));
    const body = (await res.json()) as { recentErrors: Array<{ summary: string }> };
    expect(body.recentErrors).toHaveLength(10);
    // Newest first: err-11, err-10, err-9, ...
    expect(body.recentErrors[0]!.summary).toMatch(/err-11/);
    expect(body.recentErrors[9]!.summary).toMatch(/err-2/);
  });

  it('sets Cache-Control: no-store (operational data must not be CDN-cached)', async () => {
    const res = await handleStatus(buildContext(new Request('https://x/api/status')));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
