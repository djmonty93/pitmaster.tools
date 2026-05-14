// Sanity tests for the Step 1 scaffolding.
// - shared package resolves through tsconfig paths
// - physics constants are present
// - the worker entrypoint exports a fetch handler

import { describe, expect, it } from 'vitest';
import { COOKER_RH, wetBulbF } from '@shared/physics';
import type { Cooker, ScoreInput } from '@shared/types';
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

  it('wetBulbF returns a plausible outdoor wet-bulb', () => {
    // 85 °F / 50 % RH is a hot-and-humid summer day; wet-bulb should land
    // in the mid-70s. Stull (2011) gives ~73.6 °F for this input — assert
    // a tight window so a regression in the port is caught.
    const tw = wetBulbF(85, 50);
    expect(Number.isFinite(tw)).toBe(true);
    expect(tw).toBeGreaterThan(70);
    expect(tw).toBeLessThan(76);
  });

  it('ScoreInput type wires up through tsconfig paths', () => {
    const fixture: Pick<ScoreInput, 'cut' | 'cooker'> = {
      cut: 'brisket-flat',
      cooker: 'offset',
    };
    expect(fixture.cut).toBe('brisket-flat');
  });

  it('worker fetch handler is exported', () => {
    expect(typeof worker.fetch).toBe('function');
  });
});
