/* smoke-physics.js — diffusion-based smoking time engine
   Shared across all Pitmaster Tools smoking calculators.
   All temperatures in °F, times in hours, L in inches. */

/* ── Wet-bulb temperature (Stull 2011) ──────────────────────────────────────*/
function wetBulb_F(Tdb_F, rh) {
  var T = (Tdb_F - 32) * 5 / 9;
  var tw = T * Math.atan(0.151977 * Math.pow(rh + 8.313659, 0.5))
         + Math.atan(T + rh)
         - Math.atan(rh - 1.676331)
         + 0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh)
         - 4.686035;
  return tw * 9 / 5 + 32;
}

/* ── Temperature conversions ────────────────────────────────────────────────*/
function spF2C(f) { return (f - 32) * 5 / 9; }
function spC2F(c) { return c * 9 / 5 + 32; }

/* ── Psychrometrics (SI: kPa, °C, humidity ratio W in kg water / kg dry air) ─
   pSat: Buck equation. wetBulbC: ASHRAE relation solved by bisection (stable
   near saturation, where a Newton step is not). */
function spPSat(T) { return 0.61121 * Math.exp((18.678 - T / 234.5) * (T / (257.14 + T))); }
function spPAtm(altM) { return 101.325 * Math.pow(1 - 2.25577e-5 * (altM || 0), 5.2559); }
function spHumidityRatio(T, rh, p) {
  var pv = (rh / 100) * spPSat(T);
  return 0.621945 * pv / (p - pv);
}
function spWetBulbC(Tdb, W, p) {
  var lo = 0, hi = Tdb, Twb, Ws, Wc, i;
  for (i = 0; i < 40; i++) {
    Twb = (lo + hi) / 2;
    Ws = 0.621945 * spPSat(Twb) / (p - spPSat(Twb));
    Wc = ((2501 - 2.326 * Twb) * Ws - 1.006 * (Tdb - Twb)) / (2501 + 1.86 * Tdb - 4.186 * Twb);
    if (Wc > W) hi = Twb; else lo = Twb;
  }
  return (lo + hi) / 2;
}

/* ── Default RH by cooker type (Blonder empirical) ──────────────────────────*/
var SP_COOKER_RH = {
  'offset':   4,
  'pellet':   12,
  'kamado':   25,
  'kettle':   18,
  'electric': 45
};

/* ── Km coefficients (calibrated to forum/competition cook data) ─────────── */
var SP_KM = {
  'brisket-flat':        1.90,
  'brisket-packer':      1.85,
  'pork-butt':           1.80,
  'spare-ribs':          1.75,
  'baby-back-ribs':      1.70,
  'pork-loin':           1.60,
  'whole-chicken':       1.55,
  'spatchcock-chicken':  1.55,
  'chicken-thighs':      1.55,
  'whole-turkey':        1.55,
  'turkey-breast':       1.60,
  'fish':                1.50,
  'lamb-shoulder':       1.85
};

/* ── Per-cut stall parameters (spec §9 + §0.1) ──────────────────────────────
   LcRef: conduction half-thickness (in) at wRef. ARef: surface area (m²) at
   wRef (geometric, rugosity baked in). Xw: water mass fraction. n: thickness
   scaling exponent (Lc ∝ w^n, A ∝ w^(1−n)). Only stall-bearing cuts need real
   values; non-stall cuts fall through to SP_CUT_DEFAULT and never reach the
   dwell path. These feed plateau/dwell ONLY — baseline diffusion uses spGetL. */
var SP_CUT = {
  'brisket-packer': { LcRef: 1.25, wRef: 14,  Xw: 0.71, n: 0.22, ARef: 0.36 },
  'brisket-flat':   { LcRef: 1.00, wRef: 7,   Xw: 0.73, n: 0.22, ARef: 0.23 },
  'pork-butt':      { LcRef: 1.50, wRef: 8,   Xw: 0.72, n: 0.33, ARef: 0.22 },
  'spare-ribs':     { LcRef: 0.60, wRef: 3.5, Xw: 0.72, n: 0.22, ARef: 0.26 },
  'baby-back-ribs': { LcRef: 0.50, wRef: 2,   Xw: 0.73, n: 0.22, ARef: 0.17 },
  'lamb-shoulder':  { LcRef: 1.30, wRef: 5,   Xw: 0.72, n: 0.33, ARef: 0.17 }
};
var SP_CUT_DEFAULT = { LcRef: 1.25, wRef: 10, Xw: 0.71, n: 0.30, ARef: 0.30 };

function spCutParams(kmKey) { return SP_CUT[kmKey] || SP_CUT_DEFAULT; }

