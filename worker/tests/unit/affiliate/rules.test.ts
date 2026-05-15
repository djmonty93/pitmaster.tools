import { describe, expect, it } from 'vitest';
import { recommend, getRules, type ScoreBand } from '../../../src/lib/affiliate/rules';
import type { Cooker, Cut, AffiliateRecommendation } from '@shared/types';

const ALL_CUTS: readonly Cut[] = [
  'brisket-flat',
  'brisket-packer',
  'pork-butt',
  'spare-ribs',
  'baby-back-ribs',
  'pork-loin',
  'whole-chicken',
  'spatchcock-chicken',
  'chicken-thighs',
  'whole-turkey',
  'turkey-breast',
  'fish',
  'lamb-shoulder',
];

const ALL_COOKERS: readonly Cooker[] = ['offset', 'pellet', 'kamado', 'kettle', 'electric'];
const ALL_BANDS: readonly ScoreBand[] = ['red', 'yellow', 'green', 'ideal'];

describe('F15 affiliate rules engine', () => {
  it('always returns a recommendation for every (cut, cooker, band) combination', () => {
    // The fallback Thermapen rule should keep null out of the response
    // surface entirely — handlers can attach the field unconditionally.
    for (const cut of ALL_CUTS) {
      for (const cooker of ALL_COOKERS) {
        for (const band of ALL_BANDS) {
          const rec = recommend({ cut, cooker, band });
          expect(rec, `cut=${cut} cooker=${cooker} band=${band}`).not.toBeNull();
        }
      }
    }
  });

  it('every recommendation carries disclosureRequired: true', () => {
    // FTC compliance: the renderer is allowed to ignore the field and
    // hard-code the disclosure, but it must not be absent or false at
    // the source.
    for (const cut of ALL_CUTS) {
      for (const cooker of ALL_COOKERS) {
        for (const band of ALL_BANDS) {
          const rec = recommend({ cut, cooker, band });
          expect(rec?.disclosureRequired).toBe(true);
        }
      }
    }
  });

  it('returns the rain canopy on red-band days regardless of cut or cooker', () => {
    // Rain canopy is rule 1 — every red-band match should hit it before
    // anything more specific has a chance to fire.
    for (const cut of ALL_CUTS) {
      for (const cooker of ALL_COOKERS) {
        const rec = recommend({ cut, cooker, band: 'red' });
        expect(rec?.productId).toBe('cookout-canopy-10');
        expect(rec?.category).toBe('rain-cover');
      }
    }
  });

  it('returns the windscreen on yellow-band offset and kettle days, not on ideal/green', () => {
    const offsetYellow = recommend({ cut: 'brisket-packer', cooker: 'offset', band: 'yellow' });
    const kettleYellow = recommend({ cut: 'whole-chicken', cooker: 'kettle', band: 'yellow' });
    expect(offsetYellow?.productId).toBe('pitbarrel-windscreen');
    expect(kettleYellow?.productId).toBe('pitbarrel-windscreen');

    const offsetGreen = recommend({ cut: 'brisket-packer', cooker: 'offset', band: 'green' });
    const offsetIdeal = recommend({ cut: 'brisket-packer', cooker: 'offset', band: 'ideal' });
    expect(offsetGreen?.productId).not.toBe('pitbarrel-windscreen');
    expect(offsetIdeal?.productId).not.toBe('pitbarrel-windscreen');
  });

  it('returns the BBQ Guru controller for offset/kamado on non-red, non-yellow-offset days', () => {
    const rec = recommend({ cut: 'pork-butt', cooker: 'offset', band: 'green' });
    expect(rec?.productId).toBe('bbq-guru-partypal');
    const kamado = recommend({ cut: 'pork-butt', cooker: 'kamado', band: 'green' });
    expect(kamado?.productId).toBe('bbq-guru-partypal');
  });

  it('returns the pellet blend for pellet cookers on non-rain days', () => {
    const rec = recommend({ cut: 'spare-ribs', cooker: 'pellet', band: 'green' });
    expect(rec?.productId).toBe('competition-pellet-blend');
  });

  it('returns the hardwood lump for kettle and kamado on green/ideal days (after BBQ Guru for kamado)', () => {
    // Kamado already hit BBQ Guru above — kettle should fall to the lump rule.
    const kettle = recommend({ cut: 'whole-chicken', cooker: 'kettle', band: 'green' });
    expect(kettle?.productId).toBe('jealous-devil-lump');
  });

  it('returns the dual-probe Smoke X2 for stall-prone cuts on green/ideal days for electric/pellet', () => {
    // Electric brisket green: no rain canopy, no windscreen (electric not in list),
    // no BBQ Guru (electric not in list), so the cut-driven Smoke X2 rule fires.
    const rec = recommend({ cut: 'brisket-packer', cooker: 'electric', band: 'green' });
    expect(rec?.productId).toBe('thermoworks-smoke-x2');
  });

  it('falls back to the Thermapen on ideal-band low-effort cuts that no other rule matches', () => {
    // Fish on electric, ideal day: every specific rule misses, so the
    // catch-all Thermapen rule fires.
    const rec = recommend({ cut: 'fish', cooker: 'electric', band: 'ideal' });
    expect(rec?.productId).toBe('thermoworks-thermapen');
  });

  it('rules table is well-formed (no empty arrays masquerading as filters)', () => {
    // A `[]` selector would never match anything, which is almost
    // certainly a typo. The matcher treats `[]` as "no filter" but we
    // still want a regression on the source data shape.
    for (const rule of getRules()) {
      if (rule.cuts) expect(rule.cuts.length).toBeGreaterThan(0);
      if (rule.cookers) expect(rule.cookers.length).toBeGreaterThan(0);
      if (rule.bands) expect(rule.bands.length).toBeGreaterThan(0);
      expect(rule.product.id).toMatch(/^[a-z0-9-]+$/);
      expect(rule.product.name.length).toBeGreaterThan(0);
      expect(rule.reason.length).toBeGreaterThan(0);
    }
  });

  it('does not mutate input', () => {
    const input = { cut: 'brisket-packer' as Cut, cooker: 'offset' as Cooker, band: 'green' as ScoreBand };
    const snapshot = { ...input };
    recommend(input);
    expect(input).toEqual(snapshot);
  });

  it('returns an AffiliateRecommendation with all required fields populated', () => {
    const rec = recommend({ cut: 'brisket-packer', cooker: 'offset', band: 'green' });
    expect(rec).not.toBeNull();
    const r = rec as AffiliateRecommendation;
    expect(typeof r.productId).toBe('string');
    expect(typeof r.productName).toBe('string');
    expect(typeof r.productUrl).toBe('string');
    expect(typeof r.reason).toBe('string');
    expect(['thermometer', 'fire-management', 'rain-cover', 'gloves', 'wood']).toContain(r.category);
    expect(r.disclosureRequired).toBe(true);
  });
});
