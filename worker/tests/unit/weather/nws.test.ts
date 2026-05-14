import { describe, expect, it } from 'vitest';
import { fetchNws } from '../../../src/lib/weather/nws';
import { nwsHourlyTwoDays, nwsPoints } from './fixtures';

// NWS does two GETs: points → hourly. The chained fetcher returns the
// next prepared response on each call.
function chainedFetcher(...responses: Array<{ status: number; body: unknown }>): typeof fetch {
  let i = 0;
  return async () => {
    const r = responses[i++];
    if (!r) throw new Error('chainedFetcher called more times than responses provided');
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'Content-Type': 'application/geo+json' },
    });
  };
}

describe('fetchNws', () => {
  it('chains points → hourly and groups periods into days', async () => {
    const days = await fetchNws(39.1, -94.6, 7, {
      fetcher: chainedFetcher(
        { status: 200, body: nwsPoints },
        { status: 200, body: nwsHourlyTwoDays }
      ),
    });
    expect(days).toHaveLength(2);
    expect(days[0]?.date).toBe('2026-05-14');
    expect(days[0]?.tempHighF).toBe(80); // max of [78, 80]
    expect(days[0]?.tempLowF).toBe(78);
    expect(days[0]?.gustMphMax).toBe(15); // "15 mph" + null → 15
    expect(days[0]?.windMphMean).toBeCloseTo(8.5, 1); // mean("5 to 10 mph"→10, "7 mph"→7)
    expect(days[0]?.source).toBe('nws');
    expect(days[0]?.confidence).toBe('high');
    expect(days[0]?.hourly).toHaveLength(2);
    expect(days[1]?.date).toBe('2026-05-15');
    expect(days[1]?.tempHighF).toBe(81);
  });

  it('caps day count at the requested number', async () => {
    const days = await fetchNws(39.1, -94.6, 1, {
      fetcher: chainedFetcher(
        { status: 200, body: nwsPoints },
        { status: 200, body: nwsHourlyTwoDays }
      ),
    });
    expect(days).toHaveLength(1);
    expect(days[0]?.date).toBe('2026-05-14');
  });

  it('throws WeatherError("http_5xx") when points returns 503', async () => {
    await expect(
      fetchNws(39.1, -94.6, 7, {
        fetcher: chainedFetcher({ status: 503, body: {} }),
      })
    ).rejects.toMatchObject({ source: 'nws', kind: 'http_5xx' });
  });

  it('throws WeatherError("http_5xx") when hourly returns 502', async () => {
    await expect(
      fetchNws(39.1, -94.6, 7, {
        fetcher: chainedFetcher(
          { status: 200, body: nwsPoints },
          { status: 502, body: {} }
        ),
      })
    ).rejects.toMatchObject({ source: 'nws', kind: 'http_5xx' });
  });

  it('throws WeatherError("malformed") on a broken points payload', async () => {
    await expect(
      fetchNws(39.1, -94.6, 7, {
        fetcher: chainedFetcher({ status: 200, body: { properties: {} } }),
      })
    ).rejects.toMatchObject({ source: 'nws', kind: 'malformed' });
  });

  it('converts NWS dewpoint from Celsius to Fahrenheit', async () => {
    const days = await fetchNws(39.1, -94.6, 1, {
      fetcher: chainedFetcher(
        { status: 200, body: nwsPoints },
        { status: 200, body: nwsHourlyTwoDays }
      ),
    });
    // Fixture has dewpoint 15.5°C and 16.0°C → mean 15.75°C → 60.35°F
    expect(days[0]?.dewPointMeanF).toBeCloseTo(60.35, 1);
  });

  it('throws non-recoverable WeatherError("http_4xx", 404) when points returns 404', async () => {
    // NWS returns 404 from /points/{lat,lon} for lat/lon outside its US-only
    // service area. 404 is NOT in the recoverable 4xx set, so the adapter
    // will not retry — the call propagates to the user with a clean error.
    try {
      await fetchNws(0, 0, 7, {
        fetcher: chainedFetcher({ status: 404, body: { detail: 'Data Unavailable For Requested Point' } }),
      });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toMatchObject({ source: 'nws', kind: 'http_4xx', status: 404 });
      expect((err as { isRecoverable: boolean }).isRecoverable).toBe(false);
    }
  });

  it('refuses a forecastHourly URL on a different origin than the points base', async () => {
    const attackerPoints = {
      properties: {
        // points response from api.weather.gov hands us an attacker URL
        forecastHourly: 'https://evil.example.test/forecast/hourly',
      },
    };
    await expect(
      fetchNws(39.1, -94.6, 7, {
        fetcher: chainedFetcher({ status: 200, body: attackerPoints }),
      })
    ).rejects.toMatchObject({ source: 'nws', kind: 'malformed' });
  });

  it('refuses an http (not https) forecastHourly URL when base is https', async () => {
    const downgradePoints = {
      properties: {
        forecastHourly: 'http://api.weather.gov/forecast/hourly',
      },
    };
    await expect(
      fetchNws(39.1, -94.6, 7, {
        fetcher: chainedFetcher({ status: 200, body: downgradePoints }),
      })
    ).rejects.toMatchObject({ source: 'nws', kind: 'malformed' });
  });

  it('throws WeatherError("malformed") on empty periods', async () => {
    await expect(
      fetchNws(39.1, -94.6, 7, {
        fetcher: chainedFetcher(
          { status: 200, body: nwsPoints },
          { status: 200, body: { properties: { periods: [] } } }
        ),
      })
    ).rejects.toMatchObject({ source: 'nws', kind: 'malformed' });
  });

  it('derives dewpoint from temp + RH via Magnus when NWS omits it', async () => {
    // Two periods with dewpoint = null. Magnus(80°F, 55% RH) ≈ 62.4°F.
    const noDewpointPayload = {
      properties: {
        periods: [
          {
            startTime: '2026-05-14T10:00:00-05:00',
            temperature: 80,
            temperatureUnit: 'F' as const,
            windSpeed: '5 mph',
            windGust: null,
            probabilityOfPrecipitation: { value: 10 },
            relativeHumidity: { value: 55 },
            dewpoint: { value: null },
          },
          {
            startTime: '2026-05-14T11:00:00-05:00',
            temperature: 80,
            temperatureUnit: 'F' as const,
            windSpeed: '5 mph',
            windGust: null,
            probabilityOfPrecipitation: { value: 10 },
            relativeHumidity: { value: 55 },
            dewpoint: null,
          },
        ],
      },
    };
    const days = await fetchNws(39.1, -94.6, 1, {
      fetcher: chainedFetcher(
        { status: 200, body: nwsPoints },
        { status: 200, body: noDewpointPayload }
      ),
    });
    expect(days[0]?.dewPointMeanF).toBeGreaterThan(61);
    expect(days[0]?.dewPointMeanF).toBeLessThan(64);
  });
});
