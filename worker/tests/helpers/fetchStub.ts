// Tiny `fetch` stub that routes calls by URL substring. Handler tests
// share a single stub across the geocoder, weather adapter, and
// Sender.net client because all three use the workerd `fetch` global
// through the same lazy-binding pattern. Per test we just register
// what URL substrings match which `Response` to return.

import { vi } from 'vitest';

export interface ScriptedHit {
  /** Substring match against the request URL. */
  match: string;
  /** Response factory; called each time the URL matches. */
  respond: () => Response | Promise<Response>;
}

export interface FetchStub {
  /** Captured calls in order, with method + url + parsed body (if JSON). */
  calls: Array<{ url: string; method: string; body?: unknown; headers: Record<string, string> }>;
  /** Restore the original fetch. */
  restore: () => void;
}

export function installFetchStub(script: ScriptedHit[]): FetchStub {
  const calls: FetchStub['calls'] = [];
  const stub: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k] = h[k] as string;
    }
    let body: unknown;
    if (init?.body !== undefined && typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch (_err) {
        body = init.body;
      }
    }
    calls.push({ url, method: (init?.method ?? 'GET') as string, body, headers });
    for (const hit of script) {
      if (url.includes(hit.match)) return hit.respond();
    }
    throw new Error(`fetchStub: no script matched ${url}`);
  };
  vi.stubGlobal('fetch', stub);
  return {
    calls,
    restore: () => vi.unstubAllGlobals(),
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
