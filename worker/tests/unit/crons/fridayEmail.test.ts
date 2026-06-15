import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  regionLocalFridaySlot,
  runFridayCron,
  type FridayCronOutcome,
  type FridayCronOptions,
} from '../../../src/crons/fridayEmail';
import type { SenderClient, SendCampaignInput } from '../../../src/lib/sender/client';
import { SenderError } from '../../../src/lib/sender/errors';
import type { Env } from '../../../src/index';
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

beforeEach(async () => {
  await DB.prepare(`DELETE FROM friday_campaign_log`).run();
  await DB.prepare(`DELETE FROM events`).run();
});

/** A UTC instant that resolves to Fri 06:00 in America/New_York during DST. */
const FRIDAY_6AM_ET = new Date('2026-05-15T10:00:00Z');
/** Fri 06:00 in America/Chicago (DST). */
const FRIDAY_6AM_CT = new Date('2026-05-15T11:00:00Z');
/** Fri 06:00 in America/Denver (DST). */
const FRIDAY_6AM_MT = new Date('2026-05-15T12:00:00Z');
/** Fri 06:00 in America/Los_Angeles (DST). */
const FRIDAY_6AM_PT = new Date('2026-05-15T13:00:00Z');
/**
 * Fri 06:00 in America/Los_Angeles during STANDARD time (PT = UTC-8).
 * 2026-01-16 is a Friday in January, well clear of DST cutovers. The
 * cron range MUST include this UTC hour or pacific subscribers get no
 * digest for the four winter months — that was the [P2] cron-range bug.
 */
const FRIDAY_6AM_PT_STANDARD = new Date('2026-01-16T14:00:00Z');

/**
 * The cron now builds the HTML itself; tests inject a fixed digest so
 * the state machine is exercised without real metros/forecasts. The
 * dedicated buildRegionDigest + digestEmail tests cover content.
 */
const DIGEST_STUB: NonNullable<FridayCronOptions['buildDigest']> = async (region, sendDate) => ({
  subject: `Weekend forecast — ${region} ${sendDate}`,
  html: '<p>forecast</p>',
});

function buildEnv(overrides: Partial<Env> = {}): Env {
  const base: Env = {
    ASSETS: undefined as unknown as Fetcher,
    WEATHER_KV: KV,
    SMOKE_DB: DB,
    SENDER_API_TOKEN: 'sender_test_token',
    SUBSCRIBER_TOKEN_SECRET: 'test-secret-32-bytes-long-aaaaaaaaa',
    SENDER_FROM_EMAIL: 'forecast@pitmaster.tools',
    SENDER_FROM_NAME: 'Pitmaster Tools',
  };
  return { ...base, ...overrides };
}

const ALL_GROUPS = [
  { id: 'g_all', name: 'pitmaster_all' },
  { id: 'g_northeast', name: 'pitmaster_northeast' },
  { id: 'g_southeast', name: 'pitmaster_southeast' },
  { id: 'g_midwest', name: 'pitmaster_midwest' },
  { id: 'g_south_central', name: 'pitmaster_south_central' },
  { id: 'g_mountain', name: 'pitmaster_mountain' },
  { id: 'g_pacific', name: 'pitmaster_pacific' },
];

/**
 * A fake SenderClient. `send` drives sendCampaign (the broadcast call
 * that can fail); createCampaign always succeeds with a fixed id, and
 * listGroups resolves the pitmaster_* groups so resolveGroupId works.
 */
function fakeClient(
  send: (input: SendCampaignInput) => Promise<void> = async () => {}
): SenderClient {
  return {
    subscribe: vi.fn(),
    updateSubscriberFields: vi.fn(),
    getSubscriberByEmail: vi.fn(),
    unsubscribe: vi.fn(),
    listGroups: vi.fn().mockResolvedValue(ALL_GROUPS),
    assignGroup: vi.fn(),
    removeGroup: vi.fn(),
    createCampaign: vi.fn().mockResolvedValue({ campaignId: 'camp_1' }),
    sendCampaign: vi.fn().mockImplementation(send),
  } as SenderClient;
}

/** Standard options: a fake client + the digest stub. */
function opts(send?: (input: SendCampaignInput) => Promise<void>, extra: Partial<FridayCronOptions> = {}): FridayCronOptions {
  return { client: fakeClient(send), buildDigest: DIGEST_STUB, ...extra };
}

