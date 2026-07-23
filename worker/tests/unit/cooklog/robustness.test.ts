import { describe, expect, it } from 'vitest';
import { parseCsvLine } from '../../../src/lib/cooklog/csv.js';
import { combustionAdapter } from '../../../src/lib/cooklog/combustion.js';
import { genericCsvAdapter } from '../../../src/lib/cooklog/genericCsv.js';
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
