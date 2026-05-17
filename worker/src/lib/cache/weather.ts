// Weather-specific cache wrapper. Composes the Step 2 adapter with the
// generic Step 4 KV cache. Key shape: `weather:v2:${zip}:${etDay}`
// where etDay is the calendar date in America/New_York so the cached
// entry rolls over at midnight ET and every visitor in a given metro
// on a given day sees the same forecast.

import { fetchForecast, type AdapterResult, type AdapterOptions } from '../weather/adapter.js';
import { cachedFetch, type CachedFetchOptions } from './kv.js';

// v2: switched the day-bucket from UTC to America/New_York. v1 entries
// with UTC-day suffixes are partitioned off and age out naturally via
// their existing expirationTtl — no migration step required.
const KEY_PREFIX = 'weather:v2';

// 24 hours fresh, 30 hours total TTL (24h + 6h stale-while-error grace).
// freshSeconds = full ET day so a metro's forecast is stable for the
// whole day after the cron pre-warms at midnight ET. staleSeconds drives
// KV expirationTtl and must be >= freshSeconds per kv.ts.
const FRESH_SECONDS = 24 * 60 * 60;
const STALE_SECONDS = 30 * 60 * 60;

export interface CachedForecastOptions {
  adapter?: AdapterOptions;
  cache?: Partial<CachedFetchOptions<AdapterResult>>;
  /** Override for tests so the day-bucket is deterministic. */
  now?: () => number;
}

// Tight whitelist on the cache key input. Cloudflare KV caps keys at
// 512 bytes and rejects some control characters; accept alphanumeric +
// "-" (US 5-digit zips, Canadian postal codes, etc.) up to 16 chars —
// generous for foreign postal codes, paranoid against header injection.
const ZIP_ALLOWED = /^[A-Za-z0-9-]{1,16}$/;

export function cacheKey(zip: string, dayBucket: string): string {
  if (!ZIP_ALLOWED.test(zip)) {
    throw new Error(`invalid zip for cache key: ${JSON.stringify(zip)}`);
  }
  return `${KEY_PREFIX}:${zip}:${dayBucket}`;
}

// "Today in America/New_York" as a sortable YYYY-MM-DD string. en-CA's
// locale formats dates as YYYY-MM-DD natively, which sidesteps the
// month/day/year ordering pitfall of en-US. Cloudflare Workers ship the
// full ICU tz database, so DST transitions resolve correctly: 2026-03-08
// 06:30 UTC (= 02:30 EDT, one hour after spring-forward) returns
// "2026-03-08", not "2026-03-07".
export function etDayBucket(now: number = Date.now()): string {
  return new Date(now).toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
}

export async function fetchForecastCached(
  kv: KVNamespace,
  zip: string,
  lat: number,
  lon: number,
  days: number,
  opts: CachedForecastOptions = {}
): Promise<AdapterResult> {
  const now = opts.now ?? Date.now;
  const key = cacheKey(zip, etDayBucket(now()));
  return cachedFetch(
    kv,
    key,
    () => fetchForecast(lat, lon, days, opts.adapter),
    {
      freshSeconds: FRESH_SECONDS,
      staleSeconds: STALE_SECONDS,
      now,
      ...opts.cache,
    }
  );
}
