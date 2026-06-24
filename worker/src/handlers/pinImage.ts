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

import { json, jsonError, type RouteContext } from '../router.js';

// Cap upload size. A 1000×1500 PNG of flat result art is well under this;
// the limit is an abuse guard, not a quality knob.
const MAX_PIN_BYTES = 600 * 1024;

// PNG signature: \x89 P N G \r \n \x1a \n. We check the first four bytes
// (the part that can't collide with other common image types) before
// trusting the declared content-type.
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

const HASH_RE = /^[0-9a-f]{64}$/;

function toHex(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i]!.toString(16).padStart(2, '0');
  return out;
}

export async function handlePinImageUpload(rc: RouteContext): Promise<Response> {
  const contentType = rc.request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('image/png')) {
    return jsonError(415, 'unsupported_media_type', 'Body must be image/png');
  }

  const buf = await rc.request.arrayBuffer();
  if (buf.byteLength === 0) {
    return jsonError(400, 'empty_body', 'Request body is empty');
  }
  if (buf.byteLength > MAX_PIN_BYTES) {
    return jsonError(413, 'payload_too_large', 'Image exceeds the size limit');
  }

  const bytes = new Uint8Array(buf);
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) {
      return jsonError(400, 'invalid_png', 'Body is not a PNG image');
    }
  }

  const digest = await crypto.subtle.digest('SHA-256', buf);
  const hash = toHex(digest);
  const key = `r/${hash}.png`;

  // Idempotent by construction: same bytes → same key. A repeat upload
  // just overwrites identical content, so there's no need to read-before-
  // write to dedupe.
  await rc.env.PIN_BUCKET.put(key, buf, {
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
