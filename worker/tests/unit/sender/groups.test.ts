import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_GROUP_NAME,
  assignBbqGroups,
  bbqGroupNamesForSubscriber,
  regionToGroupName,
  removeBbqGroups,
  resolveGroupId,
} from '../../../src/lib/sender/groups';
import type { Region } from '../../../src/lib/regions';

interface FakeKVStore {
  get: (key: string, type?: 'text' | 'json') => Promise<unknown>;
  put: (key: string, value: string, opts?: { expirationTtl?: number }) => Promise<void>;
}

function makeKv(): FakeKVStore & { _data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    _data: data,
    async get(key, type) {
      const v = data.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) {
      data.set(key, value);
    },
  };
}

describe('regionToGroupName', () => {
  it('returns pitmaster_<region> for each region', () => {
    const cases: Array<[Region, string]> = [
      ['northeast', 'pitmaster_northeast'],
      ['southeast', 'pitmaster_southeast'],
      ['midwest', 'pitmaster_midwest'],
      ['south_central', 'pitmaster_south_central'],
      ['mountain', 'pitmaster_mountain'],
      ['pacific', 'pitmaster_pacific'],
    ];
    for (const [region, name] of cases) {
      expect(regionToGroupName(region)).toBe(name);
    }
  });
});

describe('bbqGroupNamesForSubscriber', () => {
  it('returns [pitmaster_all, pitmaster_<region>] in canonical order', () => {
    expect(bbqGroupNamesForSubscriber('southeast')).toEqual([
      'pitmaster_all',
      'pitmaster_southeast',
    ]);
  });

  it('ALL_GROUP_NAME is the constant the function uses', () => {
    expect(ALL_GROUP_NAME).toBe('pitmaster_all');
    expect(bbqGroupNamesForSubscriber('mountain')[0]).toBe(ALL_GROUP_NAME);
  });
});

describe('resolveGroupId', () => {
  let listGroups: ReturnType<typeof vi.fn>;
  let kv: ReturnType<typeof makeKv>;

  beforeEach(() => {
    kv = makeKv();
    listGroups = vi.fn();
  });

  it('caches the group-id lookup in KV on miss', async () => {
    listGroups.mockResolvedValue([
      { id: '101', name: 'pitmaster_all' },
      { id: '202', name: 'pitmaster_southeast' },
    ]);
    const id = await resolveGroupId(
      { listGroups } as unknown as Parameters<typeof resolveGroupId>[0],
      kv as unknown as KVNamespace,
      'pitmaster_southeast'
    );
    expect(id).toBe('202');
    expect(listGroups).toHaveBeenCalledTimes(1);
    // Cache populated for BOTH groups, not just the one we asked for —
    // one listGroups call should hydrate every name we'll need.
    expect(kv._data.get('sender_group_id:pitmaster_all')).toBe('101');
    expect(kv._data.get('sender_group_id:pitmaster_southeast')).toBe('202');
  });

  it('returns from cache without calling listGroups', async () => {
    kv._data.set('sender_group_id:pitmaster_midwest', '303');
    const id = await resolveGroupId(
      { listGroups } as unknown as Parameters<typeof resolveGroupId>[0],
      kv as unknown as KVNamespace,
      'pitmaster_midwest'
    );
    expect(id).toBe('303');
    expect(listGroups).not.toHaveBeenCalled();
  });

  it('throws when the group does not exist in Sender', async () => {
    listGroups.mockResolvedValue([{ id: '1', name: 'pitmaster_all' }]);
    await expect(
      resolveGroupId(
        { listGroups } as unknown as Parameters<typeof resolveGroupId>[0],
        kv as unknown as KVNamespace,
        'pitmaster_pacific'
      )
    ).rejects.toThrow(/pitmaster_pacific/);
  });

  it('returns the matched id even when KV cache writes fail (best-effort hydration)', async () => {
    // Regression for [Codex P2] pass-17: a transient kv.put failure
    // used to reject the resolver, dropping subscribers out of their
    // regional groups even though the authoritative listGroups lookup
    // succeeded. Cache hydration is now best-effort.
    listGroups.mockResolvedValue([
      { id: '101', name: 'pitmaster_all' },
      { id: '202', name: 'pitmaster_southeast' },
    ]);
    const failingKv = {
      ...kv,
      put: vi.fn().mockRejectedValue(new Error('kv unhealthy')),
    } as unknown as KVNamespace;
    const id = await resolveGroupId(
      { listGroups } as unknown as Parameters<typeof resolveGroupId>[0],
      failingKv,
      'pitmaster_southeast'
    );
    expect(id).toBe('202');
  });
});

