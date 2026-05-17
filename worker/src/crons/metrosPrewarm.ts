// Nightly metros pre-warm + aggregate writer.
//
// Schedule: `0 4,5 * * *` — two UTC ticks per day (04:00 + 05:00).
// Cloudflare cron is UTC-only and DST shifts which UTC moment is
// "midnight in America/New_York" by an hour. The ticks cover both
// possibilities:
//   • EDT (mid-Mar–early-Nov): 04:00 UTC = 00:00 EDT (today rolls in
//     here). 05:00 UTC = 01:00 EDT (no-op — same ET day, cache fresh).
//   • EST (early-Nov–mid-Mar): 04:00 UTC = 23:00 EST on the prior ET
//     day. etDayBucket still resolves to the prior date here, so the
//     cron's per-metro fetchForecastCached calls all return cached
//     hits (this morning's warm is still fresh inside the 24h window)
//     and the aggregate is REWRITTEN from cached data — no upstream
//     calls — under the prior day's KV key. 05:00 UTC = 00:00 EST
//     (today rolls in here; warms the new bucket with upstream calls).
// Net effect across the year: exactly one tick per day actually
// fetches upstream and writes the new ET-day bucket. The other tick
// is cheap — either a same-day cache hit (EDT 05:00) or a same-day
// cache hit on yesterday's bucket (EST 04:00). Visitor traffic that
// arrives in the last hour of the EST day still sees the latest
// aggregate because the 04:00 UTC tick rewrites it from the same
// data the morning warm populated.
//
// What it does:
//   1. Read every row from the D1 `metros` table.
//   2. For each metro, call resolveZip + fetchForecastCached with the
//      default cut/cooker (brisket-packer / offset). This populates
//      the per-metro `weather:v2:<zip>:<et-date>` KV entry so the first
//      after-midnight visitor on a metro page gets an instant cached
//      response instead of paying the upstream-fetch latency.
//   3. Score the per-metro 7-day forecast at the defaults and aggregate
//      a compact summary (today's score + best day this week) into
//      one `metros:v1:<et-date>` KV blob. The /api/metros handler
//      reads this single blob to populate the chooser-page tiles.
//
// Partial-failure handling: a single metro's geocoder or upstream
// failure is logged and the metro is OMITTED from the aggregate;
// the cron does not abort. The chooser page's client-side fallback
// keeps the missing tile in a skeleton state.

import { scoreDay } from '@shared/scoring';
import type { Cooker, Cut, ScoreResult } from '@shared/types';
import type { Env } from '../index.js';
import { fetchForecastCached, etDayBucket } from '../lib/cache/weather.js';
import { GeocoderError, resolveZip } from '../lib/geo/zipGeocoder.js';
import { WeatherError } from '../lib/weather/errors.js';

// Default cut + cooker the cron scores tiles against. These match the
// handlers/forecast.ts request defaults so the tile preview matches the
// landing state of the per-metro page when a visitor arrives.
const DEFAULT_CUT: Cut = 'brisket-packer';
const DEFAULT_COOKER: Cooker = 'offset';
const DEFAULT_DAYS = 7;
const AGGREGATE_KEY_PREFIX = 'metros:v1';

export interface MetroTileSummary {
  slug: string;
  name: string;
  state: string;
  zip: string;
  todayScore: number;
  todayBand: ScoreResult['band'];
  bestDay: {
    date: string;
    score: number;
    band: ScoreResult['band'];
  };
}

export interface MetrosSummary {
  generatedAt: string;
  etDate: string;
  defaultCut: Cut;
  defaultCooker: Cooker;
  metros: MetroTileSummary[];
}

interface MetroRow {
  slug: string;
  name: string;
  state: string;
  zip: string;
}

/**
 * Build the aggregate KV key for a given ET calendar day. Exported so
 * the GET /api/metros handler can read the same key the cron writes.
 */
export function aggregateKey(etDate: string): string {
  return `${AGGREGATE_KEY_PREFIX}:${etDate}`;
}

export async function runMetrosPrewarm(env: Env, now: Date): Promise<MetrosSummary> {
  const nowMs = now.getTime();
  const etDate = etDayBucket(nowMs);

  // Pull canonical metro list from D1 so the cron + the static
  // generator stay in lockstep without duplicating the array.
  const rows = await env.SMOKE_DB.prepare(
    `SELECT slug, name, state, zip, latitude, longitude
       FROM metros
       ORDER BY slug`
  ).all<MetroRow & { latitude: number; longitude: number }>();

  const tiles: MetroTileSummary[] = [];
  for (const row of rows.results ?? []) {
    try {
      const location = await resolveZip(env.WEATHER_KV, env.SMOKE_DB, row.zip);
      const forecast = await fetchForecastCached(
        env.WEATHER_KV,
        row.zip,
        location.latitude,
        location.longitude,
        DEFAULT_DAYS,
        { now: () => nowMs }
      );
      if (forecast.days.length === 0) {
        console.warn('metrosPrewarm: empty forecast', { slug: row.slug });
        continue;
      }
      const scored = forecast.days.map((day) => ({
        date: day.date,
        score: scoreDay({ cut: DEFAULT_CUT, cooker: DEFAULT_COOKER, day }),
      }));
      // First day = today (forecast adapter orders ascending). Best day
      // is the highest score over the 7-day window with earliest-day
      // tiebreaker (matches the client's pickBestDay tie rule).
      const today = scored[0]!;
      const best = scored.reduce((acc, d) => (d.score.score > acc.score.score ? d : acc), scored[0]!);
      tiles.push({
        slug: row.slug,
        name: row.name,
        state: row.state,
        zip: row.zip,
        todayScore: today.score.score,
        todayBand: today.score.band,
        bestDay: {
          date: best.date,
          score: best.score.score,
          band: best.score.band,
        },
      });
    } catch (err) {
      // Log + skip — never let one metro's upstream failure block the
      // other 49. The chooser's client fallback masks the missing tile.
      if (err instanceof GeocoderError || err instanceof WeatherError) {
        console.warn('metrosPrewarm: skipping metro', {
          slug: row.slug,
          kind: err instanceof GeocoderError ? err.kind : 'weather',
          message: err.message,
        });
        continue;
      }
      // Unexpected error type — log with shape but still skip.
      console.error('metrosPrewarm: unexpected error', { slug: row.slug, err: String(err) });
    }
  }

  const summary: MetrosSummary = {
    generatedAt: now.toISOString(),
    etDate,
    defaultCut: DEFAULT_CUT,
    defaultCooker: DEFAULT_COOKER,
    metros: tiles,
  };

  // Write the aggregate with a TTL set to the per-metro weather
  // cache's stale window (30 h = 24 h fresh + 6 h stale-while-error
  // grace from worker/src/lib/cache/weather.ts).
  //
  // Caveat: during EST the 04:00 UTC tick rewrites the PRIOR ET day's
  // aggregate at 23:00 EST and resets its TTL to a fresh 30 h. The
  // per-metro weather entries that aggregate was built from are
  // about to expire (they were written ~25 h ago at the previous
  // EST 05:00 UTC tick), so the aggregate can outlive its source
  // data by ~24 h. That's harmless — the /api/metros yesterday
  // fallback would prefer today's fresh aggregate anyway, and the
  // per-metro forecast handler still has its own stale-while-error
  // path. The 30 h ceiling is a defense against the aggregate
  // lingering indefinitely if BOTH crons silently miss several days.
  await env.WEATHER_KV.put(aggregateKey(etDate), JSON.stringify(summary), {
    expirationTtl: 30 * 60 * 60,
  });

  return summary;
}
