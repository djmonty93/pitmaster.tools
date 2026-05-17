import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SenderClient } from '../../../src/lib/sender/client';
import { SenderError } from '../../../src/lib/sender/errors';
import {
  MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  PARK_DELAY_MS,
  backoffMs,
  drain,
  enqueue,
} from '../../../src/lib/sender/retry';
import { applyMigrations } from '../../helpers/d1';

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

beforeEach(async () => {
  await DB.prepare(`DELETE FROM sender_retry`).run();
  await DB.prepare(`DELETE FROM events`).run();
  await seedGroupIds();
});

function fakeClient(overrides: Partial<SenderClient> = {}): SenderClient {
  return {
    subscribe: vi.fn().mockResolvedValue({ id: 's_ok', email: 'x@y.com', status: 'active' }),
    updateSubscriberFields: vi.fn().mockResolvedValue({ id: 's_ok' }),
    getSubscriberByEmail: vi.fn().mockResolvedValue({ id: 's_ok' }),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    listGroups: vi.fn().mockResolvedValue([]),
    assignGroup: vi.fn().mockResolvedValue(undefined),
    removeGroup: vi.fn().mockResolvedValue(undefined),
    triggerWeeklyDigest: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as SenderClient;
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
    expect(backoffMs(9)).toBeLessThan(MAX_BACKOFF_MS);
    expect(backoffMs(10)).toBe(MAX_BACKOFF_MS);
    expect(backoffMs(100)).toBe(MAX_BACKOFF_MS);
  });
});

