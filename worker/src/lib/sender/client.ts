import type { BbqSubscriberFields } from './tags.js';
import { SenderError, type SenderRequestKind } from './errors.js';

export type Fetcher = typeof fetch;

export interface SenderClientOptions {
  apiToken: string;
  fetcher?: Fetcher;
  /** Per-call request timeout. Defaults to 8s. */
  timeoutMs?: number;
  /** Override for tests / staging. */
  baseUrl?: string;
}

export interface SubscribeInput {
  email: string;
  fields: BbqSubscriberFields;
}

export interface SubscribeResult {
  id: string;
  email: string;
  status: 'active' | 'unsubscribed' | 'bounced' | 'reported_spam' | 'non_subscribed';
}

export interface UnsubscribeInput { email: string }

export interface SenderGroup { id: string; name: string }

export interface CreateCampaignInput {
  /** Internal campaign name (not shown to recipients), e.g. "pitmaster southeast 2026-05-15". */
  name: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  /** Full HTML body of the email. */
  html: string;
  /** Sender.net group id to send to (audience = everyone in the group). */
  groupId: string;
  /** Optional deterministic idempotency key (best-effort server-side dedup). */
  idempotencyKey?: string;
}

export interface CreateCampaignResult {
  campaignId: string;
}

export interface SendCampaignInput {
  campaignId: string;
  /** Optional deterministic idempotency key (best-effort server-side dedup). */
  idempotencyKey?: string;
}

export interface SenderClient {
  subscribe(input: SubscribeInput): Promise<SubscribeResult>;
  updateSubscriberFields(email: string, fields: Record<string, unknown>): Promise<{ id: string } | null>;
  getSubscriberByEmail(email: string): Promise<{ id: string } | null>;
  unsubscribe(input: UnsubscribeInput): Promise<void>;
  listGroups(): Promise<SenderGroup[]>;
  assignGroup(subscriberId: string, groupId: string): Promise<void>;
  removeGroup(subscriberId: string, groupId: string): Promise<void>;
  /**
   * Create a one-off HTML campaign targeting a single group, then return
   * its id. Pair with sendCampaign to broadcast. Used by the Friday
   * digest cron (worker builds the HTML, Sender broadcasts to the group).
   */
  createCampaign(input: CreateCampaignInput): Promise<CreateCampaignResult>;
  /** Send (broadcast now) a previously created campaign by id. */
  sendCampaign(input: SendCampaignInput): Promise<void>;
}

const DEFAULT_BASE_URL = 'https://api.sender.net/v2';
const DEFAULT_TIMEOUT_MS = 8_000;

