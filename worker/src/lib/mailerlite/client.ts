// MailerLite Connect API client.
//
// Endpoints used (https://developers.mailerlite.com):
//   POST  /api/subscribers           — upsert by email (idempotent server-side)
//   PUT   /api/subscribers/:email    — update status (unsubscribe path)
//
// Send path: NOT in Step 6. The plan's Step 11 (Friday cron) owns the
// campaign send because MailerLite's send endpoint is bound to the
// campaign object's pre-attached groups/segments, not to a per-call
// filter — designing that shape belongs with the cron that actually
// uses it. The retry-queue schema (mailerlite_retry.request_kind CHECK
// IN ('subscribe','unsubscribe','send')) already reserves the 'send'
// slot, so adding sendCampaign in Step 11 is a code-only addition.
//
// Design notes:
// - All HTTP work funnels through `request()`, which wraps fetch with a
//   timeout (matching lib/weather/fetchWithTimeout) and maps every
//   failure mode to a MailerLiteError. 4xx errors carry the status
//   code only — the response body can echo the email the caller sent
//   us, which would land in `mailerlite_retry.last_error` if we
//   propagated it. Status alone is enough for diagnostics; richer
//   detail belongs in /api/status (Step 17) via structured events.
// - Every MailerLiteError.message is run through `redactSecrets` so a
//   stray `Authorization: Bearer …` or `token=…` in a workerd fetch
//   error never reaches D1.
// - The `Idempotency-Key` header carries a SHA-256 hash of the
//   lowercased email (or the campaign + filter key for sends). The
//   server-side semantics of this header on MailerLite Connect are
//   not strongly documented; we send it as a hash because (a) it
//   collapses concurrent retries on the same logical action without
//   leaking PII through proxy logs, and (b) the same key is reused by
//   retry.ts so a queued replay collides with the original at our
//   own D1 layer regardless of server behavior.

import type { Cooker, Cut } from '@shared/types';
import { redactSecrets } from '../redact.js';
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

export interface MailerLiteClient {
  subscribe(input: SubscribeInput): Promise<SubscribeResult>;
  unsubscribe(input: UnsubscribeInput): Promise<void>;
}

const DEFAULT_BASE_URL = 'https://connect.mailerlite.com';
const DEFAULT_TIMEOUT_MS = 8000;

interface JsonRequestInit {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'GET';
  path: string;
  body?: unknown;
  /** Pre-hashed idempotency key, ready for the header. */
  idempotencyKey?: string;
}

export function createMailerLiteClient(opts: MailerLiteClientOptions): MailerLiteClient {
  // Capture fetch in a wrapper so it's bound at call time rather than
  // module-eval time — workerd attaches per-request semantics to
  // `fetch` and a static reference can subtly misbehave across
  // execution contexts.
  const fetcher: Fetcher =
    opts.fetcher ?? ((input, init) => fetch(input as Parameters<typeof fetch>[0], init));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  if (!opts.apiKey || /\s/.test(opts.apiKey)) {
    // Reject whitespace eagerly: a stray newline in the secret would
    // get injected into the Authorization header and corrupt the
    // request preamble. Better to fail at construction than at runtime.
    throw new TypeError('createMailerLiteClient: apiKey is required and must not contain whitespace');
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
        throw makeError(kind, 'timeout', `> ${timeoutMs}ms`);
      }
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String(err.message)
          : 'fetch failed';
      throw makeError(kind, 'network', message);
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 500 && res.status < 600) {
      throw makeError(kind, 'http_5xx', `status ${res.status}`, res.status);
    }
    if (res.status >= 400) {
      // Status code only — never the body. MailerLite 4xx bodies can
      // echo the subscriber email back to the caller, and this error
      // message lands in mailerlite_retry.last_error on retry-queue
      // enqueue. Operators who need the body should consult MailerLite
      // logs directly (Step 17 status surface, not D1).
      throw makeError(kind, 'http_4xx', `status ${res.status}`, res.status);
    }

    if (res.status === 204) return undefined as T;

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (_err) {
      throw makeError(kind, 'malformed', `non-JSON body on ${res.status}`);
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
      const idempotencyKey = await hashKey('subscribe', input.email.toLowerCase());
      const json = await request<{ data: SubscribeResult }>('subscribe', {
        method: 'POST',
        path: '/api/subscribers',
        body,
        idempotencyKey,
      });
      // MailerLite responses wrap the resource in `{ data: ... }`. Be
      // forgiving if the shape ever flattens (older API or sandbox).
      const data = (json as { data?: SubscribeResult }).data ?? (json as unknown as SubscribeResult);
      if (!data || typeof data.id !== 'string') {
        throw makeError('subscribe', 'malformed', 'missing data.id in response');
      }
      return data;
    },

    async unsubscribe(input) {
      assertEmail(input.email);
      // PUT /api/subscribers/:email with status=unsubscribed is the
      // idempotent path; DELETE actually purges the subscriber and
      // forfeits historical analytics, which is the wrong default.
      const idempotencyKey = await hashKey('unsubscribe', input.email.toLowerCase());
      await request<unknown>('unsubscribe', {
        method: 'PUT',
        path: `/api/subscribers/${encodeURIComponent(input.email)}`,
        body: { status: 'unsubscribed' },
        idempotencyKey,
      });
    },
  };
}

/**
 * SHA-256 of `${kind}:${value}` truncated to 32 hex chars (128 bits).
 * Used as the Idempotency-Key header — short enough to fit in
 * Cloudflare's egress headers without truncation, long enough that
 * collision probability is negligible across our subscriber volume.
 * Exported only for the retry-queue's enqueue path so it can recompute
 * the same key without re-importing crypto primitives.
 */
export async function hashKey(kind: MailerLiteRequestKind, value: string): Promise<string> {
  const data = new TextEncoder().encode(`${kind}:${value}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 16; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return `${kind}:${hex}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function assertEmail(email: string): void {
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    throw new TypeError(`Invalid email format`);
  }
}

function makeError(
  kind: MailerLiteRequestKind,
  errorKind: MailerLiteError['kind'],
  message: string,
  status?: number
): MailerLiteError {
  return new MailerLiteError(kind, errorKind, redactSecrets(message), status);
}
