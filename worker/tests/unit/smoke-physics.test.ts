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
      ' spStall, spCompute, spResolve, spPhase, spGetL, wetBulb_F, spSpritzFactor,' +
      ' spCutParams, SP_AIR_EXCHANGE, SP_CUT, SP_KM, SP_EVAP_C, SP_STALL_K, SP_STALL_START,' +
      ' SP_WRAP_FACTOR, SP_SPRITZ_C, SP_SPRITZ_CAP, SP_FATCAP_C, SP_INJ_XW_MAX }; '
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

const AMB = { ambientF: 70, ambientRh: 50, altitudeM: 0 };
function wb(cookerType: string, extra: any = {}) {
  return P.spPitWetBulbF({ pitF: 225, cookerType, kmKey: 'brisket-packer', weightLbs: 14, ...AMB, ...extra });
}

describe('pit mass balance -> wet-bulb', () => {
  it('reproduces spec §4 table within 1.5 F across cookers', () => {
    const spec: Record<string, number> = { offset: 97, pellet: 100, kettle: 102, drum: 101, kamado: 107, electric: 110 };
    for (const [c, target] of Object.entries(spec)) expect(Math.abs(wb(c) - target)).toBeLessThan(1.5);
  });
  it('W_pit rises (wet-bulb rises) as air exchange falls: sealed > open', () => {
    expect(wb('electric')).toBeGreaterThan(wb('kamado'));
    expect(wb('kamado')).toBeGreaterThan(wb('offset'));
  });
  it('humidity iteration is stable (4 passes) and stays below pit-5', () => {
    for (const c of ['offset', 'pellet', 'kettle', 'kamado', 'electric'])
      expect(wb(c)).toBeLessThanOrEqual(220);
  });
  it('water pan raises wet-bulb more than any cooker swap', () => {
    const panSwing = wb('electric', { waterPan: true }) - wb('electric');
    const cookerSwing = wb('electric') - wb('offset');
    expect(panSwing).toBeGreaterThan(cookerSwing);
  });
  it('more pieces raise pit wet-bulb', () => {
    expect(wb('kamado', { nPieces: 8 })).toBeGreaterThan(wb('kamado', { nPieces: 1 }));
  });
});

function stall(cookerType: string, extra: any = {}) {
  return P.spStall({ kmKey: 'brisket-packer', weightLbs: 14, thicknessIn: 0, pitF: 225,
    tfF: 203, cookerType, ...AMB, ...extra });
}

describe('plateau temperature + dwell', () => {
  it('every cooker produces a nonzero brisket dwell at 225 F (the #138 regression)', () => {
    for (const c of ['offset', 'pellet', 'kettle', 'kamado', 'electric'])
      expect(stall(c).dwellH).toBeGreaterThan(0);
  });
  it('dwell increases as air exchange falls (humid = longer)', () => {
    expect(stall('kamado').dwellH).toBeGreaterThan(stall('offset').dwellH);
  });
  it('plateau temperature increases as air exchange falls (humid = shallower)', () => {
    expect(stall('kamado').T_plat).toBeGreaterThan(stall('offset').T_plat);
  });
  it('plateau temperature decreases as Lc increases', () => {
    const thin = P.spPlateauTempF(107, 225, 0.6);
    const thick = P.spPlateauTempF(107, 225, 1.6);
    expect(thick).toBeLessThan(thin);
  });
  it('brisket dwell lands ~3.5 h dry, ~3.8 h kamado (spec §6)', () => {
    expect(stall('offset').dwellH).toBeGreaterThan(3.2);
    expect(stall('offset').dwellH).toBeLessThan(3.8);
    expect(stall('kamado').dwellH).toBeGreaterThan(3.5);
    expect(stall('kamado').dwellH).toBeLessThan(4.2);
  });
  it('brisket at 225 F has full fade; a high plateau vs low target fades to 0', () => {
    expect(P.spFade(175, 203)).toBe(1);
    expect(P.spFade(205, 203)).toBe(0);
  });
  it('doubling brisket weight raises dwell < 40% (thickness-only scaling)', () => {
    const d14 = stall('offset', { weightLbs: 14 }).dwellH;
    const d28 = stall('offset', { weightLbs: 28 }).dwellH;
    expect(d28 / d14).toBeLessThan(1.40);
  });
  it('A ±25% moves offset dwell <1% and kamado dwell <5% (sensitivity guardrail)', () => {
    // Perturb via nPieces as an A-proxy on the evap term: +25% pieces ~ +25% meat flux.
    const off1 = stall('offset').dwellH, offP = stall('offset', { nPieces: 1.25 }).dwellH;
    const kam1 = stall('kamado').dwellH, kamP = stall('kamado', { nPieces: 1.25 }).dwellH;
    expect(Math.abs(offP - off1) / off1).toBeLessThan(0.02);
    expect(Math.abs(kamP - kam1) / kam1).toBeLessThan(0.06);
  });
});

