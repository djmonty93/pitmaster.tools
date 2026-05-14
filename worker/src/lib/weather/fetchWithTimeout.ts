// Aborts fetch after `timeoutMs` and surfaces the abort as a
// WeatherError('timeout') so the adapter can fail over deterministically.
//
// `fetcher` is dependency-injected so unit tests can stub network calls
// without monkey-patching the global. Production code passes nothing and
// the workerd `fetch` global is used.

import { WeatherError, type WeatherSource } from './errors.js';

export type Fetcher = typeof fetch;

export async function fetchWithTimeout(
  source: WeatherSource,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetcher: Fetcher = fetch
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new WeatherError(source, 'timeout', `> ${timeoutMs}ms`);
    }
    throw new WeatherError(source, 'network', err instanceof Error ? err.message : 'fetch failed');
  } finally {
    clearTimeout(timer);
  }
}
