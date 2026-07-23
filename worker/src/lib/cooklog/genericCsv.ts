// Generic-CSV adapter for stall-model M3 sub-project B (log normalizer).
// See docs/superpowers/specs/2026-07-22-stall-model-v2-m3-telemetry-design.md §4.
//
// The fallback adapter: recognizes any CSV whose header row has a time source
// and at least one temperature column. Named-brand adapters (combustion,
// fireboard, thermoworks) run first; this catches the rest. Every temp column
// becomes an `unknown`-role channel — generic CSV carries no food/pit hint, so
// a single-channel file reduces cleanly and a multi-channel one needs a user
// probe mapping. A column whose header marks °C is converted to °F; otherwise
// values are taken as °F.

import { cToF, headerIsCelsius, parseNum, splitCsvRows } from './csv.js';
import type { ChannelSample, LogAdapter, ParsedChannel, ParsedLog } from './types.js';

// A column is a temperature channel if its header looks thermometric OR uses
// the documented probe-mapping vocabulary (spec §2) — pit/food role words and
// common cuts, which BBQ loggers use as probe names.
const TEMP_RE = /(\btemp|°\s*[fc]|\bprobe|\binternal|\bcore|\bfood\b|\bmeat\b|\bpit\b|\bambient|\bgrill|\bsmoker|\bchamber|\bcooker|\bbrisket|\bpork\b|\bchicken|\bbeef\b|\bturkey|\bribs?\b|\bbutt\b|\bbreast|\bfish\b|\blamb)/i;

interface TempCol {
  idx: number;
  channel: ParsedChannel;
  unit: 'F' | 'C';
}

/**
 * Resolve the timestamp source. Prefers a single combined `timestamp`/`datetime`
 * column; else combines a separate `date` + `time` pair (so `Date,Time,Temp`
 * logs don't collapse to date-only); else a lone `time`/`date` column.
 */
function resolveTime(headers: string[]): { idxs: number[]; cols: Set<number> } | null {
  const combined = headers.findIndex((h) => /\b(timestamp|datetime)\b/i.test(h));
  const dateIdx = headers.findIndex((h) => /\bdate\b/i.test(h));
  const timeIdx = headers.findIndex((h) => /\btime\b/i.test(h));
  const cols = new Set<number>();
  [combined, dateIdx, timeIdx].forEach((i) => {
    if (i !== -1) cols.add(i);
  });
  let idxs: number[];
  if (combined !== -1) idxs = [combined];
  else if (dateIdx !== -1 && timeIdx !== -1 && dateIdx !== timeIdx) idxs = [dateIdx, timeIdx];
  else if (timeIdx !== -1) idxs = [timeIdx];
  else if (dateIdx !== -1) idxs = [dateIdx];
  else return null;
  return { idxs, cols };
}

function unitOf(header: string): 'F' | 'C' {
  return headerIsCelsius(header) ? 'C' : 'F';
}

function planColumns(headers: string[]): { time: number[] | null; temps: TempCol[] } {
  const t = resolveTime(headers);
  const timeCols = t?.cols ?? new Set<number>();
  const temps: TempCol[] = [];
  headers.forEach((h, idx) => {
    if (timeCols.has(idx) || !TEMP_RE.test(h)) return;
    temps.push({ idx, unit: unitOf(h), channel: { id: String(idx), label: h, role: 'unknown', samples: [] as ChannelSample[] } });
  });
  return { time: t ? t.idxs : null, temps };
}

/** Join the time source cells into one string and parse to epoch ms; null if
 *  empty, a bare number (ambiguous elapsed), or unparseable. */
function rowTime(cells: string[], idxs: number[]): number | null {
  const parts = idxs.map((i) => (cells[i] ?? '').trim());
  // Every selected time cell must be present — a split Date+Time row missing its
  // Time must NOT fall back to date-only (which would parse as midnight).
  if (parts.some((p) => p === '')) return null;
  const s = parts.join(' ');
  // A string that is itself a finite number (incl. `.5`, `+1`, `1e3`) is an
  // ambiguous elapsed value, not a calendar timestamp — reject before Date().
  if (Number.isFinite(Number(s))) return null;
  // NOTE: generic-csv accepts any Date-parseable string (ISO, US, …), so an
  // impossible date like `2026-02-30` rolls forward rather than being rejected
  // — a tolerated 1-row artifact on this freeform fallback. The vendor adapters
  // (fixed formats) DO reject impossible dates via utcFromParts.
  const ms = new Date(s).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export const genericCsvAdapter: LogAdapter = {
  name: 'generic-csv',

  detect(rawText: string): boolean {
    const rows = splitCsvRows(rawText);
    const raw = rows[0];
    if (!raw) return false;
    const { time, temps } = planColumns(raw.map((h) => h.trim()));
    if (!time || temps.length === 0) return false;
    // Require at least one parseable calendar timestamp, so a file with only
    // malformed/elapsed times isn't claimed and "normalized" into empty channels.
    return rows.slice(1).some((r) => rowTime(r, time) !== null);
  },

  parse(rawText: string): ParsedLog {
    const empty: ParsedLog = { format: 'generic-csv', channels: [] };
    const rows = splitCsvRows(rawText);
    const raw = rows[0];
    if (!raw) return empty;
    const { time, temps } = planColumns(raw.map((h) => h.trim()));
    if (!time || temps.length === 0) return empty;

    let t0: number | null = null;
    for (const cells of rows.slice(1)) {
      const t = rowTime(cells, time);
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
