import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: '../wrangler.jsonc' },
      miniflare: {
        compatibilityDate: '2026-04-12',
        compatibilityFlags: ['nodejs_compat'],
      },
    }),
  ],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../packages/shared/src'),
    },
  },
});
