// GET   /api/preferences?email=<email>&token=<token>   — read a subscriber's prefs
// PATCH /api/preferences                                — update cut / cooker
//
// Both methods require an HMAC token issued by /api/subscribe (see
// lib/auth/token.ts) — without it any caller could enumerate
// subscriber preferences or vandalize them. GET takes the token in a
// query param; PATCH takes it in the JSON body.
//
// We deliberately do NOT expose zip via GET (a leaked URL would dump
// the subscriber's home zip). The read-side returns only cut/cooker/
// timezone and a boolean `subscribed` flag.
//
// PATCH body: { email, token, cut?, cooker? }. Other fields are
// ignored — changing email or zip requires re-subscribing.

import { z } from 'zod';
import { verifyToken } from '../lib/auth/token.js';
import { json, jsonError, type RouteContext } from '../router.js';

const PreferencesPatch = z.object({
  email: z.string().email(),
  token: z.string().regex(/^[0-9a-f]{64}$/i),
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
});

export async function handlePreferences(rc: RouteContext): Promise<Response> {
  if (rc.request.method === 'GET') return handleGet(rc);
  if (rc.request.method === 'PATCH') return handlePatch(rc);
  return jsonError(405, 'method_not_allowed', 'Method not allowed for /api/preferences');
}

async function handleGet(rc: RouteContext): Promise<Response> {
  const emailParam = rc.url.searchParams.get('email');
  const tokenParam = rc.url.searchParams.get('token');
  if (!emailParam || !tokenParam) {
    return jsonError(400, 'missing_credentials', 'Provide ?email=<email>&token=<token>');
  }
  const parsed = z
    .object({
      email: z.string().email(),
      token: z.string().regex(/^[0-9a-f]{64}$/i),
    })
    .safeParse({ email: emailParam, token: tokenParam });
  if (!parsed.success) {
    // Same 401 shape as a token mismatch so a malformed email isn't
    // a different signal from "valid email + wrong token." Otherwise
    // a caller could enumerate by sending fixed bad tokens and
    // distinguishing "I sent a syntactically valid email" (401) from
    // "I sent garbage" (400).
    return jsonError(401, 'invalid_credentials', 'Email or token did not validate');
  }
  const email = parsed.data.email.trim().toLowerCase();
  const ok = await verifyToken(email, parsed.data.token, rc.env.SUBSCRIBER_TOKEN_SECRET);
  if (!ok) {
    return jsonError(401, 'invalid_credentials', 'Email or token did not validate');
  }
  const row = await rc.env.SMOKE_DB.prepare(
    `SELECT cut, cooker, timezone, unsubscribed_at FROM subscribers WHERE email = ?`
  )
    .bind(email)
    .first<{
      cut: string | null;
      cooker: string | null;
      timezone: string;
      unsubscribed_at: number | null;
    }>();
  if (!row) {
    return jsonError(404, 'not_found', 'No preferences for this email');
  }
  return json(200, {
    email,
    cut: row.cut,
    cooker: row.cooker,
    timezone: row.timezone,
    subscribed: row.unsubscribed_at === null,
  });
}

async function handlePatch(rc: RouteContext): Promise<Response> {
  let raw: unknown;
  try {
    raw = await rc.request.json();
  } catch (_err) {
    return jsonError(400, 'invalid_json', 'Request body must be JSON');
  }
  const parsed = PreferencesPatch.safeParse(raw);
  if (!parsed.success) {
    return jsonError(400, 'invalid_body', 'Request body failed validation', parsed.error.issues);
  }
  const { cut, cooker } = parsed.data;
  const email = parsed.data.email.trim().toLowerCase();
  const ok = await verifyToken(email, parsed.data.token, rc.env.SUBSCRIBER_TOKEN_SECRET);
  if (!ok) {
    return jsonError(401, 'invalid_token', 'Token does not match this email');
  }
  // Build the SET clause dynamically so a PATCH that only includes
  // `cut` doesn't blow away `cooker` (and vice-versa).
  const sets: string[] = [];
  const args: Array<string | null> = [];
  if (cut !== undefined) {
    sets.push('cut = ?');
    args.push(cut);
  }
  if (cooker !== undefined) {
    sets.push('cooker = ?');
    args.push(cooker);
  }
  if (sets.length === 0) {
    return jsonError(400, 'no_changes', 'PATCH must include at least one of: cut, cooker');
  }
  const sql = `UPDATE subscribers SET ${sets.join(', ')} WHERE email = ?`;
  args.push(email);
  const res = await rc.env.SMOKE_DB.prepare(sql).bind(...args).run();
  const changes = (res.meta as { changes?: number } | undefined)?.changes ?? 0;
  if (changes === 0) {
    return jsonError(404, 'not_found', 'No subscriber row matched this email');
  }
  return json(200, { email, cut: cut ?? undefined, cooker: cooker ?? undefined });
}
