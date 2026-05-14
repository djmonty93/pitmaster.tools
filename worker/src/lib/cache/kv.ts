// Generic KV cache wrapper with stale-while-error semantics.
//
// The cached value is stored alongside a metadata blob (writtenAt + ttl);
// reads classify the entry as fresh, stale, or absent and emit a small
// telemetry summary so callers can observe cache health. On origin
// failure we serve stale data when available — the alternative is a
// full outage when the upstream weather API blinks.
//
// Schema:
//   key        = caller-defined string
//   value      = JSON-encoded { v: <T>, writtenAt: <ms>, ttlSeconds: <number> }
// Stored on KV via put(... { expirationTtl }); the in-payload metadata
// is for stale-while-error classification, the KV-level expirationTtl is
// the eventual eviction.
//
// Constraints callers should be aware of:
// - **Serializability**: values must be JSON-safe. Class instances lose
//   their prototype across a round trip (a cached `WeatherError[]` rehydrates
//   as plain objects without the `isRecoverable` getter). Cache plain
//   data, not behavior. The weather composition only caches success
//   payloads, so this isn't currently an issue, but a follow-up adapter
//   that puts errors into cache must sanitize first.
// - **Eventual consistency**: Cloudflare KV is eventually consistent —
//   a write made by one request may take up to ~60 s to be visible to
//   another colo. Miniflare tests are strongly consistent, which makes
//   them slightly optimistic about cache-hit timing in production. The
//   stale-while-error fallback masks this for the weather use case.

import { summarizeError } from '../redact.js';

export type CacheStatus = 'hit' | 'stale' | 'miss';

export interface CacheGetResult<T> {
  status: CacheStatus;
  value?: T;
  writtenAt?: number;
}

export interface CacheOptions {
  /** Hard freshness window (seconds). Reads inside this window return 'hit'. */
  freshSeconds: number;
  /**
   * Soft retention window (seconds). Reads between freshSeconds and
   * staleSeconds return 'stale'; older reads are evicted (KV's expirationTtl).
   * Must be >= freshSeconds.
   */
  staleSeconds: number;
  /** Override for tests so freshness checks are deterministic. */
  now?: () => number;
}

interface CacheEnvelope<T> {
  v: T;
  writtenAt: number;
  ttlSeconds: number;
}

export async function kvGet<T>(
  kv: KVNamespace,
  key: string,
  opts: CacheOptions
): Promise<CacheGetResult<T>> {
  const raw = await kv.get(key, 'json');
  if (raw === null) return { status: 'miss' };
  const env = raw as CacheEnvelope<T>;
  const now = (opts.now ?? Date.now)();
  const ageSeconds = (now - env.writtenAt) / 1000;
  if (ageSeconds <= opts.freshSeconds) {
    return { status: 'hit', value: env.v, writtenAt: env.writtenAt };
  }
  return { status: 'stale', value: env.v, writtenAt: env.writtenAt };
}

export async function kvPut<T>(
  kv: KVNamespace,
  key: string,
  value: T,
  opts: CacheOptions
): Promise<void> {
  const env: CacheEnvelope<T> = {
    v: value,
    writtenAt: (opts.now ?? Date.now)(),
    ttlSeconds: opts.freshSeconds,
  };
  // KV requires expirationTtl >= 60 seconds.
  const expirationTtl = Math.max(60, Math.ceil(opts.staleSeconds));
  await kv.put(key, JSON.stringify(env), { expirationTtl });
}

export type FetchOriginResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export interface CachedFetchOptions<T> extends CacheOptions {
  /**
   * Hook for callers to log/measure cache outcomes. The `errorSummary`
   * is a redacted one-line description of the underlying error (kind
   * + message tail) — never the raw error, because origin errors can
   * embed request bodies / API tokens that the operator does not want
   * to ship to a telemetry sink. Redaction lives in lib/redact.ts so
   * the same rule applies to MailerLite errors written into D1.
   */
  onResult?: (outcome: {
    status: CacheStatus | 'origin' | 'stale-while-error';
    key: string;
    errorSummary?: string;
  }) => void;
}

/**
 * Read-through cache: fresh hit → return; otherwise call origin and
 * write back. If the origin fails AND we have a stale entry, return
 * the stale value (stale-while-error). If the origin fails AND we have
 * nothing cached, propagate the error.
 */
export async function cachedFetch<T>(
  kv: KVNamespace,
  key: string,
  origin: () => Promise<T>,
  opts: CachedFetchOptions<T>
): Promise<T> {
  const get = await kvGet<T>(kv, key, opts);
  if (get.status === 'hit') {
    opts.onResult?.({ status: 'hit', key });
    return get.value as T;
  }

  try {
    const fresh = await origin();
    opts.onResult?.({ status: 'origin', key });
    await kvPut(kv, key, fresh, opts);
    return fresh;
  } catch (err) {
    if (get.status === 'stale') {
      opts.onResult?.({ status: 'stale-while-error', key, errorSummary: summarizeError(err) });
      return get.value as T;
    }
    opts.onResult?.({ status: 'miss', key, errorSummary: summarizeError(err) });
    throw err;
  }
}
