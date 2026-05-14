// Parity guard: the TS port in packages/shared/src/physics.ts must
// agree with the JS source in _partials/smoke-physics.js to within
// 0.01 °F across 20 fixed inputs that span the realistic outdoor and
// cooker-cavity envelope. The Best Smoke Days plan flags drift as the
// single biggest risk on this port — this test is the canary.
//
// We don't import the JS file (it's a browser IIFE without exports);
// we read it as text, extract the wetBulb_F function with eval'd
// Function construction, and compare the result.

import { describe, expect, it } from 'vitest';
import { wetBulbF as wetBulbTs } from '@shared/physics';
import smokePhysicsSource from '../../../_partials/smoke-physics.js?raw';

// Reconstruct the JS wetBulb_F implementation from the partial source
// so this test will fail loudly if the JS source is edited but the TS
// port is not (and vice-versa).
function buildJsWetBulb(): (tdb: number, rh: number) => number {
  const match = smokePhysicsSource.match(/function wetBulb_F\([\s\S]*?\n\}/);
  if (!match) {
    throw new Error('could not extract wetBulb_F from smoke-physics.js');
  }
  // The function uses only Math globals — safe to construct in a fresh scope.
  // eslint-disable-next-line no-new-func
  return new Function(`${match[0]}; return wetBulb_F;`)() as (tdb: number, rh: number) => number;
}

const FIXTURES: Array<{ tdb: number; rh: number; label: string }> = [
  // Outdoor weather envelope
  { tdb: 30, rh: 80, label: 'cold humid winter morning' },
  { tdb: 45, rh: 60, label: 'cool damp spring' },
  { tdb: 55, rh: 40, label: 'mild dry day' },
  { tdb: 65, rh: 55, label: 'comfortable summer dawn' },
  { tdb: 75, rh: 50, label: 'pleasant mid-day' },
  { tdb: 80, rh: 60, label: 'warm humid afternoon' },
  { tdb: 85, rh: 50, label: 'hot moderate humidity' },
  { tdb: 90, rh: 70, label: 'hot humid day' },
  { tdb: 95, rh: 30, label: 'hot dry desert' },
  { tdb: 100, rh: 20, label: 'arid heat' },
  // Cooker-cavity envelope (high temp, low RH typical, except electric)
  { tdb: 225, rh: 4, label: 'offset at 225 °F' },
  { tdb: 225, rh: 12, label: 'pellet at 225 °F' },
  { tdb: 225, rh: 18, label: 'kettle at 225 °F' },
  { tdb: 225, rh: 25, label: 'kamado at 225 °F' },
  { tdb: 225, rh: 45, label: 'electric at 225 °F' },
  { tdb: 250, rh: 10, label: 'pellet at 250 °F' },
  { tdb: 275, rh: 20, label: 'kamado at 275 °F (turkey)' },
  // Edge cases
  { tdb: 32, rh: 100, label: 'freezing saturated' },
  { tdb: 100, rh: 100, label: 'thermal saturation' },
  { tdb: 70, rh: 0.5, label: 'near-zero humidity' },
];

describe('physics parity: TS port vs _partials/smoke-physics.js', () => {
  const wetBulbJs = buildJsWetBulb();

  for (const { tdb, rh, label } of FIXTURES) {
    it(`wetBulbF(${tdb}, ${rh}) — ${label} — agree within 0.01 °F`, () => {
      const ts = wetBulbTs(tdb, rh);
      const js = wetBulbJs(tdb, rh);
      expect(Math.abs(ts - js)).toBeLessThan(0.01);
    });
  }
});
