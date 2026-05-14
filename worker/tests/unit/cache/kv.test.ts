import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cachedFetch, kvGet, kvPut } from '../../../src/lib/cache/kv';

interface Env {
  WEATHER_KV: KVNamespace;
}

const KV = (env as unknown as Env).WEATHER_KV;
const KEY = 'test:cache:k';

describe('kv cache', () => {
  beforeEach(async () => {
    // Per-test KV reset is handled by vitest-pool-workers' isolated
    // storage. Manually delete the key just in case.
    await KV.delete(KEY);
  });

  it('kvGet returns miss when the key is absent', async () => {
    const got = await kvGet<number>(KV, KEY, { freshSeconds: 60, staleSeconds: 600 });
    expect(got.status).toBe('miss');
    expect(got.value).toBeUndefined();
  });

  it('kvPut + kvGet returns hit within the freshness window', async () => {
    const now = 1_700_000_000_000;
    await kvPut(KV, KEY, 42, { freshSeconds: 60, staleSeconds: 600, now: () => now });
    const got = await kvGet<number>(KV, KEY, {
      freshSeconds: 60,
      staleSeconds: 600,
      now: () => now + 30 * 1000,
    });
    expect(got.status).toBe('hit');
    expect(got.value).toBe(42);
  });

  it('kvGet returns stale once the freshness window has passed', async () => {
    const now = 1_700_000_000_000;
    await kvPut(KV, KEY, 'cached', { freshSeconds: 60, staleSeconds: 600, now: () => now });
    const got = await kvGet<string>(KV, KEY, {
      freshSeconds: 60,
      staleSeconds: 600,
      now: () => now + 5 * 60 * 1000, // 5 minutes later
    });
    expect(got.status).toBe('stale');
    expect(got.value).toBe('cached');
  });
});

describe('cachedFetch', () => {
  beforeEach(async () => {
    await KV.delete(KEY);
  });

  it('hit: serves from cache without calling origin', async () => {
    const now = 1_700_000_000_000;
    await kvPut(KV, KEY, 'cached-payload', {
      freshSeconds: 60,
      staleSeconds: 600,
      now: () => now,
    });
    const origin = vi.fn().mockResolvedValue('origin-payload');
    const v = await cachedFetch(KV, KEY, origin, {
      freshSeconds: 60,
      staleSeconds: 600,
      now: () => now + 30 * 1000,
    });
    expect(v).toBe('cached-payload');
    expect(origin).not.toHaveBeenCalled();
  });

  it('miss: calls origin and writes result back to KV', async () => {
    const now = 1_700_000_000_000;
    const origin = vi.fn().mockResolvedValue('fresh');
    const outcomes: string[] = [];
    const v = await cachedFetch(KV, KEY, origin, {
      freshSeconds: 60,
      staleSeconds: 600,
      now: () => now,
      onResult: ({ status }) => outcomes.push(status),
    });
    expect(v).toBe('fresh');
    expect(origin).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual(['origin']);
    const followup = await kvGet<string>(KV, KEY, {
      freshSeconds: 60,
      staleSeconds: 600,
      now: () => now + 30 * 1000,
    });
    expect(followup.status).toBe('hit');
    expect(followup.value).toBe('fresh');
  });

  it('stale-while-error: returns stale value when origin fails', async () => {
    const now = 1_700_000_000_000;
    await kvPut(KV, KEY, 'cached', {
      freshSeconds: 60,
      staleSeconds: 600,
      now: () => now,
    });
    const origin = vi.fn().mockRejectedValue(new Error('upstream down'));
    const outcomes: string[] = [];
    const v = await cachedFetch(KV, KEY, origin, {
      freshSeconds: 60,
      staleSeconds: 600,
      now: () => now + 5 * 60 * 1000, // stale window
      onResult: ({ status }) => outcomes.push(status),
    });
    expect(v).toBe('cached');
    expect(outcomes).toEqual(['stale-while-error']);
  });

  it('class-instance values lose their prototype across the JSON round-trip', async () => {
    // Pin the JSON round-trip caveat documented in kv.ts: prototype
    // methods and getters do not survive. Real workloads only cache
    // success payloads, so this is informational, but the test catches
    // a regression that would silently break a future code path that
    // tried to put real WeatherError instances through the cache.
    class FakeWeatherError {
      source = 'open-meteo';
      kind = 'http_5xx';
      get isRecoverable(): boolean {
        return true;
      }
      describe(): string {
        return `${this.source}/${this.kind}`;
      }
    }
    const attempt = new FakeWeatherError();
    expect(attempt.isRecoverable).toBe(true);
    expect(attempt.describe()).toBe('open-meteo/http_5xx');

    await kvPut(KV, KEY, { attempts: [attempt] }, { freshSeconds: 60, staleSeconds: 600 });
    const got = await kvGet<{ attempts: unknown[] }>(KV, KEY, {
      freshSeconds: 60,
      staleSeconds: 600,
    });
    expect(got.status).toBe('hit');
    const rehydrated = (got.value as { attempts: unknown[] }).attempts[0] as Record<string, unknown>;
    // Own data properties survive.
    expect(rehydrated['source']).toBe('open-meteo');
    expect(rehydrated['kind']).toBe('http_5xx');
    // Prototype-only methods and getters DON'T — that's the property we're pinning.
    expect(rehydrated['isRecoverable']).toBeUndefined();
    expect(typeof rehydrated['describe']).toBe('undefined');
  });

  it('propagates origin error when no cached value is available', async () => {
    const origin = vi.fn().mockRejectedValue(new Error('nope'));
    await expect(
      cachedFetch(KV, KEY, origin, { freshSeconds: 60, staleSeconds: 600 })
    ).rejects.toThrow('nope');
  });

  it('telemetry redacts common secret-shaped substrings from errorSummary', async () => {
    const origin = vi
      .fn()
      .mockRejectedValue(
        Object.assign(
          new Error(
            'upstream 500: Authorization: Bearer sk-do-not-leak-1234 token=abc123 sk-private-9999'
          ),
          { name: 'WeatherError' }
        )
      );
    const captured: Array<{ status: string; errorSummary?: string }> = [];
    await expect(
      cachedFetch(KV, KEY, origin, {
        freshSeconds: 60,
        staleSeconds: 600,
        onResult: (outcome) =>
          captured.push({ status: outcome.status, errorSummary: outcome.errorSummary }),
      })
    ).rejects.toBeDefined();
    const last = captured[captured.length - 1];
    expect(last?.errorSummary).toMatch(/^WeatherError: /);
    // None of the secret payloads should make it through.
    expect(last?.errorSummary).not.toContain('sk-do-not-leak');
    expect(last?.errorSummary).not.toContain('sk-private-9999');
    expect(last?.errorSummary).not.toMatch(/Bearer [a-z]/i);
    expect(last?.errorSummary).not.toMatch(/token=[a-z0-9]+/i);
    // The outcome itself carries no raw error blob.
    expect(last).not.toHaveProperty('error');
  });
});
