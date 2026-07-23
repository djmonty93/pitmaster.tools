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

import type { ChannelSample, CookSample, ParsedChannel, ParsedLog, ProbeMapping } from './types.js';

/** Average readings that share a tMin → one value per timestamp (deterministic).
 *  Coalescing each channel independently removes duplicate-timestamp ambiguity
 *  (incl. rows where one channel's cell was empty) before core and pit are joined. */
function averageByTime(samples: ChannelSample[]): Map<number, number> {
  const acc = new Map<number, { sum: number; n: number }>();
  for (const s of samples) {
    const a = acc.get(s.tMin) ?? { sum: 0, n: 0 };
    a.sum += s.tempF;
    a.n += 1;
    acc.set(s.tMin, a);
  }
  const out = new Map<number, number>();
  for (const [t, a] of acc) out.set(t, a.sum / a.n);
  return out;
}

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

  const coreByT = averageByTime(core.samples);
  const pit = pickPit(log, mapping);
  const pitByT = pit && pit.id !== core.id ? averageByTime(pit.samples) : new Map<number, number>();

  // Sort by tMin (defends against out-of-order exports) then re-baseline so
  // tMin starts at 0 (CookSample contract) even when the core probe read late.
  const tMins = [...coreByT.keys()].sort((a, b) => a - b);
  const offset = tMins[0] ?? 0;
  return tMins.flatMap((t) => {
    const coreF = coreByT.get(t);
    if (coreF === undefined) return [];
    const pitF = pitByT.get(t);
    const tMin = t - offset;
    return [pitF === undefined ? { tMin, coreF } : { tMin, coreF, pitF }];
  });
}
