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
      expect(COOKER_RH[c]).toBeGreaterThan(0);
    }
  });

  it('wetBulbF returns a finite number for plausible weather', () => {
    const tw = wetBulbF(225, 12);
    expect(Number.isFinite(tw)).toBe(true);
    expect(tw).toBeLessThan(225);
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
