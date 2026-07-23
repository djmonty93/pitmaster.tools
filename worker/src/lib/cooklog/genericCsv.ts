// Generic-CSV adapter for stall-model M3 sub-project B (log normalizer).
// See docs/superpowers/specs/2026-07-22-stall-model-v2-m3-telemetry-design.md §4.
//
// The fallback adapter: recognizes any CSV whose header row has a time/date
// column and at least one temperature column. Named-brand adapters (added
// later, once real export samples exist) run first; this catches the rest.

import type { CookSample, LogAdapter } from './types.js';

const TIME_RE = /\b(time|timestamp|date)\b/i;
const CORE_RE = /\b(internal|core|food|meat)\b/i;
const TEMP_RE = /temp/i;

function splitRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(',').map((cell) => cell.trim()));
}

function findColumns(headers: string[]): { timeIdx: number; coreIdx: number } {
  const timeIdx = headers.findIndex((h) => TIME_RE.test(h));
  // Prefer an explicit internal/core column; else the first temperature column.
  let coreIdx = headers.findIndex((h) => CORE_RE.test(h));
  if (coreIdx === -1) coreIdx = headers.findIndex((h) => TEMP_RE.test(h));
  return { timeIdx, coreIdx };
}

export const genericCsvAdapter: LogAdapter = {
  name: 'generic-csv',

  detect(headers: string[]): boolean {
    const { timeIdx, coreIdx } = findColumns(headers);
    return timeIdx !== -1 && coreIdx !== -1;
  },

  parse(text: string): CookSample[] {
    const rows = splitRows(text);
    const headers = rows[0];
    if (!headers) return [];
    const { timeIdx, coreIdx } = findColumns(headers);
    if (timeIdx === -1 || coreIdx === -1) return [];

    const samples: CookSample[] = [];
    let t0: number | null = null;
    for (const cells of rows.slice(1)) {
      const timeCell = cells[timeIdx];
      const coreCell = cells[coreIdx];
      if (timeCell === undefined || coreCell === undefined) continue;
      const t = new Date(timeCell).getTime();
      if (t0 === null) t0 = t;
      samples.push({
        tMin: Math.round((t - t0) / 60000),
        coreF: parseFloat(coreCell),
      });
    }
    return samples;
  },
};
