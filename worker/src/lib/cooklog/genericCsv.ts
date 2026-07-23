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
// °C markers: a degree-C, the word celsius, or a bracketed unit token like
// `(C)` / `[°C]`. Bare trailing "C" is intentionally NOT matched — it would
// false-positive on labels such as "Core".
const C_RE = /(°\s*c\b|\bcelsius\b|[([]\s*°?\s*c\s*[)\]])/i;
// A time cell that is purely numeric is an ambiguous elapsed value, not a
// calendar timestamp; generic-csv handles only parseable date strings.
const BARE_NUMBER_RE = /^\d+(\.\d+)?$/;

interface TempCol {
  idx: number;
  channel: ParsedChannel;
  unit: 'F' | 'C';
}

/** Parse a generic calendar-timestamp cell to epoch ms; null if empty, a bare
 *  number (ambiguous elapsed value), or unparseable. */
function parseTime(cell: string | undefined): number | null {
  if (cell === undefined) return null;
  const s = cell.trim();
  if (s === '' || BARE_NUMBER_RE.test(s)) return null;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
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
    const rows = splitCsvRows(rawText);
    const raw = rows[0];
    if (!raw) return false;
    const { timeIdx, temps } = planColumns(raw.map((h) => h.trim()));
    if (timeIdx === -1 || temps.length === 0) return false;
    // Require at least one parseable calendar timestamp, so a file with only
    // malformed/elapsed times isn't claimed and "normalized" into empty channels.
    return rows.slice(1).some((r) => parseTime(r[timeIdx]) !== null);
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
      const t = parseTime(cells[timeIdx]);
      if (t === null) continue;
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
