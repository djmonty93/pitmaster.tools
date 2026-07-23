// Canonical cook-log types for stall-model M3 sub-project B (log normalizer).
// See docs/superpowers/specs/2026-07-22-stall-model-v2-m3-telemetry-design.md §2, §4.
//
// A probe export (any supported vendor format) is normalized into an ordered
// array of CookSample. Extractors then derive the observed plateau temperature
// and dwell that the calibration harness (sub-project D) fits against.

/** One time-ordered probe reading, minutes from cook start. */
export interface CookSample {
  /** Minutes elapsed from the first sample (first sample is always 0). */
  tMin: number;
  /** Meat core / internal temperature, °F. */
  coreF: number;
  /** Pit / chamber temperature, °F, when the export provides it. */
  pitF?: number;
}

/**
 * A format adapter for one probe-export shape. Adapters are tried in order;
 * the first whose `detect` returns true parses the file. `detect` sees only
 * the header cells so format sniffing is cheap.
 */
export interface LogAdapter {
  /** Stable adapter id, e.g. "generic-csv", "thermoworks". */
  name: string;
  /** True when this adapter recognizes the given header row. */
  detect(headers: string[]): boolean;
  /** Parse the full raw file text into canonical samples. */
  parse(text: string): CookSample[];
}
