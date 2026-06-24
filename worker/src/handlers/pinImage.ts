// Dynamic "Save to Pinterest" result image storage.
//
// The cook-time math is browser-only, so the CLIENT already holds the
// computed result. On Save-after-calculate the browser renders the live
// result to a 1000×1500 PNG and POSTs the bytes here; this handler only
// stores and streams them — no server-side rendering, trivial CPU, so it
// stays comfortably inside the Workers Free plan.
//
//   POST /api/pin-image   — store an uploaded PNG, content-addressed by
//                           SHA-256, return { path: "/og/r/<hash>.png" }.
//   GET  /og/r/:hash      — stream the stored PNG (immutable, long-cache).
//
// Content-addressing makes the upload idempotent (re-posting the same
// result hits the same key — natural dedupe) and makes the GET safe to
// cache forever: a given hash always maps to the same bytes. An R2
// lifecycle rule (see wrangler.jsonc) expires objects after ~30 days,
// which is plenty — Pinterest copies the image into its own CDN at pin
// time, so our object only needs to outlive that single fetch.
//
// Abuse posture: this is a same-site-only endpoint. We reject any request
// whose Origin isn't the apex/www host (a real browser POST always carries
// Origin), exact-match the content-type, validate the PNG signature, and
// stream the body with a hard size cap so a lying/absent Content-Length
// can't force us to buffer past the limit. A Cloudflare rate-limit/WAF rule
// on POST /api/pin-image is the recommended operator-side backstop (see
// wrangler.jsonc). The client falls back to the page's static og:image
// whenever this 4xxs, so Save still works.

import { json, jsonError, type RouteContext } from '../router.js';

// Cap upload size. A 1000×1500 PNG of flat result art is well under this;
// the limit is an abuse guard, not a quality knob.
const MAX_PIN_BYTES = 600 * 1024;

// Full 8-byte PNG signature: \x89 P N G \r \n \x1a \n.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// IHDR is always the first chunk: its length field (bytes 8–11) is the
// fixed value 13, followed by the type 'IHDR' (bytes 12–15).
const IHDR_LENGTH = [0x00, 0x00, 0x00, 0x0d];
const IHDR_TYPE = [0x49, 0x48, 0x44, 0x52];

const ALLOWED_ORIGINS = new Set([
  'https://pitmaster.tools',
  'https://www.pitmaster.tools',
]);

// Per-IP upload rate limit — a BEST-EFFORT soft backstop, not a hard quota.
// The Origin allowlist only stops browsers (a scripted client can spoof
// Origin), so this WEATHER_KV counter adds real friction against sequential
// scripted abuse. It is deliberately approximate: KV is eventually consistent
// and the get→put is not atomic, so a highly-concurrent burst from one IP can
// undercount. The AUTHORITATIVE per-IP control is the Cloudflare
// rate-limit/WAF rule on POST /api/pin-image (see wrangler.jsonc), which also
// covers the distributed-IP case this counter can't. Keep this as defense in
// depth, not the sole guarantee.
const RATE_LIMIT = 60; // uploads per IP per window
const RATE_WINDOW_S = 3600; // 1 hour

const HASH_RE = /^[0-9a-f]{64}$/;

function toHex(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i]!.toString(16).padStart(2, '0');
  return out;
}

function looksLikePng(bytes: Uint8Array): boolean {
  // Need the 8-byte signature, the IHDR length field (= 13), and the IHDR
  // chunk type.
  if (bytes.length < 16) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  for (let i = 0; i < IHDR_LENGTH.length; i++) {
    if (bytes[8 + i] !== IHDR_LENGTH[i]) return false;
  }
  for (let i = 0; i < IHDR_TYPE.length; i++) {
    if (bytes[12 + i] !== IHDR_TYPE[i]) return false;
  }
  return true;
}

/**
 * Per-IP fixed-window rate limit backed by WEATHER_KV — best-effort only (see
 * the RATE_LIMIT note: KV's non-atomic get→put means concurrent bursts can
 * undercount; the CF WAF rule is the authoritative control). Returns true when
 * the caller is over the limit (→ 429). Keyed on CF-Connecting-IP; requests
 * with no client IP share a single 'unknown' bucket.
 */
