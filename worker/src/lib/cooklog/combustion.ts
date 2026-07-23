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

import type { LogAdapter, ParsedChannel, ParsedLog } from './types.js';

const cToF = (c: number): number => (c * 9) / 5 + 32;

function splitLine(line: string): string[] {
  return line.split(',').map((cell) => cell.trim());
}

export const combustionAdapter: LogAdapter = {
  name: 'combustion',

  detect(rawText: string): boolean {
    return /Combustion Inc\. Probe Data/i.test(rawText);
  },

  parse(rawText: string): ParsedLog {
    const empty: ParsedLog = { format: 'combustion', channels: [] };
    const lines = rawText.split(/\r?\n/);
    const headerIdx = lines.findIndex((l) => splitLine(l)[0] === 'Timestamp');
    if (headerIdx === -1) return empty;

    const headers = splitLine(lines[headerIdx] ?? '');
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

    for (const line of lines.slice(headerIdx + 1)) {
      if (line.trim() === '') continue;
      const cells = splitLine(line);
      const tsCell = cells[tsIdx];
      const coreCell = cells[coreIdx];
      const ambCell = cells[ambIdx];
      if (tsCell === undefined || coreCell === undefined || ambCell === undefined) continue;
      const tMin = parseFloat(tsCell) / 60;
      core.samples.push({ tMin, tempF: cToF(parseFloat(coreCell)) });
      ambient.samples.push({ tMin, tempF: cToF(parseFloat(ambCell)) });
    }

    return { format: 'combustion', channels: [core, ambient] };
  },
};
