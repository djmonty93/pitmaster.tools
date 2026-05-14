// Physics helpers ported from _partials/smoke-physics.js.
// Only wetBulb_F and SP_COOKER_RH are reused — the rest of smoke-physics.js
// is cook-time machinery, irrelevant to weather scoring.
//
// Step 3 of the Best Smoke Days plan adds the parity Vitest spec that
// asserts this TS port matches the JS source within 0.01 °F across 20
// fixed inputs.

import type { Cooker } from './types.js';

/** Wet-bulb temperature, °F (Stull 2011). */
export function wetBulbF(dryBulbF: number, rh: number): number {
  const T = ((dryBulbF - 32) * 5) / 9;
  const tw =
    T * Math.atan(0.151977 * Math.pow(rh + 8.313659, 0.5)) +
    Math.atan(T + rh) -
    Math.atan(rh - 1.676331) +
    0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
    4.686035;
  return (tw * 9) / 5 + 32;
}

/** Default cooker-cavity relative humidity by cooker type (Blonder empirical). */
export const COOKER_RH: Record<Cooker, number> = {
  offset: 4,
  pellet: 12,
  kamado: 25,
  kettle: 18,
  electric: 45,
};
