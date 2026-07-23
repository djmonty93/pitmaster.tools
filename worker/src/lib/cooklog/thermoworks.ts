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
/** Confirmed ThermoWorks BBQ-app temp columns only: `Probe <n> -°F/°C` (multi)
 *  or `Temp -°F/°C` (single-probe). Group 1 = label, group 2 = unit. Anything
 *  else falls through to generic-csv rather than being claimed here. */
const TW_COL_RE = /^(Probe\s*\d+|Temp)\s*-\s*°?\s*([FC])\s*$/i;

/** Parse `M/D/YY H:MM[:SS]` to epoch ms; null if malformed/out-of-range. */
function twTime(s: string): number | null {
  const m = s.trim().match(TW_TIME_RE);
  if (!m) return null;
  const yToken = m[3] ?? '';
  const yy = yToken.length === 2 ? Number(yToken) + 2000 : Number(yToken);
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
    const m = h.match(TW_COL_RE);
    if (!m) return;
    const unit = (m[2] ?? 'F').toUpperCase() === 'C' ? 'C' : 'F';
    const label = (m[1] ?? h).trim();
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
    const headers = raw.map((h) => h.trim());
    const { timeIdx, temps } = planColumns(headers);
    if (timeIdx === -1 || temps.length === 0) return false;
    // A clean ThermoWorks file has ONLY Time + Probe<n>/Temp columns (Appendix
    // A). Any other nonblank column (a bare "Pit", "Humidity", etc.) means it's
    // a mixed file — defer to generic-csv so no channel is silently dropped.
    // (Blank headers from a trailing comma are ignored.)
    const claimed = new Set(temps.map((t) => t.idx));
    if (headers.some((h, idx) => idx !== timeIdx && !claimed.has(idx) && h.trim() !== '')) {
      return false;
    }
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
        const tempF = tc.unit === 'C' ? cToF(v) : v;
        if (Number.isFinite(tempF)) tc.channel.samples.push({ tMin, tempF });
      }
    }
    return { format: 'thermoworks', channels: temps.map((t) => t.channel) };
  },
};
