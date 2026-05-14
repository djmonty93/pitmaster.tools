import { describe, expect, it, vi } from 'vitest';
import { createMailerLiteClient, hashKey } from '../../../src/lib/mailerlite/client';
import { MailerLiteError } from '../../../src/lib/mailerlite/errors';

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
      metroSlug: 'kansas-city-mo',
      cut: 'brisket-packer',
      cooker: 'offset',
      timezone: 'America/Chicago',
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
        metro: 'kansas-city-mo',
        cut: 'brisket-packer',
        cooker: 'offset',
        timezone: 'America/Chicago',
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
    await client.subscribe({ email: 'Mixed@Example.COM' });
    await client.subscribe({ email: 'mixed@example.com' });
    expect(captured[0]!.headers['Idempotency-Key']).toBe(captured[1]!.headers['Idempotency-Key']);
  });

  it('tolerates a flat (un-wrapped) response shape for sandbox parity', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher(
      [{ status: 200, body: { id: 'sub_flat', email: 'x@y.com', status: 'active' } }],
      captured
    );
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    const res = await client.subscribe({ email: 'x@y.com' });
    expect(res.id).toBe('sub_flat');
  });

  it('throws http_5xx on 503 and shouldRetry is true', async () => {
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher([{ status: 503, body: { error: 'down' } }], captured);
    const client = createMailerLiteClient({ apiKey: 'k', fetcher });
    try {
      await client.subscribe({ email: 'a@b.com' });
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
      await client.subscribe({ email: 'pitmaster@example.com' });
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
      await client.subscribe({ email: 'a@b.com' });
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
      await client.subscribe({ email: 'a@b.com' });
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
      await client.subscribe({ email: 'a@b.com' });
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
      await client.subscribe({ email: 'a@b.com' });
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
    await expect(client.subscribe({ email: 'no-at-symbol' })).rejects.toThrow(/Invalid email/);
    expect(fetcher).not.toHaveBeenCalled();
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
    await client.subscribe({ email: 'x@y.com' });
    expect(captured[0]!.url).toBe('https://sandbox.example.com/api/subscribers');
  });
});
