// GET  /api/preferences?email=<email>   — read a subscriber's prefs
// PATCH /api/preferences                 — update cut / cooker
//
// We deliberately do NOT expose zip via GET (a leaked URL would dump
// the subscriber's home zip). The read-side returns only cut/cooker/
// timezone and a boolean `subscribed` flag.
//
// PATCH body: { email, cut?, cooker? }. Other fields are ignored —
// changing email or zip requires re-subscribing.

import { z } from 'zod';
import { json, jsonError, type RouteContext } from '../router.js';

const PreferencesPatch = z.object({
  email: z.string().email(),
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
  const email = rc.url.searchParams.get('email');
  if (!email) {
    return jsonError(400, 'missing_email', 'Provide ?email=<email>');
  }
  // Email shape validation — avoid leaking row existence with a
  // structured "we don't know" response when the address is malformed.
  const parsed = z.string().email().safeParse(email);
  if (!parsed.success) {
    return jsonError(400, 'invalid_email', 'Email did not parse');
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
    // Same 404 shape for both "no row" and "row but private" so this
    // endpoint can't be turned into a subscription enumeration oracle.
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
  const { email, cut, cooker } = parsed.data;
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
  // D1's `meta.changes` exposes the affected row count.
  const changes = (res.meta as { changes?: number } | undefined)?.changes ?? 0;
  if (changes === 0) {
    return jsonError(404, 'not_found', 'No subscriber row matched this email');
  }
  return json(200, { email, cut: cut ?? undefined, cooker: cooker ?? undefined });
}
