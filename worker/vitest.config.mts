import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Resolve @shared/* against packages/shared/src/ via a URL pointer rather
// than `node:path`, which lets the worker tsconfig drop the "node" types
// reference for src/ and tests/.
const sharedDir = new URL('../packages/shared/src/', import.meta.url).pathname;

export default defineConfig({
  plugins: [
    cloudflareTest({
      // compatibility_date and compatibility_flags are sourced from
      // wrangler.jsonc — one source of truth across `wrangler dev`,
      // `wrangler deploy`, and the Miniflare-backed test pool.
      wrangler: { configPath: '../wrangler.jsonc' },
    }),
  ],
  resolve: {
    alias: {
      '@shared': sharedDir,
    },
  },
});
