// Sanity tests for the Step 1 scaffolding.
// - shared package resolves through tsconfig paths
// - physics constants are present
// - wetBulbF matches the Stull 2011 reference value to ±0.5 °F
// - the worker entrypoint exports a fetch handler

import { describe, expect, it } from 'vitest';
import { COOKER_RH, wetBulbF } from '@shared/physics';
import type { Cooker } from '@shared/types';
import worker from '../../src/index';

describe('Step 1 scaffolding', () => {
  it('shared physics constants are exposed for every cooker', () => {
    const cookers: Cooker[] = ['offset', 'pellet', 'kamado', 'kettle', 'electric'];
    for (const c of cookers) {
      const rh = COOKER_RH[c];
      expect(rh).toBeGreaterThan(0);
      expect(rh).toBeLessThan(100);
    }
  });

  it('wetBulbF matches the Stull 2011 reference value within 0.5 °F', () => {
    // Hand-computed reference for (85 °F dry bulb, 50 % RH):
    //   T   = (85 - 32) * 5/9                                   = 29.4444 °C
    //   tw  = 25.3017 + 1.55821 - 1.55012 + 1.18563 - 4.686035  = 21.8094 °C
    //   F   = 21.8094 * 9/5 + 32                                = 71.26 °F
    // Tightening the tolerance below ±0.5 °F would tie this test to the
    // intermediate-precision of the TS port; the Step 3 parity Vitest spec
    // pins the TS port to the JS source to 0.01 °F across 20 inputs.
    const tw = wetBulbF(85, 50);
    expect(Number.isFinite(tw)).toBe(true);
    expect(tw).toBeCloseTo(71.26, 0);
  });

  it('worker fetch handler is exported', () => {
    expect(typeof worker.fetch).toBe('function');
  });
});
