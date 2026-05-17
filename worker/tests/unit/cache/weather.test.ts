import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheKey, etDayBucket, fetchForecastCached, previousEtDate } from '../../../src/lib/cache/weather';
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
    // 04:59 UTC = 23:59 EST on the 7th — the last second of the 7th in ET.
    expect(etDayBucket(Date.UTC(2026, 2, 8, 4, 59))).toBe('2026-03-07');
    // 05:00 UTC = 00:00 EST on the 8th — the first moment of the 8th.
    expect(etDayBucket(Date.UTC(2026, 2, 8, 5, 0))).toBe('2026-03-08');
    // 06:30 UTC = 01:30 EST on the 8th (before jump) — still the 8th.
    expect(etDayBucket(Date.UTC(2026, 2, 8, 6, 30))).toBe('2026-03-08');
    // 06:59 UTC = 01:59 EST (last second pre-jump) — still the 8th.
    expect(etDayBucket(Date.UTC(2026, 2, 8, 6, 59))).toBe('2026-03-08');
    // 07:30 UTC corresponds to the wall-clock window the spring-forward
    // jump erases (02:00-02:59 ET doesn't exist; the clock skips
    // straight to 03:00 EDT). ICU resolves this UTC instant to
    // 03:30 EDT — a valid local time, still 2026-03-08 in ET. The
    // crucial property for the cache bucket is the date, not which
    // local hour the instant happens to land in.
    expect(etDayBucket(Date.UTC(2026, 2, 8, 7, 30))).toBe('2026-03-08');
    // 08:00 UTC = 04:00 EDT (well after the jump) — still the 8th.
    expect(etDayBucket(Date.UTC(2026, 2, 8, 8, 0))).toBe('2026-03-08');
  });

  it('handles DST fall-back (2026-11-01 02:00 EDT → 01:00 EST)', () => {
    // 04:30 UTC = 00:30 EDT — first 00:xx on Nov 1, the 1st.
    expect(etDayBucket(Date.UTC(2026, 10, 1, 4, 30))).toBe('2026-11-01');
    // 05:30 UTC = 01:30 EDT — FIRST occurrence of 01:30 on Nov 1
    // (the pre-fallback EDT window, before the wall clock falls back
    // to EST at 02:00 EDT).
    expect(etDayBucket(Date.UTC(2026, 10, 1, 5, 30))).toBe('2026-11-01');
    // 06:30 UTC = 01:30 EST — SECOND occurrence of 01:30 on Nov 1,
    // immediately after the wall clock has fallen back. Same local
    // label as the previous assertion but distinct UTC moment; still
    // the 1st in ET either way, which is what the cache key needs.
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

describe('previousEtDate', () => {
  it('subtracts one calendar day inside a single month', () => {
    expect(previousEtDate('2026-05-15')).toBe('2026-05-14');
  });

  it('crosses month boundaries correctly', () => {
    expect(previousEtDate('2026-06-01')).toBe('2026-05-31');
    expect(previousEtDate('2026-03-01')).toBe('2026-02-28');
    expect(previousEtDate('2024-03-01')).toBe('2024-02-29'); // leap year
  });

  it('crosses year boundaries correctly', () => {
    expect(previousEtDate('2027-01-01')).toBe('2026-12-31');
  });

  it('returns the correct prior ET day across spring-forward', () => {
    // Asking for "yesterday" of the day-after-spring-forward
    // (2026-03-09) must return 2026-03-08, NOT 2026-03-07. The naive
    // (Date.now() - 86_400_000) approach skips March 8 entirely when
    // called from the EDT half of March 9, because 24 raw UTC hours
    // back lands at 23:30 EST on March 7 (since EST is one hour later
    // in UTC than EDT). previousEtDate does calendar arithmetic on
    // the bucket string so it stays correct.
    expect(previousEtDate('2026-03-09')).toBe('2026-03-08');
    expect(previousEtDate('2026-03-08')).toBe('2026-03-07');
  });

  it('throws on malformed input', () => {
    expect(() => previousEtDate('not-a-date')).toThrow(/expected YYYY-MM-DD/);
    expect(() => previousEtDate('2026-5-15')).toThrow(/expected YYYY-MM-DD/);
    expect(() => previousEtDate('')).toThrow(/expected YYYY-MM-DD/);
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
