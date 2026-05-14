// Durable retry queue for MailerLite calls backed by the
// `mailerlite_retry` D1 table (see 0001_init.sql).
//
// Flow:
//   1. Caller invokes a client method (subscribe/unsubscribe/sendCampaign).
//   2. If it throws a MailerLiteError where shouldRetry is true, the
//      caller invokes enqueue() with the same payload + idempotency key.
//   3. A cron (Step 11) periodically calls drain() to replay queued
//      rows whose next_attempt_at <= now. On success the row is
//      deleted; on another retryable failure the row is rescheduled
//      with exponential backoff. After MAX_ATTEMPTS it is parked
//      (attempts incremented, next_attempt_at set far in the future)
//      so a human can triage from /api/status without it spinning.
//
// Idempotency is enforced by the UNIQUE constraint on idempotency_key.
// enqueue() handles the duplicate gracefully (a second enqueue of the
// same key updates last_error/attempts without inserting), so retries
// from concurrent fetches don't fan out into multiple rows.

import { MailerLiteError, type MailerLiteRequestKind } from './errors.js';
import type { MailerLiteClient } from './client.js';

export interface EnqueueInput {
  kind: MailerLiteRequestKind;
  /** Serialized arguments to replay against the client. */
  payload: unknown;
  /** Stable key; reuse the same one across retries to deduplicate. */
  idempotencyKey: string;
  /** Optional initial scheduling override (tests). */
  firstAttemptAtMs?: number;
  /** Error that caused the enqueue, for diagnostics. */
  cause?: MailerLiteError;
}

export interface DrainOptions {
  /** Max rows to process per drain call. Default 25. */
  batchSize?: number;
  /** Override for tests so backoff is deterministic. */
  now?: () => number;
  /** Per-row telemetry hook. */
  onResult?: (outcome: DrainOutcome) => void;
}

export type DrainOutcome =
  | { row: RetryRow; status: 'sent' }
  | { row: RetryRow; status: 'retry'; nextAttemptAt: number; error: MailerLiteError }
  | { row: RetryRow; status: 'parked'; error: MailerLiteError }
  | { row: RetryRow; status: 'dropped'; error: MailerLiteError };

export interface RetryRow {
  id: number;
  request_kind: MailerLiteRequestKind;
  request_payload: string;
  idempotency_key: string;
  attempts: number;
  last_status: number | null;
  last_error: string | null;
  next_attempt_at: number;
  created_at: number;
}

/** After this many attempts a row is parked and stops being drained. */
export const MAX_ATTEMPTS = 8;
/** Cap individual back-off at 6 h so a 24-h-old row still gets a chance. */
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
/** Park a row this far in the future once MAX_ATTEMPTS is hit. */
export const PARK_DELAY_MS = 365 * 24 * 60 * 60 * 1000;

export function backoffMs(attempts: number): number {
  // 1m, 2m, 4m, 8m, 16m, 32m, 1h4m, 2h8m, … capped.
  const ms = Math.min(MAX_BACKOFF_MS, 60_000 * Math.pow(2, Math.max(0, attempts - 1)));
  return ms;
}

export async function enqueue(db: D1Database, input: EnqueueInput): Promise<void> {
  const now = input.firstAttemptAtMs ?? Date.now();
  const nextAttemptAt = now + backoffMs(1);
  const lastError = input.cause ? input.cause.message.slice(0, 500) : null;
  const lastStatus = input.cause?.status ?? null;
  // ON CONFLICT lets a concurrent caller enqueue the same idempotency
  // key without exploding; we just bump attempt accounting on the
  // existing row instead of inserting a duplicate.
  await db
    .prepare(
      `INSERT INTO mailerlite_retry
         (request_kind, request_payload, idempotency_key, attempts, last_status, last_error, next_attempt_at, created_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         last_status = excluded.last_status,
         last_error  = excluded.last_error,
         next_attempt_at = MIN(mailerlite_retry.next_attempt_at, excluded.next_attempt_at)`
    )
    .bind(
      input.kind,
      JSON.stringify(input.payload),
      input.idempotencyKey,
      lastStatus,
      lastError,
      nextAttemptAt,
      now
    )
    .run();
}

