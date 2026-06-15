// Worker entry. Step 7 wires the router with /api/* + /articles/:slug
// handlers. Anything that doesn't match a route (including HTML pages
// served from dist/) falls through to env.ASSETS.fetch.
//
// Step 17 (F21) wraps the export with @sentry/cloudflare's withSentry()
// so unhandled fetch + scheduled errors are captured. Options are built
// by lib/observability/sentryOptions.ts; missing SENTRY_DSN keeps the
// SDK disabled so dev / test environments never ship events.

import { withSentry } from '@sentry/cloudflare';
import { runFridayCron } from './crons/fridayEmail.js';
import { runMetrosPrewarm } from './crons/metrosPrewarm.js';
import { runWeeklyArticleCron } from './crons/weeklyArticle.js';
import { handleArticles } from './handlers/articles.js';
import { handleForecast } from './handlers/forecast.js';
import { handleMetros } from './handlers/metros.js';
import { handleMetroPage } from './handlers/metroPage.js';
import { handleMetrosChooser } from './handlers/metrosChooser.js';
import { handlePreferences } from './handlers/preferences.js';
import { handleStatus } from './handlers/status.js';
import { handleSubscribe } from './handlers/subscribe.js';
import { handleUnsubscribe } from './handlers/unsubscribe.js';
import { createSenderClient } from './lib/sender/client.js';
import { drain } from './lib/sender/retry.js';
import { buildSentryOptions } from './lib/observability/sentryOptions.js';
import { compileRoutes, dispatch, json, jsonError } from './router.js';

export interface Env {
  ASSETS: Fetcher;
  WEATHER_KV: KVNamespace;
  SMOKE_DB: D1Database;
  SENDER_API_TOKEN: string;
  SUBSCRIBER_TOKEN_SECRET: string;
  /**
   * From-address / from-name / reply-to configured on the Sender.net
   * sending domain. See docs/sender-setup.md §5 for the DKIM/SPF/DMARC
   * records the operator must add. The Friday digest cron uses these on
   * createCampaign; an unset SENDER_FROM_EMAIL dark-disables the digest
   * (the global "not configured yet" / kill-switch state). Surfaced into
   * Env so a per-environment override (staging vs prod) is a wrangler-vars
   * change rather than a code change.
   */
  SENDER_FROM_EMAIL?: string;
  SENDER_FROM_NAME?: string;
  SENDER_REPLY_TO?: string;
  /**
   * Sentry DSN (https://o<…>.ingest.sentry.io/<…>). Provisioned with
   * `wrangler secret put SENTRY_DSN`. Empty / unset → SDK runs in
   * disabled mode so dev and test environments never ship events.
   */
  SENTRY_DSN?: string;
  /**
   * Override for Sentry's environment tag. Defaults to "production"
   * when unset; operators can flip a preview/staging deployment to a
   * separate environment without code changes.
   */
  SENTRY_ENVIRONMENT?: string;
}

const routes = compileRoutes([
  { method: 'GET', pattern: '/api/health', handler: handleHealth },
  { method: 'GET', pattern: '/api/forecast', handler: handleForecast },
  { method: 'GET', pattern: '/api/metros', handler: handleMetros },
  { method: 'POST', pattern: '/api/subscribe', handler: handleSubscribe },
  { method: 'POST', pattern: '/api/unsubscribe', handler: handleUnsubscribe },
  { method: 'GET', pattern: '/api/preferences', handler: handlePreferences },
  { method: 'PATCH', pattern: '/api/preferences', handler: handlePreferences },
  { method: 'GET', pattern: '/api/status', handler: handleStatus },
  { method: 'GET', pattern: '/articles/:slug', handler: handleArticles },
  // SSR routes: per-metro forecast page + 50-metros chooser. The
  // /metros/ route is the chooser; everything else under
  // /smoke-weather/<slug> hits handleMetroPage, which either renders
  // the metro's pre-warmed forecast or falls through to ASSETS for
  // hand-authored pages (methodology, faq, disclosures, status) and
  // unknown slugs.
  { method: 'GET', pattern: '/smoke-weather/metros/', handler: handleMetrosChooser },
  { method: 'GET', pattern: '/smoke-weather/:slug', handler: handleMetroPage },
]);

