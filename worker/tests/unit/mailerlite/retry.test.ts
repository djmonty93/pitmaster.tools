import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailerLiteClient } from '../../../src/lib/mailerlite/client';
import { MailerLiteError } from '../../../src/lib/mailerlite/errors';
import {
  MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  PARK_DELAY_MS,
  backoffMs,
  drain,
  enqueue,
} from '../../../src/lib/mailerlite/retry';
import { applyMigrations } from '../../helpers/d1';

interface Env {
  SMOKE_DB: D1Database;
}

const DB = (env as unknown as Env).SMOKE_DB;

beforeAll(async () => {
  await applyMigrations(DB);
});

beforeEach(async () => {
  await DB.prepare(`DELETE FROM mailerlite_retry`).run();
  await DB.prepare(`DELETE FROM events`).run();
});

function fakeClient(overrides: Partial<MailerLiteClient> = {}): MailerLiteClient {
  return {
    subscribe: vi.fn().mockResolvedValue({ id: 's_ok', email: 'x@y.com', status: 'active' }),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as MailerLiteClient;
}

describe('backoffMs', () => {
  it('starts at one minute on attempt 1 and doubles', () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(3)).toBe(240_000);
    expect(backoffMs(4)).toBe(480_000);
  });

  it('clamps inputs below 1 to backoffMs(1) so misuse never produces a tight loop', () => {
    expect(backoffMs(0)).toBe(60_000);
    expect(backoffMs(-3)).toBe(60_000);
  });

  it('caps at MAX_BACKOFF_MS once the doubling sequence overshoots', () => {
    // 60_000 * 2^9 = 30_720_000 > MAX_BACKOFF_MS (6 h = 21_600_000),
    // so attempt 10 is the first one to clamp. MAX_ATTEMPTS = 10 makes
    // this exactly reachable in production.
    expect(backoffMs(9)).toBeLessThan(MAX_BACKOFF_MS);
    expect(backoffMs(10)).toBe(MAX_BACKOFF_MS);
    expect(backoffMs(100)).toBe(MAX_BACKOFF_MS);
  });
});

describe('mailerlite retry — enqueue', () => {
  it('inserts a row with attempts=0 and the cause status/error', async () => {
    const cause = new MailerLiteError('subscribe', 'http_5xx', 'status 503', 503);
    await enqueue(DB, {
      kind: 'subscribe',
      payload: { email: 'a@b.com' },
      idempotencyKey: 'subscribe:abc',
      firstAttemptAtMs: 1_700_000_000_000,
      cause,
    });
    const row = await DB.prepare(
      `SELECT request_kind, request_payload, idempotency_key, attempts, last_status, last_error, next_attempt_at, created_at
         FROM mailerlite_retry WHERE idempotency_key = ?`
    )
      .bind('subscribe:abc')
      .first<{
        request_kind: string;
        request_payload: string;
        idempotency_key: string;
        attempts: number;
        last_status: number | null;
        last_error: string | null;
        next_attempt_at: number;
        created_at: number;
      }>();
    expect(row?.request_kind).toBe('subscribe');
    expect(JSON.parse(row!.request_payload)).toEqual({ email: 'a@b.com' });
    expect(row?.attempts).toBe(0);
    expect(row?.last_status).toBe(503);
    expect(row?.last_error).toMatch(/http_5xx/);
    expect(row?.created_at).toBe(1_700_000_000_000);
    expect(row?.next_attempt_at).toBe(1_700_000_000_000 + backoffMs(1));
  });

  it('redacts secrets from last_error so PII never lands in D1', async () => {
    const cause = new MailerLiteError(
      'subscribe',
      'network',
      'Authorization: Bearer ml_secret_token user@example.com'
    );
    await enqueue(DB, {
      kind: 'subscribe',
      payload: { email: 'user@example.com' },
      idempotencyKey: 'subscribe:redact',
      firstAttemptAtMs: 1_700_000_000_000,
      cause,
    });
    const row = await DB.prepare(
      `SELECT last_error FROM mailerlite_retry WHERE idempotency_key = ?`
    )
      .bind('subscribe:redact')
      .first<{ last_error: string }>();
    expect(row?.last_error).not.toContain('ml_secret_token');
    expect(row?.last_error).not.toContain('user@example.com');
    expect(row?.last_error).toMatch(/Bearer \[redacted\]|Authorization: \[redacted\]/);
  });

  it('is idempotent on duplicate key — preserves attempts, refreshes payload, clamps next_attempt_at down', async () => {
    const t0 = 1_700_000_000_000;
    await enqueue(DB, {
      kind: 'subscribe',
      payload: { email: 'a@b.com', cut: 'pork-butt' },
      idempotencyKey: 'subscribe:dup',
      firstAttemptAtMs: t0,
      cause: new MailerLiteError('subscribe', 'http_5xx', 'first', 503),
    });
    // Hand-set attempts to simulate one failed replay before the dup.
    await DB.prepare(`UPDATE mailerlite_retry SET attempts = 3 WHERE idempotency_key = ?`)
      .bind('subscribe:dup')
      .run();
    await enqueue(DB, {
      kind: 'subscribe',
      payload: { email: 'a@b.com', cut: 'brisket-flat' },
      idempotencyKey: 'subscribe:dup',
      firstAttemptAtMs: t0 + 1000,
      cause: new MailerLiteError('subscribe', 'http_5xx', 'second', 503),
    });
    const count = await DB.prepare(
      `SELECT COUNT(*) AS c FROM mailerlite_retry WHERE idempotency_key = ?`
    )
      .bind('subscribe:dup')
      .first<{ c: number }>();
    expect(count?.c).toBe(1);
    const row = await DB.prepare(
      `SELECT request_payload, attempts, last_error, next_attempt_at FROM mailerlite_retry WHERE idempotency_key = ?`
    )
      .bind('subscribe:dup')
      .first<{ request_payload: string; attempts: number; last_error: string; next_attempt_at: number }>();
    // Payload refreshed to the latest enqueue's input.
    expect(JSON.parse(row!.request_payload)).toEqual({ email: 'a@b.com', cut: 'brisket-flat' });
    // Attempts preserved across duplicate enqueue.
    expect(row?.attempts).toBe(3);
    expect(row?.last_error).toMatch(/second/);
    // next_attempt_at is the MIN of the two scheduled times.
    expect(row?.next_attempt_at).toBe(t0 + backoffMs(1));
  });
});

