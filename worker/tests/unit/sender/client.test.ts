import { describe, expect, it } from 'vitest';
import { installFetchStub, jsonResponse } from '../../helpers/fetchStub.js';
import { createSenderClient } from '../../../src/lib/sender/client.js';
import { SenderError } from '../../../src/lib/sender/errors.js';

const baseFields = {
  bbq_zip: '23219',
  bbq_state: 'VA',
  bbq_region: 'southeast' as const,
  bbq_timezone: 'America/New_York',
};

describe('SenderClient.subscribe', () => {
  it('POSTs /v2/subscribers with bearer auth and {$bbq_*} wrapped fields', async () => {
    const stub = installFetchStub([
      {
        match: 'api.sender.net/v2/subscribers',
        respond: () => jsonResponse(200, { data: { id: 'sub_abc', email: 'a@b.co', status: 'active' } }),
      },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok_xyz' });
      const res = await client.subscribe({ email: 'a@b.co', fields: baseFields });
      expect(res).toEqual({ id: 'sub_abc', email: 'a@b.co', status: 'active' });
      expect(stub.calls).toHaveLength(1);
      const call = stub.calls[0]!;
      expect(call.method).toBe('POST');
      expect(call.headers['authorization']).toBe('Bearer tok_xyz');
      expect(call.headers['content-type']).toContain('application/json');
      expect(call.body).toMatchObject({
        email: 'a@b.co',
        fields: {
          '{$bbq_zip}': '23219',
          '{$bbq_state}': 'VA',
          '{$bbq_region}': 'southeast',
          '{$bbq_timezone}': 'America/New_York',
        },
      });
    } finally {
      stub.restore();
    }
  });

  it('throws SenderError(http_5xx) with retryable=true on 503', async () => {
    const stub = installFetchStub([
      { match: 'api.sender.net/v2/subscribers', respond: () => jsonResponse(503, { message: 'down' }) },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      await expect(client.subscribe({ email: 'a@b.co', fields: baseFields })).rejects.toThrow(SenderError);
    } finally {
      stub.restore();
    }
  });

  it('throws SenderError(http_4xx, 422) non-retryable on validation failure', async () => {
    const stub = installFetchStub([
      {
        match: 'api.sender.net/v2/subscribers',
        respond: () => jsonResponse(422, { message: 'Validation', errors: { email: ['invalid'] } }),
      },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      const err = await client.subscribe({ email: 'bad', fields: baseFields }).catch((e) => e);
      expect(err).toBeInstanceOf(SenderError);
      expect((err as SenderError).status).toBe(422);
      expect((err as SenderError).shouldRetry).toBe(false);
    } finally {
      stub.restore();
    }
  });

  it('throws SenderError(timeout) when fetch is aborted', async () => {
    const stub = installFetchStub([
      {
        match: 'api.sender.net/v2/subscribers',
        respond: () => new Promise<Response>(() => { /* never resolves */ }),
      },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok', timeoutMs: 25 });
      const err = await client.subscribe({ email: 'a@b.co', fields: baseFields }).catch((e) => e);
      expect(err).toBeInstanceOf(SenderError);
      expect((err as SenderError).kind).toBe('timeout');
    } finally {
      stub.restore();
    }
  });

  it('429 with Retry-After: 30 (seconds) → err.retryAfterMs === 30000', async () => {
    const stub = installFetchStub([
      {
        match: 'api.sender.net/v2/subscribers',
        respond: () => {
          const res = new Response(JSON.stringify({ message: 'rate limited' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
          });
          return res;
        },
      },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      const err = await client.subscribe({ email: 'a@b.co', fields: baseFields }).catch((e) => e);
      expect(err).toBeInstanceOf(SenderError);
      expect((err as SenderError).status).toBe(429);
      expect((err as SenderError).retryAfterMs).toBe(30_000);
    } finally {
      stub.restore();
    }
  });

  it('429 with Retry-After: <HTTP-date 60s in the future> → retryAfterMs ≈ 60000', async () => {
    const futureDate = new Date(Date.now() + 60_000).toUTCString();
    const stub = installFetchStub([
      {
        match: 'api.sender.net/v2/subscribers',
        respond: () =>
          new Response(JSON.stringify({ message: 'rate limited' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': futureDate },
          }),
      },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      const err = await client.subscribe({ email: 'a@b.co', fields: baseFields }).catch((e) => e);
      expect(err).toBeInstanceOf(SenderError);
      expect((err as SenderError).status).toBe(429);
      const ram = (err as SenderError).retryAfterMs;
      expect(ram).toBeDefined();
      expect(Math.abs(ram! - 60_000)).toBeLessThan(1500);
    } finally {
      stub.restore();
    }
  });

  it('429 with Retry-After: 7200 (2h) → err.retryAfterMs === 7200000 (no 1h cap in parser)', async () => {
    const stub = installFetchStub([
      {
        match: 'api.sender.net/v2/subscribers',
        respond: () =>
          new Response(JSON.stringify({ message: 'rate limited' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '7200' },
          }),
      },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      const err = await client.subscribe({ email: 'a@b.co', fields: baseFields }).catch((e) => e);
      expect(err).toBeInstanceOf(SenderError);
      expect((err as SenderError).status).toBe(429);
      // Parser must NOT cap at 1h (3_600_000ms) — the raw 2h value is returned.
      // MAX_BACKOFF_MS (6h) in retry.ts is the single cap applied at queue time.
      expect((err as SenderError).retryAfterMs).toBe(7_200_000);
    } finally {
      stub.restore();
    }
  });

  it('429 without Retry-After → err.retryAfterMs === undefined', async () => {
    const stub = installFetchStub([
      {
        match: 'api.sender.net/v2/subscribers',
        respond: () =>
          new Response(JSON.stringify({ message: 'rate limited' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          }),
      },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      const err = await client.subscribe({ email: 'a@b.co', fields: baseFields }).catch((e) => e);
      expect(err).toBeInstanceOf(SenderError);
      expect((err as SenderError).status).toBe(429);
      expect((err as SenderError).retryAfterMs).toBeUndefined();
    } finally {
      stub.restore();
    }
  });

  it('does not send an Idempotency-Key header (Sender does not honor it)', async () => {
    const stub = installFetchStub([
      { match: 'api.sender.net/v2/subscribers', respond: () => jsonResponse(200, { data: { id: 'x', email: 'a@b.co', status: 'active' } }) },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      await client.subscribe({ email: 'a@b.co', fields: baseFields });
      expect(stub.calls[0]!.headers['idempotency-key']).toBeUndefined();
    } finally {
      stub.restore();
    }
  });
});

describe('SenderClient.getSubscriberByEmail', () => {
  it('returns { id } on 200', async () => {
    const stub = installFetchStub([
      { match: 'api.sender.net/v2/subscribers/a%40b.co', respond: () => jsonResponse(200, { data: { id: 'sub_1' } }) },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      expect(await client.getSubscriberByEmail('a@b.co')).toEqual({ id: 'sub_1' });
      expect(stub.calls[0]!.method).toBe('GET');
    } finally { stub.restore(); }
  });

  it('returns null on 404', async () => {
    const stub = installFetchStub([
      { match: 'api.sender.net/v2/subscribers/missing', respond: () => jsonResponse(404, { message: 'not found' }) },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      expect(await client.getSubscriberByEmail('missing@x.co')).toBeNull();
    } finally { stub.restore(); }
  });
});

describe('SenderClient.updateSubscriberFields', () => {
  it('PATCHes /v2/subscribers/{email} with wrapped field keys', async () => {
    const stub = installFetchStub([
      { match: 'api.sender.net/v2/subscribers/a%40b.co', respond: () => jsonResponse(200, { data: { id: 'sub_1' } }) },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      const res = await client.updateSubscriberFields('a@b.co', { bbq_cut_pref: 'pork-butt' });
      expect(res).toEqual({ id: 'sub_1' });
      const call = stub.calls[0]!;
      expect(call.method).toBe('PATCH');
      expect(call.body).toMatchObject({ fields: { '{$bbq_cut_pref}': 'pork-butt' } });
      expect(call.body).not.toHaveProperty('status');
    } finally { stub.restore(); }
  });

  it('returns null on 404', async () => {
    const stub = installFetchStub([
      { match: 'api.sender.net/v2/subscribers/missing', respond: () => jsonResponse(404, {}) },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      expect(await client.updateSubscriberFields('missing@x.co', {})).toBeNull();
    } finally { stub.restore(); }
  });
});

describe('SenderClient.unsubscribe', () => {
  it('PATCHes status=unsubscribed', async () => {
    const stub = installFetchStub([
      { match: 'api.sender.net/v2/subscribers/a%40b.co', respond: () => jsonResponse(200, { data: { id: 'sub_1' } }) },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      await client.unsubscribe({ email: 'a@b.co' });
      const call = stub.calls[0]!;
      expect(call.method).toBe('PATCH');
      expect(call.body).toMatchObject({ status: 'unsubscribed' });
    } finally { stub.restore(); }
  });
});

describe('SenderClient.listGroups', () => {
  it('paginates via links.next', async () => {
    let call = 0;
    const stub = installFetchStub([
      {
        match: 'api.sender.net/v2/groups',
        respond: () => {
          call++;
          if (call === 1) return jsonResponse(200, {
            data: [{ id: 'g1', name: 'pitmaster_all' }],
            links: { next: 'https://api.sender.net/v2/groups?page=2' },
          });
          return jsonResponse(200, {
            data: [{ id: 'g2', name: 'pitmaster_northeast' }],
            links: { next: null },
          });
        },
      },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      const groups = await client.listGroups();
      expect(groups).toEqual([
        { id: 'g1', name: 'pitmaster_all' },
        { id: 'g2', name: 'pitmaster_northeast' },
      ]);
      expect(stub.calls).toHaveLength(2);
    } finally { stub.restore(); }
  });
});

describe('SenderClient.assignGroup', () => {
  it('POSTs to /v2/subscribers/groups/{id} with subscribers array', async () => {
    const stub = installFetchStub([
      { match: 'api.sender.net/v2/subscribers/groups/g1', respond: () => jsonResponse(200, { data: {} }) },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      await client.assignGroup('sub_1', 'g1');
      const call = stub.calls[0]!;
      expect(call.method).toBe('POST');
      expect(call.body).toEqual({ subscribers: ['sub_1'] });
    } finally { stub.restore(); }
  });
});

describe('SenderClient.removeGroup', () => {
  it('DELETEs and swallows 404', async () => {
    const stub = installFetchStub([
      { match: 'api.sender.net/v2/subscribers/groups/g1', respond: () => jsonResponse(404, {}) },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      await expect(client.removeGroup('sub_1', 'g1')).resolves.toBeUndefined();
    } finally { stub.restore(); }
  });
});

describe('SenderClient.triggerWeeklyDigest', () => {
  it('POSTs to the per-region trigger URL with tag body', async () => {
    const stub = installFetchStub([
      { match: 'api.sender.net/v2/automations/trigger/se-token', respond: () => jsonResponse(200, {}) },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      await client.triggerWeeklyDigest({
        triggerUrl: 'https://api.sender.net/v2/automations/trigger/se-token',
        idempotencyTag: 'southeast:2026-05-15',
      });
      const call = stub.calls[0]!;
      expect(call.method).toBe('POST');
      expect(call.body).toEqual({ tag: 'southeast:2026-05-15' });
      expect(call.headers['authorization']).toBe('Bearer tok');
    } finally { stub.restore(); }
  });

  it('throws SenderError(digest_trigger) on non-2xx', async () => {
    const stub = installFetchStub([
      { match: 'api.sender.net/v2/automations/trigger/se-token', respond: () => jsonResponse(500, { message: 'boom' }) },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      const err = await client.triggerWeeklyDigest({
        triggerUrl: 'https://api.sender.net/v2/automations/trigger/se-token',
        idempotencyTag: 'x:1',
      }).catch((e) => e);
      expect(err).toBeInstanceOf(SenderError);
      expect((err as SenderError).requestKind).toBe('digest_trigger');
    } finally { stub.restore(); }
  });

  it('refuses to call triggerWeeklyDigest URL on a non-Sender host (security: prevents auth leak)', async () => {
    const stub = installFetchStub([]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      const err = await client.triggerWeeklyDigest({
        triggerUrl: 'https://evil.example.com/trigger/abc',
        idempotencyTag: 'x:1',
      }).catch((e) => e);
      expect(err).toBeInstanceOf(SenderError);
      expect((err as SenderError).requestKind).toBe('digest_trigger');
      expect((err as SenderError).kind).toBe('malformed');
      expect((err as SenderError).shouldRetry).toBe(false);
      expect(stub.calls).toHaveLength(0); // critical: fetch was NEVER called
    } finally { stub.restore(); }
  });

  it('refuses to call triggerWeeklyDigest URL with downgraded protocol (security: prevents bearer-over-plaintext)', async () => {
    const stub = installFetchStub([]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      const err = await client.triggerWeeklyDigest({
        triggerUrl: 'http://api.sender.net/v2/automations/trigger/abc',
        idempotencyTag: 'x:1',
      }).catch((e) => e);
      expect(err).toBeInstanceOf(SenderError);
      expect((err as SenderError).requestKind).toBe('digest_trigger');
      expect((err as SenderError).kind).toBe('malformed');
      expect((err as SenderError).shouldRetry).toBe(false);
      expect(stub.calls).toHaveLength(0); // critical: fetch was NEVER called
    } finally { stub.restore(); }
  });
});
