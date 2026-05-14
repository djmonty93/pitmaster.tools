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
});
