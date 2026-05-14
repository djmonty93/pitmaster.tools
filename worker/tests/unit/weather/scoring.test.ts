import { describe, expect, it } from 'vitest';
import { scoreDay, scoreForecast } from '@shared/scoring';
import type { Cooker, Cut, WeatherDay } from '@shared/types';

function fakeDay(overrides: Partial<WeatherDay> = {}): WeatherDay {
  return {
    date: '2026-05-14',
    tempHighF: 75,
    tempLowF: 55,
    rhMean: 50,
    windMphMean: 6,
    gustMphMax: 10,
    precipProbPct: 5,
    precipIn: 0,
    dewPointMeanF: 55,
    hourly: [],
    source: 'open-meteo',
    confidence: 'high',
    ...overrides,
  };
}

describe('scoreDay', () => {
  it('returns ideal for benign conditions on a forgiving cooker', () => {
    const res = scoreDay({ cut: 'pork-loin', cooker: 'electric', day: fakeDay() });
    expect(res.score).toBeGreaterThanOrEqual(85);
    expect(res.band).toBe('ideal');
  });

  it('penalizes heavy rain hard', () => {
    const wet = fakeDay({ precipProbPct: 90, precipIn: 0.5 });
    const dry = fakeDay({ precipProbPct: 5, precipIn: 0 });
    const wetScore = scoreDay({ cut: 'pork-loin', cooker: 'electric', day: wet }).score;
    const dryScore = scoreDay({ cut: 'pork-loin', cooker: 'electric', day: dry }).score;
    expect(dryScore - wetScore).toBeGreaterThan(30);
  });

  it('penalizes sustained wind even when gustMphMax is missing (NWS shape)', () => {
    // NWS often omits windGust; the adapter then sets gustMphMax=0 but
    // keeps windMphMean. Without the gust factor, this day would skate
    // free. Effective gust = max(0, 25 * 1.4) = 35 → ~30-point penalty
    // for an offset.
    const sustainedNoGust = fakeDay({ gustMphMax: 0, windMphMean: 25 });
    const calm = fakeDay({ gustMphMax: 0, windMphMean: 5 });
    const sustainedScore = scoreDay({ cut: 'pork-loin', cooker: 'offset', day: sustainedNoGust }).score;
    const calmScore = scoreDay({ cut: 'pork-loin', cooker: 'offset', day: calm }).score;
    expect(calmScore - sustainedScore).toBeGreaterThan(20);
  });

  it('applies cooker-specific wind sensitivity (offset > electric)', () => {
    const gusty = fakeDay({ gustMphMax: 30, windMphMean: 18 });
    const offsetScore = scoreDay({ cut: 'pork-loin', cooker: 'offset', day: gusty }).score;
    const electricScore = scoreDay({ cut: 'pork-loin', cooker: 'electric', day: gusty }).score;
    expect(electricScore - offsetScore).toBeGreaterThan(10);
  });

  it('flags stall risk only on stall-sensitive cuts', () => {
    const humid = fakeDay({ rhMean: 90, tempHighF: 85 });
    const stallSensitive = scoreDay({ cut: 'brisket-packer', cooker: 'electric', day: humid });
    const notSensitive = scoreDay({ cut: 'chicken-thighs', cooker: 'electric', day: humid });
    expect(stallSensitive.stallRiskPct).toBeGreaterThan(0);
    expect(notSensitive.stallRiskPct).toBeGreaterThan(0); // computed, but…
    expect(stallSensitive.score).toBeLessThan(notSensitive.score); // …only penalizes the brisket
  });

  it('penalizes hot and cold extremes', () => {
    const baseline = fakeDay();
    const cold = fakeDay({ tempLowF: 20 });
    const hot = fakeDay({ tempHighF: 100 });
    const base = scoreDay({ cut: 'pork-loin', cooker: 'pellet', day: baseline }).score;
    const c = scoreDay({ cut: 'pork-loin', cooker: 'pellet', day: cold }).score;
    const h = scoreDay({ cut: 'pork-loin', cooker: 'pellet', day: hot }).score;
    expect(base).toBeGreaterThan(c);
    expect(base).toBeGreaterThan(h);
  });

  it('rounds score to an integer and bands consistently', () => {
    for (let tempHigh = 60; tempHigh <= 95; tempHigh += 5) {
      const r = scoreDay({
        cut: 'brisket-packer',
        cooker: 'pellet',
        day: fakeDay({ tempHighF: tempHigh }),
      });
      expect(Number.isInteger(r.score)).toBe(true);
      expect(['red', 'yellow', 'green', 'ideal']).toContain(r.band);
      if (r.score >= 85) expect(r.band).toBe('ideal');
      if (r.score >= 70 && r.score < 85) expect(r.band).toBe('green');
      if (r.score >= 50 && r.score < 70) expect(r.band).toBe('yellow');
      if (r.score < 50) expect(r.band).toBe('red');
    }
  });

  it('always includes at least one reason', () => {
    const res = scoreDay({ cut: 'pork-loin', cooker: 'electric', day: fakeDay() });
    expect(res.reasons.length).toBeGreaterThan(0);
  });

  it('propagates the day-index confidence into the score', () => {
    const r1 = scoreDay({ cut: 'pork-loin', cooker: 'pellet', day: fakeDay({ confidence: 'low' }) });
    expect(r1.confidence).toBe('low');
  });
});