/* Conduction half-thickness (in). thicknessIn override wins. */
function spLc(kmKey, weightLbs, thicknessIn) {
  if (thicknessIn > 0) return thicknessIn;
  var c = spCutParams(kmKey);
  return c.LcRef * Math.pow((weightLbs || c.wRef) / c.wRef, c.n);
}

/* Evaporating surface area (m²). Same n as spLc, opposite role. */
function spSurfaceArea(kmKey, weightLbs) {
  var c = spCutParams(kmKey);
  return c.ARef * Math.pow((weightLbs || c.wRef) / c.wRef, 1 - c.n);
}

/* ── Cooker air exchange (kg dry air/h) — the only place cooker type enters
   the humidity model (spec §3.2). Higher = drier pit. ────────────────────── */
var SP_AIR_EXCHANGE = {
  'offset': 40, 'drum': 14, 'pellet': 18, 'kettle': 10,
  'kamado': 4, 'electric': 3, 'pellet-hi': 26
};

var SP_EVAP_C = 0.28;   /* kg/(h·m²·100K) — lumped meat mass-transfer coeff */
var SP_PAN_C  = 1.6;    /* kg/(h·m²·100K) — water pan */
var SP_PAN_AREA = 0.25; /* m² — full water pan surface */
var SP_WIND_C = 0.05;   /* per mph — draft boost on open cookers */

/* Pit wet-bulb (°F) from an ambient + cooker mass balance (spec §3–4).
   Fixed-point iterate 4x (evap flux depends on T_wb depends on flux). Final
   T_wb capped at pitF−5 to keep the plateau/dwell math off the singularity. */
function spPitWetBulbF(o) {
  var p = spPAtm(o.altitudeM);
  var Wamb = spHumidityRatio(spF2C(o.ambientF != null ? o.ambientF : 70),
                             (o.ambientRh != null ? o.ambientRh : 50), p);
  var TpitC = spF2C(o.pitF);
  var mAir = SP_AIR_EXCHANGE[o.cookerType] || 18;
  if (o.windMph && (o.cookerType === 'offset' || o.cookerType === 'kettle' || o.cookerType === 'drum')) {
    mAir = mAir * (1 + SP_WIND_C * o.windMph);
  }
  var Asurf = spSurfaceArea(o.kmKey, o.weightLbs);
  var Apan = o.waterPan ? SP_PAN_AREA : 0;
  var nPieces = o.nPieces || 1;
  var capC = spF2C(o.pitF - 5);
  var TwbC = 40, i, mEvap, mPan, Wpit;
  for (i = 0; i < 4; i++) {
    mEvap = SP_EVAP_C * Asurf * (TpitC - TwbC) / 100 * nPieces;
    mPan  = Apan > 0 ? SP_PAN_C * Apan * (TpitC - TwbC) / 100 : 0;
    Wpit = Wamb + (mEvap + mPan) / mAir;
    TwbC = spWetBulbC(TpitC, Wpit, p);
    if (TwbC > capC) TwbC = capC;
  }
  return spC2F(TwbC);
}

var SP_STALL_START = 150; /* wrap-trigger default only; no longer a stall-band edge */

/* ── Plateau temperature & additive dwell (spec §5–6) ───────────────────────
   Two independent axes: T_plat rises with wet-bulb and falls with thickness;
   dwell = K·Lc²·(Xw/Xw_ref)/(pit−T_wb) rises with wet-bulb. The stall is
   ADDITIVE — total = baseline diffusion cook + dwell — so it can only ever add
   time, and fades to zero as the plateau overtakes the target. */
var SP_PLAT_A = 0.68;
var SP_PLAT_B = 0.20;   /* per inch */
var SP_STALL_K = 287;   /* °F·h/in² */
var SP_XW_REF = 0.71;
var SP_PLAT_FADE = 15;  /* °F */

function spPlateauTempF(T_wb, pitF, Lc) {
  var T = T_wb + (pitF - T_wb) * (SP_PLAT_A - SP_PLAT_B * Lc);
  var lo = T_wb + 5, hi = pitF - 5;
  return Math.min(Math.max(T, lo), hi);
}

function spStallDwellH(Lc, Xw, pitF, T_wb) {
  var drive = pitF - T_wb;
  if (drive <= 0) return 0;
  return SP_STALL_K * Lc * Lc * (Xw / SP_XW_REF) / drive;
}

/* Fade: 1 well below target, ramping to 0 as the plateau reaches the pull temp
   (the poultry/ribs/low-target branch — the meat blows through the plateau). */
function spFade(T_plat, tfF) {
  var f = (tfF - T_plat) / SP_PLAT_FADE;
  return Math.min(Math.max(f, 0), 1);
}

/* Resolve the stall quantities for a set of cook params. T_wb comes from the
   mass balance when cookerType is given, else the legacy Stull path (rh). */
