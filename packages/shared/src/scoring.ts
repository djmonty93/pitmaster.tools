// Best Smoke Days scoring engine.
//
// Pure function: (cut, cooker, day) → 0-100 score, banded into
// red/yellow/green/ideal. Five signals contribute: precip, wind, gusts,
// temperature extremes, and stall risk (cut-specific, derived from
// the cooker-cavity wet-bulb using the COOKER_RH lookup from physics).
//
// Step 3 ships this and mirrors the same logic into
// _partials/weather-score-shared.js so the browser computes identical
// scores client-side without a worker hop. The mirror's behavior is
// pinned to this file by tests/unit/scoring-parity.test.ts.

import { COOKER_RH, wetBulbF } from './physics.js';
import type {
  Confidence,
  Cooker,
  Cut,
  ScoreInput,
  ScoreResult,
  WeatherDay,
  WeatherHour,
} from './types.js';

// Cookers vary in wind sensitivity: an offset's fire box gets blown out
// at gusts above ~20 mph; an electric smoker doesn't care.
const COOKER_WIND_SENSITIVITY: Record<Cooker, number> = {
  offset: 1.5,
  pellet: 1.0,
  kettle: 1.2,
  kamado: 0.5,
  electric: 0.1,
};

// Every supported cut; an explicit allow-list lets the scorer reject
// unknown cuts symmetrically with the unknown-cooker guard.
const ALL_CUTS: ReadonlySet<Cut> = new Set<Cut>([
  'brisket-flat',
  'brisket-packer',
  'pork-butt',
  'spare-ribs',
  'baby-back-ribs',
  'pork-loin',
  'whole-chicken',
  'spatchcock-chicken',
  'chicken-thighs',
  'whole-turkey',
  'turkey-breast',
  'fish',
  'lamb-shoulder',
]);

// Cuts that spend hours in the stall band (150-165 °F) — these are the
// only ones for which the stall-risk signal contributes to the score.
const STALL_SENSITIVE: ReadonlySet<Cut> = new Set<Cut>([
  'brisket-flat',
  'brisket-packer',
  'pork-butt',
  'spare-ribs',
  'baby-back-ribs',
  'lamb-shoulder',
]);

// Assumed pit setpoint for stall-risk wet-bulb calculation. Real users
// will set their own pit temp; for scoring purposes 225 °F is the
// universally-cited low-and-slow target.
const PIT_TEMP_F = 225;

export function scoreDay(input: ScoreInput): ScoreResult {
  const { cut, cooker, day } = input;
  // TS callers usually arrive through validated boundaries, but the API
  // accepts arbitrary string input (Step 7) so reject unknown cookers
  // explicitly — mirrors the strict guard in the browser JS scorer.
  // `Object.hasOwn` rather than `in` so a malicious `toString` / `__proto__`
  // value from a forged client request can't slip through the prototype chain.
  if (
    !Object.hasOwn(COOKER_WIND_SENSITIVITY, cooker) ||
    !Object.hasOwn(COOKER_RH, cooker)
  ) {
    throw new Error(`unknown cooker: ${cooker}`);
  }
  if (!ALL_CUTS.has(cut)) {
    throw new Error(`unknown cut: ${cut}`);
  }
  const reasons: string[] = [];

  // Defensive: a malformed adapter could hand us a day with tempLow > tempHigh.
  // Swap rather than fail so the score still grades the day's envelope.
  const tempHigh = Math.max(day.tempHighF, day.tempLowF);
  const tempLow = Math.min(day.tempHighF, day.tempLowF);

  // ── Precip ─────────────────────────────────────────────────────────
  // Heavy rain is the strongest single negative signal — pit gets wet,
  // smoke ring suffers, working outdoors gets miserable. 90%-prob +
  // 0.5"-accumulation costs the full 50 points so the day lands in the
  // red band on its own.
  const precipPenalty = clamp01(
    (day.precipProbPct / 100) * (1 + day.precipIn * 0.5)
  ) * 50;
  if (day.precipProbPct >= 60) reasons.push(`High chance of rain (${Math.round(day.precipProbPct)}%)`);
  else if (day.precipIn >= 0.25) reasons.push(`Heavy rain expected (${day.precipIn.toFixed(2)}")`);

  // ── Wind / gusts ───────────────────────────────────────────────────
  // 10 mph is comfortable; full penalty at ~35 mph. Cooker sensitivity
  // amplifies (offset 1.5×) or damps (electric 0.1×) the effect.
  //
  // NWS hourly forecasts commonly omit `windGust` entirely — the adapter
  // turns that into `gustMphMax: 0` while preserving the sustained wind
  // in `windMphMean`. Detect that absent-not-zero case and fall back to
  // a sustained-wind upper bound (windMphMean × 1.4, the CONUS inland
  // gust factor); otherwise trust the reported gust value verbatim.
  const effectiveGust = day.gustMphMax > 0 ? day.gustMphMax : day.windMphMean * 1.4;
  const windRaw = Math.max(0, (effectiveGust - 10) / 25);
  const windPenalty = clamp01(windRaw) * 20 * COOKER_WIND_SENSITIVITY[cooker];
  if (effectiveGust >= 25) {
    reasons.push(`Gusts to ${Math.round(effectiveGust)} mph (${cooker} sensitivity)`);
  }

  // ── Temperature extremes ───────────────────────────────────────────
  // Cold mornings make startup hard (penalty starts below 40 °F low,
  // full at 10 °F); afternoons over 85 °F push the cook into
  // uncomfortable working territory and risk over-temping the cavity
  // (penalty starts above 85 °F, full at 110 °F+ which is danger zone).
  const coldPenalty = clamp01((40 - tempLow) / 30) * 20;
  const hotPenalty = clamp01((tempHigh - 85) / 25) * 25;
  if (coldPenalty > 0) reasons.push(`Cold start (${Math.round(tempLow)} °F low)`);
  if (hotPenalty > 0) reasons.push(`Hot afternoon (${Math.round(tempHigh)} °F high)`);

  // ── Stall risk (F2) ────────────────────────────────────────────────
  // For stall-sensitive cuts only: compute the cooker-cavity wet-bulb
  // (pit at 225 °F, RH = cooker baseline boosted by outdoor humidity).
  // Higher wet-bulb → longer stall plateau → longer cook → more
  // pressure on a daylight serving window. Map wet-bulb → 0-100 %.
  const cookerCavityRh = clamp(COOKER_RH[cooker] + day.rhMean * 0.15, 0, 100);
  const wb = wetBulbF(PIT_TEMP_F, cookerCavityRh);
  // Empirically, wet-bulb below 110 °F means no meaningful stall;
  // 160 °F means the stall is essentially permanent for this cooker.
  const stallRiskPct = clamp(((wb - 110) / 50) * 100, 0, 100);
  const stallPenalty = STALL_SENSITIVE.has(cut) ? (stallRiskPct / 100) * 20 : 0;
  if (STALL_SENSITIVE.has(cut) && stallRiskPct >= 60) {
    reasons.push(`High stall risk for ${cut} (cavity wet-bulb ${wb.toFixed(0)} °F)`);
  }

  const rawScore = clamp(
    100 - precipPenalty - windPenalty - coldPenalty - hotPenalty - stallPenalty,
    0,
    100
  );
  // Band from the rounded score so {score: 85, band: "ideal"} stays
  // internally consistent — a returned 85 should never carry "green".
  const finalScore = Math.round(rawScore);

  if (reasons.length === 0) reasons.push('Conditions look good');

  return {
    score: finalScore,
    band: bandFor(finalScore),
    stallRiskPct: Math.round(stallRiskPct),
    reasons,
    confidence: day.confidence,
  };
}