describe('scoreForecast', () => {
  it('returns one score per day in order', () => {
    const days: WeatherDay[] = [
      fakeDay({ date: '2026-05-14' }),
      fakeDay({ date: '2026-05-15', precipProbPct: 80, precipIn: 0.4 }),
    ];
    const out = scoreForecast('pork-butt', 'offset', days);
    expect(out).toHaveLength(2);
    expect(out[0]?.score).toBeGreaterThan(out[1]!.score);
  });
});

describe('runtime validation', () => {
  it('throws on an unknown cooker (matches the JS mirror)', () => {
    expect(() =>
      scoreDay({
        cut: 'pork-loin',
        // Force a runtime-only invalid value past the type system —
        // simulating an API caller bypassing schema validation.
        cooker: 'pizza-oven' as Cooker,
        day: fakeDay(),
      })
    ).toThrow(/unknown cooker/);
  });

  it('throws on an unknown cut', () => {
    expect(() =>
      scoreDay({
        cut: 'tofu' as Cut,
        cooker: 'pellet',
        day: fakeDay(),
      })
    ).toThrow(/unknown cut/);
  });

  it('rejects prototype-chain keys on cut too', () => {
    for (const evil of ['toString', '__proto__', 'constructor']) {
      expect(() =>
        scoreDay({
          cut: evil as Cut,
          cooker: 'pellet',
          day: fakeDay(),
        })
      ).toThrow(/unknown cut/);
    }
  });

  it('rejects prototype-chain keys (toString, __proto__) as cooker values', () => {
    // `cooker in OBJ` would silently accept inherited keys; `Object.hasOwn`
    // is the right guard. Verify both blocked.
    for (const evil of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
      expect(() =>
        scoreDay({
          cut: 'pork-loin',
          cooker: evil as Cooker,
          day: fakeDay(),
        })
      ).toThrow(/unknown cooker/);
    }
  });
});

describe('every (cut, cooker) pair scores within bounds', () => {
  const CUTS: Cut[] = [
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
  const COOKERS: Cooker[] = ['offset', 'pellet', 'kamado', 'kettle', 'electric'];

  for (const cut of CUTS) {
    for (const cooker of COOKERS) {
      it(`${cut} × ${cooker} returns a finite 0-100 integer`, () => {
        const res = scoreDay({ cut, cooker, day: fakeDay() });
        expect(Number.isFinite(res.score)).toBe(true);
        expect(res.score).toBeGreaterThanOrEqual(0);
        expect(res.score).toBeLessThanOrEqual(100);
        expect(Number.isInteger(res.score)).toBe(true);
      });
    }
  }
});
