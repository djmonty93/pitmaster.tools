// FireBoard adapter for stall-model M3 sub-project B (log normalizer).
// See docs/superpowers/specs/2026-07-22-stall-model-v2-m3-telemetry-design.md
// §4 + Appendix A (grounded in FireBoard's official sample CSV).
//
// Format: header on line 1 = `Time,<label1>,<label2>…`; temp columns are the
// user's probe names (up to 6), so every channel is `role: unknown` and needs a
// probe mapping downstream. `Time` is `MM/DD/YY HH:MM:SS`, naive local (no TZ),
// which `new Date()` won't parse reliably — hence the dedicated parser below.
// An empty cell means that probe had no reading yet. Units are NOT in the file
// (°F/°C is a user setting); values are taken as °F.

import type { ChannelSample, LogAdapter, ParsedChannel, ParsedLog } from './types.js';

const FB_TIME_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2}):(\d{2})$/;

/** Parse `MM/DD/YY HH:MM:SS` to epoch ms (UTC basis — only deltas are used). */
function fbTime(s: string): number | null {
  const m = s.match(FB_TIME_RE);
  if (!m) return null;
  let yy = Number(m[3]);
  if (yy < 100) yy += 2000;
  return Date.UTC(yy, Number(m[1]) - 1, Number(m[2]), Number(m[4]), Number(m[5]), Number(m[6]));
}

function splitRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.length > 0)
    .map((line) => line.split(','));
}

export const fireboardAdapter: LogAdapter = {
  name: 'fireboard',

  detect(rawText: string): boolean {
    const rows = splitRows(rawText);
    const headers = rows[0];
    const firstData = rows[1];
    if (!headers || !firstData) return false;
    return headers[0]?.trim() === 'Time' && FB_TIME_RE.test((firstData[0] ?? '').trim());
  },

  parse(rawText: string): ParsedLog {
    const empty: ParsedLog = { format: 'fireboard', channels: [] };
    const rows = splitRows(rawText);
    const headers = rows[0];
    if (!headers) return empty;

    const channels: ParsedChannel[] = headers
      .slice(1)
      .map((label, i) => ({ id: String(i + 1), label: label.trim(), role: 'unknown', samples: [] as ChannelSample[] }));

    let t0: number | null = null;
    for (const cells of rows.slice(1)) {
      const t = fbTime((cells[0] ?? '').trim());
      if (t === null) continue;
      if (t0 === null) t0 = t;
      const tMin = Math.round((t - t0) / 60000);
      channels.forEach((channel, k) => {
        const cell = cells[k + 1];
        if (cell === undefined || cell.trim() === '') return;
        channel.samples.push({ tMin, tempF: parseFloat(cell) });
      });
    }
    return { format: 'fireboard', channels };
  },
};