describe('assignBbqGroups', () => {
  it('assigns subscriber to pitmaster_all AND pitmaster_<region>', async () => {
    const kv = makeKv();
    kv._data.set('sender_group_id:pitmaster_all', '1');
    kv._data.set('sender_group_id:pitmaster_south_central', '5');
    const assignGroup = vi.fn().mockResolvedValue(undefined);
    const listGroups = vi.fn();
    await assignBbqGroups(
      { assignGroup, listGroups } as unknown as Parameters<typeof assignBbqGroups>[0],
      kv as unknown as KVNamespace,
      'sub-42',
      'south_central'
    );
    expect(assignGroup).toHaveBeenCalledTimes(2);
    expect(assignGroup).toHaveBeenNthCalledWith(1, 'sub-42', '1');
    expect(assignGroup).toHaveBeenNthCalledWith(2, 'sub-42', '5');
  });

  it('propagates a 5xx from the underlying client so the retry queue can pick it up', async () => {
    const kv = makeKv();
    kv._data.set('sender_group_id:pitmaster_all', '1');
    kv._data.set('sender_group_id:pitmaster_pacific', '6');
    const assignGroup = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('boom'));
    await expect(
      assignBbqGroups(
        { assignGroup, listGroups: vi.fn() } as unknown as Parameters<typeof assignBbqGroups>[0],
        kv as unknown as KVNamespace,
        'sub-99',
        'pacific'
      )
    ).rejects.toThrow(/boom/);
    // First call succeeded; partial state is acceptable because the
    // caller enqueues a retry and `assignGroup` is idempotent at the
    // Sender layer (a repeat is a no-op).
    expect(assignGroup).toHaveBeenCalledTimes(2);
  });
});

describe('removeBbqGroups', () => {
  it('removes subscriber from every pitmaster_* group (account-scoped per spec)', async () => {
    const kv = makeKv();
    kv._data.set('sender_group_id:pitmaster_all', '1');
    kv._data.set('sender_group_id:pitmaster_northeast', '2');
    kv._data.set('sender_group_id:pitmaster_southeast', '3');
    kv._data.set('sender_group_id:pitmaster_midwest', '4');
    kv._data.set('sender_group_id:pitmaster_south_central', '5');
    kv._data.set('sender_group_id:pitmaster_mountain', '6');
    kv._data.set('sender_group_id:pitmaster_pacific', '7');
    const removeGroup = vi.fn().mockResolvedValue(undefined);
    await removeBbqGroups(
      { removeGroup, listGroups: vi.fn() } as unknown as Parameters<typeof removeBbqGroups>[0],
      kv as unknown as KVNamespace,
      'sub-77'
    );
    // 7 group IDs = 1 (all) + 6 regional. Caller doesn't know which
    // regional group the subscriber was in, so we remove from all of
    // them — Sender treats DELETE on a non-member as a no-op.
    expect(removeGroup).toHaveBeenCalledTimes(7);
    const groupIds = removeGroup.mock.calls.map((c) => c[1]);
    expect(new Set(groupIds)).toEqual(new Set(['1', '2', '3', '4', '5', '6', '7']));
  });

  it('issues DELETE for every group even when most are no-op (client swallows 404)', async () => {
    // The Sender client maps a 404 from /api/subscribers/:id/groups/:id
    // to a resolved promise — see client.removeGroup. removeBbqGroups
    // therefore sees a clean resolution for not-a-member calls and
    // continues iterating. This test mirrors that contract: the fake
    // returns undefined for the "not a member" group rather than throwing.
    const kv = makeKv();
    kv._data.set('sender_group_id:pitmaster_all', '1');
    kv._data.set('sender_group_id:pitmaster_northeast', '2');
    kv._data.set('sender_group_id:pitmaster_southeast', '3');
    kv._data.set('sender_group_id:pitmaster_midwest', '4');
    kv._data.set('sender_group_id:pitmaster_south_central', '5');
    kv._data.set('sender_group_id:pitmaster_mountain', '6');
    kv._data.set('sender_group_id:pitmaster_pacific', '7');
    const removeGroup = vi.fn().mockResolvedValue(undefined);
    await removeBbqGroups(
      { removeGroup, listGroups: vi.fn() } as unknown as Parameters<typeof removeBbqGroups>[0],
      kv as unknown as KVNamespace,
      'sub-88'
    );
    expect(removeGroup).toHaveBeenCalledTimes(7);
  });
});
