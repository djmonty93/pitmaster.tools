// Durable retry queue for Sender.net calls backed by the
// `sender_retry` D1 table (see 0001_init.sql).
//
// Flow:
//   1. Caller invokes a client method (subscribe/unsubscribe).
//   2. If it throws a SenderError where shouldRetry is true, the
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

import { SenderError, type SenderRequestKind } from './errors.js';
import type { SenderClient, SubscribeInput, UnsubscribeInput } from './client.js';
import { ALL_GROUP_NAME, assignBbqGroups, regionToGroupName, removeBbqGroups, resolveGroupId } from './groups.js';
import { summarizeError } from '../redact.js';
import type { Region } from '../regions/index.js';

export interface EnqueueInput {
  kind: SenderRequestKind;
  /** Serialized arguments to replay against the client. */
  payload: unknown;
  /** Stable key; reuse the same one across retries to deduplicate. */
  idempotencyKey: string;
  /** Optional initial scheduling override (tests). */
  firstAttemptAtMs?: number;
  /** Error that caused the enqueue, for diagnostics. */
  cause?: SenderError;
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
  | { row: RetryRow; status: 'retry'; nextAttemptAt: number; error: SenderError }
  | { row: RetryRow; status: 'parked'; error: SenderError }
  | { row: RetryRow; status: 'dropped'; error: SenderError };

export interface RetryRow {
  id: number;
  request_kind: SenderRequestKind;
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
  // If Sender returned a Retry-After header, prefer it over the default
  // backoff, capped at MAX_BACKOFF_MS to guard against absurd values.
  const firstBackoff = input.cause?.retryAfterMs !== undefined
    ? Math.min(input.cause.retryAfterMs, MAX_BACKOFF_MS)
    : backoffMs(1);
  const nextAttemptAt = now + firstBackoff;
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
      `INSERT INTO sender_retry
         (request_kind, request_payload, idempotency_key, attempts, last_status, last_error, next_attempt_at, created_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         request_payload = excluded.request_payload,
         last_status     = excluded.last_status,
         last_error      = excluded.last_error,
         next_attempt_at = MIN(sender_retry.next_attempt_at, excluded.next_attempt_at)`
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
  client: SenderClient,
  kv: KVNamespace,
  opts: DrainOptions = {}
): Promise<DrainOutcome[]> {
  const nowFn = opts.now ?? Date.now;
  const now = nowFn();
  const batchSize = opts.batchSize ?? 25;
  // The retry queue's request_kind column accepts only the three kinds
  // the D1 schema's CHECK constraint allows: 'subscribe', 'unsubscribe',
  // and 'digest_trigger'. The SenderError.requestKind enum is wider (it
  // also includes 'group_assign', 'group_remove', 'group_list', and
  // 'field_update' for error-classification purposes), but those values
  // are never written to the retry table — they would fail the CHECK.
  // Only 'subscribe' and 'unsubscribe' are drained here; 'digest_trigger'
  // is reserved in the schema for future use.
  const rowsRes = await db
    .prepare(
      `SELECT id, request_kind, request_payload, idempotency_key, attempts,
              last_status, last_error, next_attempt_at, created_at
         FROM sender_retry
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
    const outcome = await replayRow(db, client, kv, row, nowFn);
    opts.onResult?.(outcome);
    outcomes.push(outcome);
  }
  return outcomes;
}

async function replayRow(
  db: D1Database,
  client: SenderClient,
  kv: KVNamespace,
  row: RetryRow,
  now: () => number
): Promise<DrainOutcome> {
  // Belt-and-braces narrow MUST run before anything that mutates D1.
  // Drain's SQL filter already excludes non-subscribe/unsubscribe kinds,
  // but if that filter ever drifts we still refuse to touch a row whose
  // dispatch path doesn't exist — no DELETE, no UPDATE, no audit. The
  // unsupported row stays in the queue for the owner step to claim.
  if (row.request_kind !== 'subscribe' && row.request_kind !== 'unsubscribe') {
    return {
      row,
      status: 'dropped',
      error: new SenderError(
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
    const e = new SenderError(
      row.request_kind,
      'malformed',
      summarizeError(err)
    );
    await db.prepare(`DELETE FROM sender_retry WHERE id = ?`).bind(row.id).run();
    await recordError(db, row, e, now());
    return { row, status: 'dropped', error: e };
  }

  try {
    await dispatch(client, kv, row.request_kind, payload);
    await db.prepare(`DELETE FROM sender_retry WHERE id = ?`).bind(row.id).run();
    return { row, status: 'sent' };
  } catch (err) {
    if (!(err instanceof SenderError) || !err.shouldRetry) {
      // Non-retryable failure (4xx like 400/422 on a stale payload):
      // drop the row to keep the queue moving. The cron context has
      // no user to surface the error to, so we write an `events` row
      // (kind='error') as the audit trail. Step 17's /api/status
      // surfaces these to operators.
      const wrapped =
        err instanceof SenderError
          ? err
          : new SenderError(row.request_kind, 'network', summarizeError(err));
      await db.prepare(`DELETE FROM sender_retry WHERE id = ?`).bind(row.id).run();
      await recordError(db, row, wrapped, now());
      return { row, status: 'dropped', error: wrapped };
    }
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      const parkedAt = now() + PARK_DELAY_MS;
      await db
        .prepare(
          `UPDATE sender_retry
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
    // Prefer Retry-After from the error when present — Sender told us
    // exactly how long to wait. Fall back to exponential backoffMs so
    // consecutive failures grow the gap (1m, 2m, 4m, …). Cap at
    // MAX_BACKOFF_MS regardless of source.
    const rawBackoff = err instanceof SenderError && err.retryAfterMs !== undefined
      ? err.retryAfterMs
      : backoffMs(attempts + 1);
    const nextAttemptAt = now() + Math.min(rawBackoff, MAX_BACKOFF_MS);
    await db
      .prepare(
        `UPDATE sender_retry
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
  err: SenderError,
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
      'sender_retry: events audit insert failed',
      { retry_id: row.id, kind: row.request_kind, error: summarizeError(auditErr) }
    );
  }
}

interface SubscribeRetryPayload extends SubscribeInput {
  region?: Region | null;
  /**
   * Region the subscriber WAS in before this resubscribe. When set and
   * different from `region`, the drain detaches pitmaster_<oldRegion>
   * after assigning the new groups so a region-change resubscribe that
   * happened during a Sender.net outage doesn't leave the subscriber
   * in both regional audiences after recovery.
   *
   * Optional because most queued subscribes are first-time signups
   * (no prior region) — only resubscribes carry this hint.
   */
  oldRegion?: Region | null;
}

interface GroupAssignStagePayload {
  stage: 'group_assign';
  subscriberId: string;
  region: Region | null;
  /**
   * Region the subscriber WAS in before this resubscribe. Symmetric
   * with SubscribeRetryPayload.oldRegion — when set and different from
   * `region`, the drain detaches pitmaster_<oldRegion> after assigning
   * the new groups. Without this hint, a transient assignBbqGroups
   * failure during a region-change resubscribe leaves the user in
   * BOTH regional audiences after drain recovery.
   */
  oldRegion?: Region | null;
}

interface GroupRemoveStagePayload {
  stage: 'group_remove';
  subscriberId: string;
  /** Group name like `pitmaster_southeast`; resolved at replay time. */
  groupName: string;
}

interface PreferencesStagePayload {
  stage: 'preferences';
  email: string;
  fields: Record<string, unknown>;
}

interface UnsubscribeRetryPayload extends UnsubscribeInput {
  /** Pre-resolved Sender subscriber id (skip the GET). */
  subscriberId?: string;
}

function isSubscribePayload(payload: unknown): payload is SubscribeRetryPayload {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as { email?: unknown; fields?: unknown };
  return typeof p.email === 'string' && !!p.fields && typeof p.fields === 'object';
}

function isGroupAssignStage(payload: unknown): payload is GroupAssignStagePayload {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as { stage?: unknown; subscriberId?: unknown };
  return p.stage === 'group_assign' && typeof p.subscriberId === 'string';
}

function isGroupRemoveStage(payload: unknown): payload is GroupRemoveStagePayload {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as { stage?: unknown; subscriberId?: unknown; groupName?: unknown };
  return (
    p.stage === 'group_remove' &&
    typeof p.subscriberId === 'string' &&
    typeof p.groupName === 'string'
  );
}

function isPreferencesStage(payload: unknown): payload is PreferencesStagePayload {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as { stage?: unknown; email?: unknown; fields?: unknown };
  return (
    p.stage === 'preferences' &&
    typeof p.email === 'string' &&
    !!p.fields &&
    typeof p.fields === 'object'
  );
}

function isUnsubscribePayload(payload: unknown): payload is UnsubscribeRetryPayload {
  if (!payload || typeof payload !== 'object') return false;
  return typeof (payload as { email?: unknown }).email === 'string';
}

/**
 * `kind` is narrowed to `'subscribe' | 'unsubscribe'` by the drain
 * SQL filter — digest_trigger and other reserved kinds are skipped at
 * the query level. The narrow type is enforced at compile time by the
 * union the caller passes in.
 */
type DispatchableKind = 'subscribe' | 'unsubscribe';

async function dispatch(
  client: SenderClient,
  kv: KVNamespace,
  kind: DispatchableKind,
  payload: unknown
): Promise<void> {
  switch (kind) {
    case 'subscribe':
      await dispatchSubscribe(client, kv, payload);
      return;
    case 'unsubscribe':
      await dispatchUnsubscribe(client, kv, payload);
      return;
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unknown dispatchable kind: ${_exhaustive as string}`);
    }
  }
}

