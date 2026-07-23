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

export function toCookSamples(log: ParsedLog, mapping?: ProbeMapping): CookSample[] {
  const core = pickCore(log, mapping);
  if (!core || core.samples.length === 0) return [];

  const pit = pickPit(log, mapping);
  const pitByT = new Map<number, number>();
  if (pit && pit.id !== core.id) {
    for (const s of pit.samples) pitByT.set(s.tMin, s.tempF);
  }

  // Re-baseline the output to the core's first reading so tMin starts at 0
  // (CookSample contract) even when the core probe started reading late. Pit
  // is looked up by the ORIGINAL tMin, then the offset is applied to the output.
  const offset = core.samples[0]?.tMin ?? 0;
  return core.samples.map((s) => {
    const pitF = pitByT.get(s.tMin);
    const tMin = s.tMin - offset;
    return pitF === undefined
      ? { tMin, coreF: s.tempF }
      : { tMin, coreF: s.tempF, pitF };
  });
}