function handleHealth(): Response {
  // Use json() so SECURITY_HEADERS (no-store, no-referrer, nosniff) land
  // on /api/health like every other API response. Bare Response.json
  // bypasses that helper.
  return json(200, {
    status: 'ok',
    version: 'step-7',
    time: new Date().toISOString(),
  });
}

const handler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      // www → apex canonicalization. With both pitmaster.tools and
      // www.pitmaster.tools bound to this Worker (wrangler.jsonc routes),
      // a 301 keeps a single canonical host and prevents duplicate-content
      // SEO splits. Method and full path/query are preserved.
      const url = new URL(request.url);
      if (url.hostname === 'www.pitmaster.tools') {
        url.hostname = 'pitmaster.tools';
        // Force https on the Location so a plain-HTTP request to
        // www.pitmaster.tools (rare past Cloudflare's automatic HTTPS
        // upgrade + HSTS, but possible from a misconfigured client)
        // doesn't 301 to http://pitmaster.tools.
        url.protocol = 'https:';
        return new Response(null, {
          status: 301,
          headers: {
            Location: url.toString(),
            'Cache-Control': 'public, max-age=86400',
          },
        });
      }
      const matched = await dispatch(routes, request, env, ctx);
      if (matched) return matched;
      return env.ASSETS.fetch(request);
    } catch (err) {
      // Last-line-of-defense 500. withSentry() captures the throw via
      // instrumented fetch — we still emit a JSON envelope so the
      // client doesn't see an opaque workerd error page.
      console.error('worker unhandled error', err);
      return jsonError(500, 'internal_error', 'An unexpected error occurred');
    }
  },
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Two cron triggers feed into this handler (see wrangler.jsonc):
    //
    //   `0 10-14 * * 5` — Friday digest. Awaited so a retryable
    //   failure throw propagates to Cloudflare's scheduled-handler
    //   contract and triggers auto-retry. Without the await,
    //   Cloudflare sees the handler resolve normally and never
    //   re-attempts the only matching 6am-local tick for a failed
    //   region.
    //
    //   `*/5 * * * *` — sender_retry drain. Without this nothing
    //   ever calls drain() in production, so subscribe/unsubscribe/
    //   preferences/group-assign retryable failures would queue
    //   forever. The 5-minute cadence aligns with the retry queue's
    //   1-minute initial backoff.
    //
    //   `0 12 * * 1` — F17 weekly article cron. Mondays at 12:00 UTC
    //   writes the week's `weekly-summary` row to D1; /articles/:slug
    //   renders it. Idempotent — re-runs in the same ISO week UPDATE.
    if (controller.cron === '0 10-14 * * 5') {
      await runFridayCron(env, new Date(controller.scheduledTime));
      return;
    }
    if (controller.cron === '*/5 * * * *') {
      const client = createSenderClient({ apiToken: env.SENDER_API_TOKEN });
      await drain(env.SMOKE_DB, client, env.WEATHER_KV);
      return;
    }
    if (controller.cron === '0 12 * * 1') {
      await runWeeklyArticleCron(env, new Date(controller.scheduledTime));
      return;
    }
    //   `0 4,5 * * *` — nightly metros pre-warm. Two ticks at 04:00 UTC
    //   (= midnight EDT) and 05:00 UTC (= midnight EST) blanket
    //   "midnight ET" year-round on UTC-only Workers cron. The second
    //   tick is a no-op when the first already wrote today's aggregate
    //   — both crons are idempotent (KV put + per-metro fetchCached
    //   that returns the fresh entry on the same ET day).
    if (controller.cron === '0 4,5 * * *') {
      await runMetrosPrewarm(env, new Date(controller.scheduledTime));
      return;
    }
    console.warn('scheduled: unrecognized cron expression', { cron: controller.cron });
  },
} satisfies ExportedHandler<Env>;

export default withSentry((env: Env) => buildSentryOptions(env), handler);
