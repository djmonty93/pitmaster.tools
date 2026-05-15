import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handlePreferences } from '../../src/handlers/preferences';
import { signToken } from '../../src/lib/auth/token';
import { applyMigrations } from '../helpers/d1';
import { installFetchStub, jsonResponse, type FetchStub } from '../helpers/fetchStub';
import { buildContext, TEST_SUBSCRIBER_TOKEN_SECRET } from '../helpers/routeContext';

interface E {
  SMOKE_DB: D1Database;
}

const DB = (env as unknown as E).SMOKE_DB;

beforeAll(async () => {
  await applyMigrations(DB);
});

let validToken = '';
let stub: FetchStub | null = null;

beforeEach(async () => {
  await DB.prepare(`DELETE FROM subscribers`).run();
  await DB.prepare(`DELETE FROM mailerlite_retry`).run();
  await DB.prepare(
    `INSERT INTO subscribers (email, zip, cut, cooker, timezone, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind('me@example.com', '30303', 'brisket-flat', 'offset', 'America/New_York', Date.now())
    .run();
  validToken = await signToken('me@example.com', TEST_SUBSCRIBER_TOKEN_SECRET);
});

afterEach(() => {
  stub?.restore();
  stub = null;
});

const mailerliteOk = () =>
  jsonResponse(200, {
    data: { id: 'sub_42', email: 'me@example.com', status: 'active' },
  });

describe('GET /api/preferences', () => {
  it('returns the subscriber row when email + token validate', async () => {
    const res = await handlePreferences(
      buildContext(
        new Request(
          `https://x/api/preferences?email=me@example.com&token=${validToken}`,
          { method: 'GET' }
        )
      )
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      email: 'me@example.com',
      cut: 'brisket-flat',
      cooker: 'offset',
      timezone: 'America/New_York',
      subscribed: true,
    });
  });

  it("reports subscribed:false when unsubscribed_at is set", async () => {
    await DB.prepare(`UPDATE subscribers SET unsubscribed_at = ? WHERE email = ?`)
      .bind(Date.now(), 'me@example.com')
      .run();
    const res = await handlePreferences(
      buildContext(
        new Request(
          `https://x/api/preferences?email=me@example.com&token=${validToken}`,
          { method: 'GET' }
        )
      )
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { subscribed: boolean }).toMatchObject({ subscribed: false });
  });

  it('400s when ?email or ?token is missing', async () => {
    const missingBoth = await handlePreferences(
      buildContext(new Request('https://x/api/preferences', { method: 'GET' }))
    );
    expect(missingBoth.status).toBe(400);

    const missingToken = await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences?email=me@example.com', { method: 'GET' })
      )
    );
    expect(missingToken.status).toBe(400);
  });

  it('401s when the token does not validate (both malformed and wrong-but-valid-format collapse to the same response)', async () => {
    // Malformed token shape, valid email.
    const malformed = await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences?email=me@example.com&token=garbage', {
          method: 'GET',
        })
      )
    );
    expect(malformed.status).toBe(401);
    expect(await malformed.json()).toMatchObject({ error: 'invalid_credentials' });

    // Well-formed but wrong-secret token.
    const wrongSig = await signToken('me@example.com', 'wrong-secret');
    const mismatched = await handlePreferences(
      buildContext(
        new Request(
          `https://x/api/preferences?email=me@example.com&token=${wrongSig}`,
          { method: 'GET' }
        )
      )
    );
    expect(mismatched.status).toBe(401);
    expect(await mismatched.json()).toMatchObject({ error: 'invalid_credentials' });
  });

  it('cannot be used as an enumeration oracle — unknown email still requires a valid token', async () => {
    // A token signed for a real email won't validate against an
    // arbitrary other email, so adversaries can't probe existence.
    const otherToken = await signToken('attacker@example.com', TEST_SUBSCRIBER_TOKEN_SECRET);
    const res = await handlePreferences(
      buildContext(
        new Request(
          `https://x/api/preferences?email=me@example.com&token=${otherToken}`,
          { method: 'GET' }
        )
      )
    );
    expect(res.status).toBe(401);
  });

  it('does NOT leak zip in the GET response', async () => {
    const res = await handlePreferences(
      buildContext(
        new Request(
          `https://x/api/preferences?email=me@example.com&token=${validToken}`,
          { method: 'GET' }
        )
      )
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['zip']).toBeUndefined();
  });
});

