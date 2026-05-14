// Minimal worker entry. Step 7 grows this into a real router with
// /api/forecast, /api/subscribe, etc. For now every request falls
// through to the static assets binding.

export interface Env {
  ASSETS: Fetcher;
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
