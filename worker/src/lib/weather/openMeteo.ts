// Open-Meteo forecast client. Keyless, 10000 req/day free tier.
// Returns one WeatherDay per requested day, each with an hourly array.

import { z } from 'zod';
import type { WeatherDay, WeatherHour } from '@shared/types';
import { confidenceByDayIndex } from './confidence.js';
import { WeatherError } from './errors.js';
import { fetchWithTimeout, type Fetcher } from './fetchWithTimeout.js';

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
const DEFAULT_TIMEOUT_MS = 5000;
const NUM = z.number().finite();

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
    throw new WeatherError('open-meteo', 'http_5xx', `status ${res.status}`);
  }
  if (!res.ok) {
    throw new WeatherError('open-meteo', 'http_4xx', `status ${res.status}`);
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

  return normalize(parsed.data);
}

function normalize(data: z.infer<typeof OpenMeteoResponse>): WeatherDay[] {
  const { daily, hourly } = data;
  const out: WeatherDay[] = [];

  for (let i = 0; i < daily.time.length; i++) {
    const date = daily.time[i];
    if (date === undefined) continue;
    const dayHourly = hoursForDay(hourly, date);
    const day: WeatherDay = {
      date,
      tempHighF: req(daily.temperature_2m_max, i),
      tempLowF: req(daily.temperature_2m_min, i),
      rhMean: req(daily.relative_humidity_2m_mean, i),
      windMphMean: meanOf(dayHourly.map((h) => h.windMph)) ?? req(daily.wind_speed_10m_max, i),
      gustMphMax: req(daily.wind_gusts_10m_max, i),
      precipProbPct: req(daily.precipitation_probability_max, i),
      precipIn: req(daily.precipitation_sum, i),
      dewPointMeanF: req(daily.dew_point_2m_mean, i),
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
    out.push({
      t,
      tempF: req(hourly.temperature_2m, i),
      rh: req(hourly.relative_humidity_2m, i),
      windMph: req(hourly.wind_speed_10m, i),
      gustMph: req(hourly.wind_gusts_10m, i),
      precipProbPct: req(hourly.precipitation_probability, i),
      precipIn: req(hourly.precipitation, i),
      dewPointF: req(hourly.dew_point_2m, i),
    });
  }
  return out;
}

function req(arr: readonly number[], i: number): number {
  const v = arr[i];
  if (v === undefined) {
    // zod has already asserted the column is fully populated to daily.time.length,
    // so an undefined here means the response was internally inconsistent.
    throw new WeatherError('open-meteo', 'malformed', `index ${i} missing`);
  }
  return v;
}

function meanOf(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}
