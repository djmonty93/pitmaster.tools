// Integration test for the dynamic "Save to Pinterest" image routes.
// Drives the worker via the vitest-pool-workers Miniflare adapter (which
// provides an in-memory R2 for PIN_BUCKET) so the round-trip
// POST /api/pin-image → GET /og/r/<hash>.png is exercised end-to-end.

import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// Use the apex host so the www→apex 301 in the worker's fetch() doesn't
// intercept the request.
const ORIGIN = 'https://pitmaster.tools';

// A minimal, valid 1×1 PNG. The handler only validates the 4-byte magic,
// but using real PNG bytes keeps the fixture honest.
const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

function uploadPng(body: BodyInit, contentType = 'image/png'): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/pin-image`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  });
}

describe('POST /api/pin-image + GET /og/r/:hash', () => {
  it('stores a PNG and serves it back at a content-addressed path', async () => {
    const post = await uploadPng(PNG_1x1);
    expect(post.status).toBe(200);
    const { path } = await post.json<{ path: string }>();
    expect(path).toMatch(/^\/og\/r\/[0-9a-f]{64}\.png$/);

    const get = await SELF.fetch(`${ORIGIN}${path}`);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('image/png');
    expect(get.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const bytes = new Uint8Array(await get.arrayBuffer());
    expect(bytes).toEqual(PNG_1x1);
  });

  it('is idempotent — the same bytes map to the same hash (dedupe)', async () => {
    const a = await uploadPng(PNG_1x1);
    const b = await uploadPng(PNG_1x1);
    const pa = (await a.json<{ path: string }>()).path;
    const pb = (await b.json<{ path: string }>()).path;
    expect(pa).toBe(pb);
  });

  it('rejects a non-PNG content-type with 415', async () => {
    const res = await uploadPng(PNG_1x1, 'application/octet-stream');
    expect(res.status).toBe(415);
  });

  it('rejects a body whose magic bytes are not PNG with 400', async () => {
    const notPng = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // "GIF89a"
    const res = await uploadPng(notPng);
    expect(res.status).toBe(400);
  });

  it('rejects an oversize body with 413', async () => {
    // 0x89 PNG magic prefix + filler so it passes the magic check but trips
    // the size cap (> 600 KB).
    const big = new Uint8Array(600 * 1024 + 1);
    big.set(PNG_1x1.subarray(0, 4), 0);
    const res = await uploadPng(big);
    expect(res.status).toBe(413);
  });

  it('404s a well-formed but unknown hash', async () => {
    const res = await SELF.fetch(`${ORIGIN}/og/r/${'a'.repeat(64)}.png`);
    expect(res.status).toBe(404);
  });

  it('404s a malformed hash without touching the bucket', async () => {
    const res = await SELF.fetch(`${ORIGIN}/og/r/not-a-hash.png`);
    expect(res.status).toBe(404);
  });
});
