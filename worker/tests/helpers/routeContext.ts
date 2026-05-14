// Test helper to build a RouteContext for direct handler invocation.
// Avoids round-tripping through the router so each test stays scoped
// to one handler. The router itself is unit-tested separately.

import { env } from 'cloudflare:test';
import type { RouteContext } from '../../src/router';
import type { Env } from '../../src/index';

const fakeCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  // workerd's typed ExecutionContext now carries a `props` field
  // (for the Worker-to-Worker RPC context); tests don't use it but
  // need to satisfy the type.
  props: {},
} as unknown as ExecutionContext;

export interface TestEnvOverrides {
  MAILERLITE_API_KEY?: string;
}

export function buildContext(
  request: Request,
  params: Record<string, string> = {},
  overrides: TestEnvOverrides = {}
): RouteContext {
  // cloudflare:test populates env with declared bindings (KV, D1,
  // ASSETS). Test secrets aren't declared in wrangler.jsonc, so we
  // synthesize MAILERLITE_API_KEY here.
  const e = env as unknown as Partial<Env>;
  const composedEnv: Env = {
    ASSETS: e.ASSETS as Fetcher,
    WEATHER_KV: e.WEATHER_KV as KVNamespace,
    SMOKE_DB: e.SMOKE_DB as D1Database,
    MAILERLITE_API_KEY: overrides.MAILERLITE_API_KEY ?? 'ml_test_secret_key',
  };
  return {
    request,
    env: composedEnv,
    ctx: fakeCtx,
    url: new URL(request.url),
    params,
  };
}
