// GET /api/forecast
//
// Query params (all optional except the bare-minimum behavior):
//   zip       5-digit US zip; defaults to request.cf.postalCode when present
//   cut       Cut enum; defaults to 'brisket-packer' if absent
//   cooker    Cooker enum; defaults to 'offset'
//   days      number of forecast days (1-7); defaults to 7
//
// Pipeline:
//   zip → resolveZip (KV + D1 metros fast path)
//       → fetchForecastCached (Step 4 KV-wrapped Step 2 adapter)
//       → scoreDay per WeatherDay (Step 3 scoring engine)
//   → ForecastResponse JSON
//
// All recoverable failures are mapped to JSON errors. The cron context
// is not in play here (this is a user-facing request), so failures
// bubble back as 5xx for the client to retry — no D1 retry-queue
// hop.

import { scoreDay } from '@shared/scoring';
import type { Cooker, Cut, ForecastResponse } from '@shared/types';
import { recommend } from '../lib/affiliate/rules.js';
import { fetchForecastCached } from '../lib/cache/weather.js';
import { GeocoderError, resolveZip } from '../lib/geo/zipGeocoder.js';
import { WeatherError } from '../lib/weather/errors.js';
import { json, jsonError, type RouteContext } from '../router.js';

const ALL_CUTS: ReadonlyArray<Cut> = [
  'brisket-flat',
  'brisket-packer',
  'pork-butt',
  'spare-ribs',
  'baby-back-ribs',
  'pork-loin',
  'whole-chicken',
  'spatchcock-chicken',
  'chicken-thighs',
  'whole-turkey',
  'turkey-breast',
  'fish',
  'lamb-shoulder',
];

const ALL_COOKERS: ReadonlyArray<Cooker> = ['offset', 'pellet', 'kamado', 'kettle', 'electric'];

const DEFAULT_CUT: Cut = 'brisket-packer';
const DEFAULT_COOKER: Cooker = 'offset';
const DEFAULT_DAYS = 7;

export async function handleForecast(rc: RouteContext): Promise<Response> {
  const params = rc.url.searchParams;
  const zipParam = params.get('zip')?.trim();
  // Geo-IP default (F10): use Cloudflare's request.cf.postalCode when
  // the caller didn't specify a zip. The cf object is undefined in
  // local dev but always present in production at the edge.
  const cfPostal =
    (rc.request as Request & { cf?: { postalCode?: string; country?: string } }).cf?.postalCode ?? null;
  const zipFromQuery = zipParam && zipParam.length > 0;
  const zip = zipFromQuery ? zipParam : cfPostal;
  if (!zip) {
    return jsonError(400, 'missing_zip', 'Provide ?zip=<5-digit US zip>');
  }

  const cutParam = (params.get('cut') ?? DEFAULT_CUT) as Cut;
  if (!ALL_CUTS.includes(cutParam)) {
    return jsonError(400, 'invalid_cut', `cut must be one of: ${ALL_CUTS.join(', ')}`);
  }

  const cookerParam = (params.get('cooker') ?? DEFAULT_COOKER) as Cooker;
  if (!ALL_COOKERS.includes(cookerParam)) {
    return jsonError(400, 'invalid_cooker', `cooker must be one of: ${ALL_COOKERS.join(', ')}`);
  }

  const daysRaw = params.get('days');
  const days = daysRaw ? Number.parseInt(daysRaw, 10) : DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > 7) {
    return jsonError(400, 'invalid_days', 'days must be an integer 1-7');
  }

  let location;
  try {
    location = await resolveZip(rc.env.WEATHER_KV, rc.env.SMOKE_DB, zip);
  } catch (err) {
    if (err instanceof GeocoderError) {
      if (err.kind === 'invalid_zip' || err.kind === 'not_found') {
        return jsonError(404, 'unknown_zip', `Could not resolve zip ${zip}`);
      }
      return jsonError(503, 'geocoder_unavailable', 'Upstream geocoder failed; try again shortly');
    }
    throw err;
  }

  let forecast;
  try {
    forecast = await fetchForecastCached(
      rc.env.WEATHER_KV,
      zip,
      location.latitude,
      location.longitude,
      days
    );
  } catch (err) {
    if (err instanceof WeatherError) {
      return jsonError(503, 'weather_unavailable', 'Upstream weather sources failed; try again shortly');
    }
    throw err;
  }

  const scored = forecast.days.map((day) => ({
    date: day.date,
    day,
    score: scoreDay({ cut: cutParam, cooker: cookerParam, day }),
  }));

  // F15: pick a single product placement keyed on the best-day band so
  // the recommendation tracks the verdict the user is actually shown
  // in the hero. Falls back to the highest-score day when scored is
  // non-empty (the empty branch is unreachable in practice: a
  // successful upstream response always returns at least one day, and
  // the early-return paths above already cover the failure modes).
  // The recommend() rule table includes a catch-all so a `null` result
  // means there were literally no scored days — in that case omit the
  // field entirely rather than surface a placeholder card.
  const bestDay = scored.reduce<typeof scored[number] | null>(
    (acc, d) => (acc === null || d.score.score > acc.score.score ? d : acc),
    null
  );
  const recommendation = bestDay
    ? recommend({ cut: cutParam, cooker: cookerParam, band: bestDay.score.band })
    : null;

  const response: ForecastResponse = {
    zip,
    metro: location.metroSlug ?? undefined,
    source: forecast.source,
    generatedAt: new Date().toISOString(),
    days: scored,
    ...(recommendation ? { recommendation } : {}),
  };
  // Cache-Control split:
  //   - When the zip came from an explicit query param, the URL fully
  //     identifies the response so we can let CDN cache it
  //     publicly for 5 min.
  //   - When the zip came from request.cf.postalCode, the URL is the
  //     SAME across visitors in different metros but the response is
  //     personalized. Public caching would poison the CDN entry —
  //     visitor #1 in 90210 would seed a row that visitor #2 in 10001
  //     would then receive. Use `private` (browser cache only) for
  //     the geo-IP fallback path.
  const cacheControl = zipFromQuery
    ? 'public, max-age=300'
    : 'private, max-age=60';
  return json(200, response, { 'Cache-Control': cacheControl });
}