function spStall(p) {
  var c = spCutParams(p.kmKey);
  var Lc = spLc(p.kmKey, p.weightLbs || c.wRef, p.thicknessIn);
  var T_wb = (p.cookerType)
    ? spPitWetBulbF({ pitF: p.pitF, cookerType: p.cookerType,
        ambientF: p.ambientF, ambientRh: p.ambientRh, altitudeM: p.altitudeM,
        waterPan: p.waterPan, nPieces: p.nPieces, kmKey: p.kmKey,
        weightLbs: p.weightLbs, windMph: p.windMph })
    : wetBulb_F(p.pitF, p.rh || 12);
  var T_plat = spPlateauTempF(T_wb, p.pitF, Lc);
  var dwellH = spStallDwellH(Lc, c.Xw, p.pitF, T_wb) * spFade(T_plat, p.tfF);
  return { T_wb: T_wb, T_plat: T_plat, Lc: Lc, dwellH: dwellH };
}

/* ── Weight → characteristic half-thickness L (inches) ─────────────────────*/
function spGetL(kmKey, weightLbs) {
  switch (kmKey) {
    case 'brisket-flat':
    case 'brisket-packer':  return 1.2 + 0.05 * weightLbs;
    case 'pork-butt':       return 1.9;
    case 'spare-ribs':      return 0.75;
    case 'baby-back-ribs':  return 0.50;
    case 'whole-chicken':      return 1.0 + 0.10 * weightLbs;
    case 'spatchcock-chicken': return 1.2 + 0.05 * weightLbs;
    case 'turkey-breast':      return 1.0 + 0.08 * weightLbs;
    case 'whole-turkey':       return 1.5 + 0.05 * weightLbs;
    case 'lamb-shoulder':   return 1.0 + 0.07 * weightLbs;
    default:                return 1.5;
  }
}

/* ── Core diffusion phase formula ───────────────────────────────────────────
   t = Km * L² * ln((T_drive - Ti) / (T_drive - Tf))
   Returns Infinity when the target temperature is unreachable. */
function spPhase(Km, L, T_drive, Ti, Tf) {
  if (T_drive <= Tf) return Infinity;
  var ratio = (T_drive - Ti) / (T_drive - Tf);
  if (ratio <= 0 || !isFinite(ratio)) return Infinity;
  return Km * L * L * Math.log(ratio);
}

/* ── Main compute ────────────────────────────────────────────────────────────
  params:
    kmKey        — key into SP_KM
    weightLbs    — used for L when thicknessIn is 0/falsy
    thicknessIn  — half-thickness override (inches); 0 = derive from weight
    pitF         — smoker temp °F
    rh           — relative humidity 0-100
    tiF          — starting meat temp °F (default 38)
    tfF          — pull temp °F
    hasStall     — true for brisket/butt/ribs/lamb
    wrapTriggerF — internal temp at which meat is wrapped (default SP_STALL_START)
    wrapMethod   — 'foil' | 'paper' | 'none'
  returns:
    { t1h, t2h, t3h, totalH, T_wb, L, error } */
function spCompute(p) {
  var Km  = SP_KM[p.kmKey] || 1.70;
  var L   = (p.thicknessIn > 0) ? p.thicknessIn : spGetL(p.kmKey, p.weightLbs || 10);
  var tiF = p.tiF || 38;

  /* No-stall cuts: single diffusion phase. Humidity does not affect timing here
     (baseline uses Km/L), so T_wb is display-only. */
  if (!p.hasStall) {
    var tw0 = (p.cookerType) ? spStall(p).T_wb : wetBulb_F(p.pitF, p.rh || 12);
    var t = spPhase(Km, L, p.pitF, tiF, p.tfF);
    if (!isFinite(t)) return { error: 'Pull temperature exceeds pit temperature.' };
    return { t1h: t, t2h: 0, t3h: 0, totalH: t, T_wb: tw0, T_plat: null, L: L, dwellH: 0, error: null };
  }

  var s = spStall(p);
  if (s.T_wb >= p.pitF) {
    return { error: 'Pit temperature is too low to cook. Raise smoker temperature.' };
  }

  /* Wrapped cook (saturated limit): stall truncated, climb at full pit drive. */
  var wrapActive = (p.wrapMethod === 'foil' || p.wrapMethod === 'paper');
  if (wrapActive) {
    var Twrap = p.wrapTriggerF || SP_STALL_START;
    var t1w = spPhase(Km, L, p.pitF, tiF, Twrap);
    var t3w = spPhase(Km, L, p.pitF, Twrap, p.tfF);
    if (!isFinite(t1w) || !isFinite(t3w)) {
      return { error: 'Pull temperature or wrap trigger temperature exceeds pit temperature.' };
    }
    return { t1h: t1w, t2h: 0, t3h: t3w, totalH: t1w + t3w, T_wb: s.T_wb, T_plat: s.T_plat, L: L, dwellH: 0, error: null };
  }

  /* Plateau overtakes the target: no observable stall, single climb. Guards
     against a negative t3 when T_plat > tfF. */
  if (s.T_plat >= p.tfF) {
    var tAll = spPhase(Km, L, p.pitF, tiF, p.tfF);
    if (!isFinite(tAll)) return { error: 'Pull temperature exceeds pit temperature.' };
    return { t1h: tAll, t2h: 0, t3h: 0, totalH: tAll, T_wb: s.T_wb, T_plat: s.T_plat, L: L, dwellH: 0, error: null };
  }

  /* Unwrapped stall: additive. Phase boundary = T_plat (was hardcoded 150). */
  var t1 = spPhase(Km, L, p.pitF, tiF, s.T_plat);
  var t2 = s.dwellH;
  var t3 = spPhase(Km, L, p.pitF, s.T_plat, p.tfF);
  if (!isFinite(t1) || !isFinite(t3)) {
    return { error: 'Pull temperature exceeds pit temperature.' };
  }
  return { t1h: t1, t2h: t2, t3h: t3, totalH: t1 + t2 + t3, T_wb: s.T_wb, T_plat: s.T_plat, L: L, dwellH: t2, error: null };
}

