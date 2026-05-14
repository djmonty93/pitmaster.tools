import { describe, expect, it } from 'vitest';
import { WeatherError } from '../../../src/lib/weather/errors';
import { fetchWithTimeout } from '../../../src/lib/weather/fetchWithTimeout';

describe('fetchWithTimeout', () => {
  it('passes through a successful response', async () => {
    const fetcher = async () => new Response('ok', { status: 200 });
    const res = await fetchWithTimeout('open-meteo', 'https://x.test/', {}, 1000, fetcher);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('throws WeatherError("timeout") when the fetch is aborted', async () => {
    const fetcher = (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    await expect(
      fetchWithTimeout('open-meteo', 'https://x.test/', {}, 20, fetcher)
    ).rejects.toMatchObject({
      name: 'WeatherError',
      source: 'open-meteo',
      kind: 'timeout',
    });
  });

  it('wraps non-abort network errors as WeatherError("network")', async () => {
    const fetcher = async () => {
      throw new TypeError('connection refused');
    };
    await expect(
      fetchWithTimeout('nws', 'https://x.test/', {}, 1000, fetcher)
    ).rejects.toBeInstanceOf(WeatherError);
  });

  it('classifies as timeout even when err.name is the only abort signal', async () => {
    // Some workerd versions surface aborted fetches as a plain object that
    // has `name: "AbortError"` but no `instanceof Error` lineage. Ensure
    // the classifier handles that without falling through to "network".
    const fetcher: typeof fetch = (_url, init) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          // Throw a bare object that won't pass `instanceof Error`.
          reject({ name: 'AbortError', message: 'aborted' });
        });
      });
    await expect(
      fetchWithTimeout('open-meteo', 'https://x.test/', {}, 20, fetcher)
    ).rejects.toMatchObject({ kind: 'timeout' });
  });
});
