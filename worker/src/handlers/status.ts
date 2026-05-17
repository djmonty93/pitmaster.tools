// GET /api/status — operational health for the status page (Step 17).
//
// Returns JSON describing:
//   - retry queue: pending / parked counts so an operator can see the
//     MailerLite backlog at a glance.
//   - recent errors: last 10 events of kind='error', minimal shape so
//     an operator can correlate without exposing PII (events.payload
//     is already redacted by lib/redact.ts at write time).
//   - subscribers: total count and active count.
//   - build: a static descriptor so dashboards know what's deployed.
//
// We don't include MailerLite or weather provider health checks here
// — those would mean live network calls on every dashboard refresh,
// which is the wrong cost shape for a status page. Operators read
// /api/status; Sentry surfaces the real-time failures.

import { json, type RouteContext } from '../router.js';
import { MAX_ATTEMPTS } from '../lib/sender/retry.js';

interface StatusResponse {
  ok: true;
  generatedAt: string;
  esp_retry: {
    esp_retry_pending: number;
    esp_retry_parked: number;
    nextAttemptAt: number | null;
  };
  subscribers: {
    total: number;
    active: number;
  };
  recentErrors: Array<{
    id: number;
    createdAt: number;
    summary: string;
  }>;
}

export async function handleStatus(rc: RouteContext): Promise<Response> {
  const db = rc.env.SMOKE_DB;

  // Queued = attempts < MAX_ATTEMPTS; parked = attempts >= MAX_ATTEMPTS.
  // Two single-aggregate queries are cheaper than a GROUP BY + post-
  // process for D1's per-statement cost shape.
  const queued = await db
    .prepare(
      `SELECT COUNT(*) AS c, MIN(next_attempt_at) AS next
         FROM sender_retry WHERE attempts < ?`
    )
    .bind(MAX_ATTEMPTS)
    .first<{ c: number; next: number | null }>();
  const parked = await db
    .prepare(`SELECT COUNT(*) AS c FROM sender_retry WHERE attempts >= ?`)
    .bind(MAX_ATTEMPTS)
    .first<{ c: number }>();
  const subs = await db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN unsubscribed_at IS NULL THEN 1 ELSE 0 END) AS active
       FROM subscribers`
    )
    .first<{ total: number; active: number }>();
  const events = await db
    .prepare(
      `SELECT id, payload, created_at
         FROM events
        WHERE kind = 'error'
        ORDER BY created_at DESC
        LIMIT 10`
    )
    .all<{ id: number; payload: string | null; created_at: number }>();

  const recentErrors = events.results.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    summary: summarizeEventPayload(row.payload),
  }));

  const body: StatusResponse = {
    ok: true,
    generatedAt: new Date().toISOString(),
    esp_retry: {
      esp_retry_pending: queued?.c ?? 0,
      esp_retry_parked: parked?.c ?? 0,
      nextAttemptAt: queued?.next ?? null,
    },
    subscribers: {
      total: subs?.total ?? 0,
      active: Number(subs?.active ?? 0),
    },
    recentErrors,
  };
  return json(200, body, { 'Cache-Control': 'no-store' });
}

function summarizeEventPayload(payload: string | null): string {
  if (!payload) return '';
  try {
    const obj = JSON.parse(payload) as Record<string, unknown>;
    const kind = typeof obj.kind === 'string' ? obj.kind : 'unknown';
    const error = typeof obj.error === 'string' ? obj.error : '';
    return `${kind}: ${error}`.slice(0, 200);
  } catch (_err) {
    return payload.slice(0, 200);
  }
}