/* ── Shared result scaling ────────────────────────────────────────────────────
   Preserve phase ratios when a calculator applies a simple time modifier. */
function spScaleResult(result, factor) {
  if (!result || !isFinite(factor) || factor <= 0 || factor === 1) return result;
  return {
    t1h: (result.t1h || 0) * factor,
    t2h: (result.t2h || 0) * factor,
    t3h: (result.t3h || 0) * factor,
    totalH: (result.totalH || 0) * factor,
    T_wb: result.T_wb,
    L: result.L,
    error: result.error || null
  };
}

/* ── Live re-solve ───────────────────────────────────────────────────────────
  params: { kmKey, thicknessIn, weightLbs, pitF, rh, currentF, tfF, hasStall, wrapMethod, wrapTriggerF }
  returns: { remainingH, error } */
function spResolve(p) {
  var Km  = SP_KM[p.kmKey] || 1.70;
  var L   = (p.thicknessIn > 0) ? p.thicknessIn : spGetL(p.kmKey, p.weightLbs || 10);
  var tiF = p.tiF || 38;
  var hasStall = !!p.hasStall;
  var wrapMethod = p.wrapMethod || 'none';
  var wrapTriggerF = p.wrapTriggerF || SP_STALL_START;
  var wrapActive = (wrapMethod === 'foil' || wrapMethod === 'paper');

  if (p.currentF >= p.tfF) {
    return { remainingH: 0, error: 'Temperature already at or above pull temperature.' };
  }

  var t;
  if (!hasStall) {
    t = spPhase(Km, L, p.pitF, p.currentF, p.tfF);
  } else if (wrapActive) {
    if (p.currentF < wrapTriggerF) {
      t = spPhase(Km, L, p.pitF, p.currentF, wrapTriggerF)
        + spPhase(Km, L, p.pitF, wrapTriggerF, p.tfF);
    } else {
      t = spPhase(Km, L, p.pitF, p.currentF, p.tfF);
    }
  } else {
    var s = spStall(p);
    if (s.T_wb >= p.pitF) {
      return { remainingH: 0, error: 'Pit temperature is too low to cook. Raise smoker temperature.' };
    }
    if (s.T_plat >= p.tfF || s.dwellH <= 0) {
      t = spPhase(Km, L, p.pitF, p.currentF, p.tfF);
    } else {
      var frac = (s.T_plat - p.currentF) / (s.T_plat - tiF);
      frac = Math.min(Math.max(frac, 0), 1);
      t = spPhase(Km, L, p.pitF, p.currentF, p.tfF) + s.dwellH * frac;
    }
  }

  if (!isFinite(t) || t < 0) {
    return { remainingH: 0, error: 'Cannot calculate: check pit and target temperatures.' };
  }
  return { remainingH: t, error: null };
}

/* ── Shared display helper ───────────────────────────────────────────────────
   Format fractional hours as "Xh Ym" */
function spFmtHrs(h) {
  if (!isFinite(h) || h < 0) return '—';
  var totalMin = Math.round(h * 60);
  var hrs  = Math.floor(totalMin / 60);
  var mins = totalMin % 60;
  if (hrs === 0) return mins + 'm';
  if (mins === 0) return hrs + 'h';
  return hrs + 'h ' + mins + 'm';
}
