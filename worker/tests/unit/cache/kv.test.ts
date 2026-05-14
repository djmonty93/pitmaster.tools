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

  it('propagates origin error when no cached value is available', async () => {
    const origin = vi.fn().mockRejectedValue(new Error('nope'));
    await expect(
      cachedFetch(KV, KEY, origin, { freshSeconds: 60, staleSeconds: 600 })
    ).rejects.toThrow('nope');
  });
});