export function createSenderClient(opts: SenderClientOptions): SenderClient {
  const fetcher = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const auth = `Bearer ${opts.apiToken}`;

  const parsedBaseUrl = new URL(baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`);
  const allowedHostname = parsedBaseUrl.hostname;
  const allowedProtocol = parsedBaseUrl.protocol;

  async function request(
    requestKind: SenderRequestKind,
    method: string,
    pathOrUrl: string,
    body?: unknown,
    idempotencyKey?: string
  ): Promise<unknown> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${baseUrl}${pathOrUrl}`;
    const targetUrl = new URL(url);
    if (targetUrl.hostname !== allowedHostname || targetUrl.protocol !== allowedProtocol) {
      throw new SenderError(
        requestKind,
        'malformed',
        `Refusing to send Authorization header to ${targetUrl.protocol}//${targetUrl.hostname}: must match ${allowedProtocol}//${allowedHostname}`
      );
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new SenderError(requestKind, 'timeout', `request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    let res: Response;
    try {
      res = await Promise.race([
        fetcher(url, {
          method,
          headers: {
            authorization: auth,
            'content-type': 'application/json',
            accept: 'application/json',
            // Defensive at-most-once: a deterministic idempotency key so a
            // retry of the same logical request is collapsed server-side IF
            // Sender honors it (standard convention; harmless if ignored —
            // unknown headers are dropped). Best-effort, not relied upon —
            // see docs/sender-setup.md §4 precondition 4.
            ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);
    } catch (err) {
      if (err instanceof SenderError) throw err;
      const kind = err instanceof DOMException && err.name === 'AbortError' ? 'timeout' : 'network';
      const message = err instanceof Error ? err.message : String(err);
      throw new SenderError(requestKind, kind, message);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new SenderError(requestKind, 'malformed', `non-JSON body: ${text.slice(0, 200)}`, res.status);
      }
    }
    if (!res.ok) {
      const errKind = res.status >= 500 ? 'http_5xx' : 'http_4xx';
      const msg = extractMessage(parsed) ?? `HTTP ${res.status}`;
      const retryAfterMs = res.status === 429 ? parseRetryAfter(res.headers.get('retry-after')) : undefined;
      throw new SenderError(requestKind, errKind, msg, res.status, retryAfterMs);
    }
    return parsed;
  }

  function wrapFieldKeys(fields: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      out[`{$${k}}`] = v;
    }
    return out;
  }

  return {
    async subscribe(input) {
      const body = {
        email: input.email,
        fields: wrapFieldKeys(input.fields as unknown as Record<string, unknown>),
        trigger_automation: false,
      };
      const parsed = await request('subscribe', 'POST', '/subscribers', body) as
        | { data?: { id?: string; email?: string; status?: SubscribeResult['status'] } }
        | null;
      const data = parsed?.data;
      if (!data?.id || !data.email || !data.status) {
        throw new SenderError('subscribe', 'malformed', 'missing data.{id,email,status} in response');
      }
      return { id: data.id, email: data.email, status: data.status };
    },
    async updateSubscriberFields(email, fields) {
      try {
        const parsed = await request(
          'field_update',
          'PATCH',
          `/subscribers/${encodeURIComponent(email)}`,
          { fields: wrapFieldKeys(fields) }
        ) as { data?: { id?: string } } | null;
        if (!parsed?.data?.id) {
          throw new SenderError('field_update', 'malformed', 'missing data.id');
        }
        return { id: parsed.data.id };
      } catch (err) {
        if (err instanceof SenderError && err.kind === 'http_4xx' && err.status === 404) {
          return null;
        }
        throw err;
      }
    },
    async getSubscriberByEmail(email) {
      try {
        const parsed = await request(
          'subscribe',
          'GET',
          `/subscribers/${encodeURIComponent(email)}`
        ) as { data?: { id?: string } } | null;
        if (!parsed?.data?.id) {
          throw new SenderError('subscribe', 'malformed', 'missing data.id');
        }
        return { id: parsed.data.id };
      } catch (err) {
        if (err instanceof SenderError && err.kind === 'http_4xx' && err.status === 404) {
          return null;
        }
        throw err;
      }
    },
    async unsubscribe(input) {
      await request(
        'unsubscribe',
        'PATCH',
        `/subscribers/${encodeURIComponent(input.email)}`,
        { status: 'unsubscribed' }
      );
    },
    async listGroups() {
      const out: SenderGroup[] = [];
      let url: string | null = '/groups?limit=100';
      while (url !== null) {
        // Sender.net's /v2/groups returns the group name under `title`
        // (NOT `name`); `id` is a short alphanumeric string. Reading the
        // wrong key silently filtered out every group, so resolveGroupId
        // reported "group not found" for groups that actually existed.
        const parsed = await request('group_list', 'GET', url) as
          | { data?: Array<{ id?: string; title?: string }>; links?: { next?: string | null } }
          | null;
        for (const row of parsed?.data ?? []) {
          if (typeof row.id === 'string' && typeof row.title === 'string') {
            out.push({ id: row.id, name: row.title });
          }
        }
        url = parsed?.links?.next ?? null;
      }
      return out;
    },
    async assignGroup(subscriberId, groupId) {
      await request(
        'group_assign',
        'POST',
        `/subscribers/groups/${encodeURIComponent(groupId)}`,
        { subscribers: [subscriberId] }
      );
    },
    async removeGroup(subscriberId, groupId) {
      try {
        await request(
          'group_remove',
          'DELETE',
          `/subscribers/groups/${encodeURIComponent(groupId)}`,
          { subscribers: [subscriberId] }
        );
      } catch (err) {
        if (err instanceof SenderError && err.kind === 'http_4xx' && err.status === 404) return;
        throw err;
      }
    },
    async createCampaign(input) {
      const parsed = await request(
        'campaign_create',
        'POST',
        '/campaigns',
        campaignCreateBody(input),
        input.idempotencyKey
      ) as { data?: { id?: string } } | null;
      const id = parsed?.data?.id;
      if (typeof id !== 'string' || id.length === 0) {
        throw new SenderError('campaign_create', 'malformed', 'missing data.id in create-campaign response');
      }
      return { campaignId: id };
    },
    async sendCampaign(input) {
      await request(
        'campaign_send',
        'POST',
        `/campaigns/${encodeURIComponent(input.campaignId)}/send`,
        undefined,
        input.idempotencyKey
      );
    },
  };
}

/**
 * Build the create-campaign request body.
 *
 * ⚠️ UNVERIFIED CONTRACT. The exact field names and the create/send
 * endpoint paths for Sender.net's Campaigns API were not confirmable
 * against the live docs (they render client-side). This is the single
 * place that encodes the wire shape — confirm it against the live API
 * before enabling real sends (see docs/sender-setup.md §4) and adjust
 * here only. The Campaigns API is also typically a paid-tier feature.
 */
function campaignCreateBody(input: CreateCampaignInput): Record<string, unknown> {
  return {
    title: input.name,
    subject: input.subject,
    from: input.fromName,
    from_email: input.fromEmail,
    reply_to: input.replyTo ?? input.fromEmail,
    content_type: 'html',
    content: input.html,
    groups: [input.groupId],
  };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const secs = Number(trimmed);
    return Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined;
  }
  const ts = Date.parse(trimmed);
  if (Number.isNaN(ts)) return undefined;
  const ms = ts - Date.now();
  return ms > 0 ? ms : undefined;
}

function extractMessage(parsed: unknown): string | null {
  if (parsed && typeof parsed === 'object' && 'message' in parsed && typeof (parsed as { message: unknown }).message === 'string') {
    return (parsed as { message: string }).message;
  }
  return null;
}
