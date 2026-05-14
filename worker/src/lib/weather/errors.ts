// Error taxonomy for the weather adapter. Each subclass signals a
// distinct *recoverable* failure mode that the adapter should fail over
// on; anything else (TypeError, etc.) is non-recoverable and re-thrown
// to the worker's top-level handler.

export type WeatherSource = 'open-meteo' | 'nws';

export class WeatherError extends Error {
  constructor(
    public readonly source: WeatherSource,
    public readonly kind: 'http_5xx' | 'http_4xx' | 'timeout' | 'malformed' | 'network',
    message: string
  ) {
    super(`${source}: ${kind}: ${message}`);
    this.name = 'WeatherError';
  }

  /** True if the adapter should try the next source on this error. */
  get isRecoverable(): boolean {
    // 4xx errors propagate (caller passed a bad lat/lon, more requests
    // won't help); everything else means we should try the next source.
    return this.kind !== 'http_4xx';
  }
}