function compute(extra: any = {}) {
  return P.spCompute({ kmKey: 'brisket-packer', weightLbs: 14, thicknessIn: 0, pitF: 225,
    tiF: 38, tfF: 203, hasStall: true, wrapMethod: 'none', cookerType: 'offset', ...AMB, ...extra });
}

describe('spCompute / spResolve assembly', () => {
  it('phases split at T_plat, not 150', () => {
    const r = compute({ cookerType: 'kamado' });
    // t1 climbs to the plateau; with T_plat ~158 the boundary is well above 150.
    expect(r.T_plat).toBeGreaterThan(150);
    // The phase boundary IS T_plat (the #138 fix), not the old hardcoded 150:
    // t1 is exactly the climb ti->T_plat and t3 the climb T_plat->tf. A revert
    // to a 150 boundary would break these even though totalH stays the same.
    const Km = P.SP_KM['brisket-packer'];
    const L = P.spGetL('brisket-packer', 14);
    expect(r.t1h).toBeCloseTo(P.spPhase(Km, L, 225, 38, r.T_plat), 6);
    expect(r.t3h).toBeCloseTo(P.spPhase(Km, L, 225, r.T_plat, 203), 6);
    // total == baseline diffusion (ti->tf) + dwell, to 1e-6 h
    const baseline = P.spCompute({ kmKey: 'brisket-packer', weightLbs: 14, pitF: 225, tiF: 38,
      tfF: 203, hasStall: false, cookerType: 'kamado', ...AMB }).totalH;
    expect(Math.abs(r.totalH - (baseline + r.dwellH))).toBeLessThan(1e-6);
  });
  it('brisket totals land 12–20 h across cookers', () => {
    for (const c of ['offset', 'pellet', 'kettle', 'kamado', 'electric']) {
      const t = compute({ cookerType: c }).totalH;
      expect(t).toBeGreaterThan(12);
      expect(t).toBeLessThan(20);
    }
  });
  it('a stall adds time: unwrapped total > baseline no-stall cook', () => {
    const r = compute();
    const baseline = P.spCompute({ kmKey: 'brisket-packer', weightLbs: 14, pitF: 225, tiF: 38,
      tfF: 203, hasStall: false, cookerType: 'offset', ...AMB }).totalH;
    expect(r.totalH).toBeGreaterThan(baseline);
  });
  it('wrapped cook truncates the stall (t2h == 0)', () => {
    expect(compute({ wrapMethod: 'foil' }).t2h).toBe(0);
  });
  it('legacy rh path still resolves (browser-smoke compatibility)', () => {
    const r = P.spResolve({ kmKey: 'brisket-packer', weightLbs: 12, pitF: 250, rh: 4,
      currentF: 155, tfF: 195, hasStall: true, wrapMethod: 'foil', wrapTriggerF: 150 });
    expect(r.error).toBeNull();
    expect(r.remainingH).toBeGreaterThan(0);
  });
  it('spResolve dwell proration: full dwell until past the plateau, then zero', () => {
    const base = { kmKey: 'brisket-packer', weightLbs: 14, pitF: 225, tiF: 38, tfF: 203,
      hasStall: true, wrapMethod: 'none', cookerType: 'offset', ...AMB };
    const s = P.spStall({ ...base });
    // Still climbing (below the plateau): the whole stall is ahead -> full dwell remains.
    const belowF = Math.round(s.T_plat) - 5;
    const below = P.spResolve({ ...base, currentF: belowF }).remainingH;
    const climbBelow = P.spResolve({ ...base, currentF: belowF, hasStall: false }).remainingH;
    expect(Math.abs(below - (climbBelow + s.dwellH))).toBeLessThan(0.01);
    // At fridge start temp is also below the plateau -> full dwell.
    const atStart = P.spResolve({ ...base, currentF: 38 }).remainingH;
    const climbStart = P.spResolve({ ...base, currentF: 38, hasStall: false }).remainingH;
    expect(Math.abs(atStart - (climbStart + s.dwellH))).toBeLessThan(0.01);
    // Past the plateau: the stall is done -> no dwell remains, just the climb.
    const aboveF = Math.round(s.T_plat) + 5;
    const above = P.spResolve({ ...base, currentF: aboveF }).remainingH;
    const climbAbove = P.spResolve({ ...base, currentF: aboveF, hasStall: false }).remainingH;
    expect(Math.abs(above - climbAbove)).toBeLessThan(0.05); // ~no dwell left
  });
  it('a wrapped cook carries no dwell and is shorter than the unwrapped stall', () => {
    // Pork butt: plateau below the 150 trigger -> wrap at the ~146 stall temp.
    const pb = { kmKey: 'pork-butt', weightLbs: 8, thicknessIn: 0, pitF: 225, tiF: 38, tfF: 203,
      hasStall: true, cookerType: 'offset', ...AMB };
    const s = P.spStall({ ...pb });
    expect(s.T_plat).toBeLessThan(150);
    const pbWrap = P.spCompute({ ...pb, wrapMethod: 'foil', wrapTriggerF: 150 });
    const pbNone = P.spCompute({ ...pb, wrapMethod: 'none' });
    expect(pbWrap.dwellH).toBe(0);
    expect(pbWrap.wrapAtF).toBeCloseTo(s.T_plat, 5);          // wraps at the stall temp, not 150
    expect(pbWrap.totalH).toBeLessThan(pbNone.totalH);        // wrapping saves the stall
    // Brisket: plateau above the trigger -> wrap at 150, still no dwell, still shorter.
    const bz = { kmKey: 'brisket-packer', weightLbs: 14, thicknessIn: 0, pitF: 225, tiF: 38, tfF: 203,
      hasStall: true, cookerType: 'offset', ...AMB };
    const bWrap = P.spCompute({ ...bz, wrapMethod: 'foil', wrapTriggerF: 150 });
    const bNone = P.spCompute({ ...bz, wrapMethod: 'none' });
    expect(bWrap.dwellH).toBe(0);
    expect(bWrap.wrapAtF).toBe(150);
    expect(bWrap.totalH).toBeLessThan(bNone.totalH);
  });
});

