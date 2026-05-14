// Error taxonomy for the MailerLite client. The shape mirrors
// lib/weather/errors.ts so callers (Step 7's /api/subscribe handler,
// Step 11's Friday cron) can branch on the same `shouldRetry` rule
// across both clients.
//
// A request is *retryable* if the failure looks transient on the
// provider side: 5xx, timeout, network error. 4xx is treated as
// caller-side (bad email, malformed payload, revoked API key) and is
// not enqueued — the retry queue would just replay the same failure
// forever. 429 (rate limit) IS retryable since MailerLite's free tier
// caps at ~120 req/min and bursts on Friday-cron will hit it.

export type MailerLiteRequestKind = 'subscribe' | 'unsubscribe' | 'send';

export type MailerLiteErrorKind =
  | 'http_5xx'
  | 'http_4xx'
  | 'timeout'
  | 'malformed'
  | 'network';

/** 4xx codes that should still trigger a retry-queue enqueue. */
const RETRYABLE_4XX = new Set([408, 425, 429]);

export class MailerLiteError extends Error {
  constructor(
    public readonly requestKind: MailerLiteRequestKind,
    public readonly kind: MailerLiteErrorKind,
    message: string,
    /** Underlying HTTP status, when kind is http_4xx or http_5xx. */
    public readonly status?: number
  ) {
    super(
      `mailerlite ${requestKind}: ${kind}${status !== undefined ? ` (${status})` : ''}: ${message}`
    );
    this.name = 'MailerLiteError';
  }

  /** True if the call should be enqueued on mailerlite_retry. */
  get shouldRetry(): boolean {
    if (this.kind === 'http_4xx') {
      return this.status !== undefined && RETRYABLE_4XX.has(this.status);
    }
    return this.kind !== 'malformed';
  }
}
