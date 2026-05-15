import { describe, expect, it } from 'vitest';
import { RegionError, stateToRegion, zipToRegion, REGIONS, type Region } from '../../../src/lib/regions';

describe('regions: stateToRegion', () => {
  const expected: Record<Region, string[]> = {
    northeast: ['CT', 'MA', 'ME', 'NH', 'NJ', 'NY', 'PA', 'RI', 'VT'],
    southeast: ['AL', 'FL', 'GA', 'KY', 'MS', 'NC', 'SC', 'TN', 'VA', 'WV', 'DC', 'DE', 'MD'],
    midwest: ['IA', 'IL', 'IN', 'KS', 'MI', 'MN', 'ND', 'NE', 'OH', 'SD', 'WI'],
    south_central: ['AR', 'LA', 'MO', 'OK', 'TX'],
    mountain: ['AZ', 'CO', 'ID', 'MT', 'NM', 'NV', 'UT', 'WY'],
    pacific: ['AK', 'CA', 'HI', 'OR', 'WA'],
  };

  it('maps all 50 states + DC to a region', () => {
    const seen = new Set<string>();
    for (const [region, states] of Object.entries(expected)) {
      for (const state of states) {
        expect(stateToRegion(state)).toBe(region);
        seen.add(state);
      }
    }
    // 50 states + DC = 51 entries
    expect(seen.size).toBe(51);
  });

  it('places MO in south_central, not midwest (KC BBQ alignment)', () => {
    expect(stateToRegion('MO')).toBe('south_central');
    // Kansas (KC's other half) lives in midwest — they intentionally split.
    expect(stateToRegion('KS')).toBe('midwest');
  });

  it('places DC in southeast', () => {
    expect(stateToRegion('DC')).toBe('southeast');
  });

  it('is case-insensitive on input', () => {
    expect(stateToRegion('tx')).toBe('south_central');
    expect(stateToRegion('Tx')).toBe('south_central');
    expect(stateToRegion('  ny  ')).toBe('northeast');
  });

  it('throws RegionError on unknown two-letter codes', () => {
    expect(() => stateToRegion('XX')).toThrow(RegionError);
    expect(() => stateToRegion('XX')).toThrow(/unknown_state/i);
  });

  it('throws RegionError on non-two-letter input', () => {
    expect(() => stateToRegion('California')).toThrow(RegionError);
    expect(() => stateToRegion('')).toThrow(RegionError);
    expect(() => stateToRegion('T')).toThrow(RegionError);
    // @ts-expect-error — runtime check on bad types
    expect(() => stateToRegion(null)).toThrow(RegionError);
    // @ts-expect-error
    expect(() => stateToRegion(undefined)).toThrow(RegionError);
  });

  it('exports REGIONS in stable order', () => {
    expect(REGIONS).toEqual(['northeast', 'southeast', 'midwest', 'south_central', 'mountain', 'pacific']);
  });
});

describe('regions: zipToRegion', () => {
  // zipToRegion is async because it resolves zip → state via the geocoder,
  // which can hit KV / D1 / Open-Meteo. Tests inject a synchronous stub
  // resolver so they exercise the region mapping in isolation.

  it('resolves a TX zip to south_central via the resolver', async () => {
    const region = await zipToRegion('78701', async () => ({ state: 'TX' }));
    expect(region).toBe('south_central');
  });

  it('honors the KC border split: 66xxx → KS → midwest, 64xxx → MO → south_central', async () => {
    expect(await zipToRegion('66101', async () => ({ state: 'KS' }))).toBe('midwest');
    expect(await zipToRegion('64108', async () => ({ state: 'MO' }))).toBe('south_central');
  });

  it('throws RegionError when the resolver returns an unknown state', async () => {
    await expect(zipToRegion('00000', async () => ({ state: 'XX' }))).rejects.toThrow(RegionError);
  });

  it('throws RegionError when the resolver returns null state (non-US zip)', async () => {
    await expect(zipToRegion('99999', async () => ({ state: null }))).rejects.toThrow(RegionError);
    await expect(zipToRegion('99999', async () => ({ state: null }))).rejects.toThrow(/no state/i);
  });

  it('propagates resolver failures', async () => {
    await expect(
      zipToRegion('12345', async () => {
        throw new Error('resolver exploded');
      })
    ).rejects.toThrow(/resolver exploded/);
  });
});
