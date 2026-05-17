// F14 — Friday digest cron (portfolio-aware regional version).
//
// Schedule: `0 10-14 * * 5` — fires hourly Friday UTC across the five
// anchor-timezone Friday-6am windows (covers Pacific standard time at
// 14:00 UTC plus four DST windows):
//   10:00 UTC  →  06:00 America/New_York   (northeast + southeast, DST)
//   11:00 UTC  →  06:00 America/Chicago    (midwest + south_central, DST)
//   12:00 UTC  →  06:00 America/Denver     (mountain, DST)
//   13:00 UTC  →  06:00 America/Los_Angeles (pacific, DST)
//   14:00 UTC  →  06:00 America/Los_Angeles (pacific, standard time)
//
// Per tick, for each region whose anchor timezone says it is now
// Friday 06:00 local, this cron:
//   1. Claims an idempotency slot in `friday_campaign_log (region, send_date)`
//   2. Triggers the region's Sender.net automation via its trigger URL
//      (SENDER_DIGEST_TRIGGER_URL_<REGION> secret)
//   3. Records a 'send' row in `events` for /api/status observability
//   4. Updates the friday_campaign_log slot to 'sent' or 'failed'
//
// Audience filtering: the automation is configured in the Sender.net
// dashboard to send only to subscribers in `pitmaster_<region>`. The
// cron has no per-subscriber loop — that's the portfolio scaling win
// vs. the v1 per-subscriber tz-gated model.
//
// Forecast injection (Sat/Sun score grid) is NOT in this cron in v1.
// The per-region automation's email template is static across weeks
// and uses {$if:bbq_cut_pref="..."} conditional merge tags to vary
// content by stored subscriber preference. A future enhancement could
// PATCH per-region forecast fields before the trigger to inject
// dynamic content — see docs/portfolio-email-architecture.md.

import type { Env } from '../index.js';
import { createSenderClient, type SenderClient } from '../lib/sender/client.js';
import { SenderError } from '../lib/sender/errors.js';
import { REGIONS, type Region } from '../lib/regions/index.js';
import { summarizeError } from '../lib/redact.js';

export interface FridayCronOptions {
  now?: () => Date;
  client?: SenderClient;
  /** Per-region telemetry — invoked once per processed region. */
  onResult?: (outcome: FridayCronOutcome) => void;
  /**
   * Suppress the "throw after the loop on retryable failures" behavior.
   * Default is to throw so Cloudflare's scheduled-handler auto-retry
   * fires; tests that exercise the retryable code path without wanting
   * the throw set this to true.
   */
  swallowRetryableThrow?: boolean;
}

export type FridayCronOutcome =
  | { region: Region; status: 'skipped'; reason: 'already-sent' | 'previously-failed' | 'no-trigger-url' | 'not-local-friday-6' | 'retry-after-pending' }
  | { region: Region; status: 'sent'; sendDate: string }
  | { region: Region; status: 'failed'; sendDate: string; error: string; retryable: boolean };

/**
 * A 'sending' row whose attempted_at is older than this is considered
 * stale (the caller probably crashed mid-trigger) and is eligible for
 * re-claim by the next cron invocation. Cloudflare's scheduled-handler
 * timeout is well under this; 5 minutes is comfortably conservative.
 */
const SENDING_STALE_MS = 5 * 60 * 1000;

/**
 * Anchor timezone per region — the IANA tz the cron uses to decide
 * "is it Friday 06:00 in this region right now". Subscribers can live
 * across multiple offsets within a region (a Florida subscriber and a
 * Virginia subscriber share `southeast` but differ on local clock); the
 * anchor is a single deterministic choice per region. Picked to match
 * the population center of each region.
 */
const REGION_ANCHOR_TZ: Readonly<Record<Region, string>> = {
  northeast: 'America/New_York',
  southeast: 'America/New_York',
  midwest: 'America/Chicago',
  south_central: 'America/Chicago',
  mountain: 'America/Denver',
  pacific: 'America/Los_Angeles',
};

