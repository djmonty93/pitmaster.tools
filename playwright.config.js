const { defineConfig } = require('@playwright/test');

// Best Smoke Days needs e2e specs to exercise Worker-backed /api/* routes,
// not just static assets, so the test web server is `wrangler dev` from
// Step 1 onward. Wrangler dev fully supersedes the previous static-server
// (it serves dist/ via the ASSETS binding) so the existing browser-smoke
// suite keeps passing — it just gets a slower cold boot.

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  reporter: 'list',
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
  },
  webServer: {
    command: 'npm run build && npx wrangler dev --port 4173 --ip 127.0.0.1 --log-level error',
    port: 4173,
    // On CI, never reuse an existing process — a leaked server from a prior
    // failed job would skip the build step and mask stale-asset regressions.
    // Locally, reusing keeps the dev loop fast.
    reuseExistingServer: !process.env.CI,
    timeout: 90000,
  },
});
