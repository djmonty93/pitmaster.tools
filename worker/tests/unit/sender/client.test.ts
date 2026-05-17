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
      const call = stub.calls[0];
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

  it('does not send an Idempotency-Key header (Sender does not honor it)', async () => {
    const stub = installFetchStub([
      { match: 'api.sender.net/v2/subscribers', respond: () => jsonResponse(200, { data: { id: 'x', email: 'a@b.co', status: 'active' } }) },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      await client.subscribe({ email: 'a@b.co', fields: baseFields });
      expect(stub.calls[0].headers['idempotency-key']).toBeUndefined();
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
      expect(stub.calls[0].method).toBe('GET');
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
      const call = stub.calls[0];
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