/** Convenience: score every day in a forecast in order. */
export function scoreForecast(
  cut: Cut,
  cooker: Cooker,
  days: readonly WeatherDay[]
): ScoreResult[] {
  return days.map((day) => scoreDay({ cut, cooker, day }));
}

/**
 * Per-hour score (used by the SSR renderer in worker/src/lib/render/
 * and the client mirror in _partials/weather-score-shared.js for the
 * hour-by-hour color-coding).
 *
 * The scoring engine is day-shaped (tempHighF/tempLowF/rhMean/...) but
 * hour rows carry single-point readings (tempF/rh/windMph/...). Map
 * the hour to a "synthetic day" envelope so the same engine produces
 * a comparable 0-100 + band tag. The cold/hot penalties degenerate
 * cleanly when tempLow == tempHigh — that's exactly the right shape
 * for "score this single hour" semantics.
 */
export interface ScoreHourInput {
  cut: Cut;
  cooker: Cooker;
  hour: WeatherHour;
  /** Confidence inherited from the parent day. */
  confidence?: ScoreResult['confidence'];
}

export function scoreHour(input: ScoreHourInput): ScoreResult {
  const { cut, cooker, hour } = input;
  const synthDay: WeatherDay = {
    date: typeof hour.t === 'string' ? hour.t.slice(0, 10) : '',
    tempHighF:     hour.tempF,
    tempLowF:      hour.tempF,
    rhMean:        hour.rh,
    windMphMean:   hour.windMph,
    gustMphMax:    hour.gustMph,
    precipProbPct: hour.precipProbPct,
    precipIn:      hour.precipIn,
    dewPointMeanF: hour.dewPointF,
    hourly:        [],
    source:        'open-meteo',
    confidence:    input.confidence ?? 'high',
  };
  return scoreDay({ cut, cooker, day: synthDay });
}

function bandFor(score: number): ScoreResult['band'] {
  if (score >= 85) return 'ideal';
  if (score >= 70) return 'green';
  if (score >= 50) return 'yellow';
  return 'red';
}

function clamp(x: number, lo: number, hi: number): number {
  // Non-finite (NaN / ±Infinity) defaults to `lo`. F20 defense-in-depth:
  // the adapter's zod schema rejects malformed WeatherDays in production,
  // but if one slips through, every penalty branch must still produce a
  // finite integer score. Falling back to `lo` neutralizes the affected
  // penalty (most call sites use clamp01, so the missing signal becomes
  // a 0-contribution rather than poisoning the whole score with NaN).
  if (!Number.isFinite(x)) return lo;
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function clamp01(x: number): number {
  return clamp(x, 0, 1);
}

// Re-export for backwards compatibility with the Step 1 stub.
export { scoreDay as score };

// Re-export Confidence so callers can pin the type without importing types.ts.
export type { Confidence };
