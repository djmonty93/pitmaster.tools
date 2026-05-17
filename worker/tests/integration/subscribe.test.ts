import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleSubscribe } from '../../src/handlers/subscribe';
import { signToken } from '../../src/lib/auth/token';
import { applyMigrations } from '../helpers/d1';
import { installFetchStub, jsonResponse, type FetchStub } from '../helpers/fetchStub';
import { buildContext, TEST_SUBSCRIBER_TOKEN_SECRET } from '../helpers/routeContext';

interface E {
  SMOKE_DB: D1Database;
  WEATHER_KV: KVNamespace;
}

const DB = (env as unknown as E).SMOKE_DB;
const KV = (env as unknown as E).WEATHER_KV;

beforeAll(async () => {
  await applyMigrations(DB);
});

// Pre-seed Sender group ids so the handler skips the listGroups
// network call. The integration tests don't care about cache-fill
// behavior — that's covered by tests/unit/sender/groups.test.ts.
async function seedGroupIds() {
  await KV.put('sender_group_id:pitmaster_all', '1');
  await KV.put('sender_group_id:pitmaster_northeast', '2');
  await KV.put('sender_group_id:pitmaster_southeast', '3');
  await KV.put('sender_group_id:pitmaster_midwest', '4');
  await KV.put('sender_group_id:pitmaster_south_central', '5');
  await KV.put('sender_group_id:pitmaster_mountain', '6');
  await KV.put('sender_group_id:pitmaster_pacific', '7');
}

let stub: FetchStub | null = null;
beforeEach(async () => {
  await DB.prepare(`DELETE FROM subscribers`).run();
  await DB.prepare(`DELETE FROM sender_retry`).run();
  await seedGroupIds();
});
afterEach(() => {
  stub?.restore();
  stub = null;
});

const senderOk = () =>
  jsonResponse(200, {
    data: { id: 'sub_123', email: 'pitmaster@example.com', status: 'active' },
  });

const groupAssignOk = () => jsonResponse(200, { data: {} });

/**
 * Standard stub for the happy path: subscribe POST returns sub_123 and
 * every group-assignment POST returns empty 200. The `/groups/` match
 * MUST come before the broader subscribers match because substring
 * matching picks the first hit.
 */
const happyPathHits = () => [
  { match: '/groups/', respond: groupAssignOk },
  { match: 'api.sender.net', respond: senderOk },
];

