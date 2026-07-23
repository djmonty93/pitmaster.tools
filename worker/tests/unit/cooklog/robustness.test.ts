import { describe, expect, it } from 'vitest';
import { parseCsvLine, parseNum, splitCsvRows, utcFromParts } from '../../../src/lib/cooklog/csv.js';
import { combustionAdapter } from '../../../src/lib/cooklog/combustion.js';
import { fireboardAdapter } from '../../../src/lib/cooklog/fireboard.js';
import { genericCsvAdapter } from '../../../src/lib/cooklog/genericCsv.js';
import { thermoworksAdapter } from '../../../src/lib/cooklog/thermoworks.js';
import { normalizeLog, toCookSamples, extractStall } from '../../../src/lib/cooklog/index.js';
import type { CookSample, ParsedLog } from '../../../src/lib/cooklog/types.js';

// Regression tests for the Codex-review findings on PR #148.

describe('csv tokenizer (#9)', () => {
  it('keeps a quoted field that contains a comma intact', () => {
    expect(parseCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
  });
});

describe('adapter precedence + detect (#1, #2)', () => {
  it('routes a Time-first, seconds-stamped, unit-suffixed file to ThermoWorks (not FireBoard)', () => {
    // Both FireBoard and ThermoWorks detect this; only ThermoWorks reads the °F unit.
    expect(normalizeLog('Time,Temp -°F\n10/16/18 11:52:30,150')?.format).toBe('thermoworks');
  });

  it('does not let ThermoWorks claim a unit-suffixed file with ISO timestamps', () => {
    // No valid ThermoWorks timestamp → falls through to generic-csv, not empty channels.
    expect(normalizeLog('Time,Probe1 -°F\n2026-07-01T10:00:00Z,150')?.format).toBe('generic-csv');
  });
});

describe('generic-csv robustness (#4, #5)', () => {
  it('skips a malformed first-row timestamp instead of poisoning tMin with NaN', () => {
    const log = genericCsvAdapter.parse(
      'Time,Temp\nnotadate,150\n2026-07-01T10:01:00Z,151\n2026-07-01T10:02:00Z,152',
    );
    expect(log.channels[0]?.samples).toEqual([{ tMin: 0, tempF: 151 }, { tMin: 1, tempF: 152 }]);
  });

  it('converts a °C-marked column to °F', () => {
    const log = genericCsvAdapter.parse(
      'Time,Water Temp °C\n2026-07-01T10:00:00Z,65\n2026-07-01T10:01:00Z,70',
    );
    expect(log.channels[0]?.samples).toEqual([{ tMin: 0, tempF: 149 }, { tMin: 1, tempF: 158 }]);
  });
});

describe('combustion NaN handling (#6)', () => {
  it('skips an empty core cell without dropping the ambient reading', () => {
    const file = [
      'Combustion Inc. Probe Data',
      'Timestamp,VirtualCoreTemperature,VirtualAmbientTemperature',
      '0.000,65,105',
      '60.000,,110',
    ].join('\n');
    const log = combustionAdapter.parse(file);
    expect(log.channels[0]?.samples).toEqual([{ tMin: 0, tempF: 149 }]);
    expect(log.channels[1]?.samples).toEqual([{ tMin: 0, tempF: 221 }, { tMin: 1, tempF: 230 }]);
  });
});

describe('reducer re-baselines core to tMin 0 (#10)', () => {
  it('shifts a late-starting core to 0 while aligning pit by original tMin', () => {
    const log: ParsedLog = {
      format: 'x',
      channels: [
        { id: 'c', label: 'c', role: 'core', samples: [{ tMin: 3, tempF: 150 }, { tMin: 4, tempF: 151 }] },
        { id: 'p', label: 'p', role: 'ambient', samples: [{ tMin: 3, tempF: 225 }, { tMin: 4, tempF: 226 }] },
      ],
    };
    expect(toCookSamples(log)).toEqual([
      { tMin: 0, coreF: 150, pitF: 225 },
      { tMin: 1, coreF: 151, pitF: 226 },
    ]);
  });
});

describe('extractStall ignores a steep drop (#11)', () => {
  it('does not merge a post-plateau probe drop into the stall span', () => {
    const curve: CookSample[] = [
      { tMin: 0, coreF: 70 }, { tMin: 30, coreF: 110 },
      { tMin: 60, coreF: 150 }, { tMin: 90, coreF: 151 }, { tMin: 120, coreF: 152 },
      { tMin: 150, coreF: 153 }, { tMin: 180, coreF: 154 },
      { tMin: 210, coreF: 70 }, { tMin: 240, coreF: 71 }, { tMin: 270, coreF: 72 },
    ];
    const r = extractStall(curve);
    expect(r?.dwellHr).toBe(2); // the 60→180 plateau, not 60→270
    expect(r?.plateauF).toBeCloseTo(152, 5);
  });
});

// Codex review round 2.

describe('utcFromParts rejects impossible dates (r2 #1)', () => {
  it('returns null for 02/30 instead of rolling into March', () => {
    expect(utcFromParts(2018, 2, 30, 12, 0, 0)).toBeNull();
    expect(utcFromParts(2018, 4, 31, 12, 0, 0)).toBeNull();
    expect(utcFromParts(2018, 3, 15, 12, 0, 0)).not.toBeNull();
  });
});

describe('generic-csv unit + elapsed-time hardening (r2 #2, #3)', () => {
  it('converts a bracketed (C) column to °F', () => {
    const log = genericCsvAdapter.parse('Time,Temp (C)\n2026-07-01T10:00:00Z,65\n2026-07-01T10:01:00Z,70');
    expect(log.channels[0]?.samples).toEqual([{ tMin: 0, tempF: 149 }, { tMin: 1, tempF: 158 }]);
  });

  it('does not match a bare "C" in a label like "Core" (stays °F)', () => {
    const log = genericCsvAdapter.parse('Time,Core\n2026-07-01T10:00:00Z,150');
    expect(log.channels[0]?.samples).toEqual([{ tMin: 0, tempF: 150 }]);
  });

  it('skips bare-numeric time cells rather than feeding them to Date()', () => {
    const log = genericCsvAdapter.parse('Time,Temp\n0,150\n1,151');
    expect(log.channels[0]?.samples).toEqual([]);
  });
});

describe('fireboard defers unit-declaring files (r2 #4)', () => {
  it('routes a FireBoard-stamped but unit-marked file to generic-csv (with °C conversion)', () => {
    const file = 'Time,Water Temp (°C)\n07/03/16 15:06:00,65';
    const log = normalizeLog(file);
    expect(log?.format).toBe('generic-csv');
    expect(log?.channels[0]?.samples).toEqual([{ tMin: 0, tempF: 149 }]);
  });
});

// Codex review round 3.

describe('combustion detect requires a valid header (r3)', () => {
  it('does not claim a banner-only file with no usable header', () => {
    expect(combustionAdapter.detect('Combustion Inc. Probe Data\nfoo,bar\n1,2')).toBe(false);
  });
});

describe('fireboard ignores blank trailing-comma header (r3)', () => {
  it('does not spawn a phantom channel that makes a single-probe log ambiguous', () => {
    const log = fireboardAdapter.parse('Time,Ribs,\n07/03/16 15:06:00,150,');
    expect(log.channels).toEqual([
      { id: '1', label: 'Ribs', role: 'unknown', samples: [{ tMin: 0, tempF: 150 }] },
    ]);
    expect(toCookSamples(log)).toEqual([{ tMin: 0, coreF: 150 }]);
  });
});

describe('reducer tolerates out-of-order samples (r3)', () => {
  it('sorts by original tMin before baselining to 0', () => {
    const log: ParsedLog = {
      format: 'x',
      channels: [{ id: 'c', label: 'c', role: 'core',
        samples: [{ tMin: 4, tempF: 151 }, { tMin: 3, tempF: 150 }] }],
    };
    expect(toCookSamples(log)).toEqual([{ tMin: 0, coreF: 150 }, { tMin: 1, coreF: 151 }]);
  });
});

// Codex review round 4.

describe('fireboard defers named-unit headers; generic detect requires a timestamp (r4)', () => {
  it('routes a "…Celsius" header to generic-csv with conversion, not FireBoard', () => {
    const log = normalizeLog('Time,Water Temperature Celsius\n07/03/16 15:06:00,65');
    expect(log?.format).toBe('generic-csv');
    expect(log?.channels[0]?.samples).toEqual([{ tMin: 0, tempF: 149 }]);
  });

  it('returns null (parse failure) when no row carries a parseable timestamp', () => {
    expect(normalizeLog('Time,Temp\nnotadate,150\nalsobad,151')).toBeNull();
  });
});

// Codex review round 5.

describe('generic-csv combines split Date + Time columns (r5 #2)', () => {
  it('does not collapse a Date,Time,Temp log to identical tMin', () => {
    const log = genericCsvAdapter.parse(
      'Date,Time,Temp\n2026-07-01,10:00:00,150\n2026-07-01,10:01:00,151',
    );
    expect(log.channels[0]?.samples).toEqual([{ tMin: 0, tempF: 150 }, { tMin: 1, tempF: 151 }]);
  });
});

describe('generic-csv unit detection uses only unambiguous markers (r5 #3 / r9 #1)', () => {
  it('treats a bare "Temp C" as ambiguous → °F (no conversion)', () => {
    // Bare trailing letter is not a unit marker (collides with probe names).
    const log = genericCsvAdapter.parse('Time,Temp C\n2026-07-01T10:00:00Z,65');
    expect(log.channels[0]).toMatchObject({ label: 'Temp C', samples: [{ tMin: 0, tempF: 65 }] });
  });

  it('converts only when the unit is unambiguous (°C)', () => {
    const log = genericCsvAdapter.parse('Time,Temp °C\n2026-07-01T10:00:00Z,65');
    expect(log.channels[0]?.samples).toEqual([{ tMin: 0, tempF: 149 }]);
  });

  it('does not misread "Internal Temp (°F)" as Celsius', () => {
    const log = genericCsvAdapter.parse('Time,Internal Temp (°F)\n2026-07-01T10:00:00Z,150');
    expect(log.channels[0]?.samples).toEqual([{ tMin: 0, tempF: 150 }]);
  });
});

// Codex review round 6.

describe('csv parser handles quoted multiline fields (r6 #1)', () => {
  it('keeps an embedded newline inside quotes as one field, not a spurious row', () => {
    // parseCsvLine is line-level; splitCsvRows spans records. Exercise via an
    // adapter: the quoted Notes newline must not create an extra data row.
    const log = combustionAdapter.parse(
      'Combustion Inc. Probe Data\nTimestamp,VirtualCoreTemperature,VirtualAmbientTemperature,Notes\n0.000,65,105,"line1\nline2"\n60.000,70,110,ok',
    );
    expect(log.channels[0]?.samples).toEqual([{ tMin: 0, tempF: 149 }, { tMin: 1, tempF: 158 }]);
  });
});

describe('generic-csv rejects numeric elapsed forms (r6 #2)', () => {
  it('skips .5 / 1e3 style time cells instead of parsing them as dates', () => {
    const log = genericCsvAdapter.parse('Time,Temp\n.5,150\n1e3,151');
    expect(log.channels[0]?.samples).toEqual([]);
  });
});

describe('timestamp regexes reject 3-digit years (r6 #3, #4)', () => {
  it('fireboard: 2- or 4-digit year detects, 3-digit does not', () => {
    expect(fireboardAdapter.detect('Time,Ribs\n07/03/16 15:06:00,150')).toBe(true);
    expect(fireboardAdapter.detect('Time,Ribs\n07/03/999 15:06:00,150')).toBe(false);
  });

  it('thermoworks: 3-digit year is not accepted', () => {
    expect(thermoworksAdapter.detect('Probe1 -°F,Time\n150,10/12/16 15:12')).toBe(true);
    expect(thermoworksAdapter.detect('Probe1 -°F,Time\n150,10/12/999 15:12')).toBe(false);
  });
});

// Codex review round 7.

describe('fireboard defers trailing-unit headers; generic requires all time cells (r7)', () => {
  it('routes an unambiguously °C-marked file to generic-csv with conversion', () => {
    const log = normalizeLog('Time,Temp °C\n07/03/16 15:06:00,65');
    expect(log?.format).toBe('generic-csv');
    expect(log?.channels[0]?.samples).toEqual([{ tMin: 0, tempF: 149 }]);
  });

  it('keeps a FireBoard file with an ambiguous "Probe C" label (not deferred/converted)', () => {
    const log = normalizeLog('Time,Probe C\n07/03/16 15:06:00,150');
    expect(log?.format).toBe('fireboard');
    expect(log?.channels[0]).toMatchObject({ label: 'Probe C', samples: [{ tMin: 0, tempF: 150 }] });
  });

  it('drops a Date,Time row whose Time cell is blank instead of parsing midnight', () => {
    const log = genericCsvAdapter.parse(
      'Date,Time,Temp\n2026-07-01,10:00:00,150\n2026-07-01,,151\n2026-07-01,10:02:00,152',
    );
    expect(log.channels[0]?.samples).toEqual([{ tMin: 0, tempF: 150 }, { tMin: 2, tempF: 152 }]);
  });
});

// Codex review round 8.

describe('thermoworks restricts to confirmed column shapes (r8 #2)', () => {
  it('still claims Probe<n>/Temp columns', () => {
    expect(thermoworksAdapter.detect('Probe1 -°F,Time\n150,10/12/16 15:12')).toBe(true);
  });
  it('does not claim an arbitrary -°C column; it falls through to generic-csv', () => {
    expect(thermoworksAdapter.detect('Chamber -°C,Time\n107,10/12/16 15:12')).toBe(false);
    expect(normalizeLog('Chamber -°C,Time\n107,10/12/16 15:12')?.format).toBe('generic-csv');
  });
});

describe('generic-csv recognizes the mapping vocabulary (r8 #3)', () => {
  it('treats Pit / Brisket probe columns as temperature channels', () => {
    const log = genericCsvAdapter.parse('Time,Pit,Brisket\n2026-07-01T10:00:00Z,225,150');
    expect(log.channels.map((c) => c.label)).toEqual(['Pit', 'Brisket']);
    expect(log.channels[1]?.samples).toEqual([{ tMin: 0, tempF: 150 }]);
  });

  it('matches the plural "Ribs" label (r9 #5)', () => {
    const log = genericCsvAdapter.parse('Time,Ribs\n2026-07-01T10:00:00Z,150');
    expect(log.channels.map((c) => c.label)).toEqual(['Ribs']);
  });
});

describe('reducer validates explicit mappings + duplicate-tMin pit (r10)', () => {
  const twoUnknown: ParsedLog = {
    format: 'x',
    channels: [
      { id: '0', label: 'a', role: 'unknown', samples: [{ tMin: 0, tempF: 150 }] },
      { id: '1', label: 'b', role: 'unknown', samples: [{ tMin: 0, tempF: 225 }] },
    ],
  };

  it('returns [] when a mapping names a missing channel (no silent fallback)', () => {
    expect(toCookSamples(twoUnknown, { coreId: 'nope' })).toEqual([]);
  });

  it('returns [] when core and pit ids are the same', () => {
    expect(toCookSamples(twoUnknown, { coreId: '0', pitId: '0' })).toEqual([]);
  });

  it('coalesces duplicate-timestamp readings per channel (average), not last-wins', () => {
    const log: ParsedLog = {
      format: 'x',
      channels: [
        { id: 'c', label: 'c', role: 'core', samples: [{ tMin: 0, tempF: 150 }, { tMin: 0, tempF: 151 }] },
        { id: 'p', label: 'p', role: 'ambient', samples: [{ tMin: 0, tempF: 220 }, { tMin: 0, tempF: 230 }] },
      ],
    };
    expect(toCookSamples(log)).toEqual([{ tMin: 0, coreF: 150.5, pitF: 225 }]);
  });

  it('aligns pit correctly when a duplicate-timestamp row had an empty pit cell (r13 #2)', () => {
    // core has two readings at tMin 0; pit only one (the other row's cell empty).
    const log: ParsedLog = {
      format: 'x',
      channels: [
        { id: 'c', label: 'c', role: 'core', samples: [{ tMin: 0, tempF: 150 }, { tMin: 0, tempF: 152 }] },
        { id: 'p', label: 'p', role: 'ambient', samples: [{ tMin: 0, tempF: 220 }] },
      ],
    };
    expect(toCookSamples(log)).toEqual([{ tMin: 0, coreF: 151, pitF: 220 }]);
  });
});

// Codex review round 11.

describe('generic-csv temp-column matching has token boundaries (r11 #1)', () => {
  it('does not treat "Attempt" or "Score" as temperature columns', () => {
    expect(genericCsvAdapter.detect('Time,Attempt,Score\n2026-07-01T10:00:00Z,1,2')).toBe(false);
  });
  it('still matches "Temp1"', () => {
    const log = genericCsvAdapter.parse('Time,Temp1\n2026-07-01T10:00:00Z,150');
    expect(log.channels.map((c) => c.label)).toEqual(['Temp1']);
  });
});

describe('csv rejects an unterminated quoted field (r11 #2)', () => {
  it('returns [] rather than swallowing the remainder', () => {
    expect(splitCsvRows('a,b\n"unterminated,c\nd,e')).toEqual([]);
  });
});

describe('extractStall survives duplicate timestamps (r11 #3)', () => {
  it('does not fragment the dwell when a tMin repeats', () => {
    const curve = [
      { tMin: 0, coreF: 70 }, { tMin: 30, coreF: 110 },
      { tMin: 60, coreF: 150 }, { tMin: 60, coreF: 150 }, // duplicate
      { tMin: 90, coreF: 151 }, { tMin: 120, coreF: 152 },
      { tMin: 150, coreF: 153 }, { tMin: 180, coreF: 154 }, { tMin: 210, coreF: 190 },
    ];
    const r = extractStall(curve);
    expect(r?.dwellHr).toBe(2);
    expect(r?.plateauF).toBeCloseTo(152, 5);
  });
});

// Codex review round 12.

describe('thermoworks defers mixed-unit files (r12 #1)', () => {
  it('does not claim a file that also has a non-TW unit column', () => {
    expect(thermoworksAdapter.detect('Probe1 -°F,Chamber -°C,Time\n150,107,10/12/16 15:12')).toBe(false);
    expect(normalizeLog('Probe1 -°F,Chamber -°C,Time\n150,107,10/12/16 15:12')?.format).toBe('generic-csv');
  });

  it('also defers when the extra column is a bare (unit-less) probe like "Pit" (r13 #1)', () => {
    expect(thermoworksAdapter.detect('Time,Temp -°F,Pit\n10/12/16 15:12,150,225')).toBe(false);
    expect(normalizeLog('Time,Temp -°F,Pit\n10/12/16 15:12,150,225')?.format).toBe('generic-csv');
  });
});

describe('extractStall coalesces same-time samples (r12 #2)', () => {
  it('averages duplicate-tMin readings rather than dropping the jump', () => {
    const curve = [
      { tMin: 0, coreF: 70 }, { tMin: 30, coreF: 110 },
      { tMin: 60, coreF: 150 }, { tMin: 90, coreF: 149 }, { tMin: 90, coreF: 151 }, // avg 150
      { tMin: 120, coreF: 150 }, { tMin: 150, coreF: 150 }, { tMin: 180, coreF: 150 }, { tMin: 210, coreF: 190 },
    ];
    const r = extractStall(curve);
    expect(r?.dwellHr).toBe(2);
    expect(r?.plateauF).toBeCloseTo(150, 5);
  });
});

describe('generic-csv treats a "Celsius" unit-word header as a temp column (r12 #3)', () => {
  it('recognizes and converts it', () => {
    const log = genericCsvAdapter.parse('Time,Celsius\n2026-07-01T10:00:00Z,65');
    expect(log.channels[0]).toMatchObject({ label: 'Celsius', samples: [{ tMin: 0, tempF: 149 }] });
  });
});

// Codex review round 14.

describe('hyphenated -C/-F is an unambiguous unit (r14 #1)', () => {
  it('generic converts a degree-less "Temp -C" column', () => {
    const log = genericCsvAdapter.parse('Time,Temp -C\n2026-07-01T10:00:00Z,65');
    expect(log.channels[0]?.samples).toEqual([{ tMin: 0, tempF: 149 }]);
  });

  it('a mixed file deferred from thermoworks still converts "Temp -C" in generic', () => {
    const log = normalizeLog('Time,Temp -C,Pit\n2026-07-01T10:00:00Z,65,225');
    expect(log?.format).toBe('generic-csv');
    const tempCh = log?.channels.find((c) => c.label === 'Temp -C');
    expect(tempCh?.samples).toEqual([{ tMin: 0, tempF: 149 }]);
  });
});

describe('generic-csv prefers an exact Time header (r14 #2)', () => {
  it('an exact "Time" column wins over a "Time Zone" column', () => {
    const log = genericCsvAdapter.parse(
      'Time Zone,Time,Temp\nAmerica/New_York,2026-07-01T10:00:00Z,150',
    );
    expect(log.channels.find((c) => c.label === 'Temp')?.samples).toEqual([{ tMin: 0, tempF: 150 }]);
  });
});

// Claude gate.

describe('parseNum accepts only plain decimals (claude)', () => {
  it('parses decimals and rejects hex / Infinity / junk', () => {
    expect(parseNum('150')).toBe(150);
    expect(parseNum('77.6')).toBe(77.6);
    expect(parseNum('-5')).toBe(-5);
    expect(parseNum('0x50')).toBeNull();
    expect(parseNum('Infinity')).toBeNull();
    expect(parseNum('12px')).toBeNull();
    expect(parseNum('')).toBeNull();
  });
});

describe('combustion tolerates reordered columns (r9 #2)', () => {
  it('finds the header by required names in any order', () => {
    const file = [
      'Combustion Inc. Probe Data',
      'SessionID,Timestamp,VirtualAmbientTemperature,VirtualCoreTemperature',
      '657681738,0.000,105,65',
    ].join('\n');
    const log = combustionAdapter.parse(file);
    expect(log.channels[0]).toMatchObject({ role: 'core', samples: [{ tMin: 0, tempF: 149 }] });
    expect(log.channels[1]).toMatchObject({ role: 'ambient', samples: [{ tMin: 0, tempF: 221 }] });
  });
});
