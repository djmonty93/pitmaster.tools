// POST /api/unsubscribe
//
// Body JSON: { email, token }.
//
// Portfolio-aware behavior: instead of setting status=unsubscribed at
// the MailerLite account level (which would also remove the subscriber
// from any future powersizing_*, overlanding_* groups they belong to),
// we remove them from the BBQ-prefixed groups only. The subscriber
// stays in MailerLite as `status=active` so sibling sites can keep
// emailing them.
//
// Flow:
//   1. Verify HMAC token against the email.
//   2. Look up the subscriber's MailerLite id (GET /api/subscribers/:email).
//      Null result means "never made it into MailerLite" — still mark
//      D1 unsubscribed and return success.
//   3. removeBbqGroups: DELETE from pitmaster_all + every pitmaster_<region>.
//   4. UPDATE D1 subscribers SET unsubscribed_at = now.
//
// Retryable MailerLite failures during group removal enqueue on
// mailerlite_retry and still update D1 — the user sees immediate
// success and the queue catches up later.

import { z } from 'zod';
import { verifyToken } from '../lib/auth/token.js';
import { createMailerLiteClient } from '../lib/mailerlite/client.js';
import { MailerLiteError } from '../lib/mailerlite/errors.js';
import { removeBbqGroups } from '../lib/mailerlite/groups.js';
import { enqueue } from '../lib/mailerlite/retry.js';
import { summarizeError } from '../lib/redact.js';
import { json, jsonError, type RouteContext } from '../router.js';

const UnsubscribeBody = z.object({
  email: z.string().email(),
  token: z.string().regex(/^[0-9a-f]{64}$/i),
});

export async function handleUnsubscribe(rc: RouteContext): Promise<Response> {
  let raw: unknown;
  try {
    raw = await rc.request.json();
  } catch (_err) {
    return jsonError(400, 'invalid_json', 'Request body must be JSON');
  }
  const parsed = UnsubscribeBody.safeParse(raw);
  if (!parsed.success) {
    return jsonError(400, 'invalid_body', 'Request body failed validation', parsed.error.issues);
  }
  const email = parsed.data.email.trim().toLowerCase();
  const ok = await verifyToken(email, parsed.data.token, rc.env.SUBSCRIBER_TOKEN_SECRET);
  if (!ok) {
    return jsonError(401, 'invalid_token', 'Token does not match this email');
  }

  const client = createMailerLiteClient({ apiKey: rc.env.MAILERLITE_API_KEY });
  let status: 'sent' | 'queued' = 'sent';
  let subscriberId: string | null = null;
  try {
    const found = await client.getSubscriberByEmail(email);
    subscriberId = found?.id ?? null;
  } catch (err) {
    if (!(err instanceof MailerLiteError)) {
      throw err;
    }
    // client.getSubscriberByEmail ALREADY swallows 404 (returns null),
    // so any MailerLiteError that propagates here is something else:
    // 401/403 (revoked key), 5xx, timeout, etc. Treating these as
    // "not in MailerLite" would let the handler skip group removal
    // and report unsubscribe success while the user remains in
    // pitmaster_* groups. Queue the retry instead so the drain can
    // complete the cleanup once the upstream recovers (or park the
    // row for operator triage after MAX_ATTEMPTS).
    await enqueue(rc.env.SMOKE_DB, {
      kind: 'unsubscribe',
      payload: { email },
      idempotencyKey: `unsubscribe:${email}`,
      cause: err.shouldRetry ? err : undefined,
    });
    status = 'queued';
  }

  if (subscriberId) {
    try {
      await removeBbqGroups(client, rc.env.WEATHER_KV, subscriberId);
    } catch (err) {
      // Any failure here (retryable or not) potentially leaves the
      // subscriber in one or more pitmaster_* groups — removeBbqGroups
      // iterates seven DELETEs and a mid-loop 4xx (group missing,
      // unexpected response shape, etc.) could mean some removals
      // succeeded and others didn't. Enqueue regardless so the
      // retry drain re-attempts the full remove sequence.
      //
      // Original [P2] pass-5 bug: a non-retryable error after partial
      // removal used to be swallowed and the response still said
      // 'sent', leaving the subscriber on the regional automation's
      // audience even though D1 said unsubscribed.
      const cause = err instanceof MailerLiteError ? err : undefined;
      await enqueue(rc.env.SMOKE_DB, {
        kind: 'unsubscribe',
        payload: { email, subscriberId, stage: 'remove_groups' },
        idempotencyKey: `unsubscribe:${email}`,
        cause,
      });
      status = 'queued';
      if (!(err instanceof MailerLiteError)) {
        console.warn('unsubscribe: removeBbqGroups unexpected error', summarizeError(err));
      }
    }
  }

  const now = Date.now();
  await rc.env.SMOKE_DB.prepare(
    `UPDATE subscribers SET unsubscribed_at = ? WHERE email = ?`
  )
    .bind(now, email)
    .run();

  return json(200, { status, email });
}