/** Env var name carrying the per-region Sender trigger URL. */
const REGION_TO_TRIGGER_URL_ENV: Readonly<Record<Region, keyof Env>> = {
  northeast:     'SENDER_DIGEST_TRIGGER_URL_NORTHEAST',
  southeast:     'SENDER_DIGEST_TRIGGER_URL_SOUTHEAST',
  midwest:       'SENDER_DIGEST_TRIGGER_URL_MIDWEST',
  south_central: 'SENDER_DIGEST_TRIGGER_URL_SOUTH_CENTRAL',
  mountain:      'SENDER_DIGEST_TRIGGER_URL_MOUNTAIN',
  pacific:       'SENDER_DIGEST_TRIGGER_URL_PACIFIC',
};

/**
 * Returns the region's local date + hour + weekday at the given UTC
 * timestamp. Null if the timezone is rejected (shouldn't happen — the
 * anchor map only carries known IANA values).
 */
export function regionLocalFridaySlot(
  now: Date,
  region: Region
): { date: string; weekday: string; hour: number } | null {
  const timeZone = REGION_ANCHOR_TZ[region];
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    }).formatToParts(now);
  } catch {
    return null;
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const yyyy = get('year');
  const mm = get('month');
  const dd = get('day');
  const weekday = get('weekday');
  const hourStr = get('hour');
  const hourRaw = Number.parseInt(hourStr, 10);
  const hour = Number.isFinite(hourRaw) ? hourRaw % 24 : NaN;
  if (!yyyy || !mm || !dd || !weekday || Number.isNaN(hour)) return null;
  return { date: `${yyyy}-${mm}-${dd}`, weekday, hour };
}

export async function runFridayCron(
  env: Env,
  scheduledTime: Date,
  opts: FridayCronOptions = {}
): Promise<FridayCronOutcome[]> {
  const client =
    opts.client ?? createSenderClient({ apiToken: env.SENDER_API_TOKEN });
  const outcomes: FridayCronOutcome[] = [];
  const nowFn = opts.now ?? (() => new Date());

  for (const region of REGIONS) {
    const slot = regionLocalFridaySlot(scheduledTime, region);
    if (!slot || slot.weekday !== 'Fri' || slot.hour !== 6) {
      const o: FridayCronOutcome = {
        region,
        status: 'skipped',
        reason: 'not-local-friday-6',
      };
      opts.onResult?.(o);
      outcomes.push(o);
      continue;
    }
    const triggerUrl = env[REGION_TO_TRIGGER_URL_ENV[region]] as string | undefined;
    if (!triggerUrl) {
      const o: FridayCronOutcome = {
        region,
        status: 'skipped',
        reason: 'no-trigger-url',
      };
      opts.onResult?.(o);
      outcomes.push(o);
      // Write a warning event so operators can observe the missing-URL
      // condition from the events table. Guarded by a friday_campaign_log
      // check so repeated cron invocations within the same Friday window
      // only write the event once per (region, sendDate).
      const sendDate = slot.date;
      const nowMs = nowFn().getTime();
      await recordMissingUrlEvent(env.SMOKE_DB, region, sendDate, nowMs);
      continue;
    }
    const outcome = await processRegion(env, client, region, triggerUrl, slot.date, nowFn);
    opts.onResult?.(outcome);
    outcomes.push(outcome);
  }

  // If any region failed retryably, throw so Cloudflare's
  // scheduled-handler auto-retry fires. Without this the
  // ctx.waitUntil(runFridayCron(...)) in index.ts resolves normally,
  // Cloudflare considers the invocation a success, and the failed
  // region's only Fri-06:00 anchor-tz tick has passed by the next
  // hourly cron — the digest is dark for that region for the week.
  // Successful regions are NOT re-attempted on auto-retry because the
  // claim SQL skips 'sent' rows.
  if (!opts.swallowRetryableThrow) {
    const retryable = outcomes.find(
      (o): o is Extract<FridayCronOutcome, { status: 'failed' }> =>
        o.status === 'failed' && o.retryable
    );
    if (retryable) {
      throw new Error(
        `runFridayCron: retryable failure for region(s) ` +
          `[${outcomes
            .filter((o) => o.status === 'failed' && o.retryable)
            .map((o) => (o as { region: Region }).region)
            .join(', ')}] — Cloudflare scheduled-handler retry should re-attempt`
      );
    }
  }
  return outcomes;
}

