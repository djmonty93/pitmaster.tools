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

describe('cut geometry', () => {
  it('A scales as m^(1-n): brisket 14->28 lb ~1.72x', () => {
    const r = P.spSurfaceArea('brisket-packer', 28) / P.spSurfaceArea('brisket-packer', 14);
    expect(Math.abs(r - 1.72)).toBeLessThan(0.02);
  });
  it('A scales as m^(1-n): pork butt 8->16 lb ~1.59x', () => {
    const r = P.spSurfaceArea('pork-butt', 16) / P.spSurfaceArea('pork-butt', 8);
    expect(Math.abs(r - 1.59)).toBeLessThan(0.02);
  });
  it('surface-to-mass ordering: baby back highest, prime rib lowest', () => {
    const ratio = (k: string) => P.SP_CUT[k].ARef / P.SP_CUT[k].wRef;
    const keys = Object.keys(P.SP_CUT);
    const byRatio = keys.slice().sort((a, b) => ratio(b) - ratio(a));
    expect(byRatio[0]).toBe('baby-back-ribs');
  });
  it('Lc rises with weight and Lc(ref weight) == LcRef', () => {
    expect(P.spLc('brisket-packer', 14, 0)).toBeCloseTo(1.25, 5);
    expect(P.spLc('brisket-packer', 20, 0)).toBeGreaterThan(1.25);
  });
});
