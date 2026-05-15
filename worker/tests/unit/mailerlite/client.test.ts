import { describe, expect, it, vi } from 'vitest';
import { createMailerLiteClient, hashKey } from '../../../src/lib/mailerlite/client';
import { MailerLiteError } from '../../../src/lib/mailerlite/errors';
import type { BbqSubscriberFields } from '../../../src/lib/mailerlite/tags';

/** Minimal valid fields object for subscribe-path tests that don't care about field shape. */
const FIELDS: BbqSubscriberFields = {
  bbq_zip: '00000',
  bbq_state: 'CA',
  bbq_region: 'pacific',
  bbq_timezone: 'America/Los_Angeles',
};

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

interface Scripted {
  status: number;
  body?: unknown;
  /** Replace JSON with raw text (e.g. to simulate malformed payload). */
  text?: string;
  /** Throw before producing a Response — simulates network failure. */
  throw?: Error;
}

function makeFetcher(
  script: Scripted[],
  captured: CapturedCall[]
): typeof fetch {
  let i = 0;
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    const reqHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const k of Object.keys(reqHeaders)) headers[k] = reqHeaders[k] as string;
    captured.push({
      url,
      method: (init?.method ?? 'GET') as string,
      headers,
      body: init?.body !== undefined ? JSON.parse(init.body as string) : undefined,
    });
    const step = script[i++];
    if (!step) throw new Error(`scripted fetcher exhausted at call ${i}`);
    if (step.throw) throw step.throw;
    const body =
      step.text !== undefined
        ? step.text
        : step.body !== undefined
          ? JSON.stringify(step.body)
          : null;
    return new Response(body, {
      status: step.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

describe('mailerlite client — subscribe', () => {
  it('POSTs /api/subscribers with Bearer token, hashed idempotency key, and tag fields', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher(
      [
        {
          status: 200,
          body: { data: { id: 'sub_123', email: 'pitmaster@example.com', status: 'active' } },
        },
      ],
      captured
    );
    const client = createMailerLiteClient({ apiKey: 'ml_test_key', fetcher });
    const res = await client.subscribe({
      email: 'pitmaster@example.com',
      fields: {
        bbq_zip: '64108',
        bbq_state: 'MO',
        bbq_region: 'south_central',
        bbq_cut_pref: 'brisket-packer',
        bbq_cooker_pref: 'offset',
        bbq_timezone: 'America/Chicago',
      },
    });
    expect(res).toEqual({ id: 'sub_123', email: 'pitmaster@example.com', status: 'active' });
    expect(captured).toHaveLength(1);
    const call = captured[0]!;
    expect(call.url).toBe('https://connect.mailerlite.com/api/subscribers');
    expect(call.method).toBe('POST');
    expect(call.headers['Authorization']).toBe('Bearer ml_test_key');
    expect(call.headers['Content-Type']).toBe('application/json');
    const expectedKey = await hashKey('subscribe', 'pitmaster@example.com');
    expect(call.headers['Idempotency-Key']).toBe(expectedKey);
    // The key MUST NOT contain the plaintext email — it's the whole
    // point of hashing rather than concatenating.
    expect(call.headers['Idempotency-Key']).not.toContain('pitmaster@example.com');
    expect(call.body).toEqual({
      email: 'pitmaster@example.com',
      status: 'active',
      fields: {
        bbq_zip: '64108',
        bbq_state: 'MO',
        bbq_region: 'south_central',
        bbq_cut_pref: 'brisket-packer',
        bbq_cooker_pref: 'offset',
        bbq_timezone: 'America/Chicago',
      },
    });
  });

  it('collapses case-only-different emails to the same idempotency key', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher(
      [
        { status: 200, body: { data: { id: 's1', email: 'Mixed@Example.COM', status: 'active' } } },
        { status: 200, body: { data: { id: 's2', email: 'mixed@example.com', status: 'active' } } },
      ],
      captured
    );
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    await client.subscribe({ email: 'Mixed@Example.COM', fields: FIELDS });
    await client.subscribe({ email: 'mixed@example.com', fields: FIELDS });
    expect(captured[0]!.headers['Idempotency-Key']).toBe(captured[1]!.headers['Idempotency-Key']);
  });

  it('tolerates a flat (un-wrapped) response shape for sandbox parity', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher(
      [{ status: 200, body: { id: 'sub_flat', email: 'x@y.com', status: 'active' } }],
      captured
    );
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    const res = await client.subscribe({ email: 'x@y.com', fields: FIELDS });
    expect(res.id).toBe('sub_flat');
  });

  it('throws http_5xx on 503 and shouldRetry is true', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher([{ status: 503, body: { error: 'down' } }], captured);
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    try {
      await client.subscribe({ email: 'a@b.com', fields: FIELDS });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MailerLiteError);
      const e = err as MailerLiteError;
      expect(e.kind).toBe('http_5xx');
      expect(e.status).toBe(503);
      expect(e.requestKind).toBe('subscribe');
      expect(e.shouldRetry).toBe(true);
    }
  });

  it('throws http_4xx on 422 and shouldRetry is false', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher(
      [{ status: 422, body: { errors: { email: ['already exists for pitmaster@example.com'] } } }],
      captured
    );
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    try {
      await client.subscribe({ email: 'pitmaster@example.com', fields: FIELDS });
      expect.fail('expected throw');
    } catch (err) {
      const e = err as MailerLiteError;
      expect(e.kind).toBe('http_4xx');
      expect(e.status).toBe(422);
      expect(e.shouldRetry).toBe(false);
      // The 4xx body could echo the email — the error MUST NOT carry it.
      expect(e.message).not.toContain('pitmaster@example.com');
      expect(e.message).not.toContain('already exists');
    }
  });

  it('treats 429 as retryable (provider-side rate limit)', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher([{ status: 429, body: {} }], captured);
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    try {
      await client.subscribe({ email: 'a@b.com', fields: FIELDS });
      expect.fail('expected throw');
    } catch (err) {
      const e = err as MailerLiteError;
      expect(e.status).toBe(429);
      expect(e.shouldRetry).toBe(true);
    }
  });

  it('throws timeout when the request exceeds timeoutMs', async () => {
    const captured: CapturedCall[] = [];
    const slow: typeof fetch = (_url, init) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    const client = createMailerLiteClient({ apiKey: 'k', fetcher: slow, timeoutMs: 20 });
    try {
      await client.subscribe({ email: 'a@b.com', fields: FIELDS });
      expect.fail('expected throw');
    } catch (err) {
      const e = err as MailerLiteError;
      expect(e.kind).toBe('timeout');
      expect(e.shouldRetry).toBe(true);
    }
    expect(captured).toHaveLength(0);
  });

  it('throws malformed when a 2xx body is not JSON', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher([{ status: 200, text: '<html>cdn page</html>' }], captured);
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    try {
      await client.subscribe({ email: 'a@b.com', fields: FIELDS });
      expect.fail('expected throw');
    } catch (err) {
      const e = err as MailerLiteError;
      expect(e.kind).toBe('malformed');
      expect(e.shouldRetry).toBe(false);
    }
  });

  it('redacts Bearer tokens that show up inside a network error message', async () => {
    const captured: CapturedCall[] = [];
    const fetcher: typeof fetch = async () => {
      throw new Error(
        'workerd fetch failed: Authorization: Bearer ml_super_secret_token while POST /api/subscribers'
      );
    };
    const client = createMailerLiteClient({ apiKey: 'ml_super_secret_token', fetcher });
    try {
      await client.subscribe({ email: 'a@b.com', fields: FIELDS });
      expect.fail('expected throw');
    } catch (err) {
      const e = err as MailerLiteError;
      expect(e.kind).toBe('network');
      expect(e.message).not.toContain('ml_super_secret_token');
      expect(e.message).toMatch(/Bearer \[redacted\]|Authorization: \[redacted\]/);
    }
    expect(captured).toHaveLength(0);
  });

  it('rejects obviously bad emails before issuing a request', async () => {
    const fetcher = vi.fn();
    const client = createMailerLiteClient({ apiKey: 'k', fetcher: fetcher as unknown as typeof fetch });
    await expect(client.subscribe({ email: 'no-at-symbol', fields: FIELDS })).rejects.toThrow(/Invalid email/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('mailerlite client — updateSubscriberFields', () => {
  it('POSTs /api/subscribers WITHOUT a status field (does not reactivate unsubscribed)', async () => {
    // Regression: client.subscribe always sends `status: 'active'`,
    // which would silently reactivate an unsubscribed user when the
    // preferences PATCH handler races an unsubscribe between snapshot
    // and network call. updateSubscriberFields omits status to keep
    // the upstream's existing status unchanged.
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher(
      [{ status: 200, body: { data: { id: 'sub_99', email: 'p@example.com' } } }],
      captured
    );
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    const res = await client.updateSubscriberFields('p@example.com', {
      bbq_cut_pref: 'brisket-packer',
      bbq_cooker_pref: 'offset',
    });
    expect(res).toEqual({ id: 'sub_99' });
    expect(captured).toHaveLength(1);
    const call = captured[0]!;
    expect(call.url).toBe('https://connect.mailerlite.com/api/subscribers');
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({
      email: 'p@example.com',
      fields: {
        bbq_cut_pref: 'brisket-packer',
        bbq_cooker_pref: 'offset',
      },
    });
    // Status MUST NOT be present — that's the whole point.
    expect((call.body as Record<string, unknown>).status).toBeUndefined();
  });

  it('tolerates a flat {id} response shape', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher(
      [{ status: 200, body: { id: 'sub_flat' } }],
      captured
    );
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    const res = await client.updateSubscriberFields('p@example.com', { bbq_cut_pref: '' });
    expect(res).toEqual({ id: 'sub_flat' });
  });

  it('returns null on 404 (subscriber not in MailerLite)', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher([{ status: 404, body: {} }], captured);
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    const res = await client.updateSubscriberFields('gone@example.com', { bbq_cut_pref: '' });
    expect(res).toBeNull();
  });

  it('propagates retryable 5xx errors so the caller can enqueue', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher([{ status: 503, body: {} }], captured);
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    try {
      await client.updateSubscriberFields('p@example.com', { bbq_cut_pref: '' });
      expect.fail('expected throw');
    } catch (err) {
      const e = err as MailerLiteError;
      expect(e.kind).toBe('http_5xx');
      expect(e.shouldRetry).toBe(true);
    }
  });

  it('rejects obviously bad emails before issuing a request', async () => {
    const fetcher = vi.fn();
    const client = createMailerLiteClient({ apiKey: 'k', fetcher: fetcher as unknown as typeof fetch });
    await expect(client.updateSubscriberFields('no-at', { bbq_cut_pref: '' })).rejects.toThrow(/Invalid email/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses a DIFFERENT idempotency key when the field values change for the same email', async () => {
    // Regression for [Codex P2] pass-16: a stable per-email key meant
    // MailerLite could treat a follow-up cut/cooker edit as a duplicate
    // of the original within its idempotency retention window, dropping
    // the new value while the handler reported 'sent'. The key now
    // hashes the canonical fields JSON so distinct values produce
    // distinct keys.
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher(
      [
        { status: 200, body: { data: { id: 'sub_1' } } },
        { status: 200, body: { data: { id: 'sub_1' } } },
      ],
      captured
    );
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    await client.updateSubscriberFields('p@example.com', { bbq_cut_pref: 'pork-butt' });
    await client.updateSubscriberFields('p@example.com', { bbq_cut_pref: 'brisket-flat' });
    expect(captured[0]!.headers['Idempotency-Key']).not.toBe(
      captured[1]!.headers['Idempotency-Key']
    );
  });

  it('uses the SAME idempotency key for an exact-duplicate retry (same email, same fields)', async () => {
    // Two calls with identical fields collapse on idempotency so the
    // retry queue is safe to replay without producing accidental
    // duplicate writes.
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher(
      [
        { status: 200, body: { data: { id: 'sub_1' } } },
        { status: 200, body: { data: { id: 'sub_1' } } },
      ],
      captured
    );
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    const fields = { bbq_cut_pref: 'pork-butt', bbq_cooker_pref: 'offset' };
    await client.updateSubscriberFields('p@example.com', fields);
    await client.updateSubscriberFields('p@example.com', fields);
    expect(captured[0]!.headers['Idempotency-Key']).toBe(
      captured[1]!.headers['Idempotency-Key']
    );
  });

  it('idempotency key is insensitive to field-key insertion order', async () => {
    // Canonical JSON sorts keys, so `{a, b}` and `{b, a}` produce the
    // same key. Otherwise a caller who happened to construct the
    // fields object differently would burn an extra MailerLite write.
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher(
      [
        { status: 200, body: { data: { id: 'sub_1' } } },
        { status: 200, body: { data: { id: 'sub_1' } } },
      ],
      captured
    );
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    await client.updateSubscriberFields('p@example.com', {
      bbq_cut_pref: 'pork-butt',
      bbq_cooker_pref: 'offset',
    });
    await client.updateSubscriberFields('p@example.com', {
      bbq_cooker_pref: 'offset',
      bbq_cut_pref: 'pork-butt',
    });
    expect(captured[0]!.headers['Idempotency-Key']).toBe(
      captured[1]!.headers['Idempotency-Key']
    );
  });
});

describe('mailerlite client — unsubscribe', () => {
  it('PUTs status=unsubscribed against the email-keyed path with a hashed idempotency key', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher([{ status: 200, body: { data: {} } }], captured);
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    await client.unsubscribe({ email: 'gone@example.com' });
    expect(captured).toHaveLength(1);
    const call = captured[0]!;
    expect(call.method).toBe('PUT');
    expect(call.url).toBe('https://connect.mailerlite.com/api/subscribers/gone%40example.com');
    expect(call.body).toEqual({ status: 'unsubscribed' });
    const expectedKey = await hashKey('unsubscribe', 'gone@example.com');
    expect(call.headers['Idempotency-Key']).toBe(expectedKey);
    expect(call.headers['Idempotency-Key']).not.toContain('gone@example.com');
  });

  it('accepts 204 No Content without trying to parse a body', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher([{ status: 204 }], captured);
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    await client.unsubscribe({ email: 'gone@example.com' });
    expect(captured).toHaveLength(1);
  });

  it('propagates a 5xx with requestKind=unsubscribe', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher([{ status: 502, body: {} }], captured);
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    try {
      await client.unsubscribe({ email: 'gone@example.com' });
      expect.fail('expected throw');
    } catch (err) {
      const e = err as MailerLiteError;
      expect(e.requestKind).toBe('unsubscribe');
      expect(e.shouldRetry).toBe(true);
    }
  });
});

