import { describe, expect, it } from 'vitest';
import { toCookSamples } from '../../../src/lib/cooklog/reducer.js';
import type { ParsedLog } from '../../../src/lib/cooklog/types.js';

describe('toCookSamples', () => {
  it('merges a fixed-role core + ambient channel into coreF/pitF, aligned by tMin', () => {
    const log: ParsedLog = {
      format: 'combustion',
      channels: [
        { id: 'core', label: 'VirtualCoreTemperature', role: 'core',
          samples: [{ tMin: 0, tempF: 70 }, { tMin: 1, tempF: 150 }] },
        { id: 'amb', label: 'VirtualAmbientTemperature', role: 'ambient',
          samples: [{ tMin: 0, tempF: 225 }, { tMin: 1, tempF: 230 }] },
      ],
    };
    expect(toCookSamples(log)).toEqual([
      { tMin: 0, coreF: 70, pitF: 225 },
      { tMin: 1, coreF: 150, pitF: 230 },
    ]);
  });

  it('uses the sole channel as core when there is exactly one and no mapping', () => {
    const log: ParsedLog = {
      format: 'generic-csv',
      channels: [{ id: '0', label: 'Temp', role: 'unknown', samples: [{ tMin: 0, tempF: 70 }] }],
    };
    expect(toCookSamples(log)).toEqual([{ tMin: 0, coreF: 70 }]);
  });

  it('returns [] when multiple unknown channels have no mapping (ambiguous core)', () => {
    const log: ParsedLog = {
      format: 'thermoworks',
      channels: [
        { id: '0', label: 'Probe1', role: 'unknown', samples: [{ tMin: 0, tempF: 150 }] },
        { id: '1', label: 'Probe 2', role: 'unknown', samples: [{ tMin: 0, tempF: 225 }] },
      ],
    };
    expect(toCookSamples(log)).toEqual([]);
  });

  it('honors an explicit probe mapping by channel id', () => {
    const log: ParsedLog = {
      format: 'fireboard',
      channels: [
        { id: '0', label: 'Traeger', role: 'unknown', samples: [{ tMin: 0, tempF: 225 }] },
        { id: '1', label: 'Ribs', role: 'unknown', samples: [{ tMin: 0, tempF: 150 }] },
      ],
    };
    expect(toCookSamples(log, { coreId: '1', pitId: '0' })).toEqual([
      { tMin: 0, coreF: 150, pitF: 225 },
    ]);
  });
});
