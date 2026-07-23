// ThermoWorks adapter for stall-model M3 sub-project B (log normalizer).
// See docs/superpowers/specs/2026-07-22-stall-model-v2-m3-telemetry-design.md
// §4 + Appendix A (grounded in official ThermoWorks BBQ-app screenshots).
//
// Format (2018 BBQ app; RFX/Cloud is a different, unconfirmed format): no
// preamble; unit is embedded per temp header as a `-°F`/`-°C` suffix; `Time`
// is `M/D/YY H:MM` local and its column position varies (last in multi-probe,
// first in single-probe) — so locate every column by name/shape, not index.
// Probes are by physical port, so roles are `unknown` (needs a probe mapping).

import { cToF, parseNum, splitCsvRows, utcFromParts } from './csv.js';
import type { ChannelSample, LogAdapter, ParsedChannel, ParsedLog } from './types.js';

const TW_TIME_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
/** Temp headers end in a `-°F` / `-°C` unit suffix; captures F or C. */
const TW_UNIT_RE = /-\s*°?\s*([FC])\s*$/i;

/** Parse `M/D/YY H:MM[:SS]` to epoch ms; null if malformed/out-of-range. */
function twTime(s: string): number | null {
  const m = s.trim().match(TW_TIME_RE);
  if (!m) return null;
  let yy = Number(m[3]);
  if (yy < 100) yy += 2000;
  return utcFromParts(yy, Number(m[1]), Number(m[2]), Number(m[4]), Number(m[5]), m[6] ? Number(m[6]) : 0);
}

interface TempCol {
  idx: number;
  channel: ParsedChannel;
  unit: 'F' | 'C';
}

function planColumns(headers: string[]): { timeIdx: number; temps: TempCol[] } {
  const timeIdx = headers.findIndex((h) => /^time$/i.test(h));
  const temps: TempCol[] = [];
  headers.forEach((h, idx) => {
    if (idx === timeIdx) return;
    const m = h.match(TW_UNIT_RE);
    if (!m) return;
    const unit = (m[1] ?? 'F').toUpperCase() === 'C' ? 'C' : 'F';
    const label = h.replace(TW_UNIT_RE, '').trim();
    temps.push({ idx, unit, channel: { id: String(idx), label, role: 'unknown', samples: [] as ChannelSample[] } });
  });
  return { timeIdx, temps };
}

export const thermoworksAdapter: LogAdapter = {
  name: 'thermoworks',

  detect(rawText: string): boolean {
    const rows = splitCsvRows(rawText);
    const raw = rows[0];
    if (!raw) return false;
    const { timeIdx, temps } = planColumns(raw.map((h) => h.trim()));
    if (timeIdx === -1 || temps.length === 0) return false;
    // Require an actual ThermoWorks-shaped timestamp so a unit-suffixed file
    // with ISO/epoch times isn't claimed and then parsed into empty channels.
    return rows.slice(1).some((r) => twTime(r[timeIdx] ?? '') !== null);
  },

  parse(rawText: string): ParsedLog {
    const empty: ParsedLog = { format: 'thermoworks', channels: [] };
    const rows = splitCsvRows(rawText);
    const raw = rows[0];
    if (!raw) return empty;
    const { timeIdx, temps } = planColumns(raw.map((h) => h.trim()));
    if (timeIdx === -1 || temps.length === 0) return empty;

    let t0: number | null = null;
    for (const cells of rows.slice(1)) {
      const t = twTime(cells[timeIdx] ?? '');
      if (t === null) continue;
      if (t0 === null) t0 = t;
      const tMin = (t - t0) / 60000;
      for (const tc of temps) {
        const v = parseNum(cells[tc.idx]);
        if (v === null) continue;
        tc.channel.samples.push({ tMin, tempF: tc.unit === 'C' ? cToF(v) : v });
      }
    }
    return { format: 'thermoworks', channels: temps.map((t) => t.channel) };
  },
};
