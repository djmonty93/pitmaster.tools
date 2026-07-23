import { describe, expect, it } from 'vitest';
import { extractStall } from '../../../src/lib/cooklog/extract.js';
import type { CookSample } from '../../../src/lib/cooklog/types.js';

// Synthetic cook: fast climb to 150, a 2-hour near-flat plateau (150->154),
// then a fast climb to done. Samples every 30 min.
const CURVE: CookSample[] = [
  { tMin: 0, coreF: 70 },
  { tMin: 30, coreF: 110 },
  { tMin: 60, coreF: 150 }, // stall entry
  { tMin: 90, coreF: 151 },
  { tMin: 120, coreF: 152 },
  { tMin: 150, coreF: 153 },
  { tMin: 180, coreF: 154 }, // stall exit
  { tMin: 210, coreF: 190 },
  { tMin: 240, coreF: 203 },
];

describe('extractStall', () => {
  it('finds the plateau temperature and dwell of the longest low-slope span', () => {
    const r = extractStall(CURVE);
    expect(r).not.toBeNull();
    expect(r!.dwellHr).toBe(2); // t=60 .. t=180
    expect(r!.plateauF).toBeCloseTo(152, 5); // mean of 150,151,152,153,154
  });

  it('returns null when the core temp never stalls', () => {
    const steady: CookSample[] = [
      { tMin: 0, coreF: 70 },
      { tMin: 30, coreF: 120 },
      { tMin: 60, coreF: 170 },
      { tMin: 90, coreF: 203 },
    ];
    expect(extractStall(steady)).toBeNull();
  });
});
