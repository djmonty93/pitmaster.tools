import { describe, expect, it } from 'vitest';
import smokePhysicsSource from '../../../_partials/smoke-physics.js?raw';

// The partial is a plain browser script (no exports). Wrap the whole source in a
// Function scope and hand back the globals we test — same trick as physics-parity.test.ts.
export function loadPhysics(): any {
  // eslint-disable-next-line no-new-func
  return new Function(
    smokePhysicsSource +
      '\n; return { spF2C, spC2F, spPSat, spPAtm, spHumidityRatio, spWetBulbC,' +
      ' spLc, spSurfaceArea, spPitWetBulbF, spPlateauTempF, spStallDwellH, spFade,' +
      ' spStall, spCompute, spResolve, wetBulb_F,' +
      ' SP_AIR_EXCHANGE, SP_CUT, SP_EVAP_C, SP_STALL_K, SP_STALL_START }; '
  )();
}

const P = loadPhysics();

describe('psychrometric primitives', () => {
  it('pSat(100 C) ~= 101.3 kPa within 1%', () => {
    expect(Math.abs(P.spPSat(100) - 101.3) / 101.3).toBeLessThan(0.01);
  });
  it('wetBulbC round-trips: saturated air gives T_wb == T_db within 0.1 C', () => {
    const p = P.spPAtm(0);
    const Wsat = P.spHumidityRatio(30, 100, p); // 30 C, 100% RH
    expect(Math.abs(P.spWetBulbC(30, Wsat, p) - 30)).toBeLessThan(0.1);
  });
  it('wetBulbC monotonic increasing in W at fixed T_db', () => {
    const p = P.spPAtm(0);
    const lo = P.spWetBulbC(40, 0.005, p);
    const hi = P.spWetBulbC(40, 0.020, p);
    expect(hi).toBeGreaterThan(lo);
  });
});
