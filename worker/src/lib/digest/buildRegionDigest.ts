// Assembles one region's Friday digest: that region's metros, each with
// Saturday/Sunday/Monday smoke scores, rendered to an HTML email body.
//
// Group broadcasts can't personalise per subscriber, so every score uses
// a single default profile (pork butt on an offset) disclosed in the
// email footer. Forecasts come from the same KV cache the nightly metros
// pre-warm populates (keyed by ZIP), so Friday-morning reads are mostly
// cache hits.

import type { Env } from '../../index.js';
import { stateToRegion, type Region } from '../regions/index.js';
import { fetchForecastCached } from '../cache/weather.js';
import { scoreDay } from '@shared/scoring';
import type { Cooker, Cut } from '@shared/types';
import {
  pickWeeklyTool,
  renderDigestEmail,
  type DigestDay,
  type DigestMetro,
} from '../render/digestEmail.js';

const DEFAULT_CUT: Cut = 'pork-butt';
const DEFAULT_COOKER: Cooker = 'offset';

/**
 * Match the nightly pre-warm's day count so a Friday read reuses its
 * cached entry (the cache key ignores `days`, but a cache MISS fetches
 * exactly this many). 7 days from Friday includes Sat/Sun/Mon.
 */
const FORECAST_DAYS = 7;

/** The weekend window, in render order. */
const WEEKEND_WEEKDAYS = ['Sat', 'Sun', 'Mon'] as const;
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const REGION_LABEL: Readonly<Record<Region, string>> = {
  northeast: 'Northeast',
  southeast: 'Southeast',
  midwest: 'Midwest',
  south_central: 'South Central',
  mountain: 'Mountain',
  pacific: 'Pacific',
};

const DETAIL_URL = 'https://pitmaster.tools/smoke-weather/';

interface MetroRow {
  slug: string;
  name: string;
  state: string;
  zip: string;
  latitude: number;
  longitude: number;
}

export interface BuildRegionDigestOptions {
  now?: () => Date;
}

export interface RegionDigest {
  subject: string;
  html: string;
}

/**
 * Build the digest for one region. Returns null when no metro in the
 * region produced any weekend forecast (e.g. a total upstream outage) —
 * the caller treats that as a transient, retryable condition.
 */
export async function buildRegionDigest(
  env: Env,
  region: Region,
  sendDate: string,
  opts: BuildRegionDigestOptions = {}
): Promise<RegionDigest | null> {
  const now = opts.now ?? (() => new Date());
  const nowMs = now().getTime();

  const rows = await env.SMOKE_DB.prepare(
    `SELECT slug, name, state, zip, latitude, longitude
       FROM metros
       ORDER BY slug`
  ).all<MetroRow>();

  const metros: DigestMetro[] = [];
  for (const row of rows.results ?? []) {
    let rowRegion: Region;
    try {
      rowRegion = stateToRegion(row.state);
    } catch {
      continue; // unknown state code — skip
    }
    if (rowRegion !== region) continue;

    try {
      const forecast = await fetchForecastCached(
        env.WEATHER_KV,
        row.zip,
        row.latitude,
        row.longitude,
        FORECAST_DAYS,
        { now: () => nowMs }
      );
      const days = pickWeekendDays(forecast.days);
      if (days.length === 0) continue;
      metros.push({ name: `${row.name}, ${row.state}`, days });
    } catch {
      // One metro's upstream failure must never sink the whole region.
      continue;
    }
  }

  if (metros.length === 0) return null;

  const regionLabel = REGION_LABEL[region];
  const html = renderDigestEmail({
    regionLabel,
    sendDate,
    metros,
    tool: pickWeeklyTool(sendDate),
    detailUrl: DETAIL_URL,
  });
  return {
    subject: `This weekend's best smoke days — ${regionLabel}`,
    html,
  };
}

/** Pick the Sat/Sun/Mon days from a forecast and score each. */
function pickWeekendDays(days: readonly { date: string }[]): DigestDay[] {
  const out: DigestDay[] = [];
  for (const target of WEEKEND_WEEKDAYS) {
    const match = days.find((d) => weekdayShort(d.date) === target);
    if (match) {
      out.push({
        weekday: target,
        date: match.date,
        // `match` is a WeatherDay; scoreDay only reads weather fields.
        score: scoreDay({ cut: DEFAULT_CUT, cooker: DEFAULT_COOKER, day: match as Parameters<typeof scoreDay>[0]['day'] }),
      });
    }
  }
  return out;
}

// Weekday short name from YYYY-MM-DD without the Date(ISO-string) tz
// hazard (Safari/Chrome disagree on UTC vs local midnight).
function weekdayShort(iso: string): string {
  const parts = iso.split('-');
  const y = parseInt(parts[0] ?? '', 10);
  const m = parseInt(parts[1] ?? '', 10);
  const d = parseInt(parts[2] ?? '', 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return '';
  return DAY_SHORT[new Date(y, m - 1, d).getDay()] ?? '';
}
