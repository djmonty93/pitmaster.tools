// GET /api/metros
//
// Returns the pre-computed metros summary (one tile entry per of the 50
// seeded metros) used by the /smoke-weather/metros chooser page. The
// aggregate is written nightly by the metrosPrewarm cron at midnight
// ET; this handler is a read-only KV lookup so the page is cheap to
// serve and CDN-cacheable.
//
// Cold-start behavior: if the aggregate is missing (first deploy, or a
// missed cron), return a 200 with `metros: []` and a null generatedAt.
// The chooser-page client renders skeleton tiles in that state — the
// navigation links to per-metro pages still work, which is the
// minimum-viable degraded mode. We don't synchronously trigger the
// cron from here: a cron run touches 50 upstream APIs and would blow
// the per-request CPU budget for every cold-cache visitor.

import { aggregateKey, type MetrosSummary } from '../crons/metrosPrewarm.js';
import { etDayBucket } from '../lib/cache/weather.js';
import { json, type RouteContext } from '../router.js';

export async function handleMetros(rc: RouteContext): Promise<Response> {
  const etDate = etDayBucket();
  let summary = await rc.env.WEATHER_KV.get<MetrosSummary>(aggregateKey(etDate), 'json');
  // Yesterday-fallback: if today's aggregate hasn't been written yet
  // (e.g. the 04:00 UTC tick hasn't fired during EST months when
  // midnight ET = 05:00 UTC), serve yesterday's data so the chooser
  // shows real tiles instead of an empty skeleton.
  if (!summary) {
    const yesterday = etDayBucket(Date.now() - 24 * 60 * 60 * 1000);
    summary = await rc.env.WEATHER_KV.get<MetrosSummary>(aggregateKey(yesterday), 'json');
  }

  if (!summary) {
    return json(200, { generatedAt: null, etDate, metros: [] }, {
      'Cache-Control': 'public, max-age=60',
    });
  }
  // Aggregate is global (no per-visitor personalization) and rolls over
  // once a day — 5 minute CDN window is the right trade between
  // freshness and edge-cache hit rate. The browser also revalidates
  // on chooser-page open via the standard cache-revalidation chain.
  return json(200, summary, { 'Cache-Control': 'public, max-age=300' });
}
