import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  regionLocalFridaySlot,
  runFridayCron,
  type FridayCronOutcome,
} from '../../../src/crons/fridayEmail';
import type { SenderClient, TriggerDigestInput } from '../../../src/lib/sender/client';
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

function buildEnv(overrides: Partial<Env> = {}): Env {
  const base: Env = {
    ASSETS: undefined as unknown as Fetcher,
    WEATHER_KV: KV,
    SMOKE_DB: DB,
    SENDER_API_TOKEN: 'sender_test_token',
    SUBSCRIBER_TOKEN_SECRET: 'test-secret-32-bytes-long-aaaaaaaaa',
    SENDER_DIGEST_TRIGGER_URL_NORTHEAST: 'https://api.sender.net/v2/automations/trigger/ne-test',
    SENDER_DIGEST_TRIGGER_URL_SOUTHEAST: 'https://api.sender.net/v2/automations/trigger/se-test',
    SENDER_DIGEST_TRIGGER_URL_MIDWEST: 'https://api.sender.net/v2/automations/trigger/mw-test',
    SENDER_DIGEST_TRIGGER_URL_SOUTH_CENTRAL: 'https://api.sender.net/v2/automations/trigger/sc-test',
    SENDER_DIGEST_TRIGGER_URL_MOUNTAIN: 'https://api.sender.net/v2/automations/trigger/mt-test',
    SENDER_DIGEST_TRIGGER_URL_PACIFIC: 'https://api.sender.net/v2/automations/trigger/pa-test',
  };
  return { ...base, ...overrides };
}

