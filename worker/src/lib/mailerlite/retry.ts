// Durable retry queue for MailerLite calls backed by the
// `mailerlite_retry` D1 table (see 0001_init.sql).
//
// Flow:
//   1. Caller invokes a client method (subscribe/unsubscribe).
//   2. If it throws a MailerLiteError where shouldRetry is true, the
//      caller invokes enqueue() with the same payload + idempotency key.
//   3. A cron (Step 11) periodically calls drain() to replay queued
//      rows whose next_attempt_at <= now. On success the row is
//      deleted; on another retryable failure the row is rescheduled
//      with exponential backoff. After MAX_ATTEMPTS it is parked
//      (attempts incremented, next_attempt_at set far in the future)
//      so a human can triage from /api/status without it spinning.
//
// Backoff schedule (gap between consecutive attempts), assuming
// continued retryable failures from enqueue at t0:
//   t0 → first replay      : +1m   (enqueue uses backoffMs(1))
//   replay1 → replay2      : +2m
//   replay2 → replay3      : +4m
//   ... doubling, capped at MAX_BACKOFF_MS (6h)
// With MAX_ATTEMPTS = 10 the final retry waits ~256m and then parks.
//
// Idempotency is enforced by the UNIQUE constraint on idempotency_key.
// enqueue() handles the duplicate gracefully (ON CONFLICT DO UPDATE
// keeps the row but refreshes payload + clamps next_attempt_at down so
// the duplicate hint speeds up the next attempt instead of pushing it
// out). The `attempts` counter is preserved across duplicate enqueues
// — a second concurrent failure for the same key shouldn't reset the
// retry history.

import { MailerLiteError, type MailerLiteRequestKind } from './errors.js';
import type { MailerLiteClient } from './client.js';
import { summarizeError } from '../redact.js';

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
export const MAX_ATTEMPTS = 10;
/** Cap individual back-off at 6 h so a 24-h-old row still gets a chance. */
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
/** Park a row this far in the future once MAX_ATTEMPTS is hit. */
export const PARK_DELAY_MS = 365 * 24 * 60 * 60 * 1000;

export function backoffMs(attempts: number): number {
  // backoffMs(1) = 1m, backoffMs(2) = 2m, backoffMs(3) = 4m, …
  // Capped at MAX_BACKOFF_MS. attempts < 1 collapses to 1m so a
  // misuse never produces a zero-delay tight loop.
  const n = Math.max(1, attempts);
  return Math.min(MAX_BACKOFF_MS, 60_000 * Math.pow(2, n - 1));
}

