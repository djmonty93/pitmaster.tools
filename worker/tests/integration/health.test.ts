// Integration test: spin up the worker via the vitest-pool-workers
// Miniflare adapter and confirm /api/health responds and that a
// non-matched path is *not* served by the /api/health handler.

import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('worker entrypoint', () => {
  it('GET /api/health returns 200 with status payload', async () => {
    const res = await SELF.fetch('https://example.com/api/health');
    expect(res.status).toBe(200);
    const body = await res.json<{ status: string; version: string }>();
    expect(body.status).toBe('ok');
    expect(body.version).toBe('setup');
  });

  it('non-API path is not served by the /api/health handler', async () => {
    // Whatever ASSETS returns (200 with a 404 page, 404 with empty body, or
    // 404 with a 404 page depending on whether dist/404.html exists when the
    // test runs) is fine — we only care that we did not accidentally route
    // a generic path to the /api/health response.
    const res = await SELF.fetch('https://example.com/nope.html');
    const body = await res.text();
    expect(body).not.toContain('"status":"ok"');
  });
});