function fakeClient(
  trigger: (input: TriggerDigestInput) => Promise<void> = async () => {}
): SenderClient {
  return {
    subscribe: vi.fn(),
    updateSubscriberFields: vi.fn(),
    getSubscriberByEmail: vi.fn(),
    unsubscribe: vi.fn(),
    listGroups: vi.fn(),
    assignGroup: vi.fn(),
    removeGroup: vi.fn(),
    triggerWeeklyDigest: vi.fn().mockImplementation(trigger),
  } as SenderClient;
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
  it('triggers the eastern-anchor regions at 10:00 UTC (Fri 6am ET)', async () => {
    const trigger = vi.fn().mockResolvedValue(undefined);
    const outcomes = await runFridayCron(buildEnv(), FRIDAY_6AM_ET, {
      client: fakeClient(trigger),
    });
    const sent = outcomes.filter((o) => o.status === 'sent');
    expect(sent.map((o) => (o as Extract<FridayCronOutcome, { status: 'sent' }>).region).sort()).toEqual([
      'northeast',
      'southeast',
    ]);
    expect(trigger).toHaveBeenCalledTimes(2);
    expect(trigger).toHaveBeenCalledWith({
      triggerUrl: 'https://api.sender.net/v2/automations/trigger/ne-test',
      idempotencyTag: 'northeast:2026-05-15',
    });
    expect(trigger).toHaveBeenCalledWith({
      triggerUrl: 'https://api.sender.net/v2/automations/trigger/se-test',
      idempotencyTag: 'southeast:2026-05-15',
    });
    // The other 4 regions are 'skipped' as not-local-friday-6.
    const skipped = outcomes.filter(
      (o) => o.status === 'skipped' && o.reason === 'not-local-friday-6'
    );
    expect(skipped).toHaveLength(4);
  });

  it('triggers central-anchor regions at 11:00 UTC, mountain at 12:00, pacific at 13:00', async () => {
    const triggerCt = vi.fn().mockResolvedValue(undefined);
    const ct = await runFridayCron(buildEnv(), FRIDAY_6AM_CT, {
      client: fakeClient(triggerCt),
    });
    expect(triggerCt).toHaveBeenCalledTimes(2);
    expect(ct.filter((o) => o.status === 'sent').map((o) => (o as { region: string }).region).sort()).toEqual(
      ['midwest', 'south_central']
    );

    await DB.prepare(`DELETE FROM friday_campaign_log`).run();
    const triggerMt = vi.fn().mockResolvedValue(undefined);
    const mt = await runFridayCron(buildEnv(), FRIDAY_6AM_MT, {
      client: fakeClient(triggerMt),
    });
    expect(triggerMt).toHaveBeenCalledTimes(1);
    expect(mt.filter((o) => o.status === 'sent')[0]).toMatchObject({ region: 'mountain' });

    await DB.prepare(`DELETE FROM friday_campaign_log`).run();
    const triggerPt = vi.fn().mockResolvedValue(undefined);
    const pt = await runFridayCron(buildEnv(), FRIDAY_6AM_PT, {
      client: fakeClient(triggerPt),
    });
    expect(triggerPt).toHaveBeenCalledTimes(1);
    expect(pt.filter((o) => o.status === 'sent')[0]).toMatchObject({ region: 'pacific' });
  });

  it('claims an idempotency slot before triggering — a second run on the same Friday is a no-op', async () => {
    const trigger = vi.fn().mockResolvedValue(undefined);
    await runFridayCron(buildEnv(), FRIDAY_6AM_ET, { client: fakeClient(trigger) });
    const second = await runFridayCron(buildEnv(), FRIDAY_6AM_ET, { client: fakeClient(trigger) });
    const sentInSecond = second.filter((o) => o.status === 'sent');
    expect(sentInSecond).toHaveLength(0);
    const alreadySent = second.filter(
      (o) => o.status === 'skipped' && o.reason === 'already-sent'
    );
    expect(alreadySent).toHaveLength(2);
    expect(trigger).toHaveBeenCalledTimes(2); // only the first run
  });

  it('skips a region whose trigger URL is missing from env', async () => {
    const trigger = vi.fn().mockResolvedValue(undefined);
    const outcomes = await runFridayCron(
      buildEnv({ SENDER_DIGEST_TRIGGER_URL_NORTHEAST: undefined }),
      FRIDAY_6AM_ET,
      { client: fakeClient(trigger) }
    );
    expect(trigger).toHaveBeenCalledTimes(1); // only southeast
    const ne = outcomes.find((o) => o.region === 'northeast')!;
    expect(ne.status).toBe('skipped');
    expect((ne as Extract<FridayCronOutcome, { status: 'skipped' }>).reason).toBe('no-trigger-url');
  });

  it('writes an events row when a region is skipped for missing trigger URL', async () => {
    await runFridayCron(
      buildEnv({ SENDER_DIGEST_TRIGGER_URL_NORTHEAST: undefined }),
      FRIDAY_6AM_ET,
      { client: fakeClient() }
    );
    const rows = await DB.prepare(
      `SELECT kind, payload FROM events WHERE kind = 'error'`
    ).all<{ kind: string; payload: string }>();
    expect(rows.results).toHaveLength(1);
    const parsed = JSON.parse(rows.results[0]!.payload) as {
      source: string;
      region: string;
      send_date: string;
      reason: string;
    };
    expect(parsed.source).toBe('friday_cron');
    expect(parsed.region).toBe('northeast');
    expect(parsed.send_date).toBe('2026-05-15');
    expect(parsed.reason).toBe('no-trigger-url');
  });

  it('does NOT write a second events row on a repeated cron invocation for the same missing-URL region+date', async () => {
    const envWithoutNe = buildEnv({ SENDER_DIGEST_TRIGGER_URL_NORTHEAST: undefined });
    // First invocation: should write one error event row for northeast.
    await runFridayCron(envWithoutNe, FRIDAY_6AM_ET, { client: fakeClient() });
    // Second invocation (same Friday window, northeast still missing URL).
    // Southeast is already 'sent' so it won't fire again; northeast still
    // has no trigger URL so the missing-url path runs again — but the
    // idempotency check on the events table must suppress the second insert.
    await runFridayCron(envWithoutNe, FRIDAY_6AM_ET, { client: fakeClient() });
    const rows = await DB.prepare(
      `SELECT kind FROM events WHERE kind = 'error'`
    ).all<{ kind: string }>();
    // Only ONE error event despite two invocations — idempotent write.
    expect(rows.results).toHaveLength(1);
  });

  it('records a sent event in the events table on success', async () => {
    await runFridayCron(buildEnv(), FRIDAY_6AM_ET, { client: fakeClient() });
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

  it('reverts to queued + throws on a retryable trigger failure so Cloudflare auto-retry fires', async () => {
    // Regression for the [P1] pass-3 finding: leaving the row at
    // 'queued' is not enough — the scheduled handler must also throw
    // so Cloudflare's auto-retry actually runs the cron again. Without
    // the throw, the handler resolves and the region's only 6am-local
    // tick is gone for the week.
    const trigger = vi.fn().mockRejectedValue(
      new SenderError('digest_trigger', 'http_5xx', 'status 503', 503)
    );
    await expect(
      runFridayCron(buildEnv(), FRIDAY_6AM_ET, { client: fakeClient(trigger) })
    ).rejects.toThrow(/retryable failure/);
    const log = await DB.prepare(
      `SELECT region, status FROM friday_campaign_log ORDER BY region`
    ).all<{ region: string; status: string }>();
    // Both rows reverted to 'queued' so the auto-retry's claim can
    // pick them up — not 'sending' (the claim-lock state) and not
    // 'failed' (the terminal state).
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
    const retryableTrigger = vi.fn().mockRejectedValue(
      new SenderError('digest_trigger', 'http_5xx', 'x', 503)
    );
    const retryableOutcomes = await runFridayCron(buildEnv(), FRIDAY_6AM_ET, {
      client: fakeClient(retryableTrigger),
      swallowRetryableThrow: true,
    });
    const r = retryableOutcomes.find((o) => o.status === 'failed')!;
    expect((r as Extract<FridayCronOutcome, { status: 'failed' }>).retryable).toBe(true);

    await DB.prepare(`DELETE FROM friday_campaign_log`).run();
    const nonRetryableTrigger = vi.fn().mockRejectedValue(
      new SenderError('digest_trigger', 'http_4xx', 'x', 400)
    );
    const nonRetryableOutcomes = await runFridayCron(buildEnv(), FRIDAY_6AM_ET, {
      client: fakeClient(nonRetryableTrigger),
    });
    const n = nonRetryableOutcomes.find((o) => o.status === 'failed')!;
    expect((n as Extract<FridayCronOutcome, { status: 'failed' }>).retryable).toBe(false);
  });

  it('a retryable failure followed by a successful retry re-claims the row and marks it sent', async () => {
    // After the first cron tick fails retryably, the row reverts to
    // 'queued' (we suppress the throw in tests). A second invocation
    // re-claims via the queued→sending transition and triggers again.
    const failingTrigger = vi.fn().mockRejectedValue(
      new SenderError('digest_trigger', 'http_5xx', 'transient', 503)
    );
    await runFridayCron(buildEnv(), FRIDAY_6AM_ET, {
      client: fakeClient(failingTrigger),
      swallowRetryableThrow: true,
    });
    expect(failingTrigger).toHaveBeenCalledTimes(2);
    const interim = await DB.prepare(
      `SELECT status FROM friday_campaign_log ORDER BY region`
    ).all<{ status: string }>();
    expect(interim.results.every((r) => r.status === 'queued')).toBe(true);

    const okTrigger = vi.fn().mockResolvedValue(undefined);
    const outcomes = await runFridayCron(buildEnv(), FRIDAY_6AM_ET, {
      client: fakeClient(okTrigger),
    });
    expect(outcomes.filter((o) => o.status === 'sent')).toHaveLength(2);
    expect(okTrigger).toHaveBeenCalledTimes(2);
    const log = await DB.prepare(
      `SELECT status FROM friday_campaign_log ORDER BY region`
    ).all<{ status: string }>();
    expect(log.results.every((r) => r.status === 'sent')).toBe(true);
  });

  it("a concurrent claim against a fresh 'sending' row reports retryable failure (not already-sent) so CF re-fires past the stale window", async () => {
    // Regression for [Codex P2] pass-14: the prior code reported
    // 'already-sent' the moment claim.meta.changes === 0, but a fresh
    // 'sending' lock is NOT the same as 'sent'. If a sibling invocation
    // claimed the row and then crashed before triggerWeeklyDigest,
    // returning 'already-sent' lets Cloudflare consider the retry
    // successful — no further retries fire, and by the time the lock
    // ages out past SENDING_STALE_MS the local-Friday-6 anchor hour
    // has passed for this region. The region's digest is dark for the
    // week. Fix: a fresh 'sending' lock reports retryable failure so
    // CF's scheduled-handler auto-retry re-fires (eventually crossing
    // the stale window and re-claiming).
    const fixedNow = FRIDAY_6AM_ET;
    await DB.prepare(
      `INSERT INTO friday_campaign_log (region, send_date, status, attempted_at)
         VALUES ('northeast', '2026-05-15', 'sending', ?)`
    )
      .bind(fixedNow.getTime())
      .run();
    const trigger = vi.fn().mockResolvedValue(undefined);
    const outcomes = await runFridayCron(buildEnv(), FRIDAY_6AM_ET, {
      client: fakeClient(trigger),
      now: () => fixedNow,
      // Don't throw at end of loop — the test asserts on outcomes directly.
      swallowRetryableThrow: true,
    });
    const ne = outcomes.find((o) => o.region === 'northeast')!;
    expect(ne.status).toBe('failed');
    expect((ne as Extract<FridayCronOutcome, { status: 'failed' }>).retryable).toBe(true);
    expect((ne as Extract<FridayCronOutcome, { status: 'failed' }>).error).toMatch(
      /claim contested.*sending/
    );
    // Southeast (no seeded row) still proceeds normally.
    const se = outcomes.find((o) => o.region === 'southeast')!;
    expect(se.status).toBe('sent');
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith({
      triggerUrl: 'https://api.sender.net/v2/automations/trigger/se-test',
      idempotencyTag: 'southeast:2026-05-15',
    });
  });

  it("throws (so Cloudflare retries) when a region's claim is contested by a fresh 'sending' lock", async () => {
    // Companion to the test above: the runFridayCron post-loop guard
    // must propagate the retryable failure so CF's scheduled-handler
    // auto-retry fires. Without the throw, CF would consider the
    // invocation successful and the region's digest would be skipped
    // for the week (the lock ages out past SENDING_STALE_MS only after
    // the next local-Friday-6 hourly tick has passed).
    const fixedNow = FRIDAY_6AM_ET;
    await DB.prepare(
      `INSERT INTO friday_campaign_log (region, send_date, status, attempted_at)
         VALUES ('northeast', '2026-05-15', 'sending', ?)`
    )
      .bind(fixedNow.getTime())
      .run();
    await expect(
      runFridayCron(buildEnv(), FRIDAY_6AM_ET, {
        client: fakeClient(),
        now: () => fixedNow,
      })
    ).rejects.toThrow(/retryable failure.*northeast/);
  });

  it("reports 'sent' even if the post-trigger D1 UPDATE fails — does NOT revert the row to a re-claimable state", async () => {
    // Regression for [Codex P2] pass-18: a broad try/catch used to
    // treat a post-send D1 error as a campaign failure → row reverted
    // to 'queued' and the next cron tick would re-fire the automation,
    // producing a duplicate weekly digest. Fix narrows the catch to
    // triggerWeeklyDigest; D1 bookkeeping is best-effort after a successful
    // trigger. Sender's per-(region, send_date) idempotency tag is
    // the backstop if the row IS somehow re-claimed.
    const fixedNow = FRIDAY_6AM_ET;
    // Sabotage updateStatus by injecting an env whose D1 throws ONLY
    // on the UPDATE issued after triggerWeeklyDigest. We do this by
    // wrapping prepare() such that a query targeting friday_campaign_log
    // status='sent' rejects.
    const realEnv = buildEnv();
    let triggerCalled = 0;
    const env = {
      ...realEnv,
      SMOKE_DB: {
        prepare(sql: string) {
          const stmt = realEnv.SMOKE_DB.prepare(sql);
          if (sql.includes('UPDATE friday_campaign_log') && triggerCalled > 0) {
            // After at least one trigger fired, this UPDATE is the
            // post-send bookkeeping. Throw to simulate D1 hiccup.
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
    const trigger = vi.fn().mockImplementation(async () => {
      triggerCalled += 1;
    });
    const outcomes = await runFridayCron(env, FRIDAY_6AM_ET, {
      client: fakeClient(trigger),
      now: () => fixedNow,
    });
    // Both ET-anchored regions (northeast, southeast) trigger
    // successfully at FRIDAY_6AM_ET. The others skip as not-local-Friday-6.
    expect(trigger).toHaveBeenCalledTimes(2);
    // Outcomes for the triggered regions must be 'sent' — NOT 'failed'
    // — even though the post-trigger D1 UPDATE threw. The campaign IS
    // sent; the outcome must reflect that, and the row must NOT be
    // reverted to a state that lets the next cron tick re-fire.
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
    const trigger = vi.fn().mockResolvedValue(undefined);
    const outcomes = await runFridayCron(buildEnv(), FRIDAY_6AM_ET, {
      client: fakeClient(trigger),
      now: () => fixedNow,
    });
    const ne = outcomes.find((o) => o.region === 'northeast')!;
    expect(ne.status).toBe('skipped');
    expect((ne as Extract<FridayCronOutcome, { status: 'skipped' }>).reason).toBe('already-sent');
  });

  it("a stale 'sending' row (> 5 minutes old) is re-claimable", async () => {
    // If a worker crashes mid-trigger, the row sits in 'sending'
    // forever. The claim SQL allows re-claim after SENDING_STALE_MS
    // so an honest crash doesn't poison the (region, send_date) slot.
    const fixedNow = FRIDAY_6AM_ET;
    await DB.prepare(
      `INSERT INTO friday_campaign_log (region, send_date, status, attempted_at)
         VALUES ('northeast', '2026-05-15', 'sending', ?)`
    )
      .bind(fixedNow.getTime() - 10 * 60 * 1000) // 10 minutes stale relative to fixedNow
      .run();
    const trigger = vi.fn().mockResolvedValue(undefined);
    const outcomes = await runFridayCron(buildEnv(), FRIDAY_6AM_ET, {
      client: fakeClient(trigger),
      now: () => fixedNow,
    });
    const ne = outcomes.find((o) => o.region === 'northeast')!;
    expect(ne.status).toBe('sent');
    expect(trigger).toHaveBeenCalledWith({
      triggerUrl: 'https://api.sender.net/v2/automations/trigger/ne-test',
      idempotencyTag: 'northeast:2026-05-15',
    });
  });

  it("marks the row failed on a non-retryable trigger error — subsequent run skips as previously-failed", async () => {
    // 4xx is terminal — the operator must investigate. The row stays
    // 'failed' and the claim SQL blocks re-attempts to avoid spinning.
    // The skip reason on a subsequent run is 'previously-failed', NOT
    // 'already-sent' — telemetry/event readers need to distinguish a
    // successful prior send from a needs-attention prior failure.
    const trigger = vi.fn().mockRejectedValue(
      new SenderError('digest_trigger', 'http_4xx', 'status 400', 400)
    );
    const outcomes = await runFridayCron(buildEnv(), FRIDAY_6AM_ET, {
      client: fakeClient(trigger),
    });
    expect(outcomes.filter((o) => o.status === 'failed')).toHaveLength(2);
    const log = await DB.prepare(
      `SELECT status FROM friday_campaign_log ORDER BY region`
    ).all<{ status: string }>();
    expect(log.results.every((r) => r.status === 'failed')).toBe(true);

    // Second run with a healthy client: must NOT re-attempt — the
    // claim filter blocks re-claim of 'failed' rows. Outcome reason
    // is 'previously-failed' so operators can see the prior outcome.
    const trigger2 = vi.fn().mockResolvedValue(undefined);
    const second = await runFridayCron(buildEnv(), FRIDAY_6AM_ET, {
      client: fakeClient(trigger2),
    });
    expect(trigger2).not.toHaveBeenCalled();
    const skipped = second.filter(
      (o) => o.status === 'skipped' && o.reason === 'previously-failed'
    );
    expect(skipped).toHaveLength(2);
  });

  it('returns skipped=not-local-friday-6 for every region on a non-Friday tick', async () => {
    const wednesday = new Date('2026-05-13T10:00:00Z');
    const outcomes = await runFridayCron(buildEnv(), wednesday, { client: fakeClient() });
    expect(outcomes).toHaveLength(6);
    expect(
      outcomes.every((o) => o.status === 'skipped' && o.reason === 'not-local-friday-6')
    ).toBe(true);
  });

  it('triggers Pacific at 14:00 UTC during winter (standard time)', async () => {
    // Regression for the [P2] cron-range bug: in standard time
    // (Nov–Mar), Pacific 6am local lands at 14:00 UTC, which the
    // original `0 10-13 * * 5` range never fired for. The fix
    // extends the range to 0 10-14 * * 5 and this asserts the gate
    // recognises that UTC instant as Fri 06:00 in Los_Angeles.
    expect(regionLocalFridaySlot(FRIDAY_6AM_PT_STANDARD, 'pacific')).toEqual({
      date: '2026-01-16',
      weekday: 'Fri',
      hour: 6,
    });
    const trigger = vi.fn().mockResolvedValue(undefined);
    const outcomes = await runFridayCron(buildEnv(), FRIDAY_6AM_PT_STANDARD, {
      client: fakeClient(trigger),
    });
    const pacific = outcomes.find((o) => o.region === 'pacific');
    expect(pacific?.status).toBe('sent');
    expect(trigger).toHaveBeenCalledWith({
      triggerUrl: 'https://api.sender.net/v2/automations/trigger/pa-test',
      idempotencyTag: 'pacific:2026-01-16',
    });
  });
});
