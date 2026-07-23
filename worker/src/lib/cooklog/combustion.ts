// Combustion Inc. adapter for stall-model M3 sub-project B (log normalizer).
// See docs/superpowers/specs/2026-07-22-stall-model-v2-m3-telemetry-design.md
// §4 + Appendix A (grounded in two real exports + parser source).
//
// Format: a 9-line metadata banner + blank line, then a header, then data.
// Timestamp = elapsed seconds; temperatures are °C. Fixed-role — the
// VirtualCore/VirtualAmbient columns identify food vs pit, so no user mapping
// is needed. Columns are keyed by NAME (iOS appends a trailing `Notes`).
// Surface is intentionally not emitted (unused by the physics; available in the
// raw file if a future consumer needs it).

import { cToF, parseNum, splitCsvRows } from './csv.js';
import type { LogAdapter, ParsedChannel, ParsedLog } from './types.js';

export const combustionAdapter: LogAdapter = {
  name: 'combustion',

  detect(rawText: string): boolean {
    return /Combustion Inc\. Probe Data/i.test(rawText);
  },

  parse(rawText: string): ParsedLog {
    const empty: ParsedLog = { format: 'combustion', channels: [] };
    const rows = splitCsvRows(rawText);
    const headerIdx = rows.findIndex((r) => (r[0] ?? '').trim() === 'Timestamp');
    if (headerIdx === -1) return empty;

    const headers = (rows[headerIdx] ?? []).map((h) => h.trim());
    const tsIdx = headers.indexOf('Timestamp');
    const coreIdx = headers.indexOf('VirtualCoreTemperature');
    const ambIdx = headers.indexOf('VirtualAmbientTemperature');
    if (tsIdx === -1 || coreIdx === -1 || ambIdx === -1) return empty;

    const core: ParsedChannel = {
      id: 'VirtualCoreTemperature', label: 'VirtualCoreTemperature', role: 'core', samples: [],
    };
    const ambient: ParsedChannel = {
      id: 'VirtualAmbientTemperature', label: 'VirtualAmbientTemperature', role: 'ambient', samples: [],
    };

    for (const cells of rows.slice(headerIdx + 1)) {
      const tSec = parseNum(cells[tsIdx]);
      if (tSec === null) continue;
      const tMin = tSec / 60;
      const c = parseNum(cells[coreIdx]);
      if (c !== null) core.samples.push({ tMin, tempF: cToF(c) });
      const a = parseNum(cells[ambIdx]);
      if (a !== null) ambient.samples.push({ tMin, tempF: cToF(a) });
    }

    return { format: 'combustion', channels: [core, ambient] };
  },
};
