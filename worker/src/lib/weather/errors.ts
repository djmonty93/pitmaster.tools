// Error taxonomy for the weather adapter. Each subclass signals a
// distinct *recoverable* failure mode that the adapter should fail over
// on; anything else (TypeError, etc.) is non-recoverable and re-thrown
// to the worker's top-level handler.

export type WeatherSource = 'open-meteo' | 'nws';

/**
 * 4xx status codes that should still trigger fail-over to the next provider.
 *
 * Most 4xx (400 bad request, 404 unknown grid, 422 unprocessable, …) signal
 * caller-side problems that won't be helped by retrying; we propagate them.
 * The exceptions are status codes that describe a *provider-side* condition
 * the next source might not share:
 *   - 408 Request Timeout: provider-internal slowness
 *   - 425 Too Early: provider replay protection
 *   - 429 Too Many Requests: rate limit, almost always provider-specific
 */
const RECOVERABLE_4XX = new Set([408, 425, 429]);

export type WeatherErrorKind =
  | 'http_5xx'
  | 'http_4xx'
  | 'timeout'
  | 'malformed'
  | 'network'
  | 'all_failed'; // every source returned a recoverable error in turn

export class WeatherError extends Error {
  constructor(
    public readonly source: WeatherSource,
    public readonly kind: WeatherErrorKind,
    message: string,
    /** Underlying HTTP status, when kind is http_4xx or http_5xx. */
    public readonly status?: number,
    /** Per-source errors collected before this one, in order. */
    public readonly attempts: WeatherError[] = []
  ) {
    super(`${source}: ${kind}${status !== undefined ? ` (${status})` : ''}: ${message}`);
    this.name = 'WeatherError';
  }

  /** True if the adapter should try the next source on this error. */
  get isRecoverable(): boolean {
    if (this.kind === 'all_failed') return false; // already tried everything
    if (this.kind !== 'http_4xx') return true;
    return this.status !== undefined && RECOVERABLE_4XX.has(this.status);
  }
}
