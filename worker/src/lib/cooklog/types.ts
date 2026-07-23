// Canonical cook-log types for stall-model M3 sub-project B (log normalizer).
// See docs/superpowers/specs/2026-07-22-stall-model-v2-m3-telemetry-design.md §2, §4.
//
// A probe export (any supported vendor format) is normalized in two steps:
//   1. an adapter parses the raw file into a channel-oriented ParsedLog
//      (samples already in minutes-from-start and °F), and
//   2. toCookSamples() reduces the chosen core (+ optional pit) channel to the
//      flat CookSample[] the extractors and calibration harness consume.
// The two steps exist because most exports do NOT label which probe is the
// food vs the pit — only Combustion self-identifies (spec §2, Appendix A).

/** One time-ordered reduced reading, minutes from cook start. */
export interface CookSample {
  /** Minutes elapsed from the first sample (first sample is always 0). */
  tMin: number;
  /** Meat core / internal temperature, °F. */
  coreF: number;
  /** Pit / chamber temperature, °F, when a pit channel is mapped. */
  pitF?: number;
}

/** What a channel measures, when known. `unknown` needs a user probe mapping. */
export type ChannelRole = 'core' | 'ambient' | 'surface' | 'unknown';

/** One normalized reading within a channel, minutes-from-start and °F. */
export interface ChannelSample {
  tMin: number;
  tempF: number;
}

/** One probe/channel from an export, with its samples normalized. */
export interface ParsedChannel {
  /** Stable id within the file (port number or column index as a string). */
  id: string;
  /** Column/probe name as written in the file ("Probe 2", "Traeger"). */
  label: string;
  /** Role when the format self-identifies it; else `unknown`. */
  role: ChannelRole;
  samples: ChannelSample[];
}

/** An adapter's parse output: every channel in the file, normalized. */
export interface ParsedLog {
  /** Adapter id that produced this ("combustion", "generic-csv", …). */
  format: string;
  channels: ParsedChannel[];
}

/**
 * A format adapter for one probe-export shape. Adapters are tried in order;
 * the first whose `detect` returns true parses the file. `detect` sees the raw
 * text (not a pre-parsed header) because formats differ in preamble, delimiter,
 * and header shape (spec §4).
 */
export interface LogAdapter {
  /** Stable adapter id, e.g. "generic-csv", "combustion". */
  name: string;
  /** True when this adapter recognizes the raw file. */
  detect(rawText: string): boolean;
  /** Parse the full raw file text into a channel-oriented ParsedLog. */
  parse(rawText: string): ParsedLog;
}

/** User-supplied (or heuristic) channel→role selection for `unknown` formats. */
export interface ProbeMapping {
  /** Channel id to treat as the food/core probe. */
  coreId: string;
  /** Optional channel id to treat as the pit/ambient probe. */
  pitId?: string;
}
