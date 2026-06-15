// POST /api/subscribe
//
// Body JSON: { email, zip, cut?, cooker?, timezone? }.
// (metroSlug is no longer accepted from the client — region is the
// canonical bucketing key and is derived server-side from zip.)
//
// Writes happen in this order:
//   1. resolveZip → (state, timezone, lat/lon, metroSlug)
//   2. stateToRegion → Region (or null if state can't be resolved)
//   3. Sender.net subscribe (upsert) with bbq_* fields
//   4. assignBbqGroups: pitmaster_all + pitmaster_<region>
//   5. D1 INSERT … ON CONFLICT (email) DO UPDATE on `subscribers`
//
// On retryable Sender.net failures the call enqueues on
// `sender_retry` and STILL writes the D1 row so the user can
// receive Friday emails once the queue drains. Non-retryable failures
// surface 4xx and the D1 row is not created.
//
// Geocoder degraded path: if the zip can't be resolved (non-US zip,
// upstream outage), we fall back to UTC timezone, null state, and null
// region. The subscriber is added to `pitmaster_all` only — they'll
// receive nothing from the Friday cron (which iterates regions) until
// region gets backfilled. That's acceptable because the alternative is
// rejecting the signup, which loses a future subscriber over a
// transient upstream failure.

import { z } from 'zod';
import { signToken } from '../lib/auth/token.js';
import { createSenderClient } from '../lib/sender/client.js';
import { SenderError } from '../lib/sender/errors.js';
import {
  ALL_GROUP_NAME,
  assignBbqGroups,
  regionToGroupName,
  resolveGroupId,
} from '../lib/sender/groups.js';
import { enqueue } from '../lib/sender/retry.js';
import { toBbqSubscriberFields, type BbqSubscriberFields } from '../lib/sender/tags.js';
import { GeocoderError, resolveZip, type ZipLocation } from '../lib/geo/zipGeocoder.js';
import { RegionError, stateToRegion, type Region } from '../lib/regions/index.js';
import { summarizeError } from '../lib/redact.js';
import { json, jsonError, type RouteContext } from '../router.js';

// Trim + lowercase the email BEFORE running the email-shape check.
const NormalizedEmail = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
  z.string().email()
);

const SubscribeBody = z.object({
  email: NormalizedEmail,
  zip: z.string().regex(/^\d{5}$/),
  cut: z
    .enum([
      'brisket-flat', 'brisket-packer', 'pork-butt',
      'spare-ribs', 'baby-back-ribs', 'pork-loin',
      'whole-chicken', 'spatchcock-chicken', 'chicken-thighs',
      'whole-turkey', 'turkey-breast', 'fish', 'lamb-shoulder',
    ])
    .nullable()
    .optional(),
  cooker: z.enum(['offset', 'pellet', 'kamado', 'kettle', 'electric']).nullable().optional(),
  timezone: z.string().min(3).nullable().optional(),
});

