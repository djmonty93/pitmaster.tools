// POST /api/subscribe
//
// Body JSON: { email, zip, cut?, cooker?, metroSlug?, timezone? }.
// If `timezone` is omitted, we resolve it via the zip geocoder (which
// stores it on the metros table or fetches via Open-Meteo).
//
// Two writes happen, in order:
//   1. MailerLite subscribe (upsert by email).
//   2. D1 INSERT … ON CONFLICT (email) DO UPDATE on `subscribers`.
//
// If MailerLite returns a retryable error, we enqueue on
// `mailerlite_retry` and still write the D1 row so the user can
// receive Friday emails once the queue drains. If MailerLite returns
// a non-retryable error (bad email, etc.) we surface 4xx and do NOT
// write the D1 row.

import { z } from 'zod';
import { signToken } from '../lib/auth/token.js';
import { createMailerLiteClient } from '../lib/mailerlite/client.js';
import { MailerLiteError } from '../lib/mailerlite/errors.js';
import { enqueue } from '../lib/mailerlite/retry.js';
import { GeocoderError, resolveZip } from '../lib/geo/zipGeocoder.js';
import { json, jsonError, type RouteContext } from '../router.js';

// Trim + lowercase the email BEFORE running the email-shape check so
// a "  Me@Example.COM  " paste mistake doesn't get rejected as
// schema-invalid and so the same address always produces the same
// downstream key (D1, MailerLite idempotency, HMAC token).
const NormalizedEmail = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
  z.string().email()
);

const SubscribeBody = z.object({
  email: NormalizedEmail,
  zip: z.string().regex(/^\d{5}$/),
  cut: z
    .enum([
      'brisket-flat',
      'brisket-packer',
      'pork-butt',
      'spare-ribs',
      'baby-back-ribs',
      'pork-loin',
      'whole-chicken',
      'spatchcock-chicken',
      'chicken-thighs',
      'whole-turkey',
      'turkey-breast',
      'fish',
      'lamb-shoulder',
    ])
    .nullable()
    .optional(),
  cooker: z.enum(['offset', 'pellet', 'kamado', 'kettle', 'electric']).nullable().optional(),
  metroSlug: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .nullable()
    .optional(),
  timezone: z.string().min(3).nullable().optional(),
});

export async function handleSubscribe(rc: RouteContext): Promise<Response> {
  let raw: unknown;
  try {
    raw = await rc.request.json();
  } catch (_err) {
    return jsonError(400, 'invalid_json', 'Request body must be JSON');
  }
  const parsed = SubscribeBody.safeParse(raw);
  if (!parsed.success) {
    return jsonError(400, 'invalid_body', 'Request body failed validation', parsed.error.issues);
  }
  // `parsed.data.email` is already trim+lowercased by NormalizedEmail.
  const body = parsed.data;

  // Resolve metro + timezone if either is missing. The geocoder
  // either returns a hit from D1 metros (fast path) or via
  // Open-Meteo (slow path, cached). If geocoding fails we still
  // proceed — the subscriber will just default to no metro tag and
  // UTC. That's a degraded-but-functional state, better than failing
  // the subscribe.
  let resolvedMetroSlug: string | null = body.metroSlug ?? null;
  let resolvedTimezone: string = body.timezone ?? 'UTC';
  if (!body.metroSlug || !body.timezone) {
    try {
      const loc = await resolveZip(rc.env.WEATHER_KV, rc.env.SMOKE_DB, body.zip);
      resolvedMetroSlug = body.metroSlug ?? loc.metroSlug;
      resolvedTimezone = body.timezone ?? loc.timezone;
    } catch (err) {
      if (!(err instanceof GeocoderError)) throw err;
      // Fall through with defaults.
    }
  }

  const client = createMailerLiteClient({ apiKey: rc.env.MAILERLITE_API_KEY });
  const subscribeInput = {
    email: body.email,
    metroSlug: resolvedMetroSlug,
    cut: body.cut ?? null,
    cooker: body.cooker ?? null,
    timezone: resolvedTimezone,
  };

  let mailerliteId: string | null = null;
  let mailerliteStatus: 'sent' | 'queued' = 'sent';
  try {
    const res = await client.subscribe(subscribeInput);
    mailerliteId = res.id;
  } catch (err) {
    if (err instanceof MailerLiteError && err.shouldRetry) {
      // Queue + keep going. D1 still gets the row so Friday cron has
      // the subscriber available the moment MailerLite recovers.
      const idempotencyKey = `subscribe:${body.email.toLowerCase()}`;
      await enqueue(rc.env.SMOKE_DB, {
        kind: 'subscribe',
        payload: subscribeInput,
        idempotencyKey,
        cause: err,
      });
      mailerliteStatus = 'queued';
    } else if (err instanceof MailerLiteError) {
      // Non-retryable (validation, revoked key) — surface to caller.
      return jsonError(
        err.status === 422 ? 422 : 400,
        'mailerlite_rejected',
        'MailerLite rejected the subscription request'
      );
    } else {
      throw err;
    }
  }

  const now = Date.now();
  await rc.env.SMOKE_DB.prepare(
    `INSERT INTO subscribers (email, zip, cut, cooker, timezone, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         zip = excluded.zip,
         cut = excluded.cut,
         cooker = excluded.cooker,
         timezone = excluded.timezone,
         unsubscribed_at = NULL`
  )
    .bind(
      body.email,
      body.zip,
      body.cut ?? null,
      body.cooker ?? null,
      resolvedTimezone,
      now
    )
    .run();

  // Issue an HMAC-signed token tied to this email. Returned in the
  // subscribe response and required by /api/unsubscribe and
  // /api/preferences so an attacker can't act on an email they
  // don't own. The token is stable across re-subscribes (it only
  // depends on email + secret), which matches the user's mental
  // model — re-subscribing doesn't invalidate the unsubscribe link.
  const token = await signToken(body.email, rc.env.SUBSCRIBER_TOKEN_SECRET);

  return json(202, {
    status: mailerliteStatus,
    email: body.email,
    metroSlug: resolvedMetroSlug,
    timezone: resolvedTimezone,
    mailerliteId,
    token,
  });
}
