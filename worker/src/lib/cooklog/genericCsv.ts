// Generic-CSV adapter for stall-model M3 sub-project B (log normalizer).
// See docs/superpowers/specs/2026-07-22-stall-model-v2-m3-telemetry-design.md §4.
//
// The fallback adapter: recognizes any CSV whose header row has a time/date
// column and at least one temperature column. Named-brand adapters (combustion,
// fireboard, thermoworks) run first; this catches the rest. Every temp column
// becomes an `unknown`-role channel — generic CSV carries no food/pit hint, so
// a single-channel file reduces cleanly and a multi-channel one needs a user
// probe mapping. Values are assumed to be °F (generic CSV has no unit info).

import type { ChannelSample, LogAdapter, ParsedChannel, ParsedLog } from './types.js';

const TIME_RE = /\b(time|timestamp|date)\b/i;
const TEMP_RE = /(temp|°\s*[fc]|probe|internal|core|\bfood\b|\bmeat\b)/i;

function splitRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(',').map((cell) => cell.trim()));
}

function findColumns(headers: string[]): { timeIdx: number; tempIdxs: number[] } {
  const timeIdx = headers.findIndex((h) => TIME_RE.test(h));
  const tempIdxs: number[] = [];
  headers.forEach((h, i) => {
    if (i !== timeIdx && TEMP_RE.test(h)) tempIdxs.push(i);
  });
  return { timeIdx, tempIdxs };
}

export const genericCsvAdapter: LogAdapter = {
  name: 'generic-csv',

  detect(rawText: string): boolean {
    const rows = splitRows(rawText);
    const headers = rows[0];
    if (!headers) return false;
    const { timeIdx, tempIdxs } = findColumns(headers);
    return timeIdx !== -1 && tempIdxs.length > 0;
  },

  parse(rawText: string): ParsedLog {
    const empty: ParsedLog = { format: 'generic-csv', channels: [] };
    const rows = splitRows(rawText);
    const headers = rows[0];
    if (!headers) return empty;
    const { timeIdx, tempIdxs } = findColumns(headers);
    if (timeIdx === -1 || tempIdxs.length === 0) return empty;

    const channels: ParsedChannel[] = tempIdxs.map((idx) => ({
      id: String(idx),
      label: headers[idx] ?? String(idx),
      role: 'unknown',
      samples: [] as ChannelSample[],
    }));

    let t0: number | null = null;
    for (const cells of rows.slice(1)) {
      const timeCell = cells[timeIdx];
      if (timeCell === undefined) continue;
      const t = new Date(timeCell).getTime();
      if (t0 === null) t0 = t;
      const tMin = Math.round((t - t0) / 60000);
      tempIdxs.forEach((idx, k) => {
        const cell = cells[idx];
        const channel = channels[k];
        if (cell === undefined || cell === '' || channel === undefined) return;
        channel.samples.push({ tMin, tempF: parseFloat(cell) });
      });
    }
    return { format: 'generic-csv', channels };
  },
};