export async function enqueue(db: D1Database, input: EnqueueInput): Promise<void> {
  const now = input.firstAttemptAtMs ?? Date.now();
  // First replay attempt is 1m out (backoffMs(1)) — matches the
  // canonical "give the upstream a minute to recover" gap before we
  // burn an internal retry slot on a still-broken provider.
  const nextAttemptAt = now + backoffMs(1);
  const causeMessage = input.cause ? summarizeError(input.cause) : null;
  const lastError = causeMessage ? causeMessage.slice(0, 500) : null;
  const lastStatus = input.cause?.status ?? null;
  const payloadJson = JSON.stringify(input.payload);

  // ON CONFLICT: refresh the payload (latest caller wins — the row's
  // idempotency_key is the logical identity, not the byte-exact
  // payload) and clamp next_attempt_at downward so a duplicate hint
  // speeds up the next attempt. `attempts` is intentionally NOT
  // touched on the UPDATE path so the retry history is preserved
  // across concurrent enqueues.
  await db
    .prepare(
      `INSERT INTO mailerlite_retry
         (request_kind, request_payload, idempotency_key, attempts, last_status, last_error, next_attempt_at, created_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         request_payload = excluded.request_payload,
         last_status     = excluded.last_status,
         last_error      = excluded.last_error,
         next_attempt_at = MIN(mailerlite_retry.next_attempt_at, excluded.next_attempt_at)`
    )
    .bind(
      input.kind,
      payloadJson,
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
  const nowFn = opts.now ?? Date.now;
  const now = nowFn();
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
    const outcome = await replayRow(db, client, row, nowFn);
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
      summarizeError(err)
    );
    await db.prepare(`DELETE FROM mailerlite_retry WHERE id = ?`).bind(row.id).run();
    await recordError(db, row, e, now());
    return { row, status: 'dropped', error: e };
  }

  try {
    await dispatch(client, row.request_kind, payload);
    await db.prepare(`DELETE FROM mailerlite_retry WHERE id = ?`).bind(row.id).run();
    return { row, status: 'sent' };
  } catch (err) {
    if (!(err instanceof MailerLiteError) || !err.shouldRetry) {
      // Non-retryable failure (4xx like 400/422 on a stale payload):
      // drop the row to keep the queue moving. The cron context has
      // no user to surface the error to, so we write an `events` row
      // (kind='error') as the audit trail. Step 17's /api/status
      // surfaces these to operators.
      const wrapped =
        err instanceof MailerLiteError
          ? err
          : new MailerLiteError(row.request_kind, 'network', summarizeError(err));
      await db.prepare(`DELETE FROM mailerlite_retry WHERE id = ?`).bind(row.id).run();
      await recordError(db, row, wrapped, now());
      return { row, status: 'dropped', error: wrapped };
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
        .bind(
          attempts,
          err.status ?? null,
          summarizeError(err).slice(0, 500),
          parkedAt,
          row.id
        )
        .run();
      await recordError(db, row, err, now());
      return { row, status: 'parked', error: err };
    }
    // backoffMs(attempts + 1) so consecutive failures grow the gap
    // (1m, 2m, 4m, …). Using backoffMs(attempts) would reuse the
    // same delay twice on attempts=1 because enqueue already used
    // backoffMs(1) as the initial schedule.
    const nextAttemptAt = now() + backoffMs(attempts + 1);
    await db
      .prepare(
        `UPDATE mailerlite_retry
            SET attempts = ?, last_status = ?, last_error = ?, next_attempt_at = ?
          WHERE id = ?`
      )
      .bind(
        attempts,
        err.status ?? null,
        summarizeError(err).slice(0, 500),
        nextAttemptAt,
        row.id
      )
      .run();
    return { row, status: 'retry', nextAttemptAt, error: err };
  }
}

async function recordError(
  db: D1Database,
  row: RetryRow,
  err: MailerLiteError,
  now: number
): Promise<void> {
  // Best-effort audit log — failures to write here must not mask the
  // original drain outcome, so we swallow any insert error. The
  // events table CHECK enforces kind='error' is one of the allowed
  // values (see migration 0001).
  try {
    const payload = JSON.stringify({
      retry_id: row.id,
      idempotency_key: row.idempotency_key,
      kind: row.request_kind,
      attempts: row.attempts,
      status: err.status ?? null,
      error: summarizeError(err),
    });
    await db
      .prepare(`INSERT INTO events (kind, payload, created_at) VALUES (?, ?, ?)`)
      .bind('error', payload, now)
      .run();
  } catch (_err) {
    /* swallow — see comment above */
  }
}

interface SubscribePayload {
  email: string;
  metroSlug?: string | null;
  cut?: string | null;
  cooker?: string | null;
  timezone?: string | null;
}

function asSubscribePayload(payload: unknown): SubscribePayload {
  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof (payload as { email?: unknown }).email !== 'string'
  ) {
    throw new MailerLiteError('subscribe', 'malformed', 'missing or invalid email');
  }
  return payload as SubscribePayload;
}

function asUnsubscribePayload(payload: unknown): { email: string } {
  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof (payload as { email?: unknown }).email !== 'string'
  ) {
    throw new MailerLiteError('unsubscribe', 'malformed', 'missing or invalid email');
  }
  return payload as { email: string };
}

async function dispatch(
  client: MailerLiteClient,
  kind: MailerLiteRequestKind,
  payload: unknown
): Promise<void> {
  switch (kind) {
    case 'subscribe':
      await client.subscribe(asSubscribePayload(payload) as Parameters<MailerLiteClient['subscribe']>[0]);
      return;
    case 'unsubscribe':
      await client.unsubscribe(asUnsubscribePayload(payload));
      return;
    case 'send':
      // Step 11 (Friday cron) is the owner of the campaign send path
      // — see client.ts header comment. Until then, draining a 'send'
      // row would be a no-op; we surface it as a malformed dispatch
      // so the row gets dropped (via the non-retryable branch in
      // replayRow) and an events audit is written, instead of
      // looping forever on something we have no code path for.
      throw new MailerLiteError(
        'send',
        'malformed',
        "'send' dispatch is owned by Step 11 (Friday cron); this row predates that work"
      );
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unknown mailerlite retry kind: ${_exhaustive as string}`);
    }
  }
}
