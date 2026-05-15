// Zip → (latitude, longitude, timezone, metroSlug?) resolver.
//
// Open-Meteo's free geocoding API
// (https://geocoding-api.open-meteo.com) accepts a postal code +
// country filter and returns lat/lon/timezone. We cache results in
// KV with a long TTL (zip→location doesn't change) so a popular zip
// resolves once per region across all visitors.
//
// For US users this is the path to support zips outside our 50 seeded
// metros. The 50 metros are a fast path: a zip whose 5-digit value is
// in the metros table skips the network call entirely. That's a
// material latency win for the F8 verdict landing page where the same
// metro pages drive most traffic.
//
// `metroSlug` in the result is best-effort: if the resolved zip
// matches a row in `metros` (exact zip match), we attach the slug so
// downstream code can tag subscribers with `metro:<slug>`. A zip that
// doesn't map to any seeded metro returns `metroSlug: null` and Step
// 11's cron has no metro routing for that subscriber — falls back to
// the generic Friday email.

import { z } from 'zod';
import { cachedFetch, type CacheStatus } from '../cache/kv.js';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const DEFAULT_TIMEOUT_MS = 3000;
const FRESH_SECONDS = 30 * 24 * 60 * 60; // 30 days — zip→location is geographically stable
const STALE_SECONDS = 90 * 24 * 60 * 60; // 90 days fallback if API is down
// Bumped from v1 → v2 when ZipLocation gained the `state` field
// (portfolio-aware region routing). v1 entries are missing `state`,
// which would silently drop subscribers into the no-region path on
// the slow-path resubscribe. Old keys age out naturally via TTL —
// no purge required.
const KEY_PREFIX = 'geo:v2';

// US 5-digit zip; we don't yet support other countries.
const US_ZIP_RE = /^\d{5}$/;

export interface ZipLocation {
  zip: string;
  latitude: number;
  longitude: number;
  /** IANA timezone (e.g. "America/New_York"). */
  timezone: string;
  /** Best-effort: matched a row in the `metros` table by exact zip. */
  metroSlug: string | null;
  /** Display name for the resolved place (e.g. "Atlanta, Georgia"). */
  name: string;
  /**
   * Two-letter US state code (e.g. "GA"). Comes from the metros table
   * on the fast path or from admin1→code conversion on the slow path.
   * Null when the geocoder can't resolve it — caller decides whether
   * to reject or proceed with region=null.
   */
  state: string | null;
}

const GeocodeResponse = z.object({
  results: z
    .array(
      z.object({
        latitude: z.number().finite(),
        longitude: z.number().finite(),
        timezone: z.string().min(3),
        name: z.string().min(1),
        admin1: z.string().optional(),
        country_code: z.string().optional(),
      })
    )
    .optional(),
});

export type Fetcher = typeof fetch;

export interface ResolveOptions {
  fetcher?: Fetcher;
  timeoutMs?: number;
  baseUrl?: string;
  now?: () => number;
  /** Override for tests / instrumentation. */
  onCacheResult?: (outcome: { status: CacheStatus | 'origin' | 'stale-while-error'; key: string }) => void;
}

export class GeocoderError extends Error {
  constructor(
    public readonly kind: 'invalid_zip' | 'not_found' | 'http' | 'timeout' | 'network' | 'malformed',
    message: string,
    public readonly status?: number
  ) {
    super(`geocode: ${kind}${status !== undefined ? ` (${status})` : ''}: ${message}`);
    this.name = 'GeocoderError';
  }
}

export async function resolveZip(
  kv: KVNamespace,
  db: D1Database,
  zip: string,
  opts: ResolveOptions = {}
): Promise<ZipLocation> {
  if (!US_ZIP_RE.test(zip)) {
    throw new GeocoderError('invalid_zip', `expected 5-digit US zip, got ${JSON.stringify(zip)}`);
  }

  // Fast path: zip matches a seeded metro exactly. Skip the network.
  const metro = await db
    .prepare(
      `SELECT slug, name, state, latitude, longitude, timezone, zip
         FROM metros WHERE zip = ?`
    )
    .bind(zip)
    .first<{
      slug: string;
      name: string;
      state: string;
      latitude: number;
      longitude: number;
      timezone: string;
      zip: string;
    }>();
  if (metro) {
    return {
      zip,
      latitude: metro.latitude,
      longitude: metro.longitude,
      timezone: metro.timezone,
      metroSlug: metro.slug,
      name: `${metro.name}, ${metro.state}`,
      state: metro.state,
    };
  }

  // Slow path: geocode via Open-Meteo, cached in KV.
  const key = `${KEY_PREFIX}:${zip}`;
  const result = await cachedFetch<ZipLocation>(
    kv,
    key,
    () => fetchGeocode(zip, opts),
    {
      freshSeconds: FRESH_SECONDS,
      staleSeconds: STALE_SECONDS,
      now: opts.now,
      onResult: opts.onCacheResult,
    }
  );
  return result;
}

async function fetchGeocode(zip: string, opts: ResolveOptions): Promise<ZipLocation> {
  const params = new URLSearchParams({
    postal_code: zip,
    count: '1',
    language: 'en',
    format: 'json',
    countryCode: 'US',
  });
  const url = `${opts.baseUrl ?? GEOCODE_URL}?${params.toString()}`;
  const fetcher: Fetcher = opts.fetcher ?? ((input, init) => fetch(input as Parameters<typeof fetch>[0], init));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetcher(url, { method: 'GET', signal: ctrl.signal });
  } catch (err) {
    const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : '';
    if (name === 'AbortError' || ctrl.signal.aborted) {
      throw new GeocoderError('timeout', `> ${timeoutMs}ms`);
    }
    throw new GeocoderError(
      'network',
      err && typeof err === 'object' && 'message' in err ? String(err.message) : 'fetch failed'
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new GeocoderError('http', `status ${res.status}`, res.status);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (_err) {
    throw new GeocoderError('malformed', 'non-JSON body');
  }
  const parsed = GeocodeResponse.safeParse(body);
  if (!parsed.success) {
    throw new GeocoderError('malformed', parsed.error.message);
  }
  const first = parsed.data.results?.[0];
  if (!first) {
    throw new GeocoderError('not_found', `no geocode results for ${zip}`);
  }
  return {
    zip,
    latitude: first.latitude,
    longitude: first.longitude,
    timezone: first.timezone,
    metroSlug: null,
    name: first.admin1 ? `${first.name}, ${first.admin1}` : first.name,
    state: first.admin1 ? stateNameToCode(first.admin1) : null,
  };
}

// Open-Meteo returns admin1 as the full state name ("Georgia"); we
// need the two-letter code for region bucketing. This table covers
// the 50 states + DC. Anything not in here returns null and the
// caller skips region assignment for that subscriber.
const STATE_NAME_TO_CODE: Readonly<Record<string, string>> = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR',
  California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE',
  'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI',
  Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA',
  Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME',
  Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
  Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE',
  Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM',
  'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH',
  Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI',
  'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX',
  Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA',
  'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
};

function stateNameToCode(name: string): string | null {
  return STATE_NAME_TO_CODE[name.trim()] ?? null;
}