function buildReq(body: unknown): Request {
  return new Request('https://x/api/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/subscribe', () => {
  it('writes to Sender + D1, derives region from zip, assigns groups, returns token', async () => {
    stub = installFetchStub(happyPathHits());
    const res = await handleSubscribe(
      buildContext(
        buildReq({
          email: 'pitmaster@example.com',
          // 30303 = Atlanta, GA → southeast.
          zip: '30303',
          cut: 'brisket-packer',
          cooker: 'offset',
        })
      )
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      status: string;
      espId: string;
      token: string;
      region: string;
    };
    expect(body.status).toBe('sent');
    expect(body.espId).toBe('sub_123');
    expect(body.region).toBe('southeast');
    const expected = await signToken('pitmaster@example.com', TEST_SUBSCRIBER_TOKEN_SECRET);
    expect(body.token).toBe(expected);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);

    // D1 row carries the derived region.
    const row = await DB.prepare(`SELECT region FROM subscribers WHERE email = ?`)
      .bind('pitmaster@example.com')
      .first<{ region: string }>();
    expect(row?.region).toBe('southeast');

    // Sender POST body carries bbq_* fields with bbq_region populated.
    const subscribeCall = stub.calls.find(
      (c) =>
        c.method === 'POST' &&
        c.url.endsWith('/subscribers') &&
        !c.url.includes('/groups/')
    );
    expect(subscribeCall).toBeDefined();
    const subBody = subscribeCall!.body as { fields: Record<string, string> };
    // Sender wraps field keys in {$...} syntax via wrapFieldKeys.
    expect(subBody.fields).toMatchObject({
      '{$bbq_zip}': '30303',
      '{$bbq_state}': 'GA',
      '{$bbq_region}': 'southeast',
      '{$bbq_cut_pref}': 'brisket-packer',
      '{$bbq_cooker_pref}': 'offset',
      '{$bbq_timezone}': 'America/New_York',
    });

    // Two group assignment POSTs: pitmaster_all (id=1) + pitmaster_southeast (id=3).
    const assignCalls = stub.calls.filter(
      (c) => c.method === 'POST' && c.url.includes('/groups/')
    );
    expect(assignCalls).toHaveLength(2);
    expect(assignCalls.some((c) => c.url.endsWith('/groups/1'))).toBe(true);
    expect(assignCalls.some((c) => c.url.endsWith('/groups/3'))).toBe(true);
  });

  it('routes a TX zip into south_central and assigns the south_central group', async () => {
    stub = installFetchStub(happyPathHits());
    const res = await handleSubscribe(
      buildContext(
        buildReq({
          email: 'tex@example.com',
          // 78701 = Austin, TX.
          zip: '78701',
        })
      )
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { region: string };
    expect(body.region).toBe('south_central');
    const assignCalls = stub.calls.filter(
      (c) => c.method === 'POST' && c.url.includes('/groups/')
    );
    expect(assignCalls.some((c) => c.url.endsWith('/groups/5'))).toBe(true);
  });

  it("normalizes the email (trim + lowercase) so case-only differences don't fork the row", async () => {
    stub = installFetchStub([
      { match: '/groups/', respond: groupAssignOk },
      {
        match: 'connect.mailerlite.com',
        respond: () =>
          jsonResponse(200, { data: { id: 'sub_1', email: 'me@example.com', status: 'active' } }),
      },
    ]);
    const res = await handleSubscribe(
      buildContext(buildReq({ email: '  Me@Example.COM  ', zip: '30303' }))
    );
    expect(res.status).toBe(202);
    const row = await DB.prepare(`SELECT email FROM subscribers WHERE email = ?`)
      .bind('me@example.com')
      .first<{ email: string }>();
    expect(row?.email).toBe('me@example.com');
  });

  it('upserts on a second subscribe with new prefs (resubscribe + change cooker)', async () => {
    stub = installFetchStub(happyPathHits());
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
    await DB.prepare(`UPDATE subscribers SET unsubscribed_at = ? WHERE email = ?`)
      .bind(Date.now(), 'pitmaster@example.com')
      .run();
    stub.restore();
    stub = installFetchStub(happyPathHits());
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
      `SELECT cooker, unsubscribed_at, region FROM subscribers WHERE email = ?`
    )
      .bind('pitmaster@example.com')
      .first<{ cooker: string; unsubscribed_at: number | null; region: string }>();
    expect(row?.cooker).toBe('pellet');
    expect(row?.unsubscribed_at).toBeNull();
    expect(row?.region).toBe('southeast');
  });

  it('queues retryable Sender failures but still writes the D1 row + returns a token', async () => {
    stub = installFetchStub([
      { match: 'api.sender.net', respond: () => jsonResponse(503, {}) },
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
    const body = (await res.json()) as { status: string; token: string };
    expect(body.status).toBe('queued');
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    const subRow = await DB.prepare(`SELECT email, region FROM subscribers WHERE email = ?`)
      .bind('retry@example.com')
      .first<{ email: string; region: string }>();
    expect(subRow?.email).toBe('retry@example.com');
    // Region is still derived locally even when Sender is down.
    expect(subRow?.region).toBe('southeast');
    const retryRow = await DB.prepare(
      `SELECT request_kind FROM sender_retry WHERE idempotency_key = ?`
    )
      .bind('subscribe:retry@example.com')
      .first<{ request_kind: string }>();
    expect(retryRow?.request_kind).toBe('subscribe');
  });

  it('includes oldRegion in the queued payload on a region-change resubscribe during outage', async () => {
    // Regression for [Self-P1] pass-14: when Sender is down on a
    // region-change resubscribe, the handler never got an espId
    // so the stale-region detach is skipped. Without plumbing oldRegion
    // through to the retry payload, the drain assigns the new region's
    // group but leaves the user in the old region too. The payload
    // must carry oldRegion so the drain can finish the cleanup.
    stub = installFetchStub(happyPathHits());
    // First subscribe: 30303 → southeast.
    await handleSubscribe(
      buildContext(buildReq({ email: 'move-outage@example.com', zip: '30303' }))
    );
    stub.restore();

    // Now Sender goes down. Resubscribe to 78701 (south_central) —
    // geocode succeeds, but the Sender subscribe call 5xx's so we
    // queue. The payload MUST carry oldRegion='southeast' for the
    // drain to detach pitmaster_southeast after recovery.
    stub = installFetchStub([
      { match: 'geocoding-api.open-meteo.com', respond: () => jsonResponse(200, {
        results: [{
          name: 'Austin', latitude: 30.27, longitude: -97.74,
          country_code: 'US', admin1: 'Texas', timezone: 'America/Chicago',
        }],
      }) },
      { match: 'api.sender.net', respond: () => jsonResponse(503, {}) },
    ]);
    const res = await handleSubscribe(
      buildContext(buildReq({ email: 'move-outage@example.com', zip: '78701' }))
    );
    expect(res.status).toBe(202);
    expect((await res.json()) as { status: string }).toMatchObject({ status: 'queued' });

    const retryRow = await DB.prepare(
      `SELECT request_payload FROM sender_retry WHERE idempotency_key = ?`
    )
      .bind('subscribe:move-outage@example.com')
      .first<{ request_payload: string }>();
    expect(retryRow).toBeDefined();
    const payload = JSON.parse(retryRow!.request_payload) as {
      email: string;
      region: string;
      oldRegion: string;
    };
    expect(payload.email).toBe('move-outage@example.com');
    expect(payload.region).toBe('south_central');
    expect(payload.oldRegion).toBe('southeast');
  });

  it('returns 422 when Sender returns 422 (non-retryable) — D1 row NOT created', async () => {
    stub = installFetchStub([
      {
        match: 'api.sender.net',
        respond: () => jsonResponse(422, { errors: { email: ['bad'] } }),
      },
    ]);
    const res = await handleSubscribe(
      buildContext(buildReq({ email: 'bad@example.com', zip: '30303' }))
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'sender_rejected' });
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

  it('preserves the original bbq_signup_date across resubscribes', async () => {
    // Regression for [P2] pass-12: every subscribe call used to send
    // today as bbq_signup_date, overwriting the original on every
    // resubscribe. Now the handler reads the prior row's created_at
    // and uses that — only a fresh row gets today.
    stub = installFetchStub(happyPathHits());
    // Seed an existing subscriber with a known prior created_at.
    const seedTime = new Date('2024-03-15T10:00:00Z').getTime();
    await DB.prepare(
      `INSERT INTO subscribers (email, zip, timezone, region, created_at)
         VALUES (?, ?, ?, ?, ?)`
    )
      .bind('og@example.com', '30303', 'America/New_York', 'southeast', seedTime)
      .run();

    const res = await handleSubscribe(
      buildContext(buildReq({ email: 'og@example.com', zip: '30303', cooker: 'pellet' }))
    );
    expect(res.status).toBe(202);
    const subscribeCall = stub.calls.find(
      (c) =>
        c.method === 'POST' &&
        c.url.endsWith('/subscribers') &&
        !c.url.includes('/groups/')
    );
    const body = subscribeCall!.body as { fields: Record<string, string> };
    // Sender wraps field keys in {$...} syntax.
    expect(body.fields['{$bbq_signup_date}']).toBe('2024-03-15');
  });

  it('on resubscribe with a different region: detaches stale region group, assigns the new one', async () => {
    // Regression for the [P2] pass-4 finding: an existing subscriber
    // who moves from southeast → south_central must end up in
    // pitmaster_south_central only, not both regional groups.
    stub = installFetchStub(happyPathHits());
    // First subscribe: Atlanta GA → southeast (group id 3).
    await handleSubscribe(
      buildContext(buildReq({ email: 'mover@example.com', zip: '30303' }))
    );
    stub.restore();

    // Resubscribe with an Austin TX zip → south_central (group id 5).
    stub = installFetchStub(happyPathHits());
    const res = await handleSubscribe(
      buildContext(buildReq({ email: 'mover@example.com', zip: '78701' }))
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { region: string };
    expect(body.region).toBe('south_central');

    // POST /groups/5 (new south_central) AND DELETE /groups/3 (old
    // southeast) both happened. pitmaster_all (id=1) is re-asserted
    // by assignBbqGroups but a duplicate assign is a no-op server-side
    // so we don't strictly assert on it. Note: DELETE calls to
    // /groups/ go to api.sender.net/v2/subscribers/groups/<id>.
    const assignCalls = stub.calls.filter(
      (c) => c.method === 'POST' && c.url.includes('/groups/')
    );
    expect(assignCalls.some((c) => c.url.endsWith('/groups/5'))).toBe(true);
    const detachCalls = stub.calls.filter(
      (c) => c.method === 'DELETE' && c.url.includes('/groups/')
    );
    expect(detachCalls).toHaveLength(1);
    expect(detachCalls[0]!.url).toContain('/groups/3');

    const row = await DB.prepare(`SELECT region FROM subscribers WHERE email = ?`)
      .bind('mover@example.com')
      .first<{ region: string }>();
    expect(row?.region).toBe('south_central');
  });

  it('enqueues a group_remove retry when the stale-region detach fails (no silent log-and-drop)', async () => {
    // Regression for [P2] pass-7: when the new assignment succeeds
    // but the old-region DELETE returns 5xx, the subscriber used to
    // stay in BOTH regions forever because the failure was just
    // logged. Now a group_remove retry row is queued.
    //
    // Setup: first subscribe to 30303 (southeast) so the D1 row has
    // region='southeast'. Then resubscribe to 78701 (south_central)
    // with /groups/ POST returning 200 (assign succeeds) but the
    // DELETE returning 503 (transient cleanup fail). Hmm — the
    // fetchStub's substring matcher can't distinguish POST vs DELETE
    // on the same URL substring. Use a method-checking respond fn.
    stub = installFetchStub(happyPathHits());
    await handleSubscribe(
      buildContext(buildReq({ email: 'move-cleanup@example.com', zip: '30303' }))
    );
    stub.restore();

    // The fetch stub matches by URL substring only, not method. We
    // need POST /groups/ → 200 and DELETE /groups/ → 503 to exercise
    // the assign-succeeds-but-cleanup-fails branch. Build a method-
    // aware fetch shim inline.
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = (async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? 'GET') as string;
      if (url.includes('/groups/') && method === 'DELETE') {
        return jsonResponse(503, {});
      }
      if (url.includes('/groups/')) {
        return jsonResponse(200, {});
      }
      return senderOk();
    }) as typeof fetch;

    try {
      const res = await handleSubscribe(
        buildContext(buildReq({ email: 'move-cleanup@example.com', zip: '78701' }))
      );
      expect(res.status).toBe(202);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe('sent');
      const retryRow = await DB.prepare(
        `SELECT request_kind, request_payload FROM sender_retry WHERE idempotency_key LIKE 'group_remove:%'`
      ).first<{ request_kind: string; request_payload: string }>();
      expect(retryRow?.request_kind).toBe('subscribe');
      const payload = JSON.parse(retryRow!.request_payload) as {
        stage: string;
        groupName: string;
      };
      expect(payload.stage).toBe('group_remove');
      expect(payload.groupName).toBe('pitmaster_southeast');
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  it('does NOT detach the old regional group when the new assignment fails (subscriber not stranded)', async () => {
    // Regression for the [P2] pass-6 finding: a region change whose
    // new-group assignment was queued used to ALSO detach the old
    // regional group, leaving the subscriber in neither regional
    // audience until the retry drain succeeded. A near-Friday move
    // would miss the digest entirely.
    stub = installFetchStub(happyPathHits());
    await handleSubscribe(
      buildContext(buildReq({ email: 'switcher@example.com', zip: '30303' }))
    );
    stub.restore();

    // Resubscribe with a TX zip but make the /groups/ POST fail.
    stub = installFetchStub([
      // Treat assignment as terminal-fail so the handler enqueues a
      // group_assign retry instead of catching with the retry path.
      { match: '/groups/', respond: () => jsonResponse(400, { error: 'bad' }) },
      { match: 'api.sender.net', respond: senderOk },
    ]);
    const res = await handleSubscribe(
      buildContext(buildReq({ email: 'switcher@example.com', zip: '78701' }))
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('queued');

    // No DELETE call: the new south_central assignment failed, so we
    // must NOT detach the southeast group either. The subscriber
    // stays in pitmaster_southeast until the retry drain completes
    // the assignment.
    const deleteCalls = stub.calls.filter((c) => c.method === 'DELETE');
    expect(deleteCalls).toHaveLength(0);
  });

  it('preserves prior region on resubscribe when geocoder fails on a non-seeded zip', async () => {
    // Regression for [P2] pass-5 finding: a resubscribe whose new zip
    // can't be geocoded would clobber the D1 region to NULL and then
    // detach the pitmaster_<oldRegion> group via the stale-cleanup
    // path. The subscriber would lose regional delivery over a
    // transient upstream failure. Fix: fall back to oldRegion.
    stub = installFetchStub(happyPathHits());
    await handleSubscribe(
      buildContext(buildReq({ email: 'sticky@example.com', zip: '30303' }))
    );
    stub.restore();

    // Now resubscribe with a non-seeded zip while the geocoder is down.
    await KV.delete('geo:v2:99999');
    stub = installFetchStub([
      { match: 'geocoding-api.open-meteo.com', respond: () => jsonResponse(503, {}) },
      { match: '/groups/', respond: groupAssignOk },
      { match: 'api.sender.net', respond: senderOk },
    ]);
    const res = await handleSubscribe(
      buildContext(buildReq({ email: 'sticky@example.com', zip: '99999' }))
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { region: string };
    // Region is preserved from the prior southeast assignment.
    expect(body.region).toBe('southeast');

    // D1 region column was NOT clobbered to NULL.
    const row = await DB.prepare(`SELECT region FROM subscribers WHERE email = ?`)
      .bind('sticky@example.com')
      .first<{ region: string }>();
    expect(row?.region).toBe('southeast');

    // The stale-region detach must NOT have fired — oldRegion ===
    // effective new region, so there's nothing to clean up.
    const detachCalls = stub.calls.filter(
      (c) => c.method === 'DELETE' && c.url.includes('/groups/')
    );
    expect(detachCalls).toHaveLength(0);
  });

  it('on resubscribe with the SAME region: no stale-group DELETE', async () => {
    stub = installFetchStub(happyPathHits());
    await handleSubscribe(
      buildContext(buildReq({ email: 'samezip@example.com', zip: '30303' }))
    );
    stub.restore();

    stub = installFetchStub(happyPathHits());
    await handleSubscribe(
      buildContext(buildReq({ email: 'samezip@example.com', zip: '30303' }))
    );
    const detachCalls = stub.calls.filter(
      (c) => c.method === 'DELETE' && c.url.includes('/groups/')
    );
    expect(detachCalls).toHaveLength(0);
  });

  it('enqueues a group_assign retry and returns queued when group assignment hits a non-retryable error', async () => {
    // Regression for [P2] from review pass 2: a 4xx on group_assign
    // (cached id stale, group renamed, etc.) used to be swallowed
    // and the response still reported status='sent'. The subscriber
    // would land in Sender but not in pitmaster_<region>, so the
    // Friday cron would skip them. Now every group failure surfaces
    // via the retry queue and the response says 'queued'.
    stub = installFetchStub([
      { match: '/groups/', respond: () => jsonResponse(400, { error: 'bad' }) },
      { match: 'api.sender.net', respond: senderOk },
    ]);
    const res = await handleSubscribe(
      buildContext(buildReq({ email: 'p2@example.com', zip: '30303' }))
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; espId: string };
    expect(body.status).toBe('queued');
    expect(body.espId).toBe('sub_123');
    // Retry queue carries a staged group_assign row for the failed assignment.
    const retryRow = await DB.prepare(
      `SELECT request_kind, request_payload FROM sender_retry WHERE idempotency_key = ?`
    )
      .bind('group_assign:sub_123')
      .first<{ request_kind: string; request_payload: string }>();
    expect(retryRow?.request_kind).toBe('subscribe');
    const payload = JSON.parse(retryRow!.request_payload) as {
      stage: string;
      subscriberId: string;
      region: string;
    };
    expect(payload.stage).toBe('group_assign');
    expect(payload.subscriberId).toBe('sub_123');
    expect(payload.region).toBe('southeast');
  });

  it('enqueues a group_assign retry when resolveGroupId throws because the group is missing', async () => {
    // resolveGroupId throws a plain Error (not a SenderError) when
    // the group doesn't exist in the cache + listGroups doesn't return
    // it. That error path was the silent-swallow case in [P2]. Force
    // it by deleting the KV cache and returning a partial group list.
    await KV.delete('sender_group_id:pitmaster_all');
    await KV.delete('sender_group_id:pitmaster_southeast');
    stub = installFetchStub([
      // listGroups: returns only pitmaster_all, missing pitmaster_southeast.
      {
        match: '/v2/groups',
        respond: () =>
          jsonResponse(200, {
            data: [{ id: '1', name: 'pitmaster_all' }],
            links: { next: null },
            meta: {},
          }),
      },
      { match: '/groups/', respond: () => jsonResponse(200, { data: {} }) },
      { match: 'api.sender.net', respond: senderOk },
    ]);
    const res = await handleSubscribe(
      buildContext(buildReq({ email: 'missing@example.com', zip: '30303' }))
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('queued');
    const retryRow = await DB.prepare(
      `SELECT COUNT(*) AS c FROM sender_retry WHERE idempotency_key = ?`
    )
      .bind('group_assign:sub_123')
      .first<{ c: number }>();
    expect(retryRow?.c).toBe(1);
  });

  it('proceeds with null region + UTC timezone when geocoder fails for a non-seeded zip', async () => {
    stub = installFetchStub([
      { match: 'geocoding-api.open-meteo.com', respond: () => jsonResponse(503, {}) },
      { match: '/groups/', respond: groupAssignOk },
      { match: 'api.sender.net', respond: senderOk },
    ]);
    await KV.delete('geo:v2:99999');
    const res = await handleSubscribe(
      buildContext(buildReq({ email: 'geo@example.com', zip: '99999', cooker: 'kettle' }))
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { region: string | null };
    expect(body.region).toBeNull();
    const row = await DB.prepare(
      `SELECT timezone, region FROM subscribers WHERE email = ?`
    )
      .bind('geo@example.com')
      .first<{ timezone: string; region: string | null }>();
    expect(row?.timezone).toBe('UTC');
    expect(row?.region).toBeNull();

    // pitmaster_all is the only group assignment when region is unknown.
    const assignCalls = stub.calls.filter(
      (c) => c.method === 'POST' && c.url.includes('/groups/')
    );
    expect(assignCalls).toHaveLength(1);
    expect(assignCalls[0]!.url).toContain('/groups/1');
  });
});
