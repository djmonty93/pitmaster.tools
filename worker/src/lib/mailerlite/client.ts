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

import { redactSecrets } from '../redact.js';
import { MailerLiteError, type MailerLiteRequestKind } from './errors.js';
import type { BbqSubscriberFields } from './tags.js';

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
  /**
   * Pre-shaped bbq_* fields — build via tags.toBbqSubscriberFields().
   * Keeping the client agnostic of the tag layer lets a portfolio site
   * (powersizing.com, etc.) reuse the same client with its own fields
   * shape.
   */
  fields: BbqSubscriberFields;
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

export interface MailerLiteGroup {
  id: string;
  name: string;
}

export interface TriggerCampaignInput {
  /** MailerLite automation id (one per region in the portfolio model). */
  automationId: string;
  /**
   * Stable per-week tag (e.g. `southeast:2026-05-15`). Hashed into the
   * Idempotency-Key so a same-week retry collapses to the original
   * trigger.
   */
  idempotencyTag: string;
}

export interface MailerLiteClient {
  subscribe(input: SubscribeInput): Promise<SubscribeResult>;
  /**
   * Update only the bbq_* fields on an existing subscriber WITHOUT
   * sending `status: 'active'`. Used by the preferences PATCH handler
   * so an unsubscribed user who edits cut/cooker (e.g. via a stale
   * link) is not silently reactivated in MailerLite. The subscribe
   * endpoint accepts both shapes — the field-only POST is treated as
   * an upsert that preserves the current status column. Returns null
   * on 404 so the caller can choose to drop a stale request silently
   * (preferences PATCH already guarded by token, so 404 means the
   * subscriber was purged out-of-band).
   */
  updateSubscriberFields(
    email: string,
    fields: Record<string, unknown>
  ): Promise<{ id: string } | null>;
  /**
   * Look up a subscriber by email. Returns null on 404 so callers can
   * branch on "not in MailerLite" without try/catch. Used by the
   * unsubscribe handler to find the MailerLite subscriber id without
   * persisting it in D1.
   */
  getSubscriberByEmail(email: string): Promise<{ id: string } | null>;
  unsubscribe(input: UnsubscribeInput): Promise<void>;
  /**
   * List all groups configured in the MailerLite account. Used by
   * groups.ts to hydrate the name→id KV cache on miss. Paginates
   * server-side via `?limit=100`; the portfolio currently has ≤7 groups
   * so a single page suffices, but the loop keeps us honest as new
   * sites onboard.
   */
  listGroups(): Promise<MailerLiteGroup[]>;
  /** POST /api/subscribers/:id/groups/:groupId — idempotent server-side. */
  assignGroup(subscriberId: string, groupId: string): Promise<void>;
  /** DELETE /api/subscribers/:id/groups/:groupId — 404 means "already not a member". */
  removeGroup(subscriberId: string, groupId: string): Promise<void>;
  /**
   * POST /api/automations/:id/run — fires the region's weekly digest
   * automation. The automation's audience filter (pitmaster_<region>)
   * is configured in the MailerLite dashboard, not by this call.
   */
  triggerCampaign(input: TriggerCampaignInput): Promise<void>;
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
      const body: Record<string, unknown> = {
        email: input.email,
        status: 'active',
        fields: { ...input.fields },
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

    async updateSubscriberFields(email, fields) {
      assertEmail(email);
      // POST without `status` so MailerLite preserves whatever status
      // the subscriber currently has (active OR unsubscribed). Posting
      // `status: 'active'` here would silently re-opt-in an unsubscribed
      // user when they edit their cut/cooker preference. Even with the
      // handler's pre-check for unsubscribed_at there is a race window
      // between the snapshot read and this network call; omitting the
      // status field closes it.
      const body: Record<string, unknown> = {
        email,
        fields: { ...fields },
      };
      // Idempotency-Key MUST include a hash of the fields, not just
      // the email. The subscribe path can reuse `subscribe:<email>`
      // because every subscribe is logically "make this user a member
      // with these tags" and a duplicate is safe to collapse. But two
      // sequential preference PATCHes (cut→pork-butt, then cut→brisket)
      // are DIFFERENT logical updates: if MailerLite honors a stable
      // key inside its retention window, the second PATCH gets treated
      // as a duplicate of the first and the new value is dropped while
      // the handler still reports 'sent'. Hashing the canonical JSON of
      // the fields keeps retry-collapse for the same logical update
      // while letting subsequent edits land.
      const idempotencyKey = await hashKey(
        'subscribe',
        `fields:${email.toLowerCase()}:${canonicalJson(fields)}`
      );
      try {
        const json = await request<unknown>('subscribe', {
          method: 'POST',
          path: '/api/subscribers',
          body,
          idempotencyKey,
        });
        // Tolerate both `{data: {id}}` and a flat `{id}` shape — same
        // pattern as getSubscriberByEmail. A 2xx without a recognizable
        // id is malformed, not "not found".
        const wrappedId = (json as { data?: { id?: unknown } } | null)?.data?.id;
        const flatId = (json as { id?: unknown } | null)?.id;
        const id =
          typeof wrappedId === 'string'
            ? wrappedId
            : typeof flatId === 'string'
              ? flatId
              : null;
        if (!id) {
          throw makeError('subscribe', 'malformed', 'missing data.id and id in updateSubscriberFields response');
        }
        return { id };
      } catch (err) {
        if (err instanceof MailerLiteError && err.kind === 'http_4xx' && err.status === 404) {
          return null;
        }
        throw err;
      }
    },

    async getSubscriberByEmail(email) {
      assertEmail(email);
      try {
        const json = await request<unknown>('subscribe', {
          method: 'GET',
          path: `/api/subscribers/${encodeURIComponent(email)}`,
        });
        // Tolerate both response shapes. MailerLite Connect wraps the
        // resource in `{data: ...}`, but sandbox / older API builds
        // return a flat object. The subscribe path applies the same
        // fallback (see line for `data ?? json as ...`) — mirror it
        // here so unsubscribe's group-removal step isn't skipped just
        // because the GET hit a sandbox endpoint that returned flat.
        const wrappedId = (json as { data?: { id?: unknown } } | null)?.data?.id;
        const flatId = (json as { id?: unknown } | null)?.id;
        const id =
          typeof wrappedId === 'string'
            ? wrappedId
            : typeof flatId === 'string'
              ? flatId
              : null;
        if (!id) {
          // 2xx with no recognizable id is malformed, not "not found".
          // Throwing here lets the unsubscribe handler enqueue a retry
          // (per its non-retryable-MLError-on-lookup catch) instead of
          // proceeding to skip group removal and report success.
          throw makeError('subscribe', 'malformed', 'missing data.id and id in subscriber lookup response');
        }
        return { id };
      } catch (err) {
        if (err instanceof MailerLiteError && err.kind === 'http_4xx' && err.status === 404) {
          return null;
        }
        throw err;
      }
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

    async listGroups() {
      // Paginate defensively. MailerLite's group API returns
      // `{ data: [...], meta: { last_page, current_page } }`. We page
      // through until current_page === last_page so a portfolio that
      // grows past the page size doesn't silently truncate.
      const groups: MailerLiteGroup[] = [];
      let page = 1;
      for (;;) {
        const json = await request<{
          data: Array<{ id: string; name: string }>;
          meta?: { last_page?: number; current_page?: number };
        }>('group_list', {
          method: 'GET',
          path: `/api/groups?limit=100&page=${page}`,
        });
        for (const g of json.data ?? []) {
          if (typeof g.id === 'string' && typeof g.name === 'string') {
            groups.push({ id: g.id, name: g.name });
          }
        }
        const last = json.meta?.last_page;
        const current = json.meta?.current_page ?? page;
        if (!last || current >= last) break;
        page = current + 1;
      }
      return groups;
    },

    async assignGroup(subscriberId, groupId) {
      // Idempotency key collapses concurrent retries of the same
      // (subscriber, group) pair. MailerLite treats a repeat assign as
      // a no-op server-side, but the key still helps the retry queue
      // detect duplicates on its own side.
      const idempotencyKey = await hashKey('group_assign', `${subscriberId}:${groupId}`);
      await request<unknown>('group_assign', {
        method: 'POST',
        path: `/api/subscribers/${encodeURIComponent(subscriberId)}/groups/${encodeURIComponent(groupId)}`,
        idempotencyKey,
      });
    },

    async removeGroup(subscriberId, groupId) {
      const idempotencyKey = await hashKey('group_remove', `${subscriberId}:${groupId}`);
      try {
        await request<unknown>('group_remove', {
          method: 'DELETE',
          path: `/api/subscribers/${encodeURIComponent(subscriberId)}/groups/${encodeURIComponent(groupId)}`,
          idempotencyKey,
        });
      } catch (err) {
        // 404 means "not a member" — treat as success so unsubscribe
        // is idempotent even when the subscriber was never in the
        // group to begin with. Any other failure propagates.
        if (err instanceof MailerLiteError && err.kind === 'http_4xx' && err.status === 404) return;
        throw err;
      }
    },

    async triggerCampaign(input) {
      if (!input.automationId) {
        throw new TypeError('triggerCampaign: automationId is required');
      }
      const idempotencyKey = await hashKey('campaign', input.idempotencyTag);
      await request<unknown>('campaign', {
        method: 'POST',
        path: `/api/automations/${encodeURIComponent(input.automationId)}/run`,
        body: {},
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

/**
 * Stable JSON encoding for a fields object: keys sorted lexicographically
 * so `{a:1,b:2}` and `{b:2,a:1}` produce byte-identical output. Used by
 * updateSubscriberFields to derive an idempotency key that collapses
 * exact-duplicate retries but distinguishes substantive edits. Values
 * are passed through JSON.stringify directly — primitives are fine and
 * nested objects (unlikely for our flat fields shape) recurse via the
 * standard JSON encoding.
 */
function canonicalJson(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  return JSON.stringify(keys.map((k) => [k, obj[k]]));
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
