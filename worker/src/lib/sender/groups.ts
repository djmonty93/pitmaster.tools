// Portfolio-aware Sender.net group management.
//
// Group naming follows `<site_prefix>_<scope>`. For Best Smoke Days:
//   pitmaster_all              — every BBQ subscriber
//   pitmaster_<region>         — six regional buckets (see regions/index.ts)
//
// Every subscriber lands in two groups: pitmaster_all + their regional
// group. The Friday cron sends one campaign per region, filtered by the
// regional group name (config'd on the dashboard automation, not by
// code here). Account-scoped fields (bbq_cut_pref, bbq_cooker_pref)
// stay on the subscriber record, not on groups, so subscribers can be
// moved between regions without losing preferences.
//
// Group IDs are resolved by name and cached in KV. Sender-assigned
// IDs are stable for the life of a group, so we cache without a TTL —
// a group rename or recreate is a deliberate operator action that
// should clear the cache (`wrangler kv:key delete`). On cache miss we
// call listGroups() and hydrate every name we see, not just the one
// requested, so a cold start populates the full portfolio map in a
// single round-trip.

import type { SenderClient } from './client.js';
import { SenderError } from './errors.js';
import { REGIONS, type Region } from '../regions/index.js';

/** Group every BBQ subscriber belongs to. */
export const ALL_GROUP_NAME = 'pitmaster_all';

/** KV key prefix for cached group-id lookups. Bump on rename. */
const KV_PREFIX = 'sender_group_id';

/** Canonical group name for a region. */
export function regionToGroupName(region: Region): string {
  return `pitmaster_${region}`;
}

/**
 * The two groups a new subscriber should join, in canonical order:
 *   [pitmaster_all, pitmaster_<region>]
 * Returned as a tuple so callers don't accidentally drop the all-group.
 */
export function bbqGroupNamesForSubscriber(region: Region): [string, string] {
  return [ALL_GROUP_NAME, regionToGroupName(region)];
}

/** All BBQ group names — the all-group plus one per region. */
export function allBbqGroupNames(): string[] {
  return [ALL_GROUP_NAME, ...REGIONS.map(regionToGroupName)];
}

/**
 * Resolve a group name to its Sender ID, populating the KV cache
 * on miss. Throws if the group doesn't exist — the operator must have
 * created it in the dashboard per docs/portfolio-email-architecture.md.
 */
export async function resolveGroupId(
  client: Pick<SenderClient, 'listGroups'>,
  kv: KVNamespace,
  name: string
): Promise<string> {
  const cached = await kv.get(`${KV_PREFIX}:${name}`);
  if (cached) return cached;
  const groups = await client.listGroups();
  const match = groups.find((g) => g.name === name);
  if (!match) {
    throw new SenderError(
      'group_list',
      'malformed',
      `Sender group not found: ${name}. Configure it in the Sender dashboard (see docs/sender-setup.md §3).`
    );
  }
  // Hydrate every known name in one pass so the next caller for any
  // BBQ group lands on a hit. Unknown groups (powersizing_*, etc.) get
  // cached too — cheap, and lets a future site share the namespace.
  //
  // KV writes are BEST-EFFORT: a transient kv.put failure here must
  // NOT block the caller's group operation. The authoritative lookup
  // already succeeded, so we have the id we need; cache hydration is
  // just an optimization for the next call. Original [P2] pass-17:
  // awaiting Promise.all of the puts meant any failed put rejected
  // the whole resolver, dropping subscribers out of their regional
  // groups solely because the cache layer was unhealthy.
  //
  // Errors are swallowed per-put and logged so an operator can
  // correlate a missing cache row with a real KV outage.
  await Promise.allSettled(
    groups.map((g) =>
      kv.put(`${KV_PREFIX}:${g.name}`, g.id, {
        // No TTL — group IDs are stable. If a group is recreated, the
        // operator must clear the cached key manually.
      })
    )
  ).then((results) => {
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r && r.status === 'rejected') {
        console.warn('resolveGroupId: KV hydration failed (best-effort)', {
          group: groups[i]?.name,
          reason: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    }
  });
  return match.id;
}

/**
 * Assign a subscriber to pitmaster_all AND pitmaster_<region>. Calls
 * are issued sequentially (not in parallel) so a 5xx on the first
 * doesn't fan out into compounding rate-limit pressure. Sender's
 * assign endpoint is idempotent server-side, so a retry of either call
 * is a no-op.
 */
export async function assignBbqGroups(
  client: Pick<SenderClient, 'listGroups' | 'assignGroup'>,
  kv: KVNamespace,
  email: string,
  region: Region
): Promise<void> {
  const names = bbqGroupNamesForSubscriber(region);
  for (const name of names) {
    const id = await resolveGroupId(client, kv, name);
    await client.assignGroup(email, id);
  }
}

/**
 * Remove a subscriber from every BBQ group. The caller doesn't know
 * which regional group the subscriber was in (they may have moved
 * regions, or the row was hand-edited), so we issue DELETEs for the
 * all-group plus all six regional groups. Sender returns 404 for
 * "not a member" and the client swallows that to keep this idempotent.
 *
 * Per-group rather than account-level — preserves any future
 * powersizing_* / overlanding_* memberships so unsubscribing from BBQ
 * doesn't accidentally unsubscribe from a sibling site.
 */
export async function removeBbqGroups(
  client: Pick<SenderClient, 'listGroups' | 'removeGroup'>,
  kv: KVNamespace,
  email: string
): Promise<void> {
  for (const name of allBbqGroupNames()) {
    const id = await resolveGroupId(client, kv, name);
    await client.removeGroup(email, id);
  }
}