/**
 * Replay a subscribe row. Two shapes are accepted:
 *   1. Full subscribe — payload carries {email, fields, region?}. We
 *      POST /api/subscribers and then assign the BBQ groups so the
 *      recovered subscriber actually ends up in pitmaster_all (and the
 *      regional group when we know it). Skipping the group assign here
 *      was the original [P1] bug: a transient Sender.net 5xx during
 *      subscribe used to leave the user ungrouped after recovery.
 *   2. Staged group_assign — payload carries {stage:'group_assign',
 *      subscriberId, region}. The subscribe call already succeeded on
 *      a prior pass; only the group assignment is owed.
 */
async function dispatchSubscribe(
  client: SenderClient,
  kv: KVNamespace,
  payload: unknown
): Promise<void> {
  if (isPreferencesStage(payload)) {
    // PATCH /api/preferences sync: push the bbq_* field deltas to
    // Sender.net WITHOUT a status field so an unsubscribed user who
    // queued a preference change is not silently reactivated when the
    // drain replays. The handler already short-circuits the unsub case
    // before enqueue, but a user could unsubscribe between enqueue and
    // drain — updateSubscriberFields closes that race window.
    //
    // NO group operations — the subscriber's group memberships are
    // unaffected by a preference change, only the conditional merge
    // tags in the email body are.
    await client.updateSubscriberFields(payload.email, payload.fields);
    return;
  }
  if (isGroupAssignStage(payload)) {
    if (payload.region) {
      await assignBbqGroups(client, kv, payload.subscriberId, payload.region);
    } else {
      const allGroupId = await resolveGroupId(client, kv, ALL_GROUP_NAME);
      await client.assignGroup(payload.subscriberId, allGroupId);
    }
    // Stale-region cleanup mirroring the full-replay path. The
    // subscribe handler's own inline detach was skipped because the
    // assign threw and gated the cleanup on success — finish it here.
    if (payload.oldRegion && payload.oldRegion !== payload.region) {
      const staleGroupId = await resolveGroupId(
        client,
        kv,
        regionToGroupName(payload.oldRegion)
      );
      await client.removeGroup(payload.subscriberId, staleGroupId);
    }
    return;
  }
  if (isGroupRemoveStage(payload)) {
    // Targeted single-group removal — used by subscribe's stale-region
    // cleanup when the user moves zips across regions. Distinct from
    // unsubscribe's removeBbqGroups which removes from ALL pitmaster_*
    // groups; here we only detach the one stale regional group.
    const groupId = await resolveGroupId(client, kv, payload.groupName);
    await client.removeGroup(payload.subscriberId, groupId);
    return;
  }
  if (!isSubscribePayload(payload)) {
    throw new SenderError('subscribe', 'malformed', 'missing or invalid email/fields');
  }
  const { region: _region, oldRegion: _oldRegion, ...subscribeInput } = payload;
  const result = await client.subscribe(subscribeInput);
  if (payload.region) {
    await assignBbqGroups(client, kv, result.id, payload.region);
  } else {
    const allGroupId = await resolveGroupId(client, kv, ALL_GROUP_NAME);
    await client.assignGroup(result.id, allGroupId);
  }
  // Stale-region cleanup: if this was a region-change resubscribe
  // captured at enqueue time, detach the prior regional group AFTER
  // the new assign succeeds. Without this, a transient Sender.net
  // outage during a region-change subscribe leaves the user in BOTH
  // pitmaster_<old> and pitmaster_<new> after drain recovery — the
  // subscribe handler's stale-detach logic was bypassed because
  // senderId was null at the time. Mirrors the handler's
  // gated-on-success guard so a partial replay doesn't strand the
  // user in neither regional audience.
  if (payload.oldRegion && payload.oldRegion !== payload.region) {
    const staleGroupId = await resolveGroupId(client, kv, regionToGroupName(payload.oldRegion));
    await client.removeGroup(result.id, staleGroupId);
  }
}

