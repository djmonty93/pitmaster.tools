// Open-Meteo forecast client. Keyless, 10000 req/day free tier.
// Returns one WeatherDay per requested day, each with an hourly array.

import { z } from 'zod';
import type { WeatherDay, WeatherHour } from '@shared/types';
import { confidenceByDayIndex } from './confidence.js';
import { WeatherError } from './errors.js';
import { fetchWithTimeout, type Fetcher } from './fetchWithTimeout.js';

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
const DEFAULT_TIMEOUT_MS = 5000;

// Open-Meteo sometimes returns null for individual hourly/daily values when
// the underlying weather model has no data for that timestamp+variable
// (e.g. precipitation_probability beyond a regional ensemble's horizon).
// Accept nullable numbers in the schema and coalesce downstream — refusing
// the whole payload would force a needless fail-over.
const NUM = z.number().finite().nullable();

const DailySchema = z.object({
  time: z.array(z.string()),
  temperature_2m_max: z.array(NUM),
  temperature_2m_min: z.array(NUM),
  relative_humidity_2m_mean: z.array(NUM),
  wind_speed_10m_max: z.array(NUM),
  wind_gusts_10m_max: z.array(NUM),
  precipitation_probability_max: z.array(NUM),
  precipitation_sum: z.array(NUM),
  dew_point_2m_mean: z.array(NUM),
});

const HourlySchema = z.object({
  time: z.array(z.string()),
  temperature_2m: z.array(NUM),
  relative_humidity_2m: z.array(NUM),
  wind_speed_10m: z.array(NUM),
  wind_gusts_10m: z.array(NUM),
  precipitation_probability: z.array(NUM),
  precipitation: z.array(NUM),
  dew_point_2m: z.array(NUM),
});

const OpenMeteoResponse = z.object({
  daily: DailySchema,
  hourly: HourlySchema,
});

const DAILY_FIELDS = [
  'temperature_2m_max',
  'temperature_2m_min',
  'relative_humidity_2m_mean',
  'wind_speed_10m_max',
  'wind_gusts_10m_max',
  'precipitation_probability_max',
  'precipitation_sum',
  'dew_point_2m_mean',
].join(',');

const HOURLY_FIELDS = [
  'temperature_2m',
  'relative_humidity_2m',
  'wind_speed_10m',
  'wind_gusts_10m',
  'precipitation_probability',
  'precipitation',
  'dew_point_2m',
].join(',');

export interface OpenMeteoOptions {
  timeoutMs?: number;
  /** Override for tests; pin a deterministic base URL. */
  baseUrl?: string;
  /** Injectable fetcher; defaults to the workerd `fetch` global. */
  fetcher?: Fetcher;
}

export async function fetchOpenMeteo(
  lat: number,
  lon: number,
  days: number,
  opts: OpenMeteoOptions = {}
): Promise<WeatherDay[]> {
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    daily: DAILY_FIELDS,
    hourly: HOURLY_FIELDS,
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'auto',
    forecast_days: days.toString(),
  });
  const url = `${opts.baseUrl ?? OPEN_METEO_URL}?${params.toString()}`;

  const res = await fetchWithTimeout(
    'open-meteo',
    url,
    { method: 'GET' },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    opts.fetcher
  );
  if (res.status >= 500) {
    throw new WeatherError('open-meteo', 'http_5xx', `status ${res.status}`, res.status);
  }
  if (!res.ok) {
    throw new WeatherError('open-meteo', 'http_4xx', `status ${res.status}`, res.status);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new WeatherError('open-meteo', 'malformed', err instanceof Error ? err.message : 'invalid json');
  }

  const parsed = OpenMeteoResponse.safeParse(body);
  if (!parsed.success) {
    throw new WeatherError('open-meteo', 'malformed', parsed.error.message);
  }

  const usable = normalize(parsed.data);
  if (usable.length === 0) {
    // Every requested day was null-anchored; treat as a fail-over signal
    // so the adapter tries NWS instead of returning an empty forecast.
    throw new WeatherError(
      'open-meteo',
      'malformed',
      'no usable days (all temperature_2m_max/min are null)'
    );
  }
  return usable;
}

function normalize(data: z.infer<typeof OpenMeteoResponse>): WeatherDay[] {
  const { daily, hourly } = data;
  const out: WeatherDay[] = [];

  for (let i = 0; i < daily.time.length; i++) {
    const date = daily.time[i];
    if (date === undefined) continue;

    // A day is only usable if we have both high and low temperatures; the
    // entire score depends on them. Other daily fields fall back to 0 when
    // missing — the score will simply not credit those signals.
    const high = daily.temperature_2m_max[i];
    const low = daily.temperature_2m_min[i];
    if (high === null || high === undefined || low === null || low === undefined) {
      continue;
    }

    const dayHourly = hoursForDay(hourly, date);
    const day: WeatherDay = {
      date,
      tempHighF: high,
      tempLowF: low,
      rhMean: cell(daily.relative_humidity_2m_mean, i),
      windMphMean:
        meanOf(dayHourly.map((h) => h.windMph)) ?? cell(daily.wind_speed_10m_max, i),
      gustMphMax: cell(daily.wind_gusts_10m_max, i),
      precipProbPct: cell(daily.precipitation_probability_max, i),
      precipIn: cell(daily.precipitation_sum, i),
      dewPointMeanF: cell(daily.dew_point_2m_mean, i),
      hourly: dayHourly,
      source: 'open-meteo',
      confidence: confidenceByDayIndex(i),
    };
    out.push(day);
  }
  return out;
}

function hoursForDay(hourly: z.infer<typeof HourlySchema>, ymd: string): WeatherHour[] {
  const out: WeatherHour[] = [];
  for (let i = 0; i < hourly.time.length; i++) {
    const t = hourly.time[i];
    if (t === undefined || !t.startsWith(ymd)) continue;
    const tempF = hourly.temperature_2m[i];
    // Skip an hour outright if its temperature is null — the rest of the
    // score is fundamentally unanchored without it.
    if (tempF === null || tempF === undefined) continue;
    out.push({
      t,
      tempF,
      rh: cell(hourly.relative_humidity_2m, i),
      windMph: cell(hourly.wind_speed_10m, i),
      gustMph: cell(hourly.wind_gusts_10m, i),
      precipProbPct: cell(hourly.precipitation_probability, i),
      precipIn: cell(hourly.precipitation, i),
      dewPointF: cell(hourly.dew_point_2m, i),
    });
  }
  return out;
}

// Read cell i from a nullable column. `null` is a legitimate "model has
// no value for this slot" — coalesce to 0 and let the score not credit
// the signal. `undefined` means the array was shorter than expected,
// which can only happen on a malformed payload (zod asserts the *type*
// of each array but not the lengths against `daily.time`); promote that
// to a WeatherError so the adapter can fail over.
function cell(arr: ReadonlyArray<number | null>, i: number): number {
  if (i >= arr.length) {
    throw new WeatherError(
      'open-meteo',
      'malformed',
      `column shorter than time series at index ${i}`
    );
  }
  const v = arr[i];
  return v === null ? 0 : (v as number);
}

function meanOf(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}