describe('regionLocalFridaySlot', () => {
  it('returns Fri 06:00 for the anchor tz at the right UTC instant', () => {
    expect(regionLocalFridaySlot(FRIDAY_6AM_ET, 'northeast')).toEqual({
      date: '2026-05-15',
      weekday: 'Fri',
      hour: 6,
    });
    expect(regionLocalFridaySlot(FRIDAY_6AM_ET, 'southeast')).toEqual({
      date: '2026-05-15',
      weekday: 'Fri',
      hour: 6,
    });
    expect(regionLocalFridaySlot(FRIDAY_6AM_CT, 'midwest')).toEqual({
      date: '2026-05-15',
      weekday: 'Fri',
      hour: 6,
    });
    expect(regionLocalFridaySlot(FRIDAY_6AM_PT, 'pacific')).toEqual({
      date: '2026-05-15',
      weekday: 'Fri',
      hour: 6,
    });
  });

  it('returns a non-Fri-06 slot for off-cycle ticks', () => {
    // 10:00 UTC is NOT 6am Pacific (that's 13:00 UTC in DST).
    const slot = regionLocalFridaySlot(FRIDAY_6AM_ET, 'pacific');
    expect(slot?.hour).not.toBe(6);
  });
});

describe('runFridayCron — region-by-region', () => {
  it('sends to the eastern-anchor regions at 10:00 UTC (Fri 6am ET)', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient(send);
    const outcomes = await runFridayCron(buildEnv(), FRIDAY_6AM_ET, { client, buildDigest: DIGEST_STUB });
    const sent = outcomes.filter((o) => o.status === 'sent');
    expect(sent.map((o) => (o as Extract<FridayCronOutcome, { status: 'sent' }>).region).sort()).toEqual([
      'northeast',
      'southeast',
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    // Each region builds + sends its own campaign, named per (region, send_date).
    expect(client.createCampaign).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'pitmaster northeast 2026-05-15', groupId: 'g_northeast' })
    );
    expect(client.createCampaign).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'pitmaster southeast 2026-05-15', groupId: 'g_southeast' })
    );
    // The other 4 regions are 'skipped' as not-local-friday-6.
    const skipped = outcomes.filter(
      (o) => o.status === 'skipped' && o.reason === 'not-local-friday-6'
    );
    expect(skipped).toHaveLength(4);
  });

  it('sends central-anchor regions at 11:00 UTC, mountain at 12:00, pacific at 13:00', async () => {
    const sendCt = vi.fn().mockResolvedValue(undefined);
    const ct = await runFridayCron(buildEnv(), FRIDAY_6AM_CT, opts(sendCt));
    expect(sendCt).toHaveBeenCalledTimes(2);
    expect(ct.filter((o) => o.status === 'sent').map((o) => (o as { region: string }).region).sort()).toEqual(
      ['midwest', 'south_central']
    );

    await DB.prepare(`DELETE FROM friday_campaign_log`).run();
    const sendMt = vi.fn().mockResolvedValue(undefined);
    const mt = await runFridayCron(buildEnv(), FRIDAY_6AM_MT, opts(sendMt));
    expect(sendMt).toHaveBeenCalledTimes(1);
    expect(mt.filter((o) => o.status === 'sent')[0]).toMatchObject({ region: 'mountain' });

    await DB.prepare(`DELETE FROM friday_campaign_log`).run();
    const sendPt = vi.fn().mockResolvedValue(undefined);
    const pt = await runFridayCron(buildEnv(), FRIDAY_6AM_PT, opts(sendPt));
    expect(sendPt).toHaveBeenCalledTimes(1);
    expect(pt.filter((o) => o.status === 'sent')[0]).toMatchObject({ region: 'pacific' });
  });

  it('claims an idempotency slot before sending — a second run on the same Friday is a no-op', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await runFridayCron(buildEnv(), FRIDAY_6AM_ET, opts(send));
    const send2 = vi.fn().mockResolvedValue(undefined);
    const second = await runFridayCron(buildEnv(), FRIDAY_6AM_ET, opts(send2));
    const sentInSecond = second.filter((o) => o.status === 'sent');
    expect(sentInSecond).toHaveLength(0);
    const alreadySent = second.filter(
      (o) => o.status === 'skipped' && o.reason === 'already-sent'
    );
    expect(alreadySent).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(2); // only the first run
    expect(send2).not.toHaveBeenCalled();
  });

  it('skips every in-window region when SENDER_FROM_EMAIL is unset (dark-disabled)', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const outcomes = await runFridayCron(
      buildEnv({ SENDER_FROM_EMAIL: undefined }),
      FRIDAY_6AM_ET,
      opts(send)
    );
    expect(send).not.toHaveBeenCalled();
    const ne = outcomes.find((o) => o.region === 'northeast')!;
    const se = outcomes.find((o) => o.region === 'southeast')!;
    expect(ne.status).toBe('skipped');
    expect((ne as Extract<FridayCronOutcome, { status: 'skipped' }>).reason).toBe('not-configured');
    expect(se.status).toBe('skipped');
    expect((se as Extract<FridayCronOutcome, { status: 'skipped' }>).reason).toBe('not-configured');
  });

  it('writes one events row per in-window region when dark-disabled', async () => {
    await runFridayCron(
      buildEnv({ SENDER_FROM_EMAIL: undefined }),
      FRIDAY_6AM_ET,
      opts()
    );
    const rows = await DB.prepare(
      `SELECT kind, payload FROM events WHERE kind = 'error'`
    ).all<{ kind: string; payload: string }>();
    // Both ET-anchored regions (northeast + southeast) are in-window.
    expect(rows.results).toHaveLength(2);
    for (const row of rows.results) {
      const parsed = JSON.parse(row.payload) as { source: string; region: string; send_date: string; reason: string };
      expect(parsed.source).toBe('friday_cron');
      expect(['northeast', 'southeast']).toContain(parsed.region);
      expect(parsed.send_date).toBe('2026-05-15');
      expect(parsed.reason).toBe('not-configured');
    }
  });

  it('does NOT write a second events row on a repeated cron invocation while dark-disabled', async () => {
    const darkEnv = buildEnv({ SENDER_FROM_EMAIL: undefined });
    await runFridayCron(darkEnv, FRIDAY_6AM_ET, opts());
    await runFridayCron(darkEnv, FRIDAY_6AM_ET, opts());
    const rows = await DB.prepare(
      `SELECT kind FROM events WHERE kind = 'error'`
    ).all<{ kind: string }>();
    // Two regions × one row each, deduped across the two invocations.
    expect(rows.results).toHaveLength(2);
  });

  it('records a sent event in the events table on success', async () => {
    await runFridayCron(buildEnv(), FRIDAY_6AM_ET, opts());
    const rows = await DB.prepare(`SELECT kind, payload FROM events ORDER BY id`).all<{
      kind: string;
      payload: string;
    }>();
    expect(rows.results).toHaveLength(2);
    for (const row of rows.results) {
      expect(row.kind).toBe('send');
      const parsed = JSON.parse(row.payload) as { region: string; send_date: string; outcome: string };
      expect(['northeast', 'southeast']).toContain(parsed.region);
      expect(parsed.send_date).toBe('2026-05-15');
      expect(parsed.outcome).toBe('sent');
    }
  });

  it('reverts to queued + throws on a retryable send failure so Cloudflare auto-retry fires', async () => {
    // Regression for the [P1] pass-3 finding: leaving the row at
    // 'queued' is not enough — the scheduled handler must also throw
    // so Cloudflare's auto-retry actually runs the cron again.
    const send = vi.fn().mockRejectedValue(
      new SenderError('campaign_send', 'http_5xx', 'status 503', 503)
    );
    await expect(
      runFridayCron(buildEnv(), FRIDAY_6AM_ET, opts(send))
    ).rejects.toThrow('Friday cron: retry required (failed retryable or retry-after pending)');
    const log = await DB.prepare(
      `SELECT region, status FROM friday_campaign_log ORDER BY region`
    ).all<{ region: string; status: string }>();
    expect(log.results.every((r) => r.status === 'queued')).toBe(true);
    const errorRows = await DB.prepare(
      `SELECT payload FROM events WHERE kind = 'error'`
    ).all<{ payload: string }>();
    expect(errorRows.results).toHaveLength(2);
    for (const row of errorRows.results) {
      expect(row.payload).toContain('(retryable)');
    }
  });

  it('outcome.retryable is true for retryable failures and false for non-retryable', async () => {
    const retryableSend = vi.fn().mockRejectedValue(
      new SenderError('campaign_send', 'http_5xx', 'x', 503)
    );
    const retryableOutcomes = await runFridayCron(buildEnv(), FRIDAY_6AM_ET,
      opts(retryableSend, { swallowRetryableThrow: true }));
    const r = retryableOutcomes.find((o) => o.status === 'failed')!;
    expect((r as Extract<FridayCronOutcome, { status: 'failed' }>).retryable).toBe(true);

    await DB.prepare(`DELETE FROM friday_campaign_log`).run();
    const nonRetryableSend = vi.fn().mockRejectedValue(
      new SenderError('campaign_send', 'http_4xx', 'x', 400)
    );
    const nonRetryableOutcomes = await runFridayCron(buildEnv(), FRIDAY_6AM_ET, opts(nonRetryableSend));
    const n = nonRetryableOutcomes.find((o) => o.status === 'failed')!;
    expect((n as Extract<FridayCronOutcome, { status: 'failed' }>).retryable).toBe(false);
  });

  it('a retryable failure followed by a successful retry re-claims the row and marks it sent', async () => {
    const failingSend = vi.fn().mockRejectedValue(
      new SenderError('campaign_send', 'http_5xx', 'transient', 503)
    );
    await runFridayCron(buildEnv(), FRIDAY_6AM_ET, opts(failingSend, { swallowRetryableThrow: true }));
    expect(failingSend).toHaveBeenCalledTimes(2);
    const interim = await DB.prepare(
      `SELECT status FROM friday_campaign_log ORDER BY region`
    ).all<{ status: string }>();
    expect(interim.results.every((r) => r.status === 'queued')).toBe(true);

    const okSend = vi.fn().mockResolvedValue(undefined);
    const outcomes = await runFridayCron(buildEnv(), FRIDAY_6AM_ET, opts(okSend));
    expect(outcomes.filter((o) => o.status === 'sent')).toHaveLength(2);
    expect(okSend).toHaveBeenCalledTimes(2);
    const log = await DB.prepare(
      `SELECT status FROM friday_campaign_log ORDER BY region`
    ).all<{ status: string }>();
    expect(log.results.every((r) => r.status === 'sent')).toBe(true);
  });

  it("a concurrent claim against a fresh 'sending' row reports retryable failure (not already-sent)", async () => {
    const fixedNow = FRIDAY_6AM_ET;
    await DB.prepare(
      `INSERT INTO friday_campaign_log (region, send_date, status, attempted_at)
         VALUES ('northeast', '2026-05-15', 'sending', ?)`
    )
      .bind(fixedNow.getTime())
      .run();
    const send = vi.fn().mockResolvedValue(undefined);
    const outcomes = await runFridayCron(buildEnv(), FRIDAY_6AM_ET,
      opts(send, { now: () => fixedNow, swallowRetryableThrow: true }));
    const ne = outcomes.find((o) => o.region === 'northeast')!;
    expect(ne.status).toBe('failed');
    expect((ne as Extract<FridayCronOutcome, { status: 'failed' }>).retryable).toBe(true);
    expect((ne as Extract<FridayCronOutcome, { status: 'failed' }>).error).toMatch(
      /claim contested.*sending/
    );
    // Southeast (no seeded row) still proceeds normally.
    const se = outcomes.find((o) => o.region === 'southeast')!;
    expect(se.status).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("throws (so Cloudflare retries) when a region's claim is contested by a fresh 'sending' lock", async () => {
    const fixedNow = FRIDAY_6AM_ET;
    await DB.prepare(
      `INSERT INTO friday_campaign_log (region, send_date, status, attempted_at)
         VALUES ('northeast', '2026-05-15', 'sending', ?)`
    )
      .bind(fixedNow.getTime())
      .run();
    await expect(
      runFridayCron(buildEnv(), FRIDAY_6AM_ET, opts(undefined, { now: () => fixedNow }))
    ).rejects.toThrow('Friday cron: retry required (failed retryable or retry-after pending)');
  });

  it("reports 'sent' even if the post-send D1 UPDATE fails — does NOT revert the row to a re-claimable state", async () => {
    const fixedNow = FRIDAY_6AM_ET;
    const realEnv = buildEnv();
    let sendCalled = 0;
    const sabotagedEnv = {
      ...realEnv,
      SMOKE_DB: {
        prepare(sql: string) {
          const stmt = realEnv.SMOKE_DB.prepare(sql);
          if (sql.includes('UPDATE friday_campaign_log') && sendCalled > 0) {
            return {
              bind: () => ({
                run: async () => {
                  throw new Error('d1 transient failure');
                },
              }),
            };
          }
          return stmt;
        },
      } as unknown as D1Database,
    } as typeof realEnv;
    const send = vi.fn().mockImplementation(async () => {
      sendCalled += 1;
    });
    const outcomes = await runFridayCron(sabotagedEnv, FRIDAY_6AM_ET,
      opts(send, { now: () => fixedNow }));
    expect(send).toHaveBeenCalledTimes(2);
    const triggered = outcomes.filter((o) => o.status !== 'skipped');
    expect(triggered).toHaveLength(2);
    expect(triggered.every((o) => o.status === 'sent')).toBe(true);
  });

  it("a row already in 'sent' state is a true skip (already-sent)", async () => {
    const fixedNow = FRIDAY_6AM_ET;
    await DB.prepare(
      `INSERT INTO friday_campaign_log (region, send_date, status, attempted_at)
         VALUES ('northeast', '2026-05-15', 'sent', ?)`
    )
      .bind(fixedNow.getTime())
      .run();
    const send = vi.fn().mockResolvedValue(undefined);
    const outcomes = await runFridayCron(buildEnv(), FRIDAY_6AM_ET,
      opts(send, { now: () => fixedNow }));
    const ne = outcomes.find((o) => o.region === 'northeast')!;
    expect(ne.status).toBe('skipped');
    expect((ne as Extract<FridayCronOutcome, { status: 'skipped' }>).reason).toBe('already-sent');
  });

  it("a stale 'sending' row (> 5 minutes old) is re-claimable", async () => {
    const fixedNow = FRIDAY_6AM_ET;
    await DB.prepare(
      `INSERT INTO friday_campaign_log (region, send_date, status, attempted_at)
         VALUES ('northeast', '2026-05-15', 'sending', ?)`
    )
      .bind(fixedNow.getTime() - 10 * 60 * 1000)
      .run();
    const send = vi.fn().mockResolvedValue(undefined);
    const outcomes = await runFridayCron(buildEnv(), FRIDAY_6AM_ET,
      opts(send, { now: () => fixedNow }));
    const ne = outcomes.find((o) => o.region === 'northeast')!;
    expect(ne.status).toBe('sent');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('builds no campaign and reports retryable when the digest has no content', async () => {
    // A total forecast outage yields a null digest → transient, retryable.
    const send = vi.fn().mockResolvedValue(undefined);
    const emptyDigest: FridayCronOptions['buildDigest'] = async () => null;
    const outcomes = await runFridayCron(buildEnv(), FRIDAY_6AM_ET, {
      client: fakeClient(send),
      buildDigest: emptyDigest,
      swallowRetryableThrow: true,
    });
    expect(send).not.toHaveBeenCalled();
    const failed = outcomes.filter((o) => o.status === 'failed');
    expect(failed).toHaveLength(2);
    expect(failed.every((o) => (o as Extract<FridayCronOutcome, { status: 'failed' }>).retryable)).toBe(true);
    const log = await DB.prepare(`SELECT status FROM friday_campaign_log ORDER BY region`).all<{ status: string }>();
    expect(log.results.every((r) => r.status === 'queued')).toBe(true);
  });

  it("marks the row failed on a non-retryable send error — subsequent run skips as previously-failed", async () => {
    const send = vi.fn().mockRejectedValue(
      new SenderError('campaign_send', 'http_4xx', 'status 400', 400)
    );
    const outcomes = await runFridayCron(buildEnv(), FRIDAY_6AM_ET, opts(send));
    expect(outcomes.filter((o) => o.status === 'failed')).toHaveLength(2);
    const log = await DB.prepare(
      `SELECT status FROM friday_campaign_log ORDER BY region`
    ).all<{ status: string }>();
    expect(log.results.every((r) => r.status === 'failed')).toBe(true);

    const send2 = vi.fn().mockResolvedValue(undefined);
    const second = await runFridayCron(buildEnv(), FRIDAY_6AM_ET, opts(send2));
    expect(send2).not.toHaveBeenCalled();
    const skipped = second.filter(
      (o) => o.status === 'skipped' && o.reason === 'previously-failed'
    );
    expect(skipped).toHaveLength(2);
  });

  it('returns skipped=not-local-friday-6 for every region on a non-Friday tick', async () => {
    const wednesday = new Date('2026-05-13T10:00:00Z');
    const outcomes = await runFridayCron(buildEnv(), wednesday, opts());
    expect(outcomes).toHaveLength(6);
    expect(
      outcomes.every((o) => o.status === 'skipped' && o.reason === 'not-local-friday-6')
    ).toBe(true);
  });

  it('429 with Retry-After: 1800 → row has next_attempt_at ≈ now + 1_800_000, status = failed', async () => {
    const fixedNow = FRIDAY_6AM_ET;
    const nowMs = fixedNow.getTime();
    const retryAfterSec = 1800;
    const send = vi.fn().mockRejectedValue(
      new SenderError('campaign_send', 'http_4xx', 'rate limited', 429, retryAfterSec * 1000)
    );
    await runFridayCron(buildEnv(), fixedNow,
      opts(send, { now: () => fixedNow, swallowRetryableThrow: true }));
    const log = await DB.prepare(
      `SELECT region, status, next_attempt_at FROM friday_campaign_log ORDER BY region`
    ).all<{ region: string; status: string; next_attempt_at: number | null }>();
    const etRows = log.results.filter((r) => r.region === 'northeast' || r.region === 'southeast');
    expect(etRows).toHaveLength(2);
    for (const row of etRows) {
      expect(row.status).toBe('failed');
      expect(row.next_attempt_at).not.toBeNull();
      expect(Math.abs(row.next_attempt_at! - (nowMs + 1_800_000))).toBeLessThan(1000);
    }
  });

  it('subsequent invocation with next_attempt_at still in the future → skipped retry-after-pending, no send', async () => {
    const fixedNow = FRIDAY_6AM_ET;
    const nowMs = fixedNow.getTime();
    const futureAttempt = nowMs + 1_800_000;
    await DB.prepare(
      `INSERT INTO friday_campaign_log (region, send_date, status, attempted_at, next_attempt_at)
         VALUES ('northeast', '2026-05-15', 'failed', ?, ?)`
    )
      .bind(nowMs, futureAttempt)
      .run();
    const send = vi.fn().mockResolvedValue(undefined);
    const outcomes = await runFridayCron(buildEnv(), fixedNow,
      opts(send, { now: () => fixedNow, swallowRetryableThrow: true }));
    const ne = outcomes.find((o) => o.region === 'northeast')!;
    expect(ne.status).toBe('skipped');
    expect((ne as Extract<FridayCronOutcome, { status: 'skipped' }>).reason).toBe('retry-after-pending');
    // Only southeast sends — northeast is skipped due to retry-after-pending.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('subsequent invocation AFTER next_attempt_at has passed → send fires normally', async () => {
    const fixedNow = FRIDAY_6AM_ET;
    const nowMs = fixedNow.getTime();
    const pastAttempt = nowMs - 1000;
    await DB.prepare(
      `INSERT INTO friday_campaign_log (region, send_date, status, attempted_at, next_attempt_at)
         VALUES ('northeast', '2026-05-15', 'failed', ?, ?)`
    )
      .bind(nowMs, pastAttempt)
      .run();
    const send = vi.fn().mockResolvedValue(undefined);
    const outcomes = await runFridayCron(buildEnv(), fixedNow,
      opts(send, { now: () => fixedNow }));
    const ne = outcomes.find((o) => o.region === 'northeast')!;
    expect(ne.status).toBe('sent');
  });

  it('retry-after-pending: runFridayCron throws when a region has a pending retry-after row (no swallow)', async () => {
    const fixedNow = FRIDAY_6AM_ET;
    const nowMs = fixedNow.getTime();
    const futureAttempt = nowMs + 1_800_000;
    await DB.prepare(
      `INSERT INTO friday_campaign_log (region, send_date, status, attempted_at, next_attempt_at)
         VALUES ('northeast', '2026-05-15', 'failed', ?, ?)`
    )
      .bind(nowMs, futureAttempt)
      .run();
    await expect(
      runFridayCron(buildEnv(), fixedNow, opts(undefined, { now: () => fixedNow }))
    ).rejects.toThrow('Friday cron: retry required (failed retryable or retry-after pending)');
  });

  it('sends Pacific at 14:00 UTC during winter (standard time)', async () => {
    expect(regionLocalFridaySlot(FRIDAY_6AM_PT_STANDARD, 'pacific')).toEqual({
      date: '2026-01-16',
      weekday: 'Fri',
      hour: 6,
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient(send);
    const outcomes = await runFridayCron(buildEnv(), FRIDAY_6AM_PT_STANDARD, { client, buildDigest: DIGEST_STUB });
    const pacific = outcomes.find((o) => o.region === 'pacific');
    expect(pacific?.status).toBe('sent');
    expect(client.createCampaign).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'pitmaster pacific 2026-01-16', groupId: 'g_pacific' })
    );
  });
});
