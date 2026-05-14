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
    // workerd does not always preserve class identity for errors thrown
    // across the fetch boundary, so check the name + AbortSignal state
    // separately instead of `err instanceof DOMException`.
    const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : '';
    if (name === 'AbortError' || ctrl.signal.aborted) {
      throw new WeatherError(source, 'timeout', `> ${timeoutMs}ms`);
    }
    const message = err && typeof err === 'object' && 'message' in err ? String(err.message) : 'fetch failed';
    throw new WeatherError(source, 'network', message);
  } finally {
    clearTimeout(timer);
  }
}
