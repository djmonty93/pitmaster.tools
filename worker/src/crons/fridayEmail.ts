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
//   2. Builds the region's HTML digest (its metros + Sat/Sun/Mon scores)
//   3. Creates a Sender.net campaign targeting `pitmaster_<region>` and
//      broadcasts it (one createCampaign + one sendCampaign call)
//   4. Records a 'send' row in `events` for /api/status observability
//   5. Updates the friday_campaign_log slot to 'sent' or 'failed'
//
// Audience filtering: the campaign targets the `pitmaster_<region>` group
// by id, so one send broadcasts to everyone in the region — the cron has
// no per-subscriber loop (the portfolio scaling win). Because the group
// can't be personalised per subscriber, scores use a single default
// profile (pork butt + offset), disclosed in the email footer.
//
// Dark-disable: an unset SENDER_FROM_EMAIL skips the whole digest (the
// global "not configured yet" / kill-switch state).

import type { Env } from '../index.js';
import { createSenderClient, type SenderClient } from '../lib/sender/client.js';
import { SenderError } from '../lib/sender/errors.js';
import { regionToGroupName, resolveGroupId } from '../lib/sender/groups.js';
import { buildRegionDigest, type RegionDigest } from '../lib/digest/buildRegionDigest.js';
import { REGIONS, type Region } from '../lib/regions/index.js';
import { summarizeError } from '../lib/redact.js';

export interface FridayCronOptions {
  now?: () => Date;
  client?: SenderClient;
  /**
   * Builds a region's digest (subject + HTML). Injectable so cron
   * state-machine tests don't need real metros/forecasts. Defaults to
   * the real buildRegionDigest. Returns null when the region produced no
   * forecast content (treated as a transient, retryable condition).
   */
  buildDigest?: (region: Region, sendDate: string) => Promise<RegionDigest | null>;
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
  | { region: Region; status: 'skipped'; reason: 'already-sent' | 'previously-failed' | 'not-configured' | 'not-local-friday-6' | 'retry-after-pending' }
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
  const buildDigest =
    opts.buildDigest ??
    ((region: Region, sendDate: string) =>
      buildRegionDigest(env, region, sendDate, { now: nowFn }));

  // Sending a campaign requires a from-address (campaign create needs it).
  // An unset SENDER_FROM_EMAIL dark-disables the whole digest — the
  // global kill switch / "not configured yet" state. Mirrors the previous
  // missing-secret-disables philosophy, now configuration-wide.
  const fromEmail = env.SENDER_FROM_EMAIL;

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
    if (!fromEmail) {
      const o: FridayCronOutcome = {
        region,
        status: 'skipped',
        reason: 'not-configured',
      };
      opts.onResult?.(o);
      outcomes.push(o);
      // Record one warning event per (region, sendDate) so operators can
      // see the dark-disabled condition in /api/status without spamming
      // the events table across the hourly Friday window.
      await recordSkipEvent(env.SMOKE_DB, region, slot.date, 'not-configured', nowFn().getTime());
      continue;
    }
    const outcome = await processRegion(env, client, region, fromEmail, slot.date, nowFn, buildDigest);
    opts.onResult?.(outcome);
    outcomes.push(outcome);
  }

  // If any region failed retryably OR has a retry-after-pending outcome,
  // throw so Cloudflare's scheduled-handler auto-retry fires. Without this
  // ctx.waitUntil(runFridayCron(...)) resolves normally, Cloudflare
  // considers the invocation a success, and the failed region's only
  // Fri-06:00 anchor-tz tick has passed by the next hourly cron — the
  // digest is dark for that region for the week.
  // Successful regions are NOT re-attempted on auto-retry because the
  // claim SQL skips 'sent' rows.
  //
  // We throw on retry-after-pending so Cloudflare's scheduled-event auto-retry
  // re-fires the same event ~5-30 min later with the SAME scheduledTime
  // (still passes the per-region local-Friday-6am gate). When next_attempt_at
  // has expired by the time the auto-retry runs, the cron attempts the
  // campaign send normally. For Retry-After values that exceed Cloudflare's
  // auto-retry budget (~30-60 min), the region is silently skipped until next
  // Friday's send_date — acceptable degradation under sustained rate limiting.
  if (!opts.swallowRetryableThrow) {
    const hasRetryableFailure = outcomes.some(
      (o) => o.status === 'failed' && o.retryable
    );
    const hasRetryAfterPending = outcomes.some(
      (o) => o.status === 'skipped' && o.reason === 'retry-after-pending'
    );
    if (hasRetryableFailure || hasRetryAfterPending) {
      throw new Error(
        'Friday cron: retry required (failed retryable or retry-after pending)'
      );
    }
  }
  return outcomes;
}

