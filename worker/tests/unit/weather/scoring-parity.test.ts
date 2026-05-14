// Parity guard: packages/shared/src/scoring.ts and the hand-mirrored
// _partials/weather-score-shared.js must produce identical scoreDay
// output for every (cut, cooker, day) the front end will plausibly send.
// The browser scorer is what users see when they toggle cut/cooker; the
// server scorer is what the API returns. They must agree.

import { describe, expect, it } from 'vitest';
import { scoreDay as scoreDayTs } from '@shared/scoring';
import type { Cooker, Cut, WeatherDay } from '@shared/types';
import jsMirrorSource from '../../../../_partials/weather-score-shared.js?raw';

// Run the IIFE in a fresh sandbox and grab the exposed WeatherScore object.
function loadJsMirror(): {
  scoreDay: (input: { cut: Cut; cooker: Cooker; day: WeatherDay }) => unknown;
} {
  const fakeGlobal: { WeatherScore?: { scoreDay: (input: unknown) => unknown } } = {};
  const factory = new Function(
    'globalThis',
    'window',
    `${jsMirrorSource}\nreturn globalThis.WeatherScore;`
  );
  const ws = factory(fakeGlobal, fakeGlobal) as {
    scoreDay: (input: { cut: Cut; cooker: Cooker; day: WeatherDay }) => unknown;
  };
  if (!ws || typeof ws.scoreDay !== 'function') {
    throw new Error('weather-score-shared.js did not register WeatherScore.scoreDay');
  }
  return ws;
}

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

const DAY_SCENARIOS: Array<{ name: string; day: WeatherDay }> = [
  { name: 'benign', day: fakeDay() },
  { name: 'rainy', day: fakeDay({ precipProbPct: 80, precipIn: 0.4 }) },
  { name: 'windy', day: fakeDay({ gustMphMax: 32 }) },
  { name: 'cold', day: fakeDay({ tempLowF: 22, tempHighF: 48 }) },
  { name: 'hot', day: fakeDay({ tempHighF: 100, rhMean: 60 }) },
  { name: 'humid', day: fakeDay({ rhMean: 90 }) },
];

describe('scoring parity: TS source vs _partials/weather-score-shared.js', () => {
  const jsMirror = loadJsMirror();

  for (const cut of CUTS) {
    for (const cooker of COOKERS) {
      for (const { name, day } of DAY_SCENARIOS) {
        it(`${cut} × ${cooker} × ${name} — identical score, band, reasons`, () => {
          const ts = scoreDayTs({ cut, cooker, day });
          const js = jsMirror.scoreDay({ cut, cooker, day }) as {
            score: number;
            band: string;
            stallRiskPct: number;
            reasons: string[];
          };
          expect(js.score).toBe(ts.score);
          expect(js.band).toBe(ts.band);
          expect(js.stallRiskPct).toBe(ts.stallRiskPct);
          expect(js.reasons).toEqual(ts.reasons);
        });
      }
    }
  }
});
