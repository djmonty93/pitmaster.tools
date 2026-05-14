import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleSubscribe } from '../../src/handlers/subscribe';
import { applyMigrations } from '../helpers/d1';
import { installFetchStub, jsonResponse, type FetchStub } from '../helpers/fetchStub';
import { buildContext } from '../helpers/routeContext';

interface E {
  SMOKE_DB: D1Database;
}

const DB = (env as unknown as E).SMOKE_DB;

beforeAll(async () => {
  await applyMigrations(DB);
});

let stub: FetchStub | null = null;
beforeEach(async () => {
  await DB.prepare(`DELETE FROM subscribers`).run();
  await DB.prepare(`DELETE FROM mailerlite_retry`).run();
});
afterEach(() => {
  stub?.restore();
  stub = null;
});

const mailerliteOk = () =>
  jsonResponse(200, {
    data: { id: 'sub_123', email: 'pitmaster@example.com', status: 'active' },
  });

function buildReq(body: unknown): Request {
  return new Request('https://x/api/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/subscribe', () => {
  it('writes to MailerLite + D1 on the happy path', async () => {
    stub = installFetchStub([{ match: 'connect.mailerlite.com', respond: mailerliteOk }]);
    const res = await handleSubscribe(
      buildContext(
        buildReq({
          email: 'pitmaster@example.com',
          zip: '30303',
          cut: 'brisket-packer',
          cooker: 'offset',
        })
      )
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; mailerliteId: string };
    expect(body.status).toBe('sent');
    expect(body.mailerliteId).toBe('sub_123');
    const row = await DB.prepare(
      `SELECT email, zip, cut, cooker, timezone, unsubscribed_at FROM subscribers WHERE email = ?`
    )
      .bind('pitmaster@example.com')
      .first<{
        email: string;
        zip: string;
        cut: string;
        cooker: string;
        timezone: string;
        unsubscribed_at: number | null;
      }>();
    expect(row?.zip).toBe('30303');
    expect(row?.cut).toBe('brisket-packer');
    expect(row?.cooker).toBe('offset');
    // 30303 is a seeded metro → timezone comes from metros table.
    expect(row?.timezone).toBe('America/New_York');
    expect(row?.unsubscribed_at).toBeNull();
  });

  it('upserts on a second subscribe with new prefs (resubscribe + change cooker)', async () => {
    stub = installFetchStub([
      { match: 'connect.mailerlite.com', respond: mailerliteOk },
    ]);
    // First subscribe
    await handleSubscribe(
      buildContext(
        buildReq({
          email: 'pitmaster@example.com',
          zip: '30303',
          cut: 'brisket-packer',
          cooker: 'offset',
        })
      )
    );
    // Mark unsubscribed manually then subscribe again with new cooker.
    await DB.prepare(`UPDATE subscribers SET unsubscribed_at = ? WHERE email = ?`)
      .bind(Date.now(), 'pitmaster@example.com')
      .run();
    stub.restore();
    stub = installFetchStub([{ match: 'connect.mailerlite.com', respond: mailerliteOk }]);
    await handleSubscribe(
      buildContext(
        buildReq({
          email: 'pitmaster@example.com',
          zip: '30303',
          cut: 'brisket-packer',
          cooker: 'pellet',
        })
      )
    );
    const row = await DB.prepare(
      `SELECT cooker, unsubscribed_at FROM subscribers WHERE email = ?`
    )
      .bind('pitmaster@example.com')
      .first<{ cooker: string; unsubscribed_at: number | null }>();
    expect(row?.cooker).toBe('pellet');
    expect(row?.unsubscribed_at).toBeNull();
  });

  it('queues retryable MailerLite failures but still writes the D1 row', async () => {
    stub = installFetchStub([
      { match: 'connect.mailerlite.com', respond: () => jsonResponse(503, {}) },
    ]);
    const res = await handleSubscribe(
      buildContext(
        buildReq({
          email: 'retry@example.com',
          zip: '30303',
          cut: 'pork-butt',
          cooker: 'pellet',
        })
      )
    );
    expect(res.status).toBe(202);
    expect((await res.json()) as { status: string }).toMatchObject({ status: 'queued' });
    const subRow = await DB.prepare(
      `SELECT email FROM subscribers WHERE email = ?`
    )
      .bind('retry@example.com')
      .first<{ email: string }>();
    expect(subRow?.email).toBe('retry@example.com');
    const retryRow = await DB.prepare(
      `SELECT request_kind, idempotency_key FROM mailerlite_retry WHERE idempotency_key = ?`
    )
      .bind('subscribe:retry@example.com')
      .first<{ request_kind: string; idempotency_key: string }>();
    expect(retryRow?.request_kind).toBe('subscribe');
  });

  it('returns 422 when MailerLite returns 422 (non-retryable) — D1 row NOT created', async () => {
    stub = installFetchStub([
      { match: 'connect.mailerlite.com', respond: () => jsonResponse(422, { errors: { email: ['bad'] } }) },
    ]);
    const res = await handleSubscribe(
      buildContext(buildReq({ email: 'bad@example.com', zip: '30303' }))
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'mailerlite_rejected' });
    const row = await DB.prepare(`SELECT email FROM subscribers WHERE email = ?`)
      .bind('bad@example.com')
      .first();
    expect(row).toBeNull();
  });

  it('400s on bad JSON', async () => {
    stub = installFetchStub([]);
    const res = await handleSubscribe(
      buildContext(
        new Request('https://x/api/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{not json',
        })
      )
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_json' });
  });

  it('400s on schema-invalid body (bad email, bad zip)', async () => {
    stub = installFetchStub([]);
    const cases: Array<unknown> = [
      { email: 'not-an-email', zip: '30303' },
      { email: 'ok@example.com', zip: 'abc' },
      { email: 'ok@example.com' /* no zip */ },
    ];
    for (const c of cases) {
      const res = await handleSubscribe(buildContext(buildReq(c)));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_body' });
    }
  });

  it('proceeds with UTC timezone when geocoder fails for a non-seeded zip', async () => {
    // 99999 isn't in metros; geocoder will be called; we fail it; the
    // handler should fall through to UTC instead of failing the subscribe.
    stub = installFetchStub([
      { match: 'geocoding-api.open-meteo.com', respond: () => jsonResponse(503, {}) },
      { match: 'connect.mailerlite.com', respond: mailerliteOk },
    ]);
    const res = await handleSubscribe(
      buildContext(
        buildReq({ email: 'geo@example.com', zip: '99999', cooker: 'kettle' })
      )
    );
    expect(res.status).toBe(202);
    const row = await DB.prepare(`SELECT timezone FROM subscribers WHERE email = ?`)
      .bind('geo@example.com')
      .first<{ timezone: string }>();
    expect(row?.timezone).toBe('UTC');
  });
});
