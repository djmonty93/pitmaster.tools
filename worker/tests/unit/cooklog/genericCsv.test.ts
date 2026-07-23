import { describe, expect, it } from 'vitest';
import { genericCsvAdapter } from '../../../src/lib/cooklog/genericCsv.js';

const csv = [
  'Time,Internal Temp (°F)',
  '2026-07-01T10:00:00Z,150',
  '2026-07-01T10:01:00Z,151',
  '2026-07-01T10:02:00Z,152',
].join('\n');

describe('genericCsvAdapter', () => {
  it('detects a CSV with a time column and at least one temp column', () => {
    expect(genericCsvAdapter.detect(csv)).toBe(true);
    expect(genericCsvAdapter.detect('foo,bar\n1,2')).toBe(false);
  });

  it('parses each temp column into an unknown-role channel with tMin/tempF samples', () => {
    const log = genericCsvAdapter.parse(csv);
    expect(log.format).toBe('generic-csv');
    expect(log.channels).toEqual([
      {
        id: '1',
        label: 'Internal Temp (°F)',
        role: 'unknown',
        samples: [
          { tMin: 0, tempF: 150 },
          { tMin: 1, tempF: 151 },
          { tMin: 2, tempF: 152 },
        ],
      },
    ]);
  });
});
