// F15 — Affiliate product recommendation engine.
//
// Pure function: (cut, cooker, best-day score band) → one product
// placement, or `null` when no rule matches. The renderer is
// responsible for showing the FTC disclosure on every placement; this
// module only picks the product and returns the disclosure flag.
//
// Design constraints:
//   - Data-driven: rules live in a typed RULES array below, no
//     conditionals in production code. Adding/removing a product is a
//     single-line edit + a test.
//   - Deterministic: given the same input the same product comes out.
//     No randomization, no time-of-day variance, no A/B logic in v1.
//   - Read-only at runtime: no D1, no KV. The rules are bundled into
//     the worker, so a recommendation never adds a network hop or a
//     read-quota line item.
//   - Most-specific-first: rules are scanned in declaration order and
//     the first match wins. A rule with both a cut and a cooker
//     constraint must appear before a rule with only one or the
//     other; the per-rule identity assertions in
//     tests/unit/affiliate/rules.test.ts (rain canopy on red,
//     windscreen on yellow offset/kettle, etc.) pin the ordering so a
//     reorder that breaks the policy fails fast in CI.

import type { AffiliateRecommendation, Cooker, Cut, ScoreResult } from '@shared/types';

export type ScoreBand = ScoreResult['band'];

interface ProductCatalog {
  id: string;
  name: string;
  url: string;
  category: AffiliateRecommendation['category'];
}

/**
 * Single recommendation rule. A `null` or `undefined` selector means
 * "any value". `bands` lists which best-day score bands trigger this
 * rule; an empty array matches all bands. The reason string is the
 * human-readable copy shown beneath the product card.
 */
export interface AffiliateRule {
  product: ProductCatalog;
  cuts?: readonly Cut[];
  cookers?: readonly Cooker[];
  bands?: readonly ScoreBand[];
  reason: string;
}

export interface RuleInput {
  cut: Cut;
  cooker: Cooker;
  band: ScoreBand;
}

// Catalog kept inline so v1 ships without an HTTP/D1 fetch for
// product metadata. URLs are empty for now — Monty will paste signed
// affiliate links here once the program(s) are approved. The
// renderer must treat an empty `productUrl` as "show copy, no link"
// rather than break.
const P = {
  bbqGuru:           { id: 'bbq-guru-partypal', name: 'BBQ Guru PartyPal temperature controller', url: '', category: 'fire-management' as const },
  thermapen:         { id: 'thermoworks-thermapen', name: 'ThermoWorks Thermapen ONE', url: '', category: 'thermometer' as const },
  smokeProbe:        { id: 'thermoworks-smoke-x2', name: 'ThermoWorks Smoke X2 dual-probe', url: '', category: 'thermometer' as const },
  windscreen:        { id: 'pitbarrel-windscreen', name: 'Universal kettle/offset windscreen kit', url: '', category: 'fire-management' as const },
  rainCanopy:        { id: 'cookout-canopy-10', name: '10×10 BBQ canopy / pop-up cover', url: '', category: 'rain-cover' as const },
  nitrileGloves:     { id: 'foodsafe-nitrile-9mil', name: 'Heavy-duty food-safe nitrile gloves', url: '', category: 'gloves' as const },
  hickoryChunks:     { id: 'hickory-chunks-10lb', name: 'Premium hickory wood chunks (10 lb)', url: '', category: 'wood' as const },
  pelletBlend:       { id: 'competition-pellet-blend', name: 'Competition blend smoking pellets', url: '', category: 'wood' as const },
  charcoalLumpHardwood: { id: 'jealous-devil-lump', name: 'Jealous Devil hardwood lump charcoal', url: '', category: 'wood' as const },
} as const;

/**
 * Rules, scanned in order, first-match wins.
 *
 * Ordering principle:
 *   1) Weather-driven rules with two or more constraints (most specific)
 *   2) Cooker-specific recommendations (medium specificity)
 *   3) Cut-specific recommendations (medium specificity)
 *   4) Fallback by score band only (lowest specificity, always matches)
 *
 * Reason copy is written in 8-12 word phrases that read naturally
 * after the product name in the rendered card.
 */
const RULES: readonly AffiliateRule[] = [
  // 1) Two-constraint, weather-driven placements ── most specific
  {
    product: P.rainCanopy,
    bands: ['red'],
    reason: 'A pop-up canopy keeps rain off the firebox and the cook.',
  },
  {
    product: P.windscreen,
    cookers: ['offset', 'kettle'],
    bands: ['yellow', 'red'],
    reason: 'A windscreen steadies the fire when gusts are working against your draft.',
  },
  // 2) Cooker-specific defaults ── medium specificity
  {
    product: P.bbqGuru,
    cookers: ['offset', 'kamado'],
    reason: 'A temperature controller holds your pit steady through a long overnight cook.',
  },
  {
    product: P.pelletBlend,
    cookers: ['pellet'],
    reason: 'A clean-burning competition blend gives pellet smokers a deeper smoke ring.',
  },
  {
    product: P.charcoalLumpHardwood,
    cookers: ['kettle', 'kamado'],
    reason: 'Hardwood lump runs hotter and cleaner than briquettes in a kettle or kamado.',
  },
  // 3) Cut-specific recommendations ── medium specificity
  {
    product: P.smokeProbe,
    cuts: ['brisket-flat', 'brisket-packer', 'pork-butt', 'lamb-shoulder'],
    reason: 'Dual probes track grate and meat temp through the 8-14 hour stall.',
  },
  {
    product: P.hickoryChunks,
    cuts: ['brisket-flat', 'brisket-packer', 'pork-butt', 'spare-ribs', 'baby-back-ribs'],
    reason: 'Hickory chunks layer the classic Texas/Carolina smoke profile onto pork and beef.',
  },
  {
    product: P.nitrileGloves,
    cuts: ['pork-butt', 'brisket-flat', 'brisket-packer'],
    reason: 'Heat-rated nitrile gloves make pulling and slicing safe at 200 °F.',
  },
  // 4) Fallback by score band only ── always matches
  {
    product: P.thermapen,
    bands: ['ideal', 'green', 'yellow', 'red'],
    reason: 'A fast-read thermometer confirms doneness in seconds, so you cook to temperature, not the clock.',
  },
];

function matches(rule: AffiliateRule, input: RuleInput): boolean {
  if (rule.cuts && rule.cuts.length > 0 && !rule.cuts.includes(input.cut)) return false;
  if (rule.cookers && rule.cookers.length > 0 && !rule.cookers.includes(input.cooker)) return false;
  if (rule.bands && rule.bands.length > 0 && !rule.bands.includes(input.band)) return false;
  return true;
}

export function recommend(input: RuleInput): AffiliateRecommendation | null {
  for (const rule of RULES) {
    if (matches(rule, input)) {
      return {
        productId: rule.product.id,
        productName: rule.product.name,
        productUrl: rule.product.url,
        reason: rule.reason,
        category: rule.product.category,
        disclosureRequired: true,
      };
    }
  }
  return null;
}

/** Exposed for tests so the rule table can be inspected without
 *  duplicating it in fixtures. */
export function getRules(): readonly AffiliateRule[] {
  return RULES;
}
