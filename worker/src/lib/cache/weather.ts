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
// full ICU tz database, so DST transitions resolve correctly:
//   • Spring-forward (2026-03-08): wall clock jumps 02:00 EST → 03:00
//     EDT, so 02:00-02:59 ET does not exist. The corresponding UTC
//     window 07:00-07:59 UTC resolves into the post-jump 03:00-03:59
//     EDT range (which IS a valid local time) — and either way still
//     falls on 2026-03-08 in ET, which is what the cache bucket needs.
//   • Fall-back (2026-11-01): wall clock falls 02:00 EDT → 01:00 EST,
//     so 01:00-01:59 ET happens twice. Both occurrences (05:00-05:59
//     UTC pre-fallback and 06:00-06:59 UTC post-fallback) resolve to
//     2026-11-01 in ET.
export function etDayBucket(now: number = Date.now()): string {
  return new Date(now).toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
}

// Return the previous-calendar-day ET bucket string given a today
// bucket. Calendar arithmetic, NOT (Date.now() - 86_400_000): the
// raw-millisecond approach skips the spring-forward ET day in the
// early hours after the jump (e.g. asking for "yesterday" of
// 2026-03-09 04:30 UTC subtracts 24h to 2026-03-08 04:30 UTC, which
// ICU still classifies as 2026-03-07 in ET because that instant is
// 23:30 EST on March 7 — entirely missing March 8). Parsing the
// YYYY-MM-DD bucket as UTC midnight and subtracting one calendar day
// avoids the local-time discontinuity.
// Return the millisecond UTC instant when the *next* ET calendar day
// rolls over (i.e., the moment `etDayBucket()` will return a new
// value). Used by SSR cache-headers so the CDN s-maxage caps at the
// next rollover instead of stranding stale forecasts across midnight
// ET. Computes by checking the candidate UTC instants where midnight
// ET can land — 04:00 UTC during EDT and 05:00 UTC during EST — for
// today and tomorrow's UTC dates, then picks the earliest one that
// resolves to a different ET day. O(4) and pure.
export function nextEtMidnightMs(nowMs: number = Date.now()): number {
  const today = etDayBucket(nowMs);
  const nowD = new Date(nowMs);
  const candidates: number[] = [];
  for (const offsetDays of [0, 1]) {
    for (const utcHour of [4, 5]) {
      candidates.push(
        Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate() + offsetDays, utcHour, 0, 0)
      );
    }
  }
  candidates.sort((a, b) => a - b);
  for (const c of candidates) {
    if (c <= nowMs) continue;
    if (etDayBucket(c) !== today) return c;
  }
  // Defensive: should be unreachable. 24h fallback so cron timing
  // doesn't break catastrophically if ICU returns something weird.
  return nowMs + 24 * 60 * 60 * 1000;
}

export function previousEtDate(etDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(etDate);
  if (!m) throw new Error(`previousEtDate: expected YYYY-MM-DD, got ${JSON.stringify(etDate)}`);
  const yesterday = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) - 86_400_000);
  const y = yesterday.getUTCFullYear();
  const mo = String(yesterday.getUTCMonth() + 1).padStart(2, '0');
  const d = String(yesterday.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
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