async function processRegion(
  env: Env,
  client: SenderClient,
  region: Region,
  fromEmail: string,
  sendDate: string,
  nowFn: () => Date,
  buildDigest: (region: Region, sendDate: string) => Promise<RegionDigest | null>
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
    //       window after a prior crash before the campaign send).
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

  // Idempotency across reclaim/retry (Codex review): createCampaign and
  // sendCampaign are two calls, and a 'sending'/'queued' row can be
  // re-claimed (stale lock) or reverted-and-retried. To guarantee at most
  // ONE campaign is ever created per (region, send_date) — so a lost send
  // response, a worker death, or a failed post-send bookkeeping UPDATE can
  // never broadcast a *second distinct* campaign — we persist the created
  // campaign's id BEFORE sending and reuse it on any re-attempt (skip
  // createCampaign, re-send the same campaign). We also send a
  // deterministic `${region}:${sendDate}` Idempotency-Key on both calls so
  // a retry is collapsed server-side IF Sender honors it. Residual: a
  // same-campaign re-send is a duplicate only if Sender both ignores the
  // idempotency key AND re-broadcasts an already-sent campaign — verify
  // before enabling sends (docs/sender-setup.md §4).
  //
  // The try/catch wraps ONLY build + create + send. A successful send is
  // committed to 'sent' with best-effort D1 bookkeeping below; if that
  // UPDATE throws we log and still report sent (the stale-cutoff guard
  // keeps the row from re-sending within the window).
  const priorCampaignId = await readCampaignId(env.SMOKE_DB, region, sendDate);
  try {
    let campaignId = priorCampaignId;
    if (!campaignId) {
      const digest = await buildDigest(region, sendDate);
      if (!digest) {
        // No metro in this region produced any weekend forecast (e.g. a
        // total upstream outage). Transient — revert to 'queued' and
        // report retryable so the scheduled-handler auto-retry re-attempts
        // on a later hourly tick once forecasts recover.
        await safeUpdateStatus(env.SMOKE_DB, region, sendDate, 'queued', nowMs);
        await recordEvent(env.SMOKE_DB, region, sendDate, 'failed', 'no digest content (forecast unavailable)', nowMs);
        return { region, status: 'failed', sendDate, error: 'no digest content', retryable: true };
      }
      const groupId = await resolveGroupId(client, env.WEATHER_KV, regionToGroupName(region));
      const created = await client.createCampaign({
        name: `pitmaster ${region} ${sendDate}`,
        subject: digest.subject,
        fromName: env.SENDER_FROM_NAME ?? 'Pitmaster Tools',
        fromEmail,
        replyTo: env.SENDER_REPLY_TO,
        html: digest.html,
        groupId,
        idempotencyKey: `${region}:${sendDate}`,
      });
      campaignId = created.campaignId;
      // Persist the id BEFORE sending. If this fails we must NOT send — a
      // send now could not be deduped by a later reclaim, risking a
      // duplicate broadcast. Revert to 'queued' and retry; the just-created
      // campaign is a harmless unsent draft, never a duplicate email.
      const persisted = await tryUpdateCampaignId(env.SMOKE_DB, region, sendDate, campaignId, nowMs);
      if (!persisted) {
        await safeUpdateStatus(env.SMOKE_DB, region, sendDate, 'queued', nowMs);
        await recordEvent(env.SMOKE_DB, region, sendDate, 'failed', 'campaign_id persist failed (will retry)', nowMs);
        return { region, status: 'failed', sendDate, error: 'campaign_id persist failed', retryable: true };
      }
    }
    await client.sendCampaign({ campaignId, idempotencyKey: `${region}:${sendDate}` });
  } catch (err) {
    const reason = summarizeError(err);
    // A SenderError uses its own retry taxonomy (5xx/timeout/network/429
    // retryable; most 4xx — e.g. a missing group — terminal). Any OTHER
    // error here is an unexpected internal/transient failure (e.g. a D1
    // hiccup in buildRegionDigest before any campaign was created); treat
    // it as retryable so a blip doesn't permanently dark the region for the
    // week. At worst CF burns its retry budget on a persistent bug, then
    // the row stays 'queued' and next week's send_date starts fresh.
    const retryable = err instanceof SenderError ? err.shouldRetry : true;
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

  // Send succeeded. From here on, the campaign IS sent — D1 bookkeeping
  // is best-effort and must not roll the outcome back to 'queued' (which
  // would re-send). Log on failure so an operator can clean up the stale
  // 'sending' row manually if needed; the stale-cutoff guard keeps the
  // row from being re-claimed before SENDING_STALE_MS elapses.
  await safeUpdateStatus(env.SMOKE_DB, region, sendDate, 'sent', nowMs);
  await recordEvent(env.SMOKE_DB, region, sendDate, 'sent', null, nowMs);
  return { region, status: 'sent', sendDate };
}

/**
 * Best-effort wrapper around updateStatus. A D1 hiccup after a
 * successful campaign send must NOT cascade to a re-send — see
 * processRegion's post-send comment.
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
 * Read the campaign id persisted by a prior attempt for this
 * (region, send_date), or null if none. Reused so a reclaim/retry never
 * creates a second campaign — see processRegion's idempotency comment.
 */
async function readCampaignId(
  db: D1Database,
  region: Region,
  sendDate: string
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT campaign_id FROM friday_campaign_log
        WHERE region = ? AND send_date = ?`
    )
    .bind(region, sendDate)
    .first<{ campaign_id: string | null }>();
  return row?.campaign_id ?? null;
}

/**
 * Persist the created campaign id on the (region, send_date) row. Returns
 * true on success; on a D1 error returns false (logged) so the caller can
 * abort the send and retry rather than broadcasting an un-deduplicatable
 * campaign.
 */
async function tryUpdateCampaignId(
  db: D1Database,
  region: Region,
  sendDate: string,
  campaignId: string,
  now: number
): Promise<boolean> {
  try {
    await db
      .prepare(
        `UPDATE friday_campaign_log
            SET campaign_id = ?, attempted_at = ?
          WHERE region = ? AND send_date = ?`
      )
      .bind(campaignId, now, region, sendDate)
      .run();
    return true;
  } catch (err) {
    console.warn('friday_campaign_log: campaign_id persist failed', {
      region,
      send_date: sendDate,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
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
 * Records a warning event when a region is in-window but the digest is
 * dark-disabled (e.g. SENDER_FROM_EMAIL unset). Idempotent: checks the
 * events table for a prior event with the same (region, sendDate, reason)
 * so repeated cron invocations within the same Friday window write at
 * most one event row per reason.
 */
async function recordSkipEvent(
  db: D1Database,
  region: Region,
  sendDate: string,
  reason: string,
  now: number
): Promise<void> {
  try {
    // Atomically insert only if no prior 'error' event for this
    // (region, sendDate, reason) already exists. This guards against
    // concurrent cron invocations in the same Friday window when the
    // dark-disable condition is consistently present. A single compound
    // statement is atomic in D1's underlying SQLite serialized writes.
    const payload = JSON.stringify({
      source: 'friday_cron',
      region,
      send_date: sendDate,
      reason,
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
              AND json_extract(payload, '$.reason') = ?
          )`
      )
      .bind('error', payload, now, region, sendDate, reason)
      .run();
  } catch (auditErr) {
    console.warn('friday_campaign_log: skip event insert failed', {
      region,
      send_date: sendDate,
      reason,
      error: summarizeError(auditErr),
    });
  }
}