export async function drain(
  db: D1Database,
  client: MailerLiteClient,
  opts: DrainOptions = {}
): Promise<DrainOutcome[]> {
  const now = (opts.now ?? Date.now)();
  const batchSize = opts.batchSize ?? 25;
  const rowsRes = await db
    .prepare(
      `SELECT id, request_kind, request_payload, idempotency_key, attempts,
              last_status, last_error, next_attempt_at, created_at
         FROM mailerlite_retry
        WHERE next_attempt_at <= ?
          AND attempts < ?
        ORDER BY next_attempt_at ASC
        LIMIT ?`
    )
    .bind(now, MAX_ATTEMPTS, batchSize)
    .all<RetryRow>();

  const outcomes: DrainOutcome[] = [];
  for (const row of rowsRes.results) {
    const outcome = await replayRow(db, client, row, opts.now ?? Date.now);
    opts.onResult?.(outcome);
    outcomes.push(outcome);
  }
  return outcomes;
}

async function replayRow(
  db: D1Database,
  client: MailerLiteClient,
  row: RetryRow,
  now: () => number
): Promise<DrainOutcome> {
  let payload: unknown;
  try {
    payload = JSON.parse(row.request_payload);
  } catch (err) {
    const e = new MailerLiteError(
      row.request_kind,
      'malformed',
      `corrupt payload: ${err instanceof Error ? err.message : String(err)}`
    );
    // A row we can't parse will never replay — drop it so the queue
    // doesn't get stuck on it. The drain caller's onResult hook is the
    // single chance to log it before deletion.
    await db.prepare(`DELETE FROM mailerlite_retry WHERE id = ?`).bind(row.id).run();
    return { row, status: 'dropped', error: e };
  }

  try {
    await dispatch(client, row.request_kind, payload);
    await db.prepare(`DELETE FROM mailerlite_retry WHERE id = ?`).bind(row.id).run();
    return { row, status: 'sent' };
  } catch (err) {
    if (!(err instanceof MailerLiteError) || !err.shouldRetry) {
      // Non-retryable failure (4xx like 400/422 on a stale payload):
      // drop the row to keep the queue moving. The original failure
      // already surfaced to the user; replaying the same call would
      // produce the same 4xx forever.
      await db.prepare(`DELETE FROM mailerlite_retry WHERE id = ?`).bind(row.id).run();
      return {
        row,
        status: 'dropped',
        error:
          err instanceof MailerLiteError
            ? err
            : new MailerLiteError(row.request_kind, 'network', String(err)),
      };
    }
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      const parkedAt = now() + PARK_DELAY_MS;
      await db
        .prepare(
          `UPDATE mailerlite_retry
              SET attempts = ?, last_status = ?, last_error = ?, next_attempt_at = ?
            WHERE id = ?`
        )
        .bind(attempts, err.status ?? null, err.message.slice(0, 500), parkedAt, row.id)
        .run();
      return { row, status: 'parked', error: err };
    }
    const nextAttemptAt = now() + backoffMs(attempts);
    await db
      .prepare(
        `UPDATE mailerlite_retry
            SET attempts = ?, last_status = ?, last_error = ?, next_attempt_at = ?
          WHERE id = ?`
      )
      .bind(attempts, err.status ?? null, err.message.slice(0, 500), nextAttemptAt, row.id)
      .run();
    return { row, status: 'retry', nextAttemptAt, error: err };
  }
}

async function dispatch(
  client: MailerLiteClient,
  kind: MailerLiteRequestKind,
  payload: unknown
): Promise<void> {
  // Each kind has its own payload shape; we let TypeScript's
  // structural check guard the union here by re-parsing inside each
  // arm. If a future kind is added the switch becomes exhaustive via
  // the `never` fall-through.
  switch (kind) {
    case 'subscribe': {
      const p = payload as { email: string; metroSlug?: string | null; cut?: string | null; cooker?: string | null; timezone?: string | null };
      await client.subscribe(p as never);
      return;
    }
    case 'unsubscribe': {
      const p = payload as { email: string };
      await client.unsubscribe(p);
      return;
    }
    case 'send': {
      const p = payload as { campaignId: string; filter?: Record<string, string> };
      await client.sendCampaign(p);
      return;
    }
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unknown mailerlite retry kind: ${_exhaustive as string}`);
    }
  }
}
