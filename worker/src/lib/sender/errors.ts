// errors.ts
//
// Error taxonomy for the Sender.net client. Mirrors lib/weather/errors.ts
// so the /api/subscribe handler and the Friday cron can branch on the
// same `shouldRetry` rule across clients.

export type SenderRequestKind =
  | 'subscribe'
  | 'unsubscribe'
  | 'digest_trigger'
  | 'campaign_create'
  | 'campaign_send'
  | 'group_assign'
  | 'group_remove'
  | 'group_list'
  | 'field_update';

export type SenderErrorKind =
  | 'http_5xx'
  | 'http_4xx'
  | 'timeout'
  | 'malformed'
  | 'network';

/** 4xx codes that should still trigger a retry-queue enqueue. */
const RETRYABLE_4XX = new Set([408, 425, 429]);

export class SenderError extends Error {
  constructor(
    public readonly requestKind: SenderRequestKind,
    public readonly kind: SenderErrorKind,
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number
  ) {
    super(
      `sender ${requestKind}: ${kind}${status !== undefined ? ` (${status})` : ''}: ${message}`
    );
    this.name = 'SenderError';
  }

  /** True if the call should be enqueued on sender_retry. */
  get shouldRetry(): boolean {
    if (this.kind === 'http_4xx') {
      return this.status !== undefined && RETRYABLE_4XX.has(this.status);
    }
    return this.kind !== 'malformed';
  }
}
