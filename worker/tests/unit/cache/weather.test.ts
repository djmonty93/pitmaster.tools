import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheKey, fetchForecastCached, utcDayBucket } from '../../../src/lib/cache/weather';
import { openMeteoTwoDays } from '../weather/fixtures';

interface Env {
  WEATHER_KV: KVNamespace;
}

const KV = (env as unknown as Env).WEATHER_KV;

function jsonFetcher(status: number, body: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
}

describe('utcDayBucket', () => {
  it('formats UTC YYYY-MM-DD', () => {
    expect(utcDayBucket(Date.UTC(2026, 4, 14, 23, 59))).toBe('2026-05-14');
    expect(utcDayBucket(Date.UTC(2026, 4, 15, 0, 0))).toBe('2026-05-15');
  });
});

describe('cacheKey', () => {
  it('builds weather:v1:<zip>:<day>', () => {
    expect(cacheKey('20001', '2026-05-14')).toBe('weather:v1:20001:2026-05-14');
  });
});

describe('fetchForecastCached', () => {
  beforeEach(async () => {
    const key = cacheKey('20001', utcDayBucket());
    await KV.delete(key);
  });

  it('writes through to KV on the first call', async () => {
    const fetcher = vi.fn(jsonFetcher(200, openMeteoTwoDays));
    const r = await fetchForecastCached(KV, '20001', 38.9, -77.0, 2, {
      adapter: { openMeteo: { fetcher } },
    });
    expect(r.source).toBe('open-meteo');
    expect(r.days).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Second call within the freshness window — origin should not be hit.
    const fetcher2 = vi.fn(jsonFetcher(200, openMeteoTwoDays));
    const r2 = await fetchForecastCached(KV, '20001', 38.9, -77.0, 2, {
      adapter: { openMeteo: { fetcher: fetcher2 } },
    });
    expect(r2.source).toBe('open-meteo');
    expect(fetcher2).not.toHaveBeenCalled();
  });

  it('falls back to stale on origin failure', async () => {
    // Prime the cache.
    await fetchForecastCached(KV, '20001', 38.9, -77.0, 2, {
      adapter: { openMeteo: { fetcher: jsonFetcher(200, openMeteoTwoDays) } },
    });

    // Now both adapters fail.
    const r = await fetchForecastCached(KV, '20001', 38.9, -77.0, 2, {
      adapter: {
        openMeteo: { fetcher: jsonFetcher(503, {}) },
        nws: { fetcher: jsonFetcher(503, {}) },
      },
      // Force a stale read by pretending lots of time has passed since
      // the prime call wrote.
      cache: { now: () => Date.now() + 60 * 60 * 1000 },
    });
    expect(r.source).toBe('open-meteo'); // cached envelope's source
    expect(r.days).toHaveLength(2);
  });
});
