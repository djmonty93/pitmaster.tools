// Channel → CookSample reducer for stall-model M3 sub-project B.
// See docs/superpowers/specs/2026-07-22-stall-model-v2-m3-telemetry-design.md §2.
//
// Collapses a ParsedLog's channels into the flat CookSample[] the extractors
// consume, choosing the core (+ optional pit) channel. Selection order:
//   1. an explicit ProbeMapping id, else
//   2. a self-identified role (`core` / `ambient`), else
//   3. the sole channel (core only) when the file has exactly one.
// Multiple `unknown` channels with no mapping are ambiguous → [] (A must
// collect a probe mapping before this can reduce).

import type { CookSample, ParsedChannel, ParsedLog, ProbeMapping } from './types.js';

function byId(log: ParsedLog, id: string | undefined): ParsedChannel | undefined {
  return id === undefined ? undefined : log.channels.find((c) => c.id === id);
}

function pickCore(log: ParsedLog, mapping?: ProbeMapping): ParsedChannel | undefined {
  const mapped = byId(log, mapping?.coreId);
  if (mapped) return mapped;
  const roled = log.channels.find((c) => c.role === 'core');
  if (roled) return roled;
  return log.channels.length === 1 ? log.channels[0] : undefined;
}

function pickPit(log: ParsedLog, mapping?: ProbeMapping): ParsedChannel | undefined {
  const mapped = byId(log, mapping?.pitId);
  if (mapped) return mapped;
  return log.channels.find((c) => c.role === 'ambient');
}

/** A supplied mapping is authoritative: reject rather than silently fall back
 *  if any named id is missing, or if core and pit resolve to the same channel. */
function mappingIsValid(log: ParsedLog, mapping?: ProbeMapping): boolean {
  if (!mapping) return true;
  const has = (id: string | undefined): boolean =>
    id === undefined || log.channels.some((c) => c.id === id);
  if (!has(mapping.coreId) || !has(mapping.pitId)) return false;
  if (mapping.pitId !== undefined && mapping.pitId === mapping.coreId) return false;
  return true;
}

export function toCookSamples(log: ParsedLog, mapping?: ProbeMapping): CookSample[] {
  if (!mappingIsValid(log, mapping)) return [];

  const core = pickCore(log, mapping);
  if (!core || core.samples.length === 0) return [];

  // Queue pit readings per tMin so duplicate timestamps are consumed in
  // occurrence order (a Map would collapse them to the last value, mispairing).
  const pit = pickPit(log, mapping);
  const pitByT = new Map<number, number[]>();
  if (pit && pit.id !== core.id) {
    for (const s of pit.samples) {
      const q = pitByT.get(s.tMin);
      if (q) q.push(s.tempF);
      else pitByT.set(s.tMin, [s.tempF]);
    }
  }

  // Sort by original tMin (defends against out-of-order exports) then
  // re-baseline so tMin starts at 0 (CookSample contract) even when the core
  // probe started reading late. Pit is looked up by the ORIGINAL tMin.
  const ordered = [...core.samples].sort((a, b) => a.tMin - b.tMin);
  const offset = ordered[0]?.tMin ?? 0;
  return ordered.map((s) => {
    const q = pitByT.get(s.tMin);
    const pitF = q && q.length > 0 ? q.shift() : undefined;
    const tMin = s.tMin - offset;
    return pitF === undefined
      ? { tMin, coreF: s.tempF }
      : { tMin, coreF: s.tempF, pitF };
  });
}
