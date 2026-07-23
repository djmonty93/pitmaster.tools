// Cook-log normalizer entry point for stall-model M3 sub-project B.
// See docs/superpowers/specs/2026-07-22-stall-model-v2-m3-telemetry-design.md §4.
//
// Public surface both the worker (A's parse step) and the Node calibration
// harness (D) import from. Adapters are tried in specificity order — named
// formats first, the broad generic-CSV fallback last — so a file that a named
// adapter recognizes never falls through to generic.

import { combustionAdapter } from './combustion.js';
import { fireboardAdapter } from './fireboard.js';
import { genericCsvAdapter } from './genericCsv.js';
import { thermoworksAdapter } from './thermoworks.js';
import type { LogAdapter, ParsedLog } from './types.js';

export * from './types.js';
export { toCookSamples } from './reducer.js';
export { extractStall } from './extract.js';
export type { StallObservation } from './extract.js';

/** Registered adapters, in detect() precedence order (most specific first). */
export const ADAPTERS: readonly LogAdapter[] = [
  combustionAdapter,
  fireboardAdapter,
  thermoworksAdapter,
  genericCsvAdapter,
];

/** Parse a raw probe export with the first adapter that recognizes it. */
export function normalizeLog(rawText: string): ParsedLog | null {
  for (const adapter of ADAPTERS) {
    if (adapter.detect(rawText)) return adapter.parse(rawText);
  }
  return null;
}