describe('mailerlite client — getSubscriberByEmail', () => {
  it('parses the wrapped {data:{id}} response shape', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher(
      [{ status: 200, body: { data: { id: 'sub_42', email: 'gone@example.com' } } }],
      captured
    );
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    const result = await client.getSubscriberByEmail('gone@example.com');
    expect(result).toEqual({ id: 'sub_42' });
    expect(captured[0]!.method).toBe('GET');
    expect(captured[0]!.url).toBe('https://connect.mailerlite.com/api/subscribers/gone%40example.com');
  });

  it('parses the flat {id} response shape (sandbox / older API)', async () => {
    // Regression for [P2] pass-10: a sandbox returning a flat object
    // used to be treated as "not found", silently skipping group
    // removal on unsubscribe.
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher(
      [{ status: 200, body: { id: 'sub_flat', email: 'gone@example.com' } }],
      captured
    );
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    const result = await client.getSubscriberByEmail('gone@example.com');
    expect(result).toEqual({ id: 'sub_flat' });
  });

  it('returns null on 404 (subscriber not in MailerLite)', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher([{ status: 404, body: {} }], captured);
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    const result = await client.getSubscriberByEmail('gone@example.com');
    expect(result).toBeNull();
  });

  it('throws malformed when 2xx body has neither data.id nor id', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher(
      [{ status: 200, body: { unrelated: 'payload' } }],
      captured
    );
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    try {
      await client.getSubscriberByEmail('gone@example.com');
      expect.fail('expected throw');
    } catch (err) {
      const e = err as MailerLiteError;
      expect(e.kind).toBe('malformed');
      // Not retryable — caller decides what to do (the unsubscribe
      // handler enqueues based on its own dispatch policy).
      expect(e.shouldRetry).toBe(false);
    }
  });
});

