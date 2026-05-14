// National Weather Service forecast client — failover when Open-Meteo is
// unavailable. Two hops: points → gridpoint hourly forecast.
//
// Reliability profile: NWS commonly takes 1-3 s, accepts only US lat/lon,
// and requires a real User-Agent identifying the caller (per
// https://www.weather.gov/documentation/services-web-api#/default/point).
// We surface the User-Agent via env so production can identify itself and
// fall back to a sensible default for local dev.

import { z } from 'zod';
import type { WeatherDay, WeatherHour } from '@shared/types';
import { confidenceByDayIndex } from './confidence.js';
import { WeatherError } from './errors.js';
import { fetchWithTimeout, type Fetcher } from './fetchWithTimeout.js';

const NWS_BASE_URL = 'https://api.weather.gov';
// 4 s per hop; NWS does two hops so the worst-case NWS wallclock is ~8 s.
// Combined with Open-Meteo's 3 s primary, total fail-over wallclock caps
// at ~11 s — within Cloudflare paid-plan wallclock budgets.
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_USER_AGENT = 'pitmaster.tools (contact@pitmaster.tools)';

const PointsResponse = z.object({
  properties: z.object({
    forecastHourly: z.string().url(),
    timeZone: z.string().optional(),
  }),
});

const NumberValue = z.object({ value: z.number().nullable() });

// NWS forecastHourly periods. In practice the only field guaranteed on
// every period is `startTime`, `temperature`, `temperatureUnit`, and
// `windSpeed`. `windGust` is almost always *absent* (not null) on hourly
// forecasts — schema accepts both. `dewpoint.value` is Celsius even when
// `temperatureUnit` is Fahrenheit; nws.ts:dewPointF handles the conversion
// and falls back to a Magnus calculation when value is null.
const HourlyPeriod = z.object({
  startTime: z.string(),
  temperature: z.number(),
  // NWS emits 'F' for the CONUS but occasionally 'C' for non-CONUS
  // offices (Alaska Region, Pacific Region). Accept both and convert
  // inside normalize so a single mis-configured office doesn't break
  // fail-over for every CONUS request that happens to reach NWS first.
  temperatureUnit: z.enum(['F', 'C']),
  windSpeed: z.string(),
  windGust: z.string().nullable().optional(),
  probabilityOfPrecipitation: NumberValue.nullable().optional(),
  relativeHumidity: NumberValue.nullable().optional(),
  dewpoint: z
    .object({ value: z.number().nullable(), unitCode: z.string().optional() })
    .nullable()
    .optional(),
});

const HourlyForecastResponse = z.object({
  properties: z.object({
    periods: z.array(HourlyPeriod),
  }),
});

export interface NwsOptions {
  timeoutMs?: number;
  userAgent?: string;
  baseUrl?: string;
  fetcher?: Fetcher;
}

export async function fetchNws(
  lat: number,
  lon: number,
  days: number,
  opts: NwsOptions = {}
): Promise<WeatherDay[]> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = {
    'User-Agent': opts.userAgent ?? DEFAULT_USER_AGENT,
    Accept: 'application/geo+json',
  };
  const base = opts.baseUrl ?? NWS_BASE_URL;

  // Hop 1: points → forecastHourly URL.
  const pointsRes = await fetchWithTimeout(
    'nws',
    `${base}/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
    { method: 'GET', headers },
    timeout,
    opts.fetcher
  );
  if (pointsRes.status >= 500) {
    throw new WeatherError('nws', 'http_5xx', `points ${pointsRes.status}`, pointsRes.status);
  }
  if (!pointsRes.ok) {
    throw new WeatherError('nws', 'http_4xx', `points ${pointsRes.status}`, pointsRes.status);
  }
  const pointsJson = await readJson(pointsRes);
  const points = PointsResponse.safeParse(pointsJson);
  if (!points.success) {
    throw new WeatherError('nws', 'malformed', `points: ${points.error.message}`);
  }

  // Pin the forecastHourly URL to the same origin as the points request.
  // NWS always returns a same-origin URL (api.weather.gov); refuse anything
  // else so a compromised/forked response can't redirect the second hop to
  // an attacker-controlled host or downgrade the scheme to http.
  const baseOrigin = new URL(base).origin;
  let forecastHourly: URL;
  try {
    forecastHourly = new URL(points.data.properties.forecastHourly);
  } catch (err) {
    throw new WeatherError(
      'nws',
      'malformed',
      `forecastHourly not a URL: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (forecastHourly.origin !== baseOrigin) {
    throw new WeatherError(
      'nws',
      'malformed',
      `forecastHourly origin ${forecastHourly.origin} != points origin ${baseOrigin}`
    );
  }

  const hourlyRes = await fetchWithTimeout(
    'nws',
    forecastHourly.toString(),
    { method: 'GET', headers },
    timeout,
    opts.fetcher
  );
  if (hourlyRes.status >= 500) {
    throw new WeatherError('nws', 'http_5xx', `forecastHourly ${hourlyRes.status}`, hourlyRes.status);
  }
  if (!hourlyRes.ok) {
    throw new WeatherError('nws', 'http_4xx', `forecastHourly ${hourlyRes.status}`, hourlyRes.status);
  }
  const hourlyJson = await readJson(hourlyRes);
  const hourly = HourlyForecastResponse.safeParse(hourlyJson);
  if (!hourly.success) {
    throw new WeatherError('nws', 'malformed', `forecastHourly: ${hourly.error.message}`);
  }

  const usable = normalize(hourly.data.properties.periods, days);
  if (usable.length === 0) {
    // Empty periods → NWS has no forecast for this grid right now. Surface
    // it as malformed so the adapter's two-source loop reports a proper
    // "all sources failed" rather than returning success with zero days.
    throw new WeatherError('nws', 'malformed', 'forecastHourly returned no periods');
  }
  return usable;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch (err) {
    throw new WeatherError('nws', 'malformed', err instanceof Error ? err.message : 'invalid json');
  }
}