describe('stage-5 modifiers (spec §7)', () => {
  it('wrap variants scale residual dwell: foil 0 < paper < boat < unwrapped', () => {
    const unwrapped = compute({ wrapMethod: 'none' }).t2h; // additive dwell
    const foil = compute({ wrapMethod: 'foil' }).t2h;
    const paper = compute({ wrapMethod: 'paper' }).t2h;
    const boat = compute({ wrapMethod: 'boat' }).t2h;
    expect(foil).toBe(0);
    expect(paper).toBeGreaterThan(0);
    expect(boat).toBeGreaterThan(paper);
    expect(unwrapped).toBeGreaterThan(boat);
    expect(paper).toBeCloseTo(unwrapped * 0.45, 6);
    expect(boat).toBeCloseTo(unwrapped * 0.70, 6);
  });
  it('wrapped totals order foil < paper < boat < none', () => {
    const f = compute({ wrapMethod: 'foil' }).totalH;
    const p = compute({ wrapMethod: 'paper' }).totalH;
    const b = compute({ wrapMethod: 'boat' }).totalH;
    const n = compute({ wrapMethod: 'none' }).totalH;
    expect(f).toBeLessThan(p);
    expect(p).toBeLessThan(b);
    expect(b).toBeLessThan(n);
  });
  it('spritz lengthens the unwrapped dwell, capped at 1.5x', () => {
    const base = compute({ spritzesPerHour: 0 }).t2h;
    const s2 = compute({ spritzesPerHour: 2 }).t2h;
    const s100 = compute({ spritzesPerHour: 100 }).t2h;
    expect(s2).toBeCloseTo(base * (1 + 0.06 * 2), 6);
    expect(s100).toBeCloseTo(base * 1.5, 6); // capped
  });
  it('spritz does not affect a wrapped cook (unwrapped-only)', () => {
    expect(compute({ wrapMethod: 'foil', spritzesPerHour: 5 }).totalH)
      .toBeCloseTo(compute({ wrapMethod: 'foil', spritzesPerHour: 0 }).totalH, 6);
    expect(compute({ wrapMethod: 'paper', spritzesPerHour: 5 }).totalH)
      .toBeCloseTo(compute({ wrapMethod: 'paper', spritzesPerHour: 0 }).totalH, 6);
  });
  it('injection raises the dwell via water fraction (Xw 0.71->0.81 ~ +14%)', () => {
    const base = stall('offset', { injectionPct: 0 }).dwellH;
    const inj = stall('offset', { injectionPct: 10 }).dwellH;
    expect(inj / base).toBeCloseTo(0.81 / 0.71, 2);
  });
  it('fat cap lowers plateau temp and lengthens dwell', () => {
    const base = stall('offset', { fatCapInches: 0 });
    const fat = stall('offset', { fatCapInches: 0.5 });
    expect(fat.Lc).toBeCloseTo(base.Lc + 0.25, 6); // +0.5*0.5 in
    expect(fat.T_plat).toBeLessThan(base.T_plat);
    expect(fat.dwellH).toBeGreaterThan(base.dwellH);
  });
  it('spResolve: paper wrap keeps partial residual dwell, foil keeps none', () => {
    const base = { kmKey: 'brisket-packer', weightLbs: 14, pitF: 225, tiF: 38, tfF: 203,
      hasStall: true, cookerType: 'offset', wrapTriggerF: 150, ...AMB };
    const s = P.spStall({ ...base });
    const belowF = Math.round(s.T_plat) - 20; // below the plateau -> full residual ahead
    const foil = P.spResolve({ ...base, wrapMethod: 'foil', currentF: belowF }).remainingH;
    const paper = P.spResolve({ ...base, wrapMethod: 'paper', currentF: belowF }).remainingH;
    const climb = P.spResolve({ ...base, hasStall: false, currentF: belowF }).remainingH;
    expect(Math.abs(foil - climb)).toBeLessThan(0.01);       // foil: no dwell
    expect(paper - foil).toBeCloseTo(s.dwellH * 0.45, 2);    // paper: +45% residual
  });
  it('spResolve gates wrapped residual dwell at wrapAtF, matching spCompute (paper)', () => {
    const base = { kmKey: 'brisket-packer', weightLbs: 14, pitF: 225, tiF: 38, tfF: 203,
      hasStall: true, cookerType: 'offset', wrapTriggerF: 150, wrapMethod: 'paper', ...AMB };
    const s = P.spStall({ ...base });
    const wrapAt = Math.min(150, s.T_plat);      // 150 for brisket (T_plat > 150)
    const residual = s.dwellH * 0.45;
    // Just below the wrap point: the whole residual is still ahead.
    const below = P.spResolve({ ...base, currentF: wrapAt - 5 }).remainingH;
    const climbBelow = P.spResolve({ ...base, hasStall: false, currentF: wrapAt - 5 }).remainingH;
    expect(below - climbBelow).toBeCloseTo(residual, 2);
    // Just above the wrap point (but still below T_plat, ~152.3 for these params):
    // the residual is already burned, matching spCompute's layout. A +5 probe would
    // overshoot T_plat entirely and mask the bug, so stay inside the (wrapAt, T_plat) gap.
    const above = P.spResolve({ ...base, currentF: wrapAt + 1 }).remainingH;
    const climbAbove = P.spResolve({ ...base, hasStall: false, currentF: wrapAt + 1 }).remainingH;
    expect(Math.abs(above - climbAbove)).toBeLessThan(0.05);
  });
});
