/// <reference types="node" />
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Node `path` + `fileURLToPath` produce a true Windows absolute path
// (H:\Code\…) rather than the `/H:/Code/…` that `new URL().pathname`
// returns. Vite's alias resolver needs the former on Windows.
//
// The node types are pulled in by the triple-slash reference at the top
// of this file so worker/tsconfig.json can leave node out of its `types`
// list — src/ and tests/ still compile against workerd globals only.
const sharedDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../packages/shared/src'
);

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