/**
 * Replay an unsubscribe row. The portfolio-aware behavior is
 * group-scoped removal — DO NOT call client.unsubscribe (which would
 * set status=unsubscribed account-wide and detach the subscriber from
 * sibling-site groups too). Original [P1] bug: a transient 5xx during
 * the group-removal phase used to enqueue kind='unsubscribe' which the
 * drain dispatched to client.unsubscribe, breaking the
 * portfolio-aware promise specifically during transient failures.
 *
 * Payload may include a pre-resolved subscriberId to skip the GET
 * (set by the handler when group removal failed after the lookup
 * already succeeded). When the GET path runs and Sender.net returns
 * null (subscriber not in Sender.net), nothing further is owed —
 * D1 was already marked unsubscribed by the original handler.
 */
async function dispatchUnsubscribe(
  client: SenderClient,
  kv: KVNamespace,
  payload: unknown
): Promise<void> {
  if (!isUnsubscribePayload(payload)) {
    throw new SenderError('unsubscribe', 'malformed', 'missing or invalid email');
  }
  let subscriberId: string | null = payload.subscriberId ?? null;
  if (!subscriberId) {
    const found = await client.getSubscriberByEmail(payload.email);
    subscriberId = found?.id ?? null;
  }
  if (!subscriberId) return;
  await removeBbqGroups(client, kv, subscriberId);
}
