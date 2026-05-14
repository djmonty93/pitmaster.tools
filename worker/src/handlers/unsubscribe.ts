// POST /api/unsubscribe
//
// Body JSON: { email, token }. Token is the HMAC-SHA256 hex string
// issued by /api/subscribe (see lib/auth/token.ts). Without a valid
// token any caller could POST another user's email and mark them
// unsubscribed in D1; the auth check closes that IDOR.
//
// Like subscribe: MailerLite first, then D1. A retryable MailerLite
// failure enqueues but still updates D1 so the subscriber is treated
// as unsubscribed immediately.

import { z } from 'zod';
import { verifyToken } from '../lib/auth/token.js';
import { createMailerLiteClient } from '../lib/mailerlite/client.js';
import { MailerLiteError } from '../lib/mailerlite/errors.js';
import { enqueue } from '../lib/mailerlite/retry.js';
import { json, jsonError, type RouteContext } from '../router.js';

const UnsubscribeBody = z.object({
  email: z.string().email(),
  // 64 hex chars = 32-byte SHA-256 HMAC.
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
    // 401 with a generic message — don't tell the caller whether the
    // email is registered, only that the token didn't validate.
    return jsonError(401, 'invalid_token', 'Token does not match this email');
  }

  const client = createMailerLiteClient({ apiKey: rc.env.MAILERLITE_API_KEY });
  let status: 'sent' | 'queued' = 'sent';
  try {
    await client.unsubscribe({ email });
  } catch (err) {
    if (err instanceof MailerLiteError && err.shouldRetry) {
      await enqueue(rc.env.SMOKE_DB, {
        kind: 'unsubscribe',
        payload: { email },
        idempotencyKey: `unsubscribe:${email}`,
        cause: err,
      });
      status = 'queued';
    } else if (err instanceof MailerLiteError) {
      // Non-retryable — most likely "subscriber not found". That's a
      // soft success from the user's perspective; reflect it as 200
      // rather than 4xx. Still update D1 below so a stale row gets
      // marked unsubscribed.
    } else {
      throw err;
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
