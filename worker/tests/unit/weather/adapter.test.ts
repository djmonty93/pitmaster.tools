import { describe, expect, it } from 'vitest';
import { fetchForecast } from '../../../src/lib/weather/adapter';
import { WeatherError } from '../../../src/lib/weather/errors';
import { nwsHourlyTwoDays, nwsPoints, openMeteoTwoDays } from './fixtures';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function scriptedFetcher(script: Array<(url: string) => Response | Promise<Response>>): typeof fetch {
  let i = 0;
  return async (input: string | URL | Request) => {
    const step = script[i++];
    if (!step) throw new Error(`scriptedFetcher exhausted after ${script.length} calls`);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return step(url);
  };
}

describe('weather adapter failover', () => {
  it('returns Open-Meteo days on success and does not call NWS', async () => {
    let nwsCalls = 0;
    const fetcher = scriptedFetcher([
      (url) => {
        expect(url).toContain('open-meteo');
        return jsonResponse(200, openMeteoTwoDays);
      },
      () => {
        nwsCalls++;
        return jsonResponse(500, {});
      },
    ]);
    const result = await fetchForecast(40.7, -74.0, 2, {
      openMeteo: { fetcher },
      nws: { fetcher },
    });
    expect(result.source).toBe('open-meteo');
    expect(result.days).toHaveLength(2);
    expect(result.attempts).toHaveLength(0);
    expect(nwsCalls).toBe(0);
  });

  it('falls over to NWS when Open-Meteo returns 503', async () => {
    const openMeteoFetcher = scriptedFetcher([() => jsonResponse(503, {})]);
    const nwsFetcher = scriptedFetcher([
      () => jsonResponse(200, nwsPoints),
      () => jsonResponse(200, nwsHourlyTwoDays),
    ]);
    const result = await fetchForecast(39.1, -94.6, 2, {
      openMeteo: { fetcher: openMeteoFetcher },
      nws: { fetcher: nwsFetcher },
    });
    expect(result.source).toBe('nws');
    expect(result.days).toHaveLength(2);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.kind).toBe('http_5xx');
  });

  it('falls over to NWS when Open-Meteo returns malformed JSON', async () => {
    const openMeteoFetcher = scriptedFetcher([() => jsonResponse(200, { wrong: 'shape' })]);
    const nwsFetcher = scriptedFetcher([
      () => jsonResponse(200, nwsPoints),
      () => jsonResponse(200, nwsHourlyTwoDays),
    ]);
    const result = await fetchForecast(39.1, -94.6, 2, {
      openMeteo: { fetcher: openMeteoFetcher },
      nws: { fetcher: nwsFetcher },
    });
    expect(result.source).toBe('nws');
    expect(result.attempts[0]?.kind).toBe('malformed');
  });

  it('falls over to NWS when Open-Meteo times out', async () => {
    const openMeteoFetcher: typeof fetch = (_url, init) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    const nwsFetcher = scriptedFetcher([
      () => jsonResponse(200, nwsPoints),
      () => jsonResponse(200, nwsHourlyTwoDays),
    ]);
    const result = await fetchForecast(39.1, -94.6, 2, {
      openMeteo: { fetcher: openMeteoFetcher, timeoutMs: 20 },
      nws: { fetcher: nwsFetcher },
    });
    expect(result.source).toBe('nws');
    expect(result.attempts[0]?.kind).toBe('timeout');
  });

  it('does NOT fail over on a 4xx — propagates as caller error', async () => {
    const openMeteoFetcher = scriptedFetcher([() => jsonResponse(400, {})]);
    let nwsCalls = 0;
    const nwsFetcher: typeof fetch = async () => {
      nwsCalls++;
      return jsonResponse(200, {});
    };
    await expect(
      fetchForecast(39.1, -94.6, 2, {
        openMeteo: { fetcher: openMeteoFetcher },
        nws: { fetcher: nwsFetcher },
      })
    ).rejects.toMatchObject({ source: 'open-meteo', kind: 'http_4xx' });
    expect(nwsCalls).toBe(0);
  });

  it('throws when both sources fail and surfaces both attempts', async () => {
    const openMeteoFetcher = scriptedFetcher([() => jsonResponse(503, {})]);
    const nwsFetcher = scriptedFetcher([() => jsonResponse(503, {})]);
    try {
      await fetchForecast(39.1, -94.6, 2, {
        openMeteo: { fetcher: openMeteoFetcher },
        nws: { fetcher: nwsFetcher },
      });
      expect.fail('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WeatherError);
      expect((err as WeatherError).message).toContain('all sources failed');
      expect((err as WeatherError).message).toContain('open-meteo');
      expect((err as WeatherError).message).toContain('nws');
    }
  });
});
