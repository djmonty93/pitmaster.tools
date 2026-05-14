// MailerLite Connect API client.
//
// Endpoints used (https://developers.mailerlite.com):
//   POST  /api/subscribers           — upsert by email (idempotent)
//   PUT   /api/subscribers/:email    — update status (unsubscribe path)
//   POST  /api/campaigns/.../send    — Friday cron send (Step 11)
//
// Design notes:
// - All HTTP work funnels through `request()`, which wraps fetch with a
//   timeout (matching lib/weather/fetchWithTimeout) and maps every
//   failure mode to a MailerLiteError so the caller can branch on
//   `.shouldRetry`. Successful 2xx responses with malformed JSON are
//   surfaced as MailerLiteError('malformed') rather than crashing the
//   request handler — empirically MailerLite returns HTML on 502 from
//   their CDN, and a malformed payload from a 2xx is almost always a
//   shape change we want to learn about, not a retry candidate.
// - `apiKey` is required at construction; the client never reads from
//   `env` directly so the same factory works for unit tests, the
//   per-request handler in worker/src/handlers, and the cron drain.
// - `fetcher` is dependency-injected. Production code lets it default
//   to the workerd `fetch` global; tests pass a scripted fetcher to
//   pin exact request/response sequences.

import type { Cooker, Cut } from '@shared/types';
import { MailerLiteError, type MailerLiteRequestKind } from './errors.js';
import { toSubscriberFields } from './tags.js';

export type Fetcher = typeof fetch;

export interface MailerLiteClientOptions {
  apiKey: string;
  fetcher?: Fetcher;
  /** Per-call request timeout. Defaults to 8s — MailerLite p99 is ~3s. */
  timeoutMs?: number;
  /** Override for tests / staging. */
  baseUrl?: string;
}

export interface SubscribeInput {
  email: string;
  metroSlug?: string | null;
  cut?: Cut | null;
  cooker?: Cooker | null;
  /** ISO timezone, stored as a custom field for the Friday-cron tz gate. */
  timezone?: string | null;
}

export interface SubscribeResult {
  /** MailerLite-assigned subscriber ID. */
  id: string;
  email: string;
  status: 'active' | 'unsubscribed' | 'unconfirmed' | 'bounced' | 'junk';
}

export interface UnsubscribeInput {
  email: string;
}

export interface SendCampaignInput {
  /** MailerLite campaign ID (configured per-environment in env vars). */
  campaignId: string;
  /** Optional segment filter, e.g. { metro: 'kansas-city-mo' }. */
  filter?: Record<string, string>;
}

export interface MailerLiteClient {
  subscribe(input: SubscribeInput): Promise<SubscribeResult>;
  unsubscribe(input: UnsubscribeInput): Promise<void>;
  sendCampaign(input: SendCampaignInput): Promise<{ campaignId: string }>;
}

const DEFAULT_BASE_URL = 'https://connect.mailerlite.com';
const DEFAULT_TIMEOUT_MS = 8000;

interface JsonRequestInit {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'GET';
  path: string;
  body?: unknown;
  /**
   * MailerLite supports the standard Idempotency-Key header — we pass
   * one on every mutation so a network blip that hides a 2xx response
   * doesn't double-subscribe a user. Same header is reused by the
   * retry-queue replay so the queued attempt collapses with the
   * original on the server side.
   */
  idempotencyKey?: string;
}

export function createMailerLiteClient(opts: MailerLiteClientOptions): MailerLiteClient {
  const fetcher: Fetcher = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  if (!opts.apiKey) {
    throw new TypeError('createMailerLiteClient: apiKey is required');
  }

  async function request<T>(
    kind: MailerLiteRequestKind,
    init: JsonRequestInit
  ): Promise<T> {
    const url = `${baseUrl}${init.path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.apiKey}`,
      Accept: 'application/json',
    };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetcher(url, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: ctrl.signal,
      });
    } catch (err) {
      const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : '';
      if (name === 'AbortError' || ctrl.signal.aborted) {
        throw new MailerLiteError(kind, 'timeout', `> ${timeoutMs}ms`);
      }
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String(err.message)
          : 'fetch failed';
      throw new MailerLiteError(kind, 'network', message);
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 500 && res.status < 600) {
      throw new MailerLiteError(kind, 'http_5xx', `status ${res.status}`, res.status);
    }
    if (res.status >= 400) {
      // Capture a short body excerpt for diagnostics; never log the
      // full body because it can echo back the email address we sent.
      const excerpt = await safeBodyExcerpt(res);
      throw new MailerLiteError(
        kind,
        'http_4xx',
        excerpt ? `status ${res.status}: ${excerpt}` : `status ${res.status}`,
        res.status
      );
    }

    if (res.status === 204) return undefined as T;

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (_err) {
      throw new MailerLiteError(kind, 'malformed', `non-JSON body on ${res.status}`);
    }
    return parsed as T;
  }

  return {
    async subscribe(input) {
      assertEmail(input.email);
      const fields = toSubscriberFields({
        metroSlug: input.metroSlug,
        cut: input.cut,
        cooker: input.cooker,
      });
      const body: Record<string, unknown> = {
        email: input.email,
        status: 'active',
        fields: {
          ...fields,
          ...(input.timezone ? { timezone: input.timezone } : {}),
        },
      };
      const json = await request<{ data: SubscribeResult }>('subscribe', {
        method: 'POST',
        path: '/api/subscribers',
        body,
        idempotencyKey: `subscribe:${input.email.toLowerCase()}`,
      });
      // MailerLite responses wrap the resource in `{ data: ... }`. Be
      // forgiving if the shape ever flattens (older API or sandbox).
      const data = (json as { data?: SubscribeResult }).data ?? (json as unknown as SubscribeResult);
      if (!data || typeof data.id !== 'string') {
        throw new MailerLiteError('subscribe', 'malformed', 'missing data.id in response');
      }
      return data;
    },

    async unsubscribe(input) {
      assertEmail(input.email);
      // PUT /api/subscribers/:email with status=unsubscribed is the
      // idempotent path; DELETE actually purges the subscriber and
      // forfeits historical analytics, which is the wrong default.
      await request<unknown>('unsubscribe', {
        method: 'PUT',
        path: `/api/subscribers/${encodeURIComponent(input.email)}`,
        body: { status: 'unsubscribed' },
        idempotencyKey: `unsubscribe:${input.email.toLowerCase()}`,
      });
    },

    async sendCampaign(input) {
      const body: Record<string, unknown> = {};
      if (input.filter) body.filter = input.filter;
      await request<unknown>('send', {
        method: 'POST',
        path: `/api/campaigns/${encodeURIComponent(input.campaignId)}/actions/send`,
        body,
        idempotencyKey: `send:${input.campaignId}:${stableFilterKey(input.filter)}`,
      });
      return { campaignId: input.campaignId };
    },
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function assertEmail(email: string): void {
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    throw new TypeError(`Invalid email ${JSON.stringify(email)}`);
  }
}

function stableFilterKey(filter?: Record<string, string>): string {
  if (!filter) return 'all';
  return Object.keys(filter)
    .sort()
    .map((k) => `${k}=${filter[k]}`)
    .join('&');
}

async function safeBodyExcerpt(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.replace(/\s+/g, ' ').trim().slice(0, 120);
  } catch (_err) {
    return '';
  }
}