describe('mailerlite client — listGroups', () => {
  it('paginates and concatenates results from /api/groups', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher(
      [
        {
          status: 200,
          body: {
            data: [
              { id: '101', name: 'pitmaster_all' },
              { id: '202', name: 'pitmaster_northeast' },
            ],
            meta: { current_page: 1, last_page: 2 },
          },
        },
        {
          status: 200,
          body: {
            data: [{ id: '303', name: 'pitmaster_southeast' }],
            meta: { current_page: 2, last_page: 2 },
          },
        },
      ],
      captured
    );
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    const groups = await client.listGroups();
    expect(groups).toEqual([
      { id: '101', name: 'pitmaster_all' },
      { id: '202', name: 'pitmaster_northeast' },
      { id: '303', name: 'pitmaster_southeast' },
    ]);
    expect(captured).toHaveLength(2);
    expect(captured[0]!.url).toContain('page=1');
    expect(captured[1]!.url).toContain('page=2');
  });

  it('stops after one page when last_page is missing or 1', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher(
      [
        {
          status: 200,
          body: {
            data: [{ id: '1', name: 'pitmaster_all' }],
            meta: { current_page: 1, last_page: 1 },
          },
        },
      ],
      captured
    );
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    const groups = await client.listGroups();
    expect(groups).toHaveLength(1);
    expect(captured).toHaveLength(1);
  });
});

