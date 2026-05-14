// Weather-specific cache wrapper. Composes the Step 2 adapter with the
// generic Step 4 KV cache. Key shape per plan: `weather:v1:${zip}:${day}`
// where day is the UTC YYYY-MM-DD bucket so subsequent requests on the
// same calendar day in the same zip share an entry.

import { fetchForecast, type AdapterResult, type AdapterOptions } from '../weather/adapter.js';
import { cachedFetch, type CachedFetchOptions } from './kv.js';

const KEY_PREFIX = 'weather:v1';

// 30 minutes fresh, 6 hours stale. Weather changes slowly compared to,
// say, stock prices; the stale-while-error window covers a major
// upstream outage without showing stale data to a fresh visitor on a
// good network.
const FRESH_SECONDS = 30 * 60;
const STALE_SECONDS = 6 * 60 * 60;

export interface CachedForecastOptions {
  adapter?: AdapterOptions;
  cache?: Partial<CachedFetchOptions<AdapterResult>>;
  /** Override for tests so the day-bucket is deterministic. */
  now?: () => number;
}

export function cacheKey(zip: string, dayBucket: string): string {
  return `${KEY_PREFIX}:${zip}:${dayBucket}`;
}

export function utcDayBucket(now: number = Date.now()): string {
  // ISO timestamp's leading 10 chars are YYYY-MM-DD in UTC.
  return new Date(now).toISOString().slice(0, 10);
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
  const key = cacheKey(zip, utcDayBucket(now()));
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
