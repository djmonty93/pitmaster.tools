// Weather adapter: Open-Meteo primary, NWS failover.
//
// The adapter calls Open-Meteo first; on any recoverable WeatherError
// (5xx, timeout, malformed payload, network failure) it falls through
// to NWS. A 4xx from Open-Meteo (bad request, unsupported coordinate)
// is propagated — the caller passed bad input and NWS won't help.

import type { WeatherDay } from '@shared/types';
import { WeatherError } from './errors.js';
import { fetchOpenMeteo, type OpenMeteoOptions } from './openMeteo.js';
import { fetchNws, type NwsOptions } from './nws.js';

export interface AdapterOptions {
  openMeteo?: OpenMeteoOptions;
  nws?: NwsOptions;
}

export interface AdapterResult {
  days: WeatherDay[];
  /** Which source produced the result. Used by /api/status. */
  source: 'open-meteo' | 'nws';
  /** Errors collected before the successful source, in order. */
  attempts: WeatherError[];
}

export async function fetchForecast(
  lat: number,
  lon: number,
  days: number,
  opts: AdapterOptions = {}
): Promise<AdapterResult> {
  const attempts: WeatherError[] = [];

  try {
    const result = await fetchOpenMeteo(lat, lon, days, opts.openMeteo);
    return { days: result, source: 'open-meteo', attempts };
  } catch (err) {
    if (!(err instanceof WeatherError) || !err.isRecoverable) throw err;
    attempts.push(err);
  }

  try {
    const result = await fetchNws(lat, lon, days, opts.nws);
    return { days: result, source: 'nws', attempts };
  } catch (err) {
    if (!(err instanceof WeatherError)) throw err;
    attempts.push(err);
    throw new WeatherError(
      'nws',
      err.kind,
      `all sources failed: ${attempts.map((a) => a.message).join(' | ')}`
    );
  }
}