describe('mailerlite client — assignGroup / removeGroup', () => {
  it('POSTs to /api/subscribers/:id/groups/:groupId with a deterministic idempotency key', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher([{ status: 200, body: {} }], captured);
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    await client.assignGroup('sub_42', 'grp_7');
    expect(captured).toHaveLength(1);
    const call = captured[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://connect.mailerlite.com/api/subscribers/sub_42/groups/grp_7');
    const expectedKey = await hashKey('group_assign', 'sub_42:grp_7');
    expect(call.headers['Idempotency-Key']).toBe(expectedKey);
  });

  it('DELETE on removeGroup, swallows 404 as not-a-member', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher([{ status: 404, body: { error: 'not found' } }], captured);
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    await client.removeGroup('sub_42', 'grp_99'); // no throw
    expect(captured[0]!.method).toBe('DELETE');
  });

  it('propagates 5xx from removeGroup as retryable', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher([{ status: 502, body: {} }], captured);
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    try {
      await client.removeGroup('sub_42', 'grp_7');
      expect.fail('expected throw');
    } catch (err) {
      const e = err as MailerLiteError;
      expect(e.requestKind).toBe('group_remove');
      expect(e.kind).toBe('http_5xx');
      expect(e.shouldRetry).toBe(true);
    }
  });
});

