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
import type { MailerLiteClient, SubscribeInput, UnsubscribeInput } from './client.js';
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
  // 'send' is reserved in the schema but Step 11 owns the dispatch
  // path. Leave any 'send' rows in the queue (do not select them) so
  // Step 11's cron picks them up exactly once and isn't preceded by a
  // silent data-loss drop here. The supported kinds will widen when
  // Step 11 lands; for now this is the gate.
  const rowsRes = await db
    .prepare(
      `SELECT id, request_kind, request_payload, idempotency_key, attempts,
              last_status, last_error, next_attempt_at, created_at
         FROM mailerlite_retry
        WHERE next_attempt_at <= ?
          AND attempts < ?
          AND request_kind IN ('subscribe', 'unsubscribe')
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
  // Belt-and-braces narrow MUST run before anything that mutates D1.
  // Drain's SQL filter already excludes 'send' (and any future kind
  // we haven't owned yet), but if that filter ever drifts we still
  // refuse to touch a row whose dispatch path doesn't exist — no
  // DELETE, no UPDATE, no audit. The unsupported row stays in the
  // queue for the owner step to claim.
  if (row.request_kind !== 'subscribe' && row.request_kind !== 'unsubscribe') {
    return {
      row,
      status: 'dropped',
      error: new MailerLiteError(
        row.request_kind,
        'malformed',
        `unsupported kind ${row.request_kind} reached replayRow; drain filter is stale`
      ),
    };
  }

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
  } catch (auditErr) {
    // Surface to workerd logs so an operator can correlate a missing
    // audit row with a real failure. Still swallowed at the function
    // boundary — the drain outcome takes precedence.
    console.warn(
      'mailerlite_retry: events audit insert failed',
      { retry_id: row.id, kind: row.request_kind, error: summarizeError(auditErr) }
    );
  }
}

function isSubscribePayload(payload: unknown): payload is SubscribeInput {
  if (!payload || typeof payload !== 'object') return false;
  return typeof (payload as { email?: unknown }).email === 'string';
}

function isUnsubscribePayload(payload: unknown): payload is UnsubscribeInput {
  if (!payload || typeof payload !== 'object') return false;
  return typeof (payload as { email?: unknown }).email === 'string';
}

/**
 * `kind` is narrowed to `'subscribe' | 'unsubscribe'` by the drain
 * SQL filter — 'send' rows are skipped at the query level until Step
 * 11 owns that dispatch path. The narrow type is enforced at compile
 * time by the union the caller passes in.
 */
type DispatchableKind = 'subscribe' | 'unsubscribe';

async function dispatch(
  client: MailerLiteClient,
  kind: DispatchableKind,
  payload: unknown
): Promise<void> {
  switch (kind) {
    case 'subscribe': {
      if (!isSubscribePayload(payload)) {
        throw new MailerLiteError('subscribe', 'malformed', 'missing or invalid email');
      }
      await client.subscribe(payload);
      return;
    }
    case 'unsubscribe': {
      if (!isUnsubscribePayload(payload)) {
        throw new MailerLiteError('unsubscribe', 'malformed', 'missing or invalid email');
      }
      await client.unsubscribe(payload);
      return;
    }
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unknown dispatchable kind: ${_exhaustive as string}`);
    }
  }
}
