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

/**
 * Split raw text into non-empty CSV rows, honoring quoted fields — including
 * quoted fields that span physical newlines (RFC 4180), so an embedded newline
 * in e.g. a Notes column doesn't spawn a spurious data row. A row is emitted
 * only if at least one of its fields is non-blank.
 */
export function splitCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;

  const endField = (): void => {
    row.push(cur);
    cur = '';
  };
  const endRow = (): void => {
    endField();
    if (row.some((f) => f.trim() !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
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
      endField();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else {
      cur += ch;
    }
  }
  endRow();
  return rows;
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

// An UNAMBIGUOUS temperature unit declared in a header: °F/°C, the words
// Celsius/Fahrenheit, or a bracketed (C)/(F)/(°C). A bare trailing letter
// (e.g. "Temp C") is intentionally NOT a marker — it collides with real probe
// names like "Probe C"; such ambiguous headers default to °F, and true
// disambiguation is a user-declared unit in sub-project A. Used to keep a
// unit-declaring file out of the FireBoard adapter (bare probe-name columns).
export const UNIT_MARKER_RE =
  /(°\s*[fc]\b|\b(?:celsius|fahrenheit)\b|[([]\s*°?\s*[fc]\s*[)\]])/i;

/** True when a header UNAMBIGUOUSLY declares Celsius (subset of UNIT_MARKER_RE). */
export function headerIsCelsius(header: string): boolean {
  return /(°\s*c\b|\bcelsius\b|[([]\s*°?\s*c\s*[)\]])/i.test(header);
}

/**
 * Build an epoch-ms timestamp from calendar parts, REJECTING out-of-range
 * components (so `13/45/20 25:99` fails instead of silently rolling over).
 * UTC basis — callers use only deltas, so no TZ handling is needed.
 *
 * Limitation: vendor exports carry naive local wall-clock with no timezone, so
 * a cook spanning a DST transition can be off by up to an hour. Correcting that
 * needs the submitter's timezone, which is not in the file — it comes from the
 * submission's ZIP in sub-projects A/C, not here. See spec §9.
 */
export function utcFromParts(
  year: number, month: number, day: number, hour: number, minute: number, second: number,
): number | null {
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (hour < 0 || minute < 0 || second < 0) return null;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  // Round-trip to reject impossible calendar dates (e.g. 02/30, 04/31) that
  // Date.UTC rolls forward, and years 0–99 which Date.UTC remaps to 1900–1999.
  const d = new Date(ms);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return ms;
}