describe('PATCH /api/preferences', () => {
  it('updates cut in D1 AND syncs bbq_cut_pref to MailerLite (token valid)', async () => {
    stub = installFetchStub([{ match: 'connect.mailerlite.com', respond: mailerliteOk }]);
    const res = await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'me@example.com', token: validToken, cut: 'pork-butt' }),
        })
      )
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({ status: 'sent' });

    const row = await DB.prepare(`SELECT cut, cooker FROM subscribers WHERE email = ?`)
      .bind('me@example.com')
      .first<{ cut: string; cooker: string }>();
    expect(row?.cut).toBe('pork-butt');
    expect(row?.cooker).toBe('offset');

    // POST /api/subscribers with the new field — MailerLite-side
    // fields stay in sync with D1 so the regional automation's
    // {$if:bbq_cut_pref="..."} merge tag reflects the new pref.
    const mlCall = stub.calls.find((c) => c.method === 'POST');
    expect(mlCall).toBeDefined();
    const body = mlCall!.body as { email: string; fields: Record<string, string> };
    expect(body.email).toBe('me@example.com');
    // Full snapshot — includes the seed's cooker='offset' even though
    // this PATCH only changed cut. See "snapshots the full preference
    // set" test below for the why.
    expect(body.fields).toEqual({ bbq_cut_pref: 'pork-butt', bbq_cooker_pref: 'offset' });
  });

  it('uses updateSubscriberFields (no status field) so a race with unsubscribe cannot reactivate', async () => {
    // Regression for [Self-P1] pass-14: client.subscribe always posts
    // `status: 'active'`. The handler's snapshot check catches the
    // common case, but a user could unsubscribe between the snapshot
    // read and the network call. updateSubscriberFields omits status
    // entirely so MailerLite preserves whatever the upstream has —
    // the unsubscribed status survives a racing preferences PATCH.
    stub = installFetchStub([{ match: 'connect.mailerlite.com', respond: mailerliteOk }]);
    const res = await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'me@example.com', token: validToken, cut: 'pork-butt' }),
        })
      )
    );
    expect(res.status).toBe(200);
    const mlCall = stub.calls.find((c) => c.method === 'POST');
    expect(mlCall).toBeDefined();
    const body = mlCall!.body as Record<string, unknown>;
    // The status field MUST NOT be present — that's the whole point.
    expect(body.status).toBeUndefined();
    expect(body.email).toBe('me@example.com');
  });

  it('skips MailerLite sync for unsubscribed users to avoid silent reactivation', async () => {
    // Regression for [P2] pass-11: client.subscribe always posts
    // status:'active', so PATCHing prefs on an unsubscribed account
    // would silently re-opt-them-in via MailerLite. Skip the sync
    // and report status='skipped' — D1 still records the new pref.
    await DB.prepare(`UPDATE subscribers SET unsubscribed_at = ? WHERE email = ?`)
      .bind(Date.now(), 'me@example.com')
      .run();
    // No fetch stub installed — the handler must NOT call MailerLite.
    const res = await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'me@example.com', token: validToken, cut: 'pork-butt' }),
        })
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('skipped');
    // D1 still reflects the new pref so a future resubscribe pushes
    // the latest state fresh.
    const row = await DB.prepare(`SELECT cut FROM subscribers WHERE email = ?`)
      .bind('me@example.com')
      .first<{ cut: string }>();
    expect(row?.cut).toBe('pork-butt');
  });

  it('enqueues retry on non-retryable preference sync failure (does NOT silently report sent)', async () => {
    // Regression for [P2] pass-11: a missing custom field or revoked
    // key returns a non-retryable 4xx. Old code reported 'sent' even
    // though MailerLite still has stale merge fields. Now the response
    // says 'queued' and a retry row is written so the drain audits it.
    stub = installFetchStub([
      { match: 'connect.mailerlite.com', respond: () => jsonResponse(400, { error: 'bad' }) },
    ]);
    const res = await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'me@example.com', token: validToken, cut: 'pork-butt' }),
        })
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('queued');
    const retryRow = await DB.prepare(
      `SELECT request_kind FROM mailerlite_retry WHERE idempotency_key = ?`
    )
      .bind('preferences:me@example.com')
      .first<{ request_kind: string }>();
    expect(retryRow?.request_kind).toBe('subscribe');
  });

  it('snapshots the full preference set after UPDATE — concurrent PATCHes do not lose fields on retry', async () => {
    // Regression for [P2] pass-7 finding: two PATCHes during a
    // MailerLite outage used to enqueue under the same idempotency
    // key with payloads carrying only their own delta. The second
    // ON CONFLICT replaced the first's payload, losing the first's
    // field. Now each PATCH queues the FULL current state.
    stub = installFetchStub([
      { match: 'connect.mailerlite.com', respond: () => jsonResponse(503, {}) },
    ]);
    // First PATCH: change cut. MailerLite is down → queued.
    await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'me@example.com', token: validToken, cut: 'pork-butt' }),
        })
      )
    );
    // Second PATCH: change cooker. MailerLite still down → queued.
    await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'me@example.com', token: validToken, cooker: 'kamado' }),
        })
      )
    );
    // The retry row's payload must carry BOTH fields — the second
    // PATCH's snapshot read sees cut='pork-butt' (committed by the
    // first PATCH) AND cooker='kamado'.
    const retryRow = await DB.prepare(
      `SELECT request_payload FROM mailerlite_retry WHERE idempotency_key = ?`
    )
      .bind('preferences:me@example.com')
      .first<{ request_payload: string }>();
    expect(retryRow).toBeDefined();
    const payload = JSON.parse(retryRow!.request_payload) as {
      fields: Record<string, string>;
    };
    expect(payload.fields).toEqual({
      bbq_cut_pref: 'pork-butt',
      bbq_cooker_pref: 'kamado',
    });
  });

  it('enqueues a retry on retryable MailerLite failure during preference sync', async () => {
    stub = installFetchStub([
      { match: 'connect.mailerlite.com', respond: () => jsonResponse(503, {}) },
    ]);
    const res = await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'me@example.com', token: validToken, cooker: 'kamado' }),
        })
      )
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({ status: 'queued' });
    // D1 still applied — caller succeeds locally.
    const row = await DB.prepare(`SELECT cooker FROM subscribers WHERE email = ?`)
      .bind('me@example.com')
      .first<{ cooker: string }>();
    expect(row?.cooker).toBe('kamado');
    // Retry row with the preferences stage payload so the drain
    // re-syncs without doing a full subscribe+group reassign.
    const retryRow = await DB.prepare(
      `SELECT request_payload FROM mailerlite_retry WHERE idempotency_key = ?`
    )
      .bind('preferences:me@example.com')
      .first<{ request_payload: string }>();
    expect(retryRow).toBeDefined();
    const payload = JSON.parse(retryRow!.request_payload) as {
      stage: string;
      email: string;
      fields: Record<string, string>;
    };
    expect(payload.stage).toBe('preferences');
    // Snapshot includes the prior cut='brisket-flat' from the seed
    // — not just the cooker delta — so a later concurrent PATCH
    // cannot lose the cooker value via idempotency-key overwrite.
    expect(payload.fields).toEqual({
      bbq_cut_pref: 'brisket-flat',
      bbq_cooker_pref: 'kamado',
    });
  });

  it('401s on a PATCH whose token does not match the email', async () => {
    const wrongToken = await signToken('attacker@example.com', TEST_SUBSCRIBER_TOKEN_SECRET);
    const res = await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'me@example.com',
            token: wrongToken,
            cut: 'pork-butt',
          }),
        })
      )
    );
    expect(res.status).toBe(401);
    const row = await DB.prepare(`SELECT cut FROM subscribers WHERE email = ?`)
      .bind('me@example.com')
      .first<{ cut: string }>();
    expect(row?.cut).toBe('brisket-flat'); // unchanged
  });

  it('400s when PATCH body has no field changes', async () => {
    const res = await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'me@example.com', token: validToken }),
        })
      )
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'no_changes' });
  });

  it('404s when PATCH targets an email with no row (after token validates)', async () => {
    const otherToken = await signToken('nobody@example.com', TEST_SUBSCRIBER_TOKEN_SECRET);
    const res = await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'nobody@example.com',
            token: otherToken,
            cut: 'fish',
          }),
        })
      )
    );
    expect(res.status).toBe(404);
  });

  it('400s on schema-invalid PATCH (bad cooker)', async () => {
    const res = await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'me@example.com',
            token: validToken,
            cooker: 'microwave',
          }),
        })
      )
    );
    expect(res.status).toBe(400);
  });

  it('clears the MailerLite field when PATCH sets a preference to null (empty string)', async () => {
    stub = installFetchStub([{ match: 'connect.mailerlite.com', respond: mailerliteOk }]);
    const res = await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'me@example.com', token: validToken, cut: null }),
        })
      )
    );
    expect(res.status).toBe(200);
    const row = await DB.prepare(`SELECT cut FROM subscribers WHERE email = ?`)
      .bind('me@example.com')
      .first<{ cut: string | null }>();
    expect(row?.cut).toBeNull();
    // MailerLite POST carries bbq_cut_pref='' so the conditional
    // merge tag `{$if:bbq_cut_pref="brisket-flat"}` no longer matches.
    // The cooker stays at its prior 'offset' value via the snapshot.
    const mlCall = stub.calls.find((c) => c.method === 'POST');
    expect(mlCall).toBeDefined();
    const body = mlCall!.body as { fields: Record<string, string> };
    expect(body.fields).toEqual({ bbq_cut_pref: '', bbq_cooker_pref: 'offset' });
  });

  it('allows setting cut to null (no preference) — D1 reflects the clear', async () => {
    stub = installFetchStub([{ match: 'connect.mailerlite.com', respond: mailerliteOk }]);
    const res = await handlePreferences(
      buildContext(
        new Request('https://x/api/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'me@example.com', token: validToken, cut: null }),
        })
      )
    );
    expect(res.status).toBe(200);
    const row = await DB.prepare(`SELECT cut FROM subscribers WHERE email = ?`)
      .bind('me@example.com')
      .first<{ cut: string | null }>();
    expect(row?.cut).toBeNull();
  });
});
