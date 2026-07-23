// Observation extractors for stall-model M3 sub-project B (log normalizer).
// See docs/superpowers/specs/2026-07-22-stall-model-v2-m3-telemetry-design.md §4, §9.
//
// From a normalized CookSample series, derive the observed stall: the longest
// contiguous span where the core-temp rise rate stays below STALL_SLOPE, lasting
// at least MIN_DWELL_HR. These observed values are what the calibration harness
// (sub-project D) fits SP_STALL_K / SP_PLAT_A|B against. Thresholds are v1
// placeholders (spec §9 open item) — adjustable without changing the contract.

import type { CookSample } from './types.js';

/** Core rising slower than this (°F/hr) counts as stalled. */
const STALL_SLOPE_F_PER_HR = 5;
/** Ignore flat spans shorter than this (hr). */
const MIN_DWELL_HR = 0.5;

export interface StallObservation {
  /** Mean core temperature over the stall span, °F. */
  plateauF: number;
  /** Duration of the stall span, hours. */
  dwellHr: number;
}

export function extractStall(samples: CookSample[]): StallObservation | null {
  let bestStart = -1;
  let bestEnd = -1;
  let bestDur = 0;
  let curStart = -1;

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (prev === undefined || cur === undefined) continue;

    const dtHr = (cur.tMin - prev.tMin) / 60;
    const slope = dtHr > 0 ? (cur.coreF - prev.coreF) / dtHr : Infinity;

    if (slope < STALL_SLOPE_F_PER_HR) {
      if (curStart === -1) curStart = i - 1;
      const start = samples[curStart];
      if (start === undefined) continue;
      const dur = (cur.tMin - start.tMin) / 60;
      if (dur > bestDur) {
        bestDur = dur;
        bestStart = curStart;
        bestEnd = i;
      }
    } else {
      curStart = -1;
    }
  }

  if (bestStart === -1 || bestDur < MIN_DWELL_HR) return null;

  const span = samples.slice(bestStart, bestEnd + 1);
  const plateauF = span.reduce((sum, s) => sum + s.coreF, 0) / span.length;
  return { plateauF, dwellHr: bestDur };
}
