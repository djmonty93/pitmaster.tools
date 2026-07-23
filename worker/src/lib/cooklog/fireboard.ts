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

import { parseNum, splitCsvRows, utcFromParts } from './csv.js';
import type { ChannelSample, LogAdapter, ParsedChannel, ParsedLog } from './types.js';

const FB_TIME_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2}):(\d{2})$/;

/** Parse `MM/DD/YY HH:MM:SS` to epoch ms; null if malformed/out-of-range. */
function fbTime(s: string): number | null {
  const m = s.trim().match(FB_TIME_RE);
  if (!m) return null;
  let yy = Number(m[3]);
  if (yy < 100) yy += 2000;
  return utcFromParts(yy, Number(m[1]), Number(m[2]), Number(m[4]), Number(m[5]), Number(m[6]));
}

export const fireboardAdapter: LogAdapter = {
  name: 'fireboard',

  detect(rawText: string): boolean {
    const rows = splitCsvRows(rawText);
    const headers = rows[0];
    if (!headers || (headers[0] ?? '').trim() !== 'Time') return false;
    // Recognize on the first row that carries a valid FireBoard timestamp, so a
    // single malformed early row doesn't hide an otherwise-valid file.
    return rows.slice(1).some((r) => fbTime(r[0] ?? '') !== null);
  },

  parse(rawText: string): ParsedLog {
    const empty: ParsedLog = { format: 'fireboard', channels: [] };
    const rows = splitCsvRows(rawText);
    const headers = rows[0];
    if (!headers) return empty;

    const channels: ParsedChannel[] = headers
      .slice(1)
      .map((label, i) => ({ id: String(i + 1), label: label.trim(), role: 'unknown', samples: [] as ChannelSample[] }));

    let t0: number | null = null;
    for (const cells of rows.slice(1)) {
      const t = fbTime(cells[0] ?? '');
      if (t === null) continue;
      if (t0 === null) t0 = t;
      const tMin = (t - t0) / 60000;
      channels.forEach((channel, k) => {
        const v = parseNum(cells[k + 1]);
        if (v !== null) channel.samples.push({ tMin, tempF: v });
      });
    }
    return { format: 'fireboard', channels };
  },
};
