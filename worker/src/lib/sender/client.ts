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

export interface TriggerDigestInput {
  /** Per-region "API Call Is Made" trigger URL configured in Sender dashboard. */
  triggerUrl: string;
  /** Stable per-week tag, e.g. "southeast:2026-05-15". Body-only. */
  idempotencyTag: string;
}

export interface SenderClient {
  subscribe(input: SubscribeInput): Promise<SubscribeResult>;
  updateSubscriberFields(email: string, fields: Record<string, unknown>): Promise<{ id: string } | null>;
  getSubscriberByEmail(email: string): Promise<{ id: string } | null>;
  unsubscribe(input: UnsubscribeInput): Promise<void>;
  listGroups(): Promise<SenderGroup[]>;
  assignGroup(subscriberId: string, groupId: string): Promise<void>;
  removeGroup(subscriberId: string, groupId: string): Promise<void>;
  triggerWeeklyDigest(input: TriggerDigestInput): Promise<void>;
}

const DEFAULT_BASE_URL = 'https://api.sender.net/v2';
const DEFAULT_TIMEOUT_MS = 8_000;

export function createSenderClient(opts: SenderClientOptions): SenderClient {
  const fetcher = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const auth = `Bearer ${opts.apiToken}`;

  async function request(
    requestKind: SenderRequestKind,
    method: string,
    pathOrUrl: string,
    body?: unknown
  ): Promise<unknown> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${baseUrl}${pathOrUrl}`;
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
      throw new SenderError(requestKind, errKind, msg, res.status);
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
        fields: wrapFieldKeys(input.fields as Record<string, unknown>),
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
    async updateSubscriberFields() { throw new Error('not implemented'); },
    async getSubscriberByEmail() { throw new Error('not implemented'); },
    async unsubscribe() { throw new Error('not implemented'); },
    async listGroups() { throw new Error('not implemented'); },
    async assignGroup() { throw new Error('not implemented'); },
    async removeGroup() { throw new Error('not implemented'); },
    async triggerWeeklyDigest() { throw new Error('not implemented'); },
  };
}

function extractMessage(parsed: unknown): string | null {
  if (parsed && typeof parsed === 'object' && 'message' in parsed && typeof (parsed as { message: unknown }).message === 'string') {
    return (parsed as { message: string }).message;
  }
  return null;
}