describe('mailerlite client — triggerCampaign', () => {
  it('POSTs /api/automations/:id/run with a region-scoped idempotency key', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher([{ status: 200, body: {} }], captured);
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    await client.triggerCampaign({
      automationId: 'auto_se',
      idempotencyTag: 'southeast:2026-05-15',
    });
    expect(captured).toHaveLength(1);
    const call = captured[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://connect.mailerlite.com/api/automations/auto_se/run');
    const expectedKey = await hashKey('campaign', 'southeast:2026-05-15');
    expect(call.headers['Idempotency-Key']).toBe(expectedKey);
  });

  it('rejects an empty automationId at construction-time argument check', async () => {
    const client = createMailerLiteClient({ apiKey: 'k' });
    await expect(
      client.triggerCampaign({ automationId: '', idempotencyTag: 'x' })
    ).rejects.toThrow(/automationId/);
  });
});

describe('mailerlite client — construction', () => {
  it('throws if apiKey is missing or empty', () => {
    expect(() => createMailerLiteClient({ apiKey: '' })).toThrow(/apiKey/);
  });

  it('throws if apiKey contains whitespace (paste-error guard)', () => {
    expect(() => createMailerLiteClient({ apiKey: 'has space' })).toThrow(/whitespace/);
    expect(() => createMailerLiteClient({ apiKey: 'has\nnewline' })).toThrow(/whitespace/);
  });

  it('respects an override baseUrl (sandbox / staging)', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher(
      [{ status: 200, body: { data: { id: 's', email: 'x@y.com', status: 'active' } } }],
      captured
    );
    const client = createMailerLiteClient({
      apiKey: 'k',
      fetcher,
      baseUrl: 'https://sandbox.example.com/',
    });
    await client.subscribe({ email: 'x@y.com', fields: FIELDS });
    expect(captured[0]!.url).toBe('https://sandbox.example.com/api/subscribers');
  });
});
