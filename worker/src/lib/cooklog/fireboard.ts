// FireBoard adapter for stall-model M3 sub-project B (log normalizer).
// See docs/superpowers/specs/2026-07-22-stall-model-v2-m3-telemetry-design.md
// §4 + Appendix A (grounded in FireBoard's official sample CSV).
//
// Format: header on line 1 = `Time,<label1>,<label2>…`; temp columns are the
// user's probe names (up to 6), so every channel is `role: unknown` and needs a
// probe mapping downstream. `Time` is `MM/DD/YY HH:MM:SS`, naive local (no TZ),
// which `new Date()` won't parse reliably — hence the dedicated parser below.
// An empty cell means that probe had no reading yet. Units are NOT in the file
// (°F/°C is a user app setting), so values are taken as °F. Honoring a °C
// FireBoard export requires the user to declare their unit — that belongs in
// sub-project A (like the probe mapping), not here; the file itself gives the
// adapter nothing to detect. See spec §9.

import { parseNum, splitCsvRows, utcFromParts } from './csv.js';
import type { ChannelSample, LogAdapter, ParsedChannel, ParsedLog } from './types.js';

const FB_TIME_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/;
// An explicit unit token in a header (°F/°C, or bracketed (C)/(F)) means the
// file is NOT FireBoard — real FireBoard columns are bare probe names. Defer
// such files to ThermoWorks (which reads the suffix) or generic-csv.
const UNIT_MARKER_RE = /(°\s*[fc]\b|[([]\s*°?\s*[fc]\s*[)\]]|\b(celsius|fahrenheit)\b)/i;

/** Parse `MM/DD/YY HH:MM:SS` to epoch ms; null if malformed/out-of-range. */
function fbTime(s: string): number | null {
  const m = s.trim().match(FB_TIME_RE);
  if (!m) return null;
  let yy = Number(m[3]);
  if (yy < 100) yy += 2000;
  return utcFromParts(yy, Number(m[1]), Number(m[2]), Number(m[4]), Number(m[5]), Number(m[6]));
}

/** Probe columns = every column after `Time` with a non-empty label; the
 *  original column index is retained so a trailing comma / blank header can't
 *  shift data lookups or spawn a phantom channel. */
function probeColumns(headers: string[]): Array<{ idx: number; label: string }> {
  const out: Array<{ idx: number; label: string }> = [];
  headers.forEach((h, idx) => {
    if (idx === 0) return;
    const label = h.trim();
    if (label !== '') out.push({ idx, label });
  });
  return out;
}

export const fireboardAdapter: LogAdapter = {
  name: 'fireboard',

  detect(rawText: string): boolean {
    const rows = splitCsvRows(rawText);
    const headers = rows[0];
    if (!headers || (headers[0] ?? '').trim() !== 'Time') return false;
    // A header that declares a unit is ThermoWorks/generic, not FireBoard.
    if (headers.slice(1).some((h) => UNIT_MARKER_RE.test(h))) return false;
    if (probeColumns(headers).length === 0) return false;
    // Recognize on the first row that carries a valid FireBoard timestamp, so a
    // single malformed early row doesn't hide an otherwise-valid file.
    return rows.slice(1).some((r) => fbTime(r[0] ?? '') !== null);
  },

  parse(rawText: string): ParsedLog {
    const empty: ParsedLog = { format: 'fireboard', channels: [] };
    const rows = splitCsvRows(rawText);
    const headers = rows[0];
    if (!headers) return empty;

    const cols = probeColumns(headers);
    const channels: ParsedChannel[] = cols.map((c) => ({
      id: String(c.idx), label: c.label, role: 'unknown', samples: [] as ChannelSample[],
    }));

    let t0: number | null = null;
    for (const cells of rows.slice(1)) {
      const t = fbTime(cells[0] ?? '');
      if (t === null) continue;
      if (t0 === null) t0 = t;
      const tMin = (t - t0) / 60000;
      cols.forEach((c, k) => {
        const v = parseNum(cells[c.idx]);
        const channel = channels[k];
        if (v !== null && channel !== undefined) channel.samples.push({ tMin, tempF: v });
      });
    }
    return { format: 'fireboard', channels };
  },
};
