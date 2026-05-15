// Portfolio-aware regional segmentation for the Best Smoke Days email
// system. Six regions cover all 50 states + DC; every subscriber lives
// in exactly one. MailerLite groups are named `pitmaster_<region>` and
// the Friday cron sends one campaign per region rather than per
// subscriber — see docs/portfolio-email-architecture.md for the why.
//
// Region buckets follow BBQ culture more than geography: Missouri sits
// in `south_central` (Kansas City BBQ aligns with TX/OK/AR) rather than
// `midwest`. This is an intentional opinionated mapping, not a
// transcription error.

export type Region =
  | 'northeast'
  | 'southeast'
  | 'midwest'
  | 'south_central'
  | 'mountain'
  | 'pacific';

/** Stable ordering used by group enumeration and docs. */
export const REGIONS: readonly Region[] = [
  'northeast',
  'southeast',
  'midwest',
  'south_central',
  'mountain',
  'pacific',
] as const;

export class RegionError extends Error {
  constructor(public readonly kind: 'unknown_state' | 'no_state', message: string) {
    super(`region: ${kind}: ${message}`);
    this.name = 'RegionError';
  }
}

// State → region. Built as a single lookup so adding a new state is one
// row and adding a new region is one entry plus the touched rows.
const STATE_TO_REGION: Readonly<Record<string, Region>> = {
  // northeast
  CT: 'northeast', MA: 'northeast', ME: 'northeast', NH: 'northeast',
  NJ: 'northeast', NY: 'northeast', PA: 'northeast', RI: 'northeast', VT: 'northeast',
  // southeast (DC + DE + MD bucket here — federal/mid-Atlantic BBQ pulls south)
  AL: 'southeast', DC: 'southeast', DE: 'southeast', FL: 'southeast',
  GA: 'southeast', KY: 'southeast', MD: 'southeast', MS: 'southeast',
  NC: 'southeast', SC: 'southeast', TN: 'southeast', VA: 'southeast', WV: 'southeast',
  // midwest
  IA: 'midwest', IL: 'midwest', IN: 'midwest', KS: 'midwest',
  MI: 'midwest', MN: 'midwest', ND: 'midwest', NE: 'midwest',
  OH: 'midwest', SD: 'midwest', WI: 'midwest',
  // south_central — MO is HERE on purpose (KC BBQ axis)
  AR: 'south_central', LA: 'south_central', MO: 'south_central',
  OK: 'south_central', TX: 'south_central',
  // mountain
  AZ: 'mountain', CO: 'mountain', ID: 'mountain', MT: 'mountain',
  NM: 'mountain', NV: 'mountain', UT: 'mountain', WY: 'mountain',
  // pacific (AK, HI bundled — small populations, shared sender cadence)
  AK: 'pacific', CA: 'pacific', HI: 'pacific', OR: 'pacific', WA: 'pacific',
};

/**
 * Map a two-letter state code (US states + DC) to its region.
 * Trims and uppercases input. Throws RegionError on unknown codes — a
 * `null` would force every caller into a branch when in practice the
 * only path to invalid input is a programming error or a hand-edited D1
 * row (zip validation runs upstream of this).
 */
export function stateToRegion(stateCode: string): Region {
  if (typeof stateCode !== 'string') {
    throw new RegionError('unknown_state', `expected string, got ${typeof stateCode}`);
  }
  const normalized = stateCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) {
    throw new RegionError('unknown_state', `expected two-letter code, got ${JSON.stringify(stateCode)}`);
  }
  const region = STATE_TO_REGION[normalized];
  if (!region) {
    throw new RegionError('unknown_state', `no region defined for ${normalized}`);
  }
  return region;
}

/**
 * Resolver injected at call time. The production path threads through
 * `resolveZip()` (which hits the metros table fast-path or the
 * Open-Meteo geocoder) and surfaces the state on the returned
 * ZipLocation. Tests inject synchronous stubs.
 */
export type ZipStateResolver = (zip: string) => Promise<{ state: string | null }>;

/**
 * Async zip → region. Calls the injected resolver to look up the state
 * (a step that can hit KV / D1 / network on a cold zip), then composes
 * with `stateToRegion`. A null state from the resolver is treated as
 * "unsupported zip" and throws RegionError('no_state') — the subscribe
 * handler should refuse the signup rather than silently dropping the
 * subscriber into an undefined regional bucket.
 */
export async function zipToRegion(
  zip: string,
  resolver: ZipStateResolver
): Promise<Region> {
  const { state } = await resolver(zip);
  if (state == null) {
    throw new RegionError('no_state', `no state mapping for zip ${zip}`);
  }
  return stateToRegion(state);
}
