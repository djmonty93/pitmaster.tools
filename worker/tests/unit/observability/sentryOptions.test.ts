import { describe, expect, it } from 'vitest';
import { buildSentryOptions } from '../../../src/lib/observability/sentryOptions';

describe('buildSentryOptions (F21)', () => {
  it('disables Sentry when SENTRY_DSN is unset — dev / test never ships events', () => {
    const opts = buildSentryOptions({});
    expect(opts.enabled).toBe(false);
    expect(opts.dsn).toBe('');
  });

  it('disables Sentry when SENTRY_DSN is an empty string', () => {
    const opts = buildSentryOptions({ SENTRY_DSN: '' });
    expect(opts.enabled).toBe(false);
  });

  it('enables Sentry when SENTRY_DSN is provided', () => {
    const opts = buildSentryOptions({
      SENTRY_DSN: 'https://abcd1234@o42.ingest.sentry.io/1',
    });
    expect(opts.enabled).toBe(true);
    expect(opts.dsn).toBe('https://abcd1234@o42.ingest.sentry.io/1');
  });

  it('defaults environment to "production" when SENTRY_ENVIRONMENT is unset', () => {
    const opts = buildSentryOptions({ SENTRY_DSN: 'https://x@o1.ingest.sentry.io/1' });
    expect(opts.environment).toBe('production');
  });

  it('honors SENTRY_ENVIRONMENT override for staging/preview', () => {
    const opts = buildSentryOptions({
      SENTRY_DSN: 'https://x@o1.ingest.sentry.io/1',
      SENTRY_ENVIRONMENT: 'preview',
    });
    expect(opts.environment).toBe('preview');
  });

  it('uses a fixed 10% traces sample rate (hobby-tier compromise)', () => {
    // Pinning the value catches an accidental "set to 1.0 for debugging
    // and never reverted" landing in a production PR.
    const opts = buildSentryOptions({ SENTRY_DSN: 'https://x@o1.ingest.sentry.io/1' });
    expect(opts.tracesSampleRate).toBe(0.1);
  });
});
