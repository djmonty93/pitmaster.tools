// Sentry options factory for the worker's withSentry() wrap.
//
// Step 17 (F21). Pulled into its own module so the policy is unit-
// testable without spinning the full Sentry pipeline — withSentry()
// itself is a runtime instrumentation pass that's hard to assert on
// in a vitest pool, but the options shape is pure and the right
// place to pin the policy.
//
// Policy:
//   - DSN comes from env.SENTRY_DSN (Cloudflare secret). Missing DSN
//     yields enabled=false so dev / test / CI never accidentally ships
//     events to a production project.
//   - environment defaults to "production"; an operator can override
//     via env.SENTRY_ENVIRONMENT (e.g. "staging", "preview").
//   - tracesSampleRate at 0.1 is the standard hobby-tier compromise —
//     enough volume to see latency outliers, low enough to stay
//     comfortably inside the free quota. Cron handlers, where slow
//     ticks matter more, will surface in their own scheduled spans.

import type { Env } from '../../index.js';

export interface SentryOptions {
  dsn: string;
  enabled: boolean;
  environment: string;
  tracesSampleRate: number;
}

export function buildSentryOptions(env: Pick<Env, 'SENTRY_DSN' | 'SENTRY_ENVIRONMENT'>): SentryOptions {
  const dsn = env.SENTRY_DSN ?? '';
  return {
    dsn,
    enabled: dsn.length > 0,
    environment: env.SENTRY_ENVIRONMENT ?? 'production',
    tracesSampleRate: 0.1,
  };
}
