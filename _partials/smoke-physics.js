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

var SP_STALL_START = 150;
var SP_STALL_END   = 165;

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
  var rh  = p.rh || 12;
  var tiF = p.tiF || 38;
  var T_wb = wetBulb_F(p.pitF, rh);

  if (T_wb >= p.pitF) {
    return { error: 'Pit temperature is too low to cook. Raise smoker temperature.' };
  }

  /* No-stall path: single phase to pull temp */
  if (!p.hasStall) {
    var t = spPhase(Km, L, p.pitF, tiF, p.tfF);
    if (!isFinite(t)) return { error: 'Pull temperature exceeds pit temperature.' };
    return { t1h: t, t2h: 0, t3h: 0, totalH: t, T_wb: T_wb, L: L, error: null };
  }

  var wrapActive = (p.wrapMethod === 'foil' || p.wrapMethod === 'paper');

  if (wrapActive) {
    /* Wrapped cook: phase 1 to wrap trigger, then drive is T_pit to pull temp.
       Foil at ~95% RH means T_wb ≈ T_pit, so evaporative cooling vanishes —
       the drive temperature for the wrapped phase is T_pit. */
    var Twrap = p.wrapTriggerF || SP_STALL_START;
    var t1 = spPhase(Km, L, p.pitF, tiF, Twrap);
    var t_wrapped = spPhase(Km, L, p.pitF, Twrap, p.tfF);
    if (!isFinite(t1) || !isFinite(t_wrapped)) {
      return { error: 'Pull temperature or wrap trigger temperature exceeds pit temperature.' };
    }
    return { t1h: t1, t2h: 0, t3h: t_wrapped, totalH: t1 + t_wrapped, T_wb: T_wb, L: L, error: null };
  }

  /* Unwrapped stall path: 3 phases */
  var T_ss = SP_STALL_START;
  var T_se = SP_STALL_END;
  var t1 = spPhase(Km, L, p.pitF, tiF, T_ss);

  /* Phase 2: stall plateau driven by wet-bulb.
     Guard: if T_wb >= T_se, the pit is hot/humid enough that no true stall occurs. */
  var t2 = 0;
  if (T_wb < T_se && T_wb < T_ss) {
    t2 = spPhase(Km, L, T_wb, T_ss, T_se);
    if (!isFinite(t2)) t2 = 0;
  }

  var t3 = spPhase(Km, L, p.pitF, T_se, p.tfF);
  if (!isFinite(t1) || !isFinite(t3)) {
    return { error: 'Pull temperature exceeds pit temperature.' };
  }
  return { t1h: t1, t2h: t2, t3h: t3, totalH: t1 + t2 + t3, T_wb: T_wb, L: L, error: null };
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
  var Km   = SP_KM[p.kmKey] || 1.70;
  var L    = (p.thicknessIn > 0) ? p.thicknessIn : spGetL(p.kmKey, p.weightLbs || 10);
  var T_wb = wetBulb_F(p.pitF, p.rh || 12);
  var hasStall = !!p.hasStall;
  var wrapMethod = p.wrapMethod || 'none';
  var wrapTriggerF = p.wrapTriggerF || SP_STALL_START;
  var wrapActive = (wrapMethod === 'foil' || wrapMethod === 'paper');
  var stallActive = hasStall && T_wb < SP_STALL_START && T_wb < SP_STALL_END && p.tfF > SP_STALL_START;
  var t = 0;

  if (p.currentF >= p.tfF) {
    return { remainingH: 0, error: 'Temperature already at or above pull temperature.' };
  }

  if (!hasStall) {
    t = spPhase(Km, L, p.pitF, p.currentF, p.tfF);
  } else if (wrapActive) {
    if (p.currentF < wrapTriggerF) {
      t = spPhase(Km, L, p.pitF, p.currentF, wrapTriggerF)
        + spPhase(Km, L, p.pitF, wrapTriggerF, p.tfF);
    } else {
      t = spPhase(Km, L, p.pitF, p.currentF, p.tfF);
    }
  } else if (!stallActive || p.currentF >= SP_STALL_END) {
    t = spPhase(Km, L, p.pitF, p.currentF, p.tfF);
  } else if (p.currentF < SP_STALL_START) {
    t = spPhase(Km, L, p.pitF, p.currentF, SP_STALL_START)
      + spPhase(Km, L, T_wb, SP_STALL_START, SP_STALL_END)
      + spPhase(Km, L, p.pitF, SP_STALL_END, p.tfF);
  } else {
    t = spPhase(Km, L, T_wb, p.currentF, SP_STALL_END)
      + spPhase(Km, L, p.pitF, SP_STALL_END, p.tfF);
  }

  if (!isFinite(t) || t < 0) {
    return { remainingH: 0, error: 'Cannot calculate — check pit and target temperatures.' };
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