async function processRegion(
  env: Env,
  client: SenderClient,
  region: Region,
  triggerUrl: string,
  sendDate: string,
  nowFn: () => Date
): Promise<FridayCronOutcome> {
  const nowMs = nowFn().getTime();
  // Claim the (region, send_date) slot atomically. The INSERT lands at
  // status='sending' so the row itself acts as the claim lock —
  // concurrent contenders see status='sending' and the WHERE filter
  // below rejects their UPDATE, exiting via changes=0.
  //
  // Re-claim is permitted when:
  //   - status='queued' — a prior attempt failed retryably and reverted
  //     the row, awaiting the next attempt.
  //   - status='sending' AND attempted_at <= now - SENDING_STALE_MS — a
  //     prior attempt crashed mid-trigger and left a stale lock. The
  //     timeout is bigger than any plausible scheduled-handler wall
  //     time so an honest in-flight call is never preempted.
  //
  // 'sent' and 'failed' are terminal: 'sent' because we shipped the
  // campaign and Sender.net collapses duplicates by idempotency key,
  // 'failed' because an operator must investigate non-retryable errors
  // via /api/status before any re-attempt.
  const staleCutoff = nowMs - SENDING_STALE_MS;
  const claim = await env.SMOKE_DB.prepare(
    `INSERT INTO friday_campaign_log (region, send_date, status, attempted_at)
       VALUES (?, ?, 'sending', ?)
       ON CONFLICT (region, send_date) DO UPDATE
         SET status = 'sending', attempted_at = excluded.attempted_at,
             next_attempt_at = NULL
         WHERE friday_campaign_log.status = 'queued'
            OR (friday_campaign_log.status = 'sending'
                AND friday_campaign_log.attempted_at <= ?)
            OR (friday_campaign_log.status = 'failed'
                AND friday_campaign_log.next_attempt_at IS NOT NULL
                AND friday_campaign_log.next_attempt_at <= ?)`
  )
    .bind(region, sendDate, nowMs, staleCutoff, nowMs)
    .run();
  if ((claim.meta.changes ?? 0) === 0) {
    // The ON CONFLICT WHERE clause rejected the UPDATE. That's one of:
    //   (a) status='sent'    — campaign already shipped this week, real skip.
    //   (b) status='failed'  — operator-investigate row; do not retry.
    //   (c) status='sending' AND attempted_at > staleCutoff — fresh lock
    //       from a sibling invocation that just claimed it (e.g. the
    //       scheduled-handler retry firing again within the stale
    //       window after a prior crash before triggerCampaign).
    //
    // Case (c) is the dangerous one: returning 'already-sent' here lets
    // Cloudflare consider the retry successful, no further retries fire,
    // and by the time the lock ages out past SENDING_STALE_MS the next
    // local-Friday-6 hourly cron has already passed for this region —
    // the region misses its weekly digest entirely.
    //
    // Read the row to disambiguate. For (c) throw retryable so the
    // scheduled handler retries again; by the time CF's retry budget
    // expires the stale-cutoff will have elapsed and the next attempt
    // will re-claim. For (a)/(b) report the real status.
    const current = await env.SMOKE_DB.prepare(
      `SELECT status, attempted_at, next_attempt_at FROM friday_campaign_log
        WHERE region = ? AND send_date = ?`
    )
      .bind(region, sendDate)
      .first<{ status: 'queued' | 'sending' | 'sent' | 'failed'; attempted_at: number; next_attempt_at: number | null }>();
    if (current?.status === 'sent') {
      return { region, status: 'skipped', reason: 'already-sent' };
    }
    if (current?.status === 'failed') {
      // A 'failed' row with next_attempt_at > now means a 429 with Retry-After
      // landed on a prior attempt — honor Sender's signal and skip until the
      // deadline passes. A subsequent hourly cron invocation after next_attempt_at
      // will re-claim and retry via the updated claim SQL.
      if (current.next_attempt_at !== null && current.next_attempt_at > nowMs) {
        return { region, status: 'skipped', reason: 'retry-after-pending' };
      }
      // next_attempt_at is null or already past — this is a terminal non-retryable
      // failure that an operator must investigate before re-attempting.
      return { region, status: 'skipped', reason: 'previously-failed' };
    }
    // 'sending' (or any unexpected state) → treat as still in-flight.
    // Report as a retryable failure so runFridayCron's post-loop guard
    // throws and Cloudflare's scheduled-handler auto-retry fires after
    // the stale window. Do NOT mutate the row — the other invocation
    // owns the lock until staleness expires.
    const lockAge = current ? nowMs - current.attempted_at : 0;
    return {
      region,
      status: 'failed',
      sendDate,
      error: `claim contested: fresh 'sending' lock (${lockAge}ms old, stale threshold ${SENDING_STALE_MS}ms)`,
      retryable: true,
    };
  }

  // Narrow the try/catch to ONLY the trigger call. A D1 failure on the
  // post-send UPDATE used to be treated as a campaign failure and
  // reverted the row to 'queued' — which made the row eligible for
  // re-claim and would fire a duplicate automation run on the next
  // cron tick. Now: trigger errors revert/mark-failed, but a successful
  // trigger is committed to a 'sent' state with best-effort D1
  // bookkeeping. If the post-send UPDATE throws, we log and report
  // sent — operators see the send in Sender.net + the stale 'sending'
  // row in D1, and the stale-cutoff guard plus the campaign-side
  // idempotency tag prevent the re-claim path from re-triggering.
  try {
    await client.triggerWeeklyDigest({
      triggerUrl,
      idempotencyTag: `${region}:${sendDate}`,
    });
  } catch (err) {
    const reason = err instanceof SenderError ? summarizeError(err) : 'trigger failed';
    const retryable = err instanceof SenderError && err.shouldRetry;
    if (retryable) {
      const retryAfterMs = err instanceof SenderError ? err.retryAfterMs : undefined;
      if (retryAfterMs !== undefined) {
        // Sender signalled an explicit Retry-After. Mark the row 'failed' with
        // next_attempt_at so subsequent hourly cron invocations skip until the
        // deadline passes, then re-claim and retry (see claim SQL + disambiguation).
        // We still throw below so Cloudflare's scheduled-handler fires the first
        // retry pass; after next_attempt_at the claim SQL will re-claim normally.
        await safeUpdateNextAttemptAt(env.SMOKE_DB, region, sendDate, nowMs + retryAfterMs, nowMs);
        await recordEvent(env.SMOKE_DB, region, sendDate, 'failed', `${reason} (retryable, retry-after=${retryAfterMs}ms)`, nowMs);
      } else {
        // Plain retryable failure (5xx without Retry-After): revert to 'queued'
        // so the CF scheduled-handler auto-retry can re-claim immediately.
        await safeUpdateStatus(env.SMOKE_DB, region, sendDate, 'queued', nowMs);
        await recordEvent(env.SMOKE_DB, region, sendDate, 'failed', `${reason} (retryable)`, nowMs);
      }
      return { region, status: 'failed', sendDate, error: reason, retryable: true };
    }
    await safeUpdateStatus(env.SMOKE_DB, region, sendDate, 'failed', nowMs);
    await recordEvent(env.SMOKE_DB, region, sendDate, 'failed', reason, nowMs);
    return { region, status: 'failed', sendDate, error: reason, retryable: false };
  }

  // Trigger succeeded. From here on, the campaign IS sent — D1
  // bookkeeping is best-effort and must not roll the outcome back to
  // 'queued' (which would re-trigger). Log on failure so an operator
  // can clean up the stale 'sending' row manually if needed; the
  // (region, send_date) idempotency tag on triggerWeeklyDigest ensures
  // Sender.net collapses any accidental re-fire to a no-op even if
  // the row is somehow re-claimed before SENDING_STALE_MS elapses.
  await safeUpdateStatus(env.SMOKE_DB, region, sendDate, 'sent', nowMs);
  await recordEvent(env.SMOKE_DB, region, sendDate, 'sent', null, nowMs);
  return { region, status: 'sent', sendDate };
}

