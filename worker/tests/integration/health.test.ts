// Integration test: spin up the worker via the vitest-pool-workers
// Miniflare adapter and confirm /api/health responds and that a
// non-matched path falls through to the static assets binding (404
// in Step 1, because ASSETS has no dist build during tests).

import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('worker entrypoint', () => {
  it('GET /api/health returns 200 with status payload', async () => {
    const res = await SELF.fetch('https://example.com/api/health');
    expect(res.status).toBe(200);
    const body = await res.json<{ status: string }>();
    expect(body.status).toBe('ok');
  });

  it('unknown path falls through to ASSETS', async () => {
    const res = await SELF.fetch('https://example.com/nope.html');
    // ASSETS has no dist build during unit tests, so a non-2xx is expected;
    // the contract is "we did not throw and did not return our /api/health body".
    expect(res.status).not.toBe(200);
  });
});