export async function handleSubscribe(rc: RouteContext): Promise<Response> {
  let raw: unknown;
  try {
    raw = await rc.request.json();
  } catch (_err) {
    return jsonError(400, 'invalid_json', 'Request body must be JSON');
  }
  const parsed = SubscribeBody.safeParse(raw);
  if (!parsed.success) {
    return jsonError(400, 'invalid_body', 'Request body failed validation', parsed.error.issues);
  }
  const body = parsed.data;

  // Look up the prior region BEFORE we resolve the zip. Two things
  // depend on it: (a) the degraded-geocoder fallback (preserve the
  // prior region rather than clobber to null over a transient outage),
  // and (b) the stale-regional-group cleanup that fires after a
  // region change.
  const priorRow = await rc.env.SMOKE_DB.prepare(
    `SELECT region, created_at FROM subscribers WHERE email = ?`
  )
    .bind(body.email)
    .first<{ region: string | null; created_at: number | null }>();
  const oldRegion: Region | null = (priorRow?.region as Region | null) ?? null;
  // bbq_signup_date is "first subscribe date" per
  // docs/portfolio-email-architecture.md. On resubscribe we keep the
  // original D1 created_at so subscriber-age automation conditionals
  // ({$if:bbq_signup_date<2026-01-01}) and analytics stay stable. Only
  // a brand-new row uses today.
  const signupDate = priorRow?.created_at != null ? new Date(priorRow.created_at) : new Date();

  // Resolve location → (state, timezone, metroSlug, lat/lon, name).
  // A geocoder failure is degraded-but-functional: we proceed with
  // null region and UTC timezone. The subscriber lands in pitmaster_all
  // (or keeps their prior regional group — see effectiveRegion below).
  let location: Partial<ZipLocation> = {};
  try {
    location = await resolveZip(rc.env.WEATHER_KV, rc.env.SMOKE_DB, body.zip);
  } catch (err) {
    if (!(err instanceof GeocoderError)) throw err;
    // Fall through with defaults.
  }
  const timezone = body.timezone ?? location.timezone ?? 'UTC';
  const state: string | null = location.state ?? null;
  const resolvedRegion: Region | null = (() => {
    if (!state) return null;
    try {
      return stateToRegion(state);
    } catch (err) {
      if (!(err instanceof RegionError)) throw err;
      return null;
    }
  })();
  // If the geocoder couldn't supply a region but the subscriber
  // already had one in D1, keep using the prior region. Without this,
  // a transient geocoder outage on resubscribe would (a) clobber the
  // D1 region column to NULL and (b) trigger the stale-region cleanup
  // and detach the pitmaster_<oldRegion> group, dropping a valid
  // subscriber out of the regional Friday digest over an upstream blip.
  const region: Region | null = resolvedRegion ?? oldRegion;

  const fields: BbqSubscriberFields = toBbqSubscriberFields({
    zip: body.zip,
    city: location.name ?? null,
    // toBbqSubscriberFields rejects an invalid state; pass a synthetic
    // "ZZ" sentinel when state is unknown so the field shape is valid
    // for the call. The bbq_state field is stripped below for the
    // unknown-state path so Sender.net doesn't store the sentinel.
    state: state ?? 'ZZ',
    // Same pattern: bbq_region key is keyed off the freshly-resolved
    // region (not the oldRegion fallback) so the Sender.net record
    // reflects what we observed now. When resolvedRegion is null we
    // strip the key below — the existing Sender.net field value
    // (from a prior subscribe) is preserved by an absent key.
    region: resolvedRegion ?? ('pacific' as Region),
    cut: body.cut ?? null,
    cooker: body.cooker ?? null,
    timezone,
    signupDate,
  });
  if (!state) {
    delete (fields as Partial<BbqSubscriberFields>).bbq_state;
  }
  if (!resolvedRegion) {
    delete (fields as Partial<BbqSubscriberFields>).bbq_region;
  }

  const client = createSenderClient({ apiToken: rc.env.SENDER_API_TOKEN });

  let espId: string | null = null;
  let espStatus: 'sent' | 'queued' = 'sent';
  try {
    const res = await client.subscribe({ email: body.email, fields });
    espId = res.id;
  } catch (err) {
    if (err instanceof SenderError && err.shouldRetry) {
      const idempotencyKey = `subscribe:${body.email.toLowerCase()}`;
      // `region` rides along on the retry payload so the drain
      // replays subscribe AND assignBbqGroups, not just the subscribe
      // POST. Without it the recovered subscriber would be active in
      // Sender.net but not in any pitmaster_* group — excluded from
      // the Friday cron despite the D1 row being active.
      //
      // `oldRegion` rides along when this is a region-change
      // resubscribe so the drain can detach the stale regional group
      // AFTER it assigns the new one. Without this, a transient
      // Sender.net outage during a zip move would leave the user in
      // BOTH pitmaster_<old> and pitmaster_<new> after recovery —
      // the handler's own detach logic was bypassed because we never
      // got an espId on the original call.
      await enqueue(rc.env.SMOKE_DB, {
        kind: 'subscribe',
        payload: { email: body.email, fields, region, oldRegion },
        idempotencyKey,
        cause: err,
      });
      espStatus = 'queued';
    } else if (err instanceof SenderError) {
      // Surface the real cause for observability — this path was silent, so
      // a misconfigured/missing SENDER_API_TOKEN (401), a request-shape
      // mismatch (422), or a malformed Sender response all looked identical
      // to a genuine rejection. summarizeError redacts secrets/PII.
      console.warn('subscribe: Sender rejected (non-retryable)', {
        status: err.status,
        kind: err.kind,
        error: summarizeError(err),
      });
      return jsonError(
        err.status === 422 ? 422 : 400,
        'sender_rejected',
        'Sender rejected the subscription request'
      );
    } else {
      throw err;
    }
  }

  // Group assignment: pitmaster_all + pitmaster_<region> when we know
  // the region. Without a region we add to pitmaster_all only.
  //
  // ANY failure enqueues a group_assign retry and reports
  // status='queued'. Original [P2] bug: a non-retryable group failure
  // (missing group, stale KV cache, bad id) used to be silently
  // swallowed while the response still said 'sent'.
  //
  // Skipped entirely when Sender.net hasn't returned a subscriber id
  // (the queued path). Drain will re-issue subscribe and re-attempt
  // group assignment on its next pass.
  let groupAssignSucceeded = false;
  if (espId) {
    try {
      if (region) {
        await assignBbqGroups(client, rc.env.WEATHER_KV, espId, region);
      } else {
        const allGroupId = await resolveGroupId(client, rc.env.WEATHER_KV, ALL_GROUP_NAME);
        await client.assignGroup(espId, allGroupId);
      }
      groupAssignSucceeded = true;
    } catch (err) {
      const cause = err instanceof SenderError ? err : undefined;
      const idempotencyKey = `group_assign:${espId}`;
      // oldRegion rides along so the drain can detach pitmaster_<oldRegion>
      // after it assigns the new group. Without it, a region-change
      // resubscribe whose group_assign step failed retryably would
      // recover the new group but leave the user in BOTH regional
      // audiences, producing duplicate Friday digests.
      await enqueue(rc.env.SMOKE_DB, {
        kind: 'subscribe',
        payload: {
          stage: 'group_assign',
          subscriberId: espId,
          region,
          oldRegion,
        },
        idempotencyKey,
        cause,
      });
      espStatus = 'queued';
      if (!(err instanceof SenderError)) {
        console.warn('subscribe: group_assign unexpected error', summarizeError(err));
      }
    }

    // Resubscribe with a different region: detach the stale
    // pitmaster_<oldRegion> group ONLY when the new-group assignment
    // actually succeeded. Otherwise the queued retry path is mid-flight
    // and removing oldRegion now would leave the subscriber in neither
    // regional audience until the drain catches up — a near-Friday zip
    // move would miss the digest entirely.
    //
    // Sender returns 404 for "not a member", which the client
    // swallows, so a stale D1 row that's already out of sync stays a
    // no-op. Best-effort: a transient failure here is logged but
    // doesn't change the user-visible outcome.
    if (groupAssignSucceeded && oldRegion && oldRegion !== region) {
      const staleGroupName = regionToGroupName(oldRegion);
      try {
        const staleGroupId = await resolveGroupId(
          client,
          rc.env.WEATHER_KV,
          staleGroupName
        );
        await client.removeGroup(espId!, staleGroupId);
      } catch (err) {
        // Original [P2] pass-7: a transient failure here used to be
        // logged and dropped, leaving the subscriber in BOTH regional
        // groups (old + new) until something else cleaned it up.
        // Now we enqueue a group_remove retry so the drain finishes
        // the cleanup. The user response stays 'sent' — the new
        // assignment landed, only the stale detach is owed.
        const cause = err instanceof SenderError ? err : undefined;
        await enqueue(rc.env.SMOKE_DB, {
          kind: 'subscribe',
          payload: {
            stage: 'group_remove',
            subscriberId: espId,
            groupName: staleGroupName,
          },
          idempotencyKey: `group_remove:${espId}:${oldRegion}`,
          cause,
        });
        console.warn(
          'subscribe: stale region cleanup queued for retry',
          { oldRegion, newRegion: region, error: summarizeError(err) }
        );
      }
    }
  }

  const now = Date.now();
  await rc.env.SMOKE_DB.prepare(
    `INSERT INTO subscribers (email, zip, cut, cooker, timezone, region, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         zip = excluded.zip,
         cut = excluded.cut,
         cooker = excluded.cooker,
         timezone = excluded.timezone,
         region = excluded.region,
         unsubscribed_at = NULL`
  )
    .bind(
      body.email,
      body.zip,
      body.cut ?? null,
      body.cooker ?? null,
      timezone,
      region,
      now
    )
    .run();

  const token = await signToken(body.email, rc.env.SUBSCRIBER_TOKEN_SECRET);

  return json(202, {
    status: espStatus,
    email: body.email,
    region,
    timezone,
    espId,
    token,
  });
}