/**
 * Best-effort wrapper around updateStatus. A D1 hiccup after a
 * successful triggerCampaign must NOT cascade to a re-trigger — see
 * processRegion's post-trigger comment.
 */
async function safeUpdateStatus(
  db: D1Database,
  region: Region,
  sendDate: string,
  status: 'queued' | 'sending' | 'sent' | 'failed',
  now: number
): Promise<void> {
  try {
    await updateStatus(db, region, sendDate, status, now);
  } catch (err) {
    console.warn('friday_campaign_log: status update failed (best-effort)', {
      region,
      send_date: sendDate,
      target_status: status,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function updateStatus(
  db: D1Database,
  region: Region,
  sendDate: string,
  status: 'queued' | 'sending' | 'sent' | 'failed',
  now: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE friday_campaign_log
          SET status = ?, attempted_at = ?
        WHERE region = ? AND send_date = ?`
    )
    .bind(status, now, region, sendDate)
    .run();
}

/**
 * Best-effort: set status='failed' + next_attempt_at on the row to honor
 * Sender's Retry-After signal. A failure here leaves the row in 'sending'
 * (stale-claimable after SENDING_STALE_MS), which is still recoverable.
 */
async function safeUpdateNextAttemptAt(
  db: D1Database,
  region: Region,
  sendDate: string,
  nextAttemptAt: number,
  now: number
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE friday_campaign_log
            SET status = 'failed', attempted_at = ?, next_attempt_at = ?
          WHERE region = ? AND send_date = ?`
      )
      .bind(now, nextAttemptAt, region, sendDate)
      .run();
  } catch (err) {
    console.warn('friday_campaign_log: next_attempt_at update failed (best-effort)', {
      region,
      send_date: sendDate,
      next_attempt_at: nextAttemptAt,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function recordEvent(
  db: D1Database,
  region: Region,
  sendDate: string,
  outcome: 'sent' | 'failed',
  reason: string | null,
  now: number
): Promise<void> {
  try {
    const payload = JSON.stringify({ region, send_date: sendDate, outcome, ...(reason ? { reason } : {}) });
    await db
      .prepare(`INSERT INTO events (kind, payload, created_at) VALUES (?, ?, ?)`)
      .bind(outcome === 'sent' ? 'send' : 'error', payload, now)
      .run();
  } catch (auditErr) {
    console.warn('friday_campaign_log: events insert failed', {
      region,
      send_date: sendDate,
      error: summarizeError(auditErr),
    });
  }
}

/**
 * Records a warning event when a region is in-window but has no
 * SENDER_DIGEST_TRIGGER_URL_<REGION> secret configured. Idempotent:
 * uses INSERT OR IGNORE (via a partial unique index on kind+send_date+region
 * encoded in the payload) — instead, checks the events table for a prior
 * no-trigger-url event for this (region, sendDate) so repeated cron
 * invocations within the same Friday window write at most one event row.
 */
async function recordMissingUrlEvent(
  db: D1Database,
  region: Region,
  sendDate: string,
  now: number
): Promise<void> {
  try {
    // Atomically insert only if no prior 'error' event for this
    // (region, sendDate, reason) already exists. This guards against
    // concurrent cron invocations in the same Friday window when the
    // trigger URL is consistently absent. A single compound statement
    // is atomic in D1's underlying SQLite serialized writes.
    const payload = JSON.stringify({
      source: 'friday_cron',
      region,
      send_date: sendDate,
      reason: 'no-trigger-url',
    });
    await db
      .prepare(
        `INSERT INTO events (kind, payload, created_at)
          SELECT ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM events
            WHERE kind = 'error'
              AND json_extract(payload, '$.source') = 'friday_cron'
              AND json_extract(payload, '$.region') = ?
              AND json_extract(payload, '$.send_date') = ?
              AND json_extract(payload, '$.reason') = 'no-trigger-url'
          )`
      )
      .bind('error', payload, now, region, sendDate)
      .run();
  } catch (auditErr) {
    console.warn('friday_campaign_log: missing-url event insert failed', {
      region,
      send_date: sendDate,
      error: summarizeError(auditErr),
    });
  }
}