function normalize(periods: z.infer<typeof HourlyPeriod>[], days: number): WeatherDay[] {
  const byDate = new Map<string, WeatherHour[]>();

  for (const p of periods) {
    const date = p.startTime.slice(0, 10); // YYYY-MM-DD from ISO timestamp
    const bucket = byDate.get(date) ?? [];
    const tempF = p.temperatureUnit === 'C' ? (p.temperature * 9) / 5 + 32 : p.temperature;
    // 50 % RH is the conservative default when NWS omits the field:
    // 0 % implies impossibly dry air and biases the score; 100 % implies
    // saturated air and over-states stall risk. 50 % keeps the Magnus
    // dewpoint reasonable without anchoring scoring in either direction.
    const rh = p.relativeHumidity?.value ?? 50;
    bucket.push({
      t: p.startTime,
      tempF,
      rh,
      windMph: parseSpeedMph(p.windSpeed),
      gustMph: parseSpeedMph(p.windGust ?? null),
      precipProbPct: numberOr(p.probabilityOfPrecipitation, 0),
      precipIn: 0, // NWS hourly forecast doesn't carry quantitative precip.
      dewPointF: dewPointF(p.dewpoint ?? null, tempF, rh),
    });
    byDate.set(date, bucket);
  }

  const sortedDates = [...byDate.keys()].sort();
  const out: WeatherDay[] = [];
  for (let i = 0; i < sortedDates.length && i < days; i++) {
    const date = sortedDates[i]!;
    const hours = byDate.get(date)!;
    const temps = hours.map((h) => h.tempF);
    out.push({
      date,
      tempHighF: Math.max(...temps),
      tempLowF: Math.min(...temps),
      rhMean: mean(hours.map((h) => h.rh)),
      windMphMean: mean(hours.map((h) => h.windMph)),
      gustMphMax: Math.max(...hours.map((h) => h.gustMph)),
      precipProbPct: Math.max(...hours.map((h) => h.precipProbPct)),
      precipIn: 0,
      dewPointMeanF: mean(hours.map((h) => h.dewPointF)),
      hourly: hours,
      source: 'nws',
      confidence: confidenceByDayIndex(i),
    });
  }
  return out;
}

function parseSpeedMph(s: string | null): number {
  if (s === null) return 0;
  // "5 mph" → 5; "5 to 10 mph" → 10 (take the upper end so gust/wind risk
  // isn't under-reported in the score).
  const matches = s.match(/\d+/g);
  if (matches === null) return 0;
  return Math.max(...matches.map((n) => Number.parseInt(n, 10)));
}

function numberOr(v: { value: number | null } | null | undefined, fallback: number): number {
  if (v === null || v === undefined || v.value === null) return fallback;
  return v.value;
}

function dewPointF(
  v: { value: number | null; unitCode?: string | undefined } | null | undefined,
  fallbackTempF: number,
  fallbackRhPct: number
): number {
  if (v !== null && v !== undefined && v.value !== null) {
    // NWS reports dewpoint in Celsius even when temperature is Fahrenheit.
    return (v.value * 9) / 5 + 32;
  }
  // NWS occasionally omits dewpoint on a period. Returning 0 here would
  // imply a freezing dewpoint and silently distort stall-risk scoring,
  // so derive it from temperature + RH instead via the Magnus formula
  // (Alduchov & Eskridge, 1996 — a=17.625, b=243.04):
  //   α  = ln(rh/100) + a*T_C / (b + T_C)
  //   Td = b*α / (a - α)            [°C]
  if (fallbackRhPct <= 0) return fallbackTempF;
  const a = 17.625;
  const b = 243.04;
  const tC = ((fallbackTempF - 32) * 5) / 9;
  const alpha = Math.log(fallbackRhPct / 100) + (a * tC) / (b + tC);
  const tdC = (b * alpha) / (a - alpha);
  return (tdC * 9) / 5 + 32;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}
