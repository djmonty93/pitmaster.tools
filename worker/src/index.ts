// Worker entry. Step 7 wires the router with /api/* + /articles/:slug
// handlers. Anything that doesn't match a route (including HTML pages
// served from dist/) falls through to env.ASSETS.fetch.

import { handleArticles } from './handlers/articles.js';
import { handleForecast } from './handlers/forecast.js';
import { handlePreferences } from './handlers/preferences.js';
import { handleStatus } from './handlers/status.js';
import { handleSubscribe } from './handlers/subscribe.js';
import { handleUnsubscribe } from './handlers/unsubscribe.js';
import { compileRoutes, dispatch, jsonError } from './router.js';

export interface Env {
  ASSETS: Fetcher;
  WEATHER_KV: KVNamespace;
  SMOKE_DB: D1Database;
  /**
   * MailerLite Connect API token. Sourced from a Wrangler secret
   * (`wrangler secret put MAILERLITE_API_KEY`) in production. Local
   * development reads it from .dev.vars. Step 6's client constructor
   * fails fast if this is missing, so the absence shows up at the
   * worker boot, not on the first user subscribe.
   */
  MAILERLITE_API_KEY: string;
  /**
   * HMAC-SHA256 secret used to sign subscriber-scoped auth tokens
   * (see worker/src/lib/auth/token.ts). Returned by /api/subscribe
   * and required by /api/unsubscribe and /api/preferences. Rotate
   * via `wrangler secret put SUBSCRIBER_TOKEN_SECRET` to invalidate
   * all existing tokens.
   */
  SUBSCRIBER_TOKEN_SECRET: string;
}

const routes = compileRoutes([
  { method: 'GET', pattern: '/api/health', handler: handleHealth },
  { method: 'GET', pattern: '/api/forecast', handler: handleForecast },
  { method: 'POST', pattern: '/api/subscribe', handler: handleSubscribe },
  { method: 'POST', pattern: '/api/unsubscribe', handler: handleUnsubscribe },
  { method: 'GET', pattern: '/api/preferences', handler: handlePreferences },
  { method: 'PATCH', pattern: '/api/preferences', handler: handlePreferences },
  { method: 'GET', pattern: '/api/status', handler: handleStatus },
  { method: 'GET', pattern: '/articles/:slug', handler: handleArticles },
]);

function handleHealth(): Response {
  return Response.json({
    status: 'ok',
    version: 'step-7',
    time: new Date().toISOString(),
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const matched = await dispatch(routes, request, env, ctx);
      if (matched) return matched;
      return env.ASSETS.fetch(request);
    } catch (err) {
      // Last-line-of-defense 500. Sentry (Step 17) will hook this and
      // capture properly; for now log + return a JSON envelope so the
      // client doesn't get an opaque workerd error page.
      console.error('worker unhandled error', err);
      return jsonError(500, 'internal_error', 'An unexpected error occurred');
    }
  },
} satisfies ExportedHandler<Env>;
