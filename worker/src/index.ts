// Minimal worker entry. Step 7 grows this into a real router with
// /api/forecast, /api/subscribe, etc. For now every request falls
// through to the static assets binding.

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
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return Response.json({
        status: 'ok',
        version: 'setup',
        time: new Date().toISOString(),
      });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