describe('mailerlite retry — drain', () => {
  it('skips rows whose next_attempt_at is in the future', async () => {
    const t0 = 1_700_000_000_000;
    await enqueue(DB, {
      kind: 'subscribe',
      payload: { email: 'a@b.com' },
      idempotencyKey: 'subscribe:k1',
      firstAttemptAtMs: t0,
      cause: new MailerLiteError('subscribe', 'http_5xx', 'x', 503),
    });
    const client = fakeClient();
    const outcomes = await drain(DB, client, { now: () => t0 + 1000 });
    expect(outcomes).toEqual([]);
    expect(client.subscribe).not.toHaveBeenCalled();
  });

  it('replays a due subscribe row and deletes it on success', async () => {
    const t0 = 1_700_000_000_000;
    await enqueue(DB, {
      kind: 'subscribe',
      payload: { email: 'a@b.com', metroSlug: 'austin-tx' },
      idempotencyKey: 'subscribe:ok',
      firstAttemptAtMs: t0,
      cause: new MailerLiteError('subscribe', 'http_5xx', 'x', 503),
    });
    const client = fakeClient();
    const outcomes = await drain(DB, client, {
      now: () => t0 + backoffMs(1) + 1,
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe('sent');
    expect(client.subscribe).toHaveBeenCalledWith({
      email: 'a@b.com',
      metroSlug: 'austin-tx',
    });
    const remaining = await DB.prepare(
      `SELECT COUNT(*) AS c FROM mailerlite_retry WHERE idempotency_key = ?`
    )
      .bind('subscribe:ok')
      .first<{ c: number }>();
    expect(remaining?.c).toBe(0);
  });

  it('on retryable failure: bumps attempts and reschedules with doubling backoff', async () => {
    const t0 = 1_700_000_000_000;
    await enqueue(DB, {
      kind: 'subscribe',
      payload: { email: 'a@b.com' },
      idempotencyKey: 'subscribe:retry',
      firstAttemptAtMs: t0,
      cause: new MailerLiteError('subscribe', 'http_5xx', 'first', 503),
    });
    const client = fakeClient({
      subscribe: vi
        .fn()
        .mockRejectedValueOnce(new MailerLiteError('subscribe', 'http_5xx', 'still down', 503)),
    });
    const drainAt = t0 + backoffMs(1) + 1;
    const outcomes = await drain(DB, client, { now: () => drainAt });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe('retry');
    const row = await DB.prepare(
      `SELECT attempts, last_status, last_error, next_attempt_at FROM mailerlite_retry WHERE idempotency_key = ?`
    )
      .bind('subscribe:retry')
      .first<{ attempts: number; last_status: number; last_error: string; next_attempt_at: number }>();
    expect(row?.attempts).toBe(1);
    expect(row?.last_status).toBe(503);
    expect(row?.last_error).toMatch(/still down/);
    // attempts=1 → next gap is backoffMs(2) = 2m, not 1m again.
    expect(row?.next_attempt_at).toBe(drainAt + backoffMs(2));
  });

  it('on non-retryable 4xx: drops the row AND writes an events audit row', async () => {
    const t0 = 1_700_000_000_000;
    await enqueue(DB, {
      kind: 'subscribe',
      payload: { email: 'a@b.com' },
      idempotencyKey: 'subscribe:drop',
      firstAttemptAtMs: t0,
      cause: new MailerLiteError('subscribe', 'http_5xx', 'x', 503),
    });
    const client = fakeClient({
      subscribe: vi
        .fn()
        .mockRejectedValueOnce(new MailerLiteError('subscribe', 'http_4xx', 'invalid', 422)),
    });
    const drainAt = t0 + backoffMs(1) + 1;
    const outcomes = await drain(DB, client, { now: () => drainAt });
    expect(outcomes[0]!.status).toBe('dropped');
    const remaining = await DB.prepare(
      `SELECT COUNT(*) AS c FROM mailerlite_retry WHERE idempotency_key = ?`
    )
      .bind('subscribe:drop')
      .first<{ c: number }>();
    expect(remaining?.c).toBe(0);
    const auditRow = await DB.prepare(
      `SELECT kind, payload FROM events ORDER BY id DESC LIMIT 1`
    ).first<{ kind: string; payload: string }>();
    expect(auditRow?.kind).toBe('error');
    const payload = JSON.parse(auditRow!.payload) as Record<string, unknown>;
    expect(payload.idempotency_key).toBe('subscribe:drop');
    expect(payload.status).toBe(422);
  });

  it('parks a row once attempts reaches MAX_ATTEMPTS and writes an audit row', async () => {
    const t0 = 1_700_000_000_000;
    await enqueue(DB, {
      kind: 'subscribe',
      payload: { email: 'a@b.com' },
      idempotencyKey: 'subscribe:park',
      firstAttemptAtMs: t0,
      cause: new MailerLiteError('subscribe', 'http_5xx', 'x', 503),
    });
    await DB.prepare(`UPDATE mailerlite_retry SET attempts = ? WHERE idempotency_key = ?`)
      .bind(MAX_ATTEMPTS - 1, 'subscribe:park')
      .run();
    const client = fakeClient({
      subscribe: vi
        .fn()
        .mockRejectedValueOnce(new MailerLiteError('subscribe', 'http_5xx', 'down', 503)),
    });
    const drainAt = t0 + backoffMs(1) + 1;
    const outcomes = await drain(DB, client, { now: () => drainAt });
    expect(outcomes[0]!.status).toBe('parked');
    const row = await DB.prepare(
      `SELECT attempts, next_attempt_at FROM mailerlite_retry WHERE idempotency_key = ?`
    )
      .bind('subscribe:park')
      .first<{ attempts: number; next_attempt_at: number }>();
    expect(row?.attempts).toBe(MAX_ATTEMPTS);
    expect(row?.next_attempt_at).toBe(drainAt + PARK_DELAY_MS);

    // Subsequent drains skip the parked row even when "now" is well past
    // the parked time, because attempts >= MAX_ATTEMPTS gates it out.
    client.subscribe = vi.fn();
    const second = await drain(DB, client, {
      now: () => drainAt + PARK_DELAY_MS + 1,
    });
    expect(second).toEqual([]);
    expect(client.subscribe).not.toHaveBeenCalled();

    // Audit row for the parking event.
    const auditRow = await DB.prepare(
      `SELECT kind FROM events ORDER BY id DESC LIMIT 1`
    ).first<{ kind: string }>();
    expect(auditRow?.kind).toBe('error');
  });

  it('respects batchSize and processes due rows in next_attempt_at order', async () => {
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) {
      await enqueue(DB, {
        kind: 'subscribe',
        payload: { email: `u${i}@example.com` },
        idempotencyKey: `subscribe:k${i}`,
        firstAttemptAtMs: t0 - i, // earlier first → drained first
        cause: new MailerLiteError('subscribe', 'http_5xx', 'x', 503),
      });
    }
    const client = fakeClient();
    const outcomes = await drain(DB, client, {
      batchSize: 2,
      now: () => t0 + backoffMs(1) + 100,
    });
    expect(outcomes).toHaveLength(2);
    const subscribe = client.subscribe as ReturnType<typeof vi.fn>;
    expect(subscribe.mock.calls.map((c) => (c[0] as { email: string }).email)).toEqual([
      'u4@example.com',
      'u3@example.com',
    ]);
  });

  it('drops a row whose request_payload is corrupted JSON', async () => {
    const t0 = 1_700_000_000_000;
    await DB.prepare(
      `INSERT INTO mailerlite_retry
         (request_kind, request_payload, idempotency_key, attempts, last_status, last_error, next_attempt_at, created_at)
         VALUES (?, ?, ?, 0, NULL, NULL, ?, ?)`
    )
      .bind('subscribe', 'not-json', 'subscribe:corrupt', t0, t0)
      .run();
    const client = fakeClient();
    const outcomes = await drain(DB, client, { now: () => t0 + 1 });
    expect(outcomes[0]!.status).toBe('dropped');
    const remaining = await DB.prepare(
      `SELECT COUNT(*) AS c FROM mailerlite_retry WHERE idempotency_key = ?`
    )
      .bind('subscribe:corrupt')
      .first<{ c: number }>();
    expect(remaining?.c).toBe(0);
    expect(client.subscribe).not.toHaveBeenCalled();
  });

  it('drops a payload missing the required email field instead of dispatching garbage', async () => {
    const t0 = 1_700_000_000_000;
    await DB.prepare(
      `INSERT INTO mailerlite_retry
         (request_kind, request_payload, idempotency_key, attempts, last_status, last_error, next_attempt_at, created_at)
         VALUES (?, ?, ?, 0, NULL, NULL, ?, ?)`
    )
      .bind('subscribe', JSON.stringify({ cooker: 'offset' }), 'subscribe:no-email', t0, t0)
      .run();
    const client = fakeClient();
    const outcomes = await drain(DB, client, { now: () => t0 + 1 });
    expect(outcomes[0]!.status).toBe('dropped');
    expect(client.subscribe).not.toHaveBeenCalled();
  });

  it('routes unsubscribe to the matching client method', async () => {
    const t0 = 1_700_000_000_000;
    await enqueue(DB, {
      kind: 'unsubscribe',
      payload: { email: 'gone@example.com' },
      idempotencyKey: 'unsubscribe:uns',
      firstAttemptAtMs: t0,
      cause: new MailerLiteError('unsubscribe', 'http_5xx', 'x', 503),
    });
    const client = fakeClient();
    await drain(DB, client, { now: () => t0 + backoffMs(1) + 100 });
    expect(client.unsubscribe).toHaveBeenCalledWith({ email: 'gone@example.com' });
  });

  it("leaves 'send' rows untouched in the queue for Step 11 to claim", async () => {
    // 'send' is a valid value of mailerlite_retry.request_kind (see
    // migration 0001) but no client method exists for it yet. Drain
    // must NOT touch these rows — silently dropping them would be
    // data loss before Step 11 ships. They sit in the queue and
    // Step 11's cron will pick them up.
    const t0 = 1_700_000_000_000;
    await DB.prepare(
      `INSERT INTO mailerlite_retry
         (request_kind, request_payload, idempotency_key, attempts, last_status, last_error, next_attempt_at, created_at)
         VALUES (?, ?, ?, 0, NULL, NULL, ?, ?)`
    )
      .bind('send', JSON.stringify({ campaignId: 'cmp_x' }), 'send:cmp_x', t0, t0)
      .run();
    const client = fakeClient();
    const outcomes = await drain(DB, client, { now: () => t0 + 1 });
    expect(outcomes).toEqual([]);
    expect(client.subscribe).not.toHaveBeenCalled();
    expect(client.unsubscribe).not.toHaveBeenCalled();
    // Row is still there — Step 11 will pick it up.
    const remaining = await DB.prepare(
      `SELECT COUNT(*) AS c FROM mailerlite_retry WHERE idempotency_key = ?`
    )
      .bind('send:cmp_x')
      .first<{ c: number }>();
    expect(remaining?.c).toBe(1);
  });
});
