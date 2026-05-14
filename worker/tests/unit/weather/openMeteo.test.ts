import { describe, expect, it } from 'vitest';
import { fetchOpenMeteo } from '../../../src/lib/weather/openMeteo';
import { openMeteoTwoDays } from './fixtures';

function jsonFetcher(status: number, body: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
}

describe('fetchOpenMeteo', () => {
  it('parses a well-formed two-day response into WeatherDay[]', async () => {
    const days = await fetchOpenMeteo(40.7, -74.0, 2, {
      fetcher: jsonFetcher(200, openMeteoTwoDays),
    });
    expect(days).toHaveLength(2);
    expect(days[0]?.date).toBe('2026-05-14');
    expect(days[0]?.tempHighF).toBeCloseTo(85.1, 1);
    expect(days[0]?.tempLowF).toBeCloseTo(64.0, 1);
    expect(days[0]?.hourly).toHaveLength(2); // two hourly samples on 2026-05-14
    expect(days[0]?.source).toBe('open-meteo');
    expect(days[0]?.confidence).toBe('high');
    expect(days[1]?.confidence).toBe('high'); // day index 1 is still 'high'
  });

  it('throws WeatherError("http_5xx") on 500', async () => {
    await expect(
      fetchOpenMeteo(0, 0, 1, { fetcher: jsonFetcher(503, {}) })
    ).rejects.toMatchObject({ source: 'open-meteo', kind: 'http_5xx' });
  });

  it('throws WeatherError("http_4xx") on 400', async () => {
    await expect(
      fetchOpenMeteo(0, 0, 1, { fetcher: jsonFetcher(400, {}) })
    ).rejects.toMatchObject({ source: 'open-meteo', kind: 'http_4xx', status: 400 });
  });

  it('carries the HTTP status on 4xx so the adapter can distinguish rate-limits', async () => {
    try {
      await fetchOpenMeteo(0, 0, 1, { fetcher: jsonFetcher(429, {}) });
    } catch (err) {
      expect(err).toMatchObject({ source: 'open-meteo', kind: 'http_4xx', status: 429 });
      // 429 is in the recoverable set; bad-request 400 is not.
      expect((err as { isRecoverable: boolean }).isRecoverable).toBe(true);
    }
  });

  it('throws WeatherError("malformed") on schema mismatch', async () => {
    await expect(
      fetchOpenMeteo(0, 0, 1, { fetcher: jsonFetcher(200, { not: 'forecast' }) })
    ).rejects.toMatchObject({ source: 'open-meteo', kind: 'malformed' });
  });

  it('throws WeatherError("malformed") on invalid JSON body', async () => {
    const fetcher: typeof fetch = async () =>
      new Response('not json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    await expect(
      fetchOpenMeteo(0, 0, 1, { fetcher })
    ).rejects.toMatchObject({ source: 'open-meteo', kind: 'malformed' });
  });

  it('tolerates null hourly + daily cells without rejecting the payload', async () => {
    const payload = {
      daily: {
        time: ['2026-05-14', '2026-05-15'],
        temperature_2m_max: [85.0, null],
        temperature_2m_min: [65.0, 66.0],
        relative_humidity_2m_mean: [50.0, 48.0],
        wind_speed_10m_max: [9.0, null],
        wind_gusts_10m_max: [null, 14.0],
        precipitation_probability_max: [10.0, null],
        precipitation_sum: [0.0, 0.0],
        dew_point_2m_mean: [null, 58.0],
      },
      hourly: {
        time: ['2026-05-14T00:00', '2026-05-14T12:00'],
        temperature_2m: [70.0, null], // second hour is dropped
        relative_humidity_2m: [55.0, 50.0],
        wind_speed_10m: [5.0, 9.0],
        wind_gusts_10m: [10.0, null],
        precipitation_probability: [10.0, 5.0],
        precipitation: [0.0, 0.0],
        dew_point_2m: [60.0, null],
      },
    };
    const days = await fetchOpenMeteo(0, 0, 2, {
      fetcher: async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    // Day 0 is kept (high+low both present); Day 1 dropped because its
    // tempHigh is null.
    expect(days).toHaveLength(1);
    expect(days[0]?.date).toBe('2026-05-14');
    // Hour 1 dropped because tempF is null. Hour 0 keeps its values; the
    // missing daily dew_point_2m_mean coalesces to 0.
    expect(days[0]?.hourly).toHaveLength(1);
    expect(days[0]?.dewPointMeanF).toBe(0);
    expect(days[0]?.gustMphMax).toBe(0);
  });

  it('throws WeatherError("malformed") when every day has null temp high/low', async () => {
    const payload = {
      daily: {
        time: ['2026-05-14'],
        temperature_2m_max: [null],
        temperature_2m_min: [null],
        relative_humidity_2m_mean: [50.0],
        wind_speed_10m_max: [9.0],
        wind_gusts_10m_max: [14.0],
        precipitation_probability_max: [10.0],
        precipitation_sum: [0.0],
        dew_point_2m_mean: [60.0],
      },
      hourly: {
        time: ['2026-05-14T00:00'],
        temperature_2m: [70.0],
        relative_humidity_2m: [55.0],
        wind_speed_10m: [5.0],
        wind_gusts_10m: [10.0],
        precipitation_probability: [10.0],
        precipitation: [0.0],
        dew_point_2m: [60.0],
      },
    };
    await expect(
      fetchOpenMeteo(0, 0, 1, {
        fetcher: async () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      })
    ).rejects.toMatchObject({ source: 'open-meteo', kind: 'malformed' });
  });

  it('throws WeatherError("malformed") when temperature column is shorter than time', async () => {
    const payload = {
      daily: {
        time: ['2026-05-14', '2026-05-15'],
        temperature_2m_max: [85.0], // mis-aligned: only one entry
        temperature_2m_min: [65.0, 66.0],
        relative_humidity_2m_mean: [50.0, 48.0],
        wind_speed_10m_max: [9.0, 11.0],
        wind_gusts_10m_max: [14.0, 18.0],
        precipitation_probability_max: [10.0, 5.0],
        precipitation_sum: [0.0, 0.0],
        dew_point_2m_mean: [60.0, 58.0],
      },
      hourly: {
        time: ['2026-05-14T00:00'],
        temperature_2m: [70.0],
        relative_humidity_2m: [55.0],
        wind_speed_10m: [5.0],
        wind_gusts_10m: [10.0],
        precipitation_probability: [10.0],
        precipitation: [0.0],
        dew_point_2m: [60.0],
      },
    };
    await expect(
      fetchOpenMeteo(0, 0, 2, {
        fetcher: async () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      })
    ).rejects.toMatchObject({ source: 'open-meteo', kind: 'malformed' });
  });

  it('throws WeatherError("malformed") when a secondary column is shorter than time', async () => {
    const payload = {
      daily: {
        time: ['2026-05-14', '2026-05-15'],
        temperature_2m_max: [85.0, 88.0],
        temperature_2m_min: [65.0, 66.0],
        relative_humidity_2m_mean: [50.0], // mis-aligned: only one entry
        wind_speed_10m_max: [9.0, 11.0],
        wind_gusts_10m_max: [14.0, 18.0],
        precipitation_probability_max: [10.0, 5.0],
        precipitation_sum: [0.0, 0.0],
        dew_point_2m_mean: [60.0, 58.0],
      },
      hourly: {
        time: ['2026-05-14T00:00'],
        temperature_2m: [70.0],
        relative_humidity_2m: [55.0],
        wind_speed_10m: [5.0],
        wind_gusts_10m: [10.0],
        precipitation_probability: [10.0],
        precipitation: [0.0],
        dew_point_2m: [60.0],
      },
    };
    await expect(
      fetchOpenMeteo(0, 0, 2, {
        fetcher: async () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      })
    ).rejects.toMatchObject({ source: 'open-meteo', kind: 'malformed' });
  });
});
