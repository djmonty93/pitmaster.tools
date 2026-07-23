// Generic-CSV adapter for stall-model M3 sub-project B (log normalizer).
// See docs/superpowers/specs/2026-07-22-stall-model-v2-m3-telemetry-design.md §4.
//
// The fallback adapter: recognizes any CSV whose header row has a time/date
// column and at least one temperature column. Named-brand adapters (combustion,
// fireboard, thermoworks) run first; this catches the rest. Every temp column
// becomes an `unknown`-role channel — generic CSV carries no food/pit hint, so
// a single-channel file reduces cleanly and a multi-channel one needs a user
// probe mapping. A column whose header marks °C is converted to °F; otherwise
// values are taken as °F.

import { cToF, parseNum, splitCsvRows } from './csv.js';
import type { ChannelSample, LogAdapter, ParsedChannel, ParsedLog } from './types.js';

const TIME_RE = /\b(time|timestamp|date)\b/i;
const TEMP_RE = /(temp|°\s*[fc]|probe|internal|core|\bfood\b|\bmeat\b)/i;
const C_RE = /(°\s*c|\bcelsius\b)/i;

interface TempCol {
  idx: number;
  channel: ParsedChannel;
  unit: 'F' | 'C';
}

function planColumns(headers: string[]): { timeIdx: number; temps: TempCol[] } {
  const timeIdx = headers.findIndex((h) => TIME_RE.test(h));
  const temps: TempCol[] = [];
  headers.forEach((h, idx) => {
    if (idx === timeIdx || !TEMP_RE.test(h)) return;
    const unit = C_RE.test(h) ? 'C' : 'F';
    temps.push({ idx, unit, channel: { id: String(idx), label: h, role: 'unknown', samples: [] as ChannelSample[] } });
  });
  return { timeIdx, temps };
}

export const genericCsvAdapter: LogAdapter = {
  name: 'generic-csv',

  detect(rawText: string): boolean {
    const raw = splitCsvRows(rawText)[0];
    if (!raw) return false;
    const { timeIdx, temps } = planColumns(raw.map((h) => h.trim()));
    return timeIdx !== -1 && temps.length > 0;
  },

  parse(rawText: string): ParsedLog {
    const empty: ParsedLog = { format: 'generic-csv', channels: [] };
    const rows = splitCsvRows(rawText);
    const raw = rows[0];
    if (!raw) return empty;
    const { timeIdx, temps } = planColumns(raw.map((h) => h.trim()));
    if (timeIdx === -1 || temps.length === 0) return empty;

    let t0: number | null = null;
    for (const cells of rows.slice(1)) {
      const timeCell = cells[timeIdx];
      if (timeCell === undefined) continue;
      const t = new Date(timeCell.trim()).getTime();
      if (!Number.isFinite(t)) continue;
      if (t0 === null) t0 = t;
      const tMin = (t - t0) / 60000;
      for (const tc of temps) {
        const v = parseNum(cells[tc.idx]);
        if (v === null) continue;
        tc.channel.samples.push({ tMin, tempF: tc.unit === 'C' ? cToF(v) : v });
      }
    }
    return { format: 'generic-csv', channels: temps.map((t) => t.channel) };
  },
};
