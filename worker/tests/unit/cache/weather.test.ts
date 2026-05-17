import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheKey, etDayBucket, fetchForecastCached } from '../../../src/lib/cache/weather';
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

describe('etDayBucket', () => {
  it('formats YYYY-MM-DD in America/New_York', () => {
    // 2026-05-15 00:00 UTC = 2026-05-14 20:00 EDT — still the 14th in ET
    expect(etDayBucket(Date.UTC(2026, 4, 15, 0, 0))).toBe('2026-05-14');
    // 2026-05-15 04:00 UTC = 2026-05-15 00:00 EDT — rolls to 15th
    expect(etDayBucket(Date.UTC(2026, 4, 15, 4, 0))).toBe('2026-05-15');
  });

  it('handles DST spring-forward (2026-03-08 02:00 EST → 03:00 EDT)', () => {
    // 06:30 UTC = 01:30 EST (before jump) — still the 8th in ET
    expect(etDayBucket(Date.UTC(2026, 2, 8, 6, 30))).toBe('2026-03-08');
    // 06:59 UTC = 01:59 EST (last second pre-jump) — still the 8th
    expect(etDayBucket(Date.UTC(2026, 2, 8, 6, 59))).toBe('2026-03-08');
    // 07:00 UTC = 03:00 EDT (wall clock jumps past 02:xx entirely)
    expect(etDayBucket(Date.UTC(2026, 2, 8, 7, 0))).toBe('2026-03-08');
    // 03:59 UTC = 22:59 EST on the 7th — last moment of the 7th in ET
    expect(etDayBucket(Date.UTC(2026, 2, 8, 3, 59))).toBe('2026-03-07');
    // 05:00 UTC = 00:00 EST on the 8th — first moment of the 8th
    expect(etDayBucket(Date.UTC(2026, 2, 8, 5, 0))).toBe('2026-03-08');
  });

  it('handles DST fall-back (2026-11-01 02:00 EDT → 01:00 EST)', () => {
    // 04:30 UTC = 00:30 EDT — first 00:xx on Nov 1, the 1st
    expect(etDayBucket(Date.UTC(2026, 10, 1, 4, 30))).toBe('2026-11-01');
    // 05:30 UTC = 01:30 EDT — second occurrence of 01:30 starts after
    // wall clock falls back; either way still the 1st in ET
    expect(etDayBucket(Date.UTC(2026, 10, 1, 5, 30))).toBe('2026-11-01');
    // 06:30 UTC = 01:30 EST — same wall-clock label but post-fallback
    expect(etDayBucket(Date.UTC(2026, 10, 1, 6, 30))).toBe('2026-11-01');
  });

  it('two distinct UTC times on the same ET day return the same bucket', () => {
    // 2026-07-04 05:00 UTC and 2026-07-05 03:59 UTC both fall on
    // 2026-07-04 in ET (between 01:00 EDT and 23:59 EDT).
    expect(etDayBucket(Date.UTC(2026, 6, 4, 5, 0))).toBe(
      etDayBucket(Date.UTC(2026, 6, 5, 3, 59))
    );
  });
});

describe('cacheKey', () => {
  it('builds weather:v2:<zip>:<day>', () => {
    expect(cacheKey('20001', '2026-05-14')).toBe('weather:v2:20001:2026-05-14');
  });

  it('accepts non-US postal codes within the whitelist', () => {
    expect(cacheKey('K1A-0B1', '2026-05-14')).toBe('weather:v2:K1A-0B1:2026-05-14');
  });

  it('throws on zip with disallowed characters (header / kv-key injection)', () => {
    for (const bad of ['20001 ', '20001\n', '20001:nope', '../../../', '<>$']) {
      expect(() => cacheKey(bad, '2026-05-14')).toThrow(/invalid zip/);
    }
  });

  it('throws on zip longer than 16 characters', () => {
    expect(() => cacheKey('12345678901234567', '2026-05-14')).toThrow(/invalid zip/);
  });
});

describe('fetchForecastCached', () => {
  beforeEach(async () => {
    const key = cacheKey('20001', etDayBucket());
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

    // Now both adapters fail. Force the cache lookup to see the prime
    // entry as stale by pretending 25 hours have passed (fresh window
    // is 24h, stale-while-error window extends to 30h).
    const r = await fetchForecastCached(KV, '20001', 38.9, -77.0, 2, {
      adapter: {
        openMeteo: { fetcher: jsonFetcher(503, {}) },
        nws: { fetcher: jsonFetcher(503, {}) },
      },
      cache: { now: () => Date.now() + 25 * 60 * 60 * 1000 },
    });
    expect(r.source).toBe('open-meteo'); // cached envelope's source
    expect(r.days).toHaveLength(2);
  });
});
