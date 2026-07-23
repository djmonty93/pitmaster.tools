// Shared CSV tokenizing + numeric/temperature helpers for the cook-log adapters
// (stall-model M3 sub-project B). See design spec §4.

/** Tokenize one CSV line, honoring double-quoted fields and "" escapes. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Split raw text into non-empty, quote-aware CSV rows. */
export function splitCsvRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map(parseCsvLine);
}

/** Parse a numeric cell strictly: empty/non-finite → null (never NaN). */
export function parseNum(cell: string | undefined): number | null {
  if (cell === undefined) return null;
  const t = cell.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export const cToF = (c: number): number => (c * 9) / 5 + 32;

/**
 * Build an epoch-ms timestamp from calendar parts, REJECTING out-of-range
 * components (so `13/45/20 25:99` fails instead of silently rolling over).
 * UTC basis — callers use only deltas, so no TZ handling is needed.
 */
export function utcFromParts(
  year: number, month: number, day: number, hour: number, minute: number, second: number,
): number | null {
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (hour < 0 || minute < 0 || second < 0) return null;
  return Date.UTC(year, month - 1, day, hour, minute, second);
}