describe('sender retry — enqueue', () => {
  it('inserts a row with attempts=0 and the cause status/error', async () => {
    const cause = new SenderError('subscribe', 'http_5xx', 'status 503', 503);
    await enqueue(DB, {
      kind: 'subscribe',
      payload: { email: 'a@b.com', fields: {} },
      idempotencyKey: 'subscribe:abc',
      firstAttemptAtMs: 1_700_000_000_000,
      cause,
    });
    const row = await DB.prepare(
      `SELECT request_kind, request_payload, idempotency_key, attempts, last_status, last_error, next_attempt_at, created_at
         FROM sender_retry WHERE idempotency_key = ?`
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
    expect(JSON.parse(row!.request_payload)).toEqual({ email: 'a@b.com', fields: {} });
    expect(row?.attempts).toBe(0);
    expect(row?.last_status).toBe(503);
    expect(row?.last_error).toMatch(/http_5xx/);
    expect(row?.created_at).toBe(1_700_000_000_000);
    expect(row?.next_attempt_at).toBe(1_700_000_000_000 + backoffMs(1));
  });

  it('redacts secrets from last_error so PII never lands in D1', async () => {
    const cause = new SenderError(
      'subscribe',
      'network',
      'Authorization: Bearer ml_secret_token user@example.com'
    );
    await enqueue(DB, {
      kind: 'subscribe',
      payload: { email: 'user@example.com', fields: {} },
      idempotencyKey: 'subscribe:redact',
      firstAttemptAtMs: 1_700_000_000_000,
      cause,
    });
    const row = await DB.prepare(
      `SELECT last_error FROM sender_retry WHERE idempotency_key = ?`
    )
      .bind('subscribe:redact')
      .first<{ last_error: string }>();
    expect(row?.last_error).not.toContain('ml_secret_token');
    expect(row?.last_error).not.toContain('user@example.com');
    expect(row?.last_error).toMatch(/Bearer \[redacted\]|Authorization: \[redacted\]/);
  });

  it('uses cause.retryAfterMs for next_attempt_at when present (overrides backoffMs(1))', async () => {
    const t0 = 1_700_000_000_000;
    const cause = new SenderError('subscribe', 'http_4xx', 'rate limited', 429, 45_000);
    await enqueue(DB, {
      kind: 'subscribe',
      payload: { email: 'a@b.com', fields: {} },
      idempotencyKey: 'subscribe:retry-after',
      firstAttemptAtMs: t0,
      cause,
    });
    const row = await DB.prepare(
      `SELECT next_attempt_at FROM sender_retry WHERE idempotency_key = ?`
    )
      .bind('subscribe:retry-after')
      .first<{ next_attempt_at: number }>();
    // Should be ~t0 + 45_000, not t0 + backoffMs(1) (= t0 + 60_000).
    expect(Math.abs(row!.next_attempt_at - (t0 + 45_000))).toBeLessThan(1000);
  });

  it('is idempotent on duplicate key — preserves attempts, refreshes payload, clamps next_attempt_at down', async () => {
    const t0 = 1_700_000_000_000;
    await enqueue(DB, {
      kind: 'subscribe',
      payload: { email: 'a@b.com', fields: { bbq_cut_pref: 'pork-butt' } },
      idempotencyKey: 'subscribe:dup',
      firstAttemptAtMs: t0,
      cause: new SenderError('subscribe', 'http_5xx', 'first', 503),
    });
    await DB.prepare(`UPDATE sender_retry SET attempts = 3 WHERE idempotency_key = ?`)
      .bind('subscribe:dup')
      .run();
    await enqueue(DB, {
      kind: 'subscribe',
      payload: { email: 'a@b.com', fields: { bbq_cut_pref: 'brisket-flat' } },
      idempotencyKey: 'subscribe:dup',
      firstAttemptAtMs: t0 + 1000,
      cause: new SenderError('subscribe', 'http_5xx', 'second', 503),
    });
    const count = await DB.prepare(
      `SELECT COUNT(*) AS c FROM sender_retry WHERE idempotency_key = ?`
    )
      .bind('subscribe:dup')
      .first<{ c: number }>();
    expect(count?.c).toBe(1);
    const row = await DB.prepare(
      `SELECT request_payload, attempts, last_error, next_attempt_at FROM sender_retry WHERE idempotency_key = ?`
    )
      .bind('subscribe:dup')
      .first<{ request_payload: string; attempts: number; last_error: string; next_attempt_at: number }>();
    expect(JSON.parse(row!.request_payload)).toEqual({
      email: 'a@b.com',
      fields: { bbq_cut_pref: 'brisket-flat' },
    });
    expect(row?.attempts).toBe(3);
    expect(row?.last_error).toMatch(/second/);
    expect(row?.next_attempt_at).toBe(t0 + backoffMs(1));
  });
});

describe('sender retry — drain — subscribe', () => {
  const minimalFields = {
    bbq_zip: '78701',
    bbq_state: 'TX',
    bbq_region: 'south_central',
    bbq_timezone: 'America/Chicago',
  };

  it('skips rows whose next_attempt_at is in the future', async () => {
    const t0 = 1_700_000_000_000;
    await enqueue(DB, {
      kind: 'subscribe',
      payload: { email: 'a@b.com', fields: minimalFields, region: 'south_central' },
      idempotencyKey: 'subscribe:k1',
      firstAttemptAtMs: t0,
      cause: new SenderError('subscribe', 'http_5xx', 'x', 503),
    });
    const client = fakeClient();
    const outcomes = await drain(DB, client, KV, { now: () => t0 + 1000 });
    expect(outcomes).toEqual([]);
    expect(client.subscribe).not.toHaveBeenCalled();
    expect(client.assignGroup).not.toHaveBeenCalled();
  });

  it('replays subscribe AND assigns BBQ groups on the replay, then deletes the row', async () => {
    const t0 = 1_700_000_000_000;
    await enqueue(DB, {
      kind: 'subscribe',
      payload: { email: 'a@b.com', fields: minimalFields, region: 'south_central' },
      idempotencyKey: 'subscribe:ok',
      firstAttemptAtMs: t0,
      cause: new SenderError('subscribe', 'http_5xx', 'x', 503),
    });
    const client = fakeClient({
      subscribe: vi
        .fn()
        .mockResolvedValue({ id: 'sub_42', email: 'a@b.com', status: 'active' }),
    });
    const outcomes = await drain(DB, client, KV, { now: () => t0 + backoffMs(1) + 1 });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe('sent');
    expect(client.subscribe).toHaveBeenCalledWith({ email: 'a@b.com', fields: minimalFields });
    // assignGroup called for pitmaster_all (id=1) + pitmaster_south_central (id=5).
    const assignCalls = (client.assignGroup as ReturnType<typeof vi.fn>).mock.calls;
    expect(assignCalls).toHaveLength(2);
    expect(assignCalls).toEqual([
      ['sub_42', '1'],
      ['sub_42', '5'],
    ]);
    const remaining = await DB.prepare(
      `SELECT COUNT(*) AS c FROM sender_retry WHERE idempotency_key = ?`
    )
      .bind('subscribe:ok')
      .first<{ c: number }>();
    expect(remaining?.c).toBe(0);
  });

  it('detaches stale pitmaster_<oldRegion> after replay when payload carries oldRegion (region change during outage)', async () => {
    // Regression for [Self-P1] pass-14: when Sender.net is down during
    // a region-change resubscribe, the queued payload now carries the
    // prior region. After drain recovery the new groups assign AND the
    // stale regional group is detached — without this the user lands
    // in BOTH pitmaster_<old> and pitmaster_<new> after recovery and
    // gets two Friday digests.
    const t0 = 1_700_000_000_000;
    await enqueue(DB, {
      kind: 'subscribe',
      payload: {
        email: 'mover@example.com',
        fields: minimalFields,
        region: 'south_central',
        oldRegion: 'northeast',
      },
      idempotencyKey: 'subscribe:move',
      firstAttemptAtMs: t0,
      cause: new SenderError('subscribe', 'http_5xx', 'x', 503),
    });
    const client = fakeClient({
      subscribe: vi
        .fn()
        .mockResolvedValue({ id: 'sub_move', email: 'mover@example.com', status: 'active' }),
    });
    await drain(DB, client, KV, { now: () => t0 + backoffMs(1) + 1 });
    // Assigned to pitmaster_all (id=1) + pitmaster_south_central (id=5).
    const assignCalls = (client.assignGroup as ReturnType<typeof vi.fn>).mock.calls;
    expect(assignCalls).toEqual([
      ['sub_move', '1'],
      ['sub_move', '5'],
    ]);
    // Stale northeast group (id=2) MUST be detached.
    const removeCalls = (client.removeGroup as ReturnType<typeof vi.fn>).mock.calls;
    expect(removeCalls).toEqual([['sub_move', '2']]);
    // Row cleaned up.
    const remaining = await DB.prepare(
      `SELECT COUNT(*) AS c FROM sender_retry WHERE idempotency_key = ?`
    )
      .bind('subscribe:move')
      .first<{ c: number }>();
    expect(remaining?.c).toBe(0);
  });

  it('does NOT call removeGroup when oldRegion equals region (no-op region match)', async () => {
    const t0 = 1_700_000_000_000;
    await enqueue(DB, {
      kind: 'subscribe',
      payload: {
        email: 'same@example.com',
        fields: minimalFields,
        region: 'south_central',
        oldRegion: 'south_central',
      },
      idempotencyKey: 'subscribe:same',
      firstAttemptAtMs: t0,
      cause: new SenderError('subscribe', 'http_5xx', 'x', 503),
    });
    const client = fakeClient({
      subscribe: vi
        .fn()
        .mockResolvedValue({ id: 'sub_same', email: 'same@example.com', status: 'active' }),
    });
    await drain(DB, client, KV, { now: () => t0 + backoffMs(1) + 1 });
    expect((client.removeGroup as ReturnType<typeof vi.fn>).mock.calls).toEqual([]);
  });

  it('replays subscribe with no region → assigns pitmaster_all only', async () => {
    const t0 = 1_700_000_000_000;
    await enqueue(DB, {
      kind: 'subscribe',
      payload: { email: 'a@b.com', fields: { bbq_zip: '99999', bbq_state: 'CA', bbq_region: 'pacific', bbq_timezone: 'UTC' }, region: null },
      idempotencyKey: 'subscribe:noregion',
      firstAttemptAtMs: t0,
      cause: new SenderError('subscribe', 'http_5xx', 'x', 503),
    });
    const client = fakeClient({
      subscribe: vi.fn().mockResolvedValue({ id: 'sub_x', email: 'a@b.com', status: 'active' }),
    });
    await drain(DB, client, KV, { now: () => t0 + backoffMs(1) + 1 });
    const assignCalls = (client.assignGroup as ReturnType<typeof vi.fn>).mock.calls;
    expect(assignCalls).toEqual([['sub_x', '1']]);
  });

  it('replays a staged group_assign payload — no subscribe call, just groups', async () => {
    const t0 = 1_700_000_000_000;
    await enqueue(DB, {
      kind: 'subscribe',
      payload: {
        stage: 'group_assign',
        subscriberId: 'sub_99',
        region: 'northeast',
      },
      idempotencyKey: 'group_assign:sub_99',
      firstAttemptAtMs: t0,
      cause: new SenderError('group_assign', 'http_5xx', 'x', 503),
    });
    const client = fakeClient();
    await drain(DB, client, KV, { now: () => t0 + backoffMs(1) + 1 });
    expect(client.subscribe).not.toHaveBeenCalled();
    const assignCalls = (client.assignGroup as ReturnType<typeof vi.fn>).mock.calls;
    expect(assignCalls).toEqual([
      ['sub_99', '1'],
      ['sub_99', '2'],
    ]);
  });

  it('detaches stale pitmaster_<oldRegion> on group_assign stage replay (region change during outage)', async () => {
    // Regression for [Codex P2] pass-15: when Sender.net's subscribe
    // succeeds but assignBbqGroups fails, the queued group_assign
    // retry now carries oldRegion. After drain recovery the new
    // regional group is assigned AND the stale one is detached —
    // without this the user lands in both regional audiences.
    const t0 = 1_700_000_000_000;
    await enqueue(DB, {
      kind: 'subscribe',
      payload: {
        stage: 'group_assign',
        subscriberId: 'sub_move',
        region: 'south_central',
        oldRegion: 'northeast',
      },
      idempotencyKey: 'group_assign:sub_move',
      firstAttemptAtMs: t0,
      cause: new SenderError('group_assign', 'http_5xx', 'x', 503),
    });
    const client = fakeClient();
    await drain(DB, client, KV, { now: () => t0 + backoffMs(1) + 1 });
    // Assigned to pitmaster_all (id=1) + pitmaster_south_central (id=5).
    const assignCalls = (client.assignGroup as ReturnType<typeof vi.fn>).mock.calls;
    expect(assignCalls).toEqual([
      ['sub_move', '1'],
      ['sub_move', '5'],
    ]);
    // Stale northeast group (id=2) detached.
    const removeCalls = (client.removeGroup as ReturnType<typeof vi.fn>).mock.calls;
    expect(removeCalls).toEqual([['sub_move', '2']]);
  });

  it('does NOT detach when group_assign stage oldRegion matches region', async () => {
    const t0 = 1_700_000_000_000;
    await enqueue(DB, {
      kind: 'subscribe',
      payload: {
        stage: 'group_assign',
        subscriberId: 'sub_same',
        region: 'south_central',
        oldRegion: 'south_central',
      },
      idempotencyKey: 'group_assign:sub_same',
      firstAttemptAtMs: t0,
      cause: new SenderError('group_assign', 'http_5xx', 'x', 503),
    });
    const client = fakeClient();
    await drain(DB, client, KV, { now: () => t0 + backoffMs(1) + 1 });
    expect((client.removeGroup as ReturnType<typeof vi.fn>).mock.calls).toEqual([]);
  });

  it('replays a staged preferences payload via updateSubscriberFields (no status:active, no group ops)', async () => {
    // Regression for [Self-P1] pass-14: the preferences-stage drain
    // path used to call client.subscribe which sends status:'active',
    // so an unsubscribe that landed between enqueue and drain replay
    // would be silently reverted. updateSubscriberFields omits status.
    const t0 = 1_700_000_000_000;
    await enqueue(DB, {
      kind: 'subscribe',
      payload: {
        stage: 'preferences',
        email: 'p@example.com',
        fields: { bbq_cut_pref: 'pork-butt', bbq_cooker_pref: 'offset' },
      },
      idempotencyKey: 'preferences:p@example.com',
      firstAttemptAtMs: t0,
      cause: new SenderError('subscribe', 'http_5xx', 'x', 503),
    });
    const client = fakeClient();
    await drain(DB, client, KV, { now: () => t0 + backoffMs(1) + 1 });
    expect(client.subscribe).not.toHaveBeenCalled();
    expect(client.assignGroup).not.toHaveBeenCalled();
    expect(client.updateSubscriberFields).toHaveBeenCalledWith(
      'p@example.com',
      { bbq_cut_pref: 'pork-butt', bbq_cooker_pref: 'offset' }
    );
  });

  it('on retryable failure during subscribe: bumps attempts and reschedules with doubling backoff', async () => {
    const t0 = 1_700_000_000_000;
    await enqueue(DB, {
      kind: 'subscribe',
      payload: { email: 'a@b.com', fields: minimalFields, region: 'south_central' },
      idempotencyKey: 'subscribe:retry',
      firstAttemptAtMs: t0,
      cause: new SenderError('subscribe', 'http_5xx', 'first', 503),
    });
    const client = fakeClient({
      subscribe: vi
        .fn()
        .mockRejectedValueOnce(new SenderError('subscribe', 'http_5xx', 'still down', 503)),
    });
    const drainAt = t0 + backoffMs(1) + 1;
    const outcomes = await drain(DB, client, KV, { now: () => drainAt });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe('retry');
    const row = await DB.prepare(
      `SELECT attempts, last_status, last_error, next_attempt_at FROM sender_retry WHERE idempotency_key = ?`
    )
      .bind('subscribe:retry')
      .first<{ attempts: number; last_status: number; last_error: string; next_attempt_at: number }>();
    expect(row?.attempts).toBe(1);
    expect(row?.last_status).toBe(503);
    expect(row?.last_error).toMatch(/still down/);
    expect(row?.next_attempt_at).toBe(drainAt + backoffMs(2));
  });

  it('on non-retryable 4xx during subscribe: drops the row AND writes an events audit row', async () => {
    const t0 = 1_700_000_000_000;
    await enqueue(DB, {
      kind: 'subscribe',
      payload: { email: 'a@b.com', fields: minimalFields, region: 'south_central' },
      idempotencyKey: 'subscribe:drop',
      firstAttemptAtMs: t0,
      cause: new SenderError('subscribe', 'http_5xx', 'x', 503),
    });
    const client = fakeClient({
      subscribe: vi
        .fn()
        .mockRejectedValueOnce(new SenderError('subscribe', 'http_4xx', 'invalid', 422)),
    });
    const drainAt = t0 + backoffMs(1) + 1;
    const outcomes = await drain(DB, client, KV, { now: () => drainAt });
    expect(outcomes[0]!.status).toBe('dropped');
    const remaining = await DB.prepare(
      `SELECT COUNT(*) AS c FROM sender_retry WHERE idempotency_key = ?`
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

  it('parks a row once attempts reaches MAX_ATTEMPTS', async () => {
    const t0 = 1_700_000_000_000;
    await enqueue(DB, {
      kind: 'subscribe',
      payload: { email: 'a@b.com', fields: minimalFields, region: 'south_central' },
      idempotencyKey: 'subscribe:park',
      firstAttemptAtMs: t0,
      cause: new SenderError('subscribe', 'http_5xx', 'x', 503),
    });
    await DB.prepare(`UPDATE sender_retry SET attempts = ? WHERE idempotency_key = ?`)
      .bind(MAX_ATTEMPTS - 1, 'subscribe:park')
      .run();
    const client = fakeClient({
      subscribe: vi
        .fn()
        .mockRejectedValueOnce(new SenderError('subscribe', 'http_5xx', 'down', 503)),
    });
    const drainAt = t0 + backoffMs(1) + 1;
    const outcomes = await drain(DB, client, KV, { now: () => drainAt });
    expect(outcomes[0]!.status).toBe('parked');
    const row = await DB.prepare(
      `SELECT attempts, next_attempt_at FROM sender_retry WHERE idempotency_key = ?`
    )
      .bind('subscribe:park')
      .first<{ attempts: number; next_attempt_at: number }>();
    expect(row?.attempts).toBe(MAX_ATTEMPTS);
    expect(row?.next_attempt_at).toBe(drainAt + PARK_DELAY_MS);

    client.subscribe = vi.fn();
    const second = await drain(DB, client, KV, {
      now: () => drainAt + PARK_DELAY_MS + 1,
    });
    expect(second).toEqual([]);
    expect(client.subscribe).not.toHaveBeenCalled();

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
        payload: {
          email: `u${i}@example.com`,
          fields: minimalFields,
          region: 'south_central',
        },
        idempotencyKey: `subscribe:k${i}`,
        firstAttemptAtMs: t0 - i,
        cause: new SenderError('subscribe', 'http_5xx', 'x', 503),
      });
    }
    const client = fakeClient();
    const outcomes = await drain(DB, client, KV, {
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
      `INSERT INTO sender_retry
         (request_kind, request_payload, idempotency_key, attempts, last_status, last_error, next_attempt_at, created_at)
         VALUES (?, ?, ?, 0, NULL, NULL, ?, ?)`
    )
      .bind('subscribe', 'not-json', 'subscribe:corrupt', t0, t0)
      .run();
    const client = fakeClient();
    const outcomes = await drain(DB, client, KV, { now: () => t0 + 1 });
    expect(outcomes[0]!.status).toBe('dropped');
    const remaining = await DB.prepare(
      `SELECT COUNT(*) AS c FROM sender_retry WHERE idempotency_key = ?`
    )
      .bind('subscribe:corrupt')
      .first<{ c: number }>();
    expect(remaining?.c).toBe(0);
    expect(client.subscribe).not.toHaveBeenCalled();
  });

  it('drops a payload missing email or fields instead of dispatching garbage', async () => {
    const t0 = 1_700_000_000_000;
    await DB.prepare(
      `INSERT INTO sender_retry
         (request_kind, request_payload, idempotency_key, attempts, last_status, last_error, next_attempt_at, created_at)
         VALUES (?, ?, ?, 0, NULL, NULL, ?, ?)`
    )
      .bind('subscribe', JSON.stringify({ email: 'a@b.com' }), 'subscribe:no-fields', t0, t0)
      .run();
    const client = fakeClient();
    const outcomes = await drain(DB, client, KV, { now: () => t0 + 1 });
    expect(outcomes[0]!.status).toBe('dropped');
    expect(client.subscribe).not.toHaveBeenCalled();
  });
});

describe('sender retry — drain — unsubscribe', () => {
  it('replays unsubscribe via getSubscriberByEmail + removeBbqGroups, NEVER calls client.unsubscribe', async () => {
    // Regression for the [P1] account-wide-unsubscribe bug. Replaying
    // an unsubscribe row must NOT mark the subscriber unsubscribed at
    // the Sender.net account level — that would detach them from
    // sibling-site groups (powersizing_*, etc) too.
    const t0 = 1_700_000_000_000;
    await enqueue(DB, {
      kind: 'unsubscribe',
      payload: { email: 'gone@example.com' },
      idempotencyKey: 'unsubscribe:uns',
      firstAttemptAtMs: t0,
      cause: new SenderError('unsubscribe', 'http_5xx', 'x', 503),
    });
    const client = fakeClient({
      getSubscriberByEmail: vi.fn().mockResolvedValue({ id: 'sub_77' }),
    });
    await drain(DB, client, KV, { now: () => t0 + backoffMs(1) + 100 });
    expect(client.getSubscriberByEmail).toHaveBeenCalledWith('gone@example.com');
    // Seven DELETE calls (all-group + six regions) — none was 404, the
    // fake resolves cleanly.
    const removeCalls = (client.removeGroup as ReturnType<typeof vi.fn>).mock.calls;
    expect(removeCalls).toHaveLength(7);
    expect(new Set(removeCalls.map((c) => c[1]))).toEqual(
      new Set(['1', '2', '3', '4', '5', '6', '7'])
    );
    // The forbidden call.
    expect(client.unsubscribe).not.toHaveBeenCalled();
  });

  it('replays unsubscribe with pre-resolved subscriberId — skips the lookup, removes groups only', async () => {
    const t0 = 1_700_000_000_000;
    await enqueue(DB, {
      kind: 'unsubscribe',
      payload: {
        email: 'gone@example.com',
        subscriberId: 'sub_88',
      },
      idempotencyKey: 'unsubscribe:uns',
      firstAttemptAtMs: t0,
      cause: new SenderError('unsubscribe', 'http_5xx', 'x', 503),
    });
    const client = fakeClient();
    await drain(DB, client, KV, { now: () => t0 + backoffMs(1) + 100 });
    expect(client.getSubscriberByEmail).not.toHaveBeenCalled();
    expect(client.unsubscribe).not.toHaveBeenCalled();
    const removeCalls = (client.removeGroup as ReturnType<typeof vi.fn>).mock.calls;
    expect(removeCalls.every((c) => c[0] === 'sub_88')).toBe(true);
    expect(removeCalls).toHaveLength(7);
  });

  it('replays unsubscribe → subscriber not in Sender.net (null) → no-op, deletes the row', async () => {
    const t0 = 1_700_000_000_000;
    await enqueue(DB, {
      kind: 'unsubscribe',
      payload: { email: 'gone@example.com' },
      idempotencyKey: 'unsubscribe:notfound',
      firstAttemptAtMs: t0,
      cause: new SenderError('unsubscribe', 'http_5xx', 'x', 503),
    });
    const client = fakeClient({
      getSubscriberByEmail: vi.fn().mockResolvedValue(null),
    });
    const outcomes = await drain(DB, client, KV, { now: () => t0 + backoffMs(1) + 100 });
    expect(outcomes[0]!.status).toBe('sent');
    expect(client.removeGroup).not.toHaveBeenCalled();
    const remaining = await DB.prepare(
      `SELECT COUNT(*) AS c FROM sender_retry WHERE idempotency_key = ?`
    )
      .bind('unsubscribe:notfound')
      .first<{ c: number }>();
    expect(remaining?.c).toBe(0);
  });
});
