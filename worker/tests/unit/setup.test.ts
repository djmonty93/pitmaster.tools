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
    // Reference value for (85 °F dry bulb, 50 % RH), computed directly
    // from the formula in physics.ts: 71.2746 °F. Tightening the tolerance
    // below ±0.5 °F would couple this smoke check to floating-point order
    // of operations; the Step 3 parity Vitest spec pins the TS port to
    // the JS source within 0.01 °F across 20 inputs.
    const tw = wetBulbF(85, 50);
    expect(Number.isFinite(tw)).toBe(true);
    expect(tw).toBeCloseTo(71.2746, 0);
  });

  it('worker fetch handler is exported', () => {
    expect(typeof worker.fetch).toBe('function');
  });
});