async function isRateLimited(rc: RouteContext): Promise<boolean> {
  const ip = rc.request.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = Math.floor(Date.now() / 1000 / RATE_WINDOW_S);
  const key = `pinrl:${ip}:${bucket}`;
  const current = Number((await rc.env.WEATHER_KV.get(key)) || '0');
  if (current >= RATE_LIMIT) return true;
  await rc.env.WEATHER_KV.put(key, String(current + 1), { expirationTtl: RATE_WINDOW_S });
  return false;
}

/**
 * Read the request body with a hard byte cap, aborting as soon as the
 * accumulated size exceeds `max`. Returns the bytes, or null if the cap
 * was exceeded. Streaming (rather than arrayBuffer()) means an absent or
 * dishonest Content-Length can't make us buffer past the limit.
 */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  const body = request.body;
  if (!body) {
    // No readable stream (some runtimes) — fall back to a buffered read with
    // a post-read size check.
    const ab = await request.arrayBuffer();
    return ab.byteLength > max ? null : new Uint8Array(ab);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      try { await reader.cancel(); } catch (_err) { /* already closed */ }
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function handlePinImageUpload(rc: RouteContext): Promise<Response> {
  // Same-site only. A real browser POST always carries Origin; reject
  // anything else so this public route can't be driven as a general R2
  // uploader.
  const origin = rc.request.headers.get('origin');
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return jsonError(403, 'forbidden', 'Cross-site uploads are not allowed');
  }

  // Best-effort per-IP soft backstop behind the spoofable Origin check;
  // authoritative enforcement is the Cloudflare rate-limit/WAF rule. Rejected
  // before reading the body.
  if (await isRateLimited(rc)) {
    return jsonError(429, 'rate_limited', 'Too many uploads — try again later');
  }

  // Exact content-type match, ignoring any parameters (e.g. "; charset=…").
  const contentType = (rc.request.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase();
  if (contentType !== 'image/png') {
    return jsonError(415, 'unsupported_media_type', 'Body must be image/png');
  }

  // Early reject on the declared size before reading anything.
  const declaredLength = Number(rc.request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PIN_BYTES) {
    return jsonError(413, 'payload_too_large', 'Image exceeds the size limit');
  }

  const bytes = await readCapped(rc.request, MAX_PIN_BYTES);
  if (bytes === null) {
    return jsonError(413, 'payload_too_large', 'Image exceeds the size limit');
  }
  if (bytes.byteLength === 0) {
    return jsonError(400, 'empty_body', 'Request body is empty');
  }

  if (!looksLikePng(bytes)) {
    return jsonError(400, 'invalid_png', 'Body is not a PNG image');
  }

  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = toHex(digest);
  const key = `r/${hash}.png`;

  // Idempotent by construction: same bytes → same key. A repeat upload
  // just overwrites identical content, so there's no read-before-write.
  await rc.env.PIN_BUCKET.put(key, bytes, {
    httpMetadata: { contentType: 'image/png' },
  });

  return json(200, { path: `/og/${key}` });
}

export async function handlePinImageGet(rc: RouteContext): Promise<Response> {
  // The route captures `:hash` as the final path segment, which still
  // carries the `.png` suffix the client requests — strip it, then
  // require a clean 64-char hex digest before touching R2 so malformed
  // keys 404 fast instead of becoming bucket lookups.
  const raw = rc.params.hash || '';
  const hash = raw.replace(/\.png$/i, '');
  if (!HASH_RE.test(hash)) {
    return jsonError(404, 'not_found', 'Image not found');
  }

  const obj = await rc.env.PIN_BUCKET.get(`r/${hash}.png`);
  if (!obj) {
    return jsonError(404, 'not_found', 'Image not found');
  }

  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      // Content-addressed → the bytes for a given hash never change, so
      // it's safe to cache forever at the edge and in the browser.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
