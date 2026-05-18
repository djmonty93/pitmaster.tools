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
  SENDER_API_TOKEN?: string;
  SUBSCRIBER_TOKEN_SECRET?: string;
  /**
   * Stub for env.ASSETS.fetch — used by the SSR handler tests so they
   * can drive a known template HTML through HTMLRewriter without
   * requiring the dist/ output to exist on disk inside Miniflare.
   */
  ASSETS?: Fetcher;
}

/** Default value used across handler tests when no override is provided. */
export const TEST_SUBSCRIBER_TOKEN_SECRET = 'test-token-secret-32-bytes-long-aaaa';

export function buildContext(
  request: Request,
  params: Record<string, string> = {},
  overrides: TestEnvOverrides = {}
): RouteContext {
  // cloudflare:test populates env with declared bindings (KV, D1,
  // ASSETS). Test secrets aren't declared in wrangler.jsonc, so we
  // synthesize them here.
  const e = env as unknown as Partial<Env>;
  const composedEnv: Env = {
    ASSETS: overrides.ASSETS ?? (e.ASSETS as Fetcher),
    WEATHER_KV: e.WEATHER_KV as KVNamespace,
    SMOKE_DB: e.SMOKE_DB as D1Database,
    SENDER_API_TOKEN: overrides.SENDER_API_TOKEN ?? 'sender_test_token',
    SUBSCRIBER_TOKEN_SECRET:
      overrides.SUBSCRIBER_TOKEN_SECRET ?? TEST_SUBSCRIBER_TOKEN_SECRET,
  };
  return {
    request,
    env: composedEnv,
    ctx: fakeCtx,
    url: new URL(request.url),
    params,
  };
}
