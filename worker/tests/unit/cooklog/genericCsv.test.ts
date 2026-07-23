import { describe, expect, it } from 'vitest';
import { genericCsvAdapter } from '../../../src/lib/cooklog/genericCsv.js';

describe('genericCsvAdapter.parse', () => {
  it('maps a time column and an internal-temp column to tMin/coreF samples', () => {
    const csv = [
      'Time,Internal Temp (°F)',
      '2026-07-01T10:00:00Z,150',
      '2026-07-01T10:01:00Z,151',
      '2026-07-01T10:02:00Z,152',
    ].join('\n');

    const samples = genericCsvAdapter.parse(csv);

    expect(samples).toEqual([
      { tMin: 0, coreF: 150 },
      { tMin: 1, coreF: 151 },
      { tMin: 2, coreF: 152 },
    ]);
  });
});
