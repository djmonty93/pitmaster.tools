import { describe, expect, it } from 'vitest';
import { thermoworksAdapter } from '../../../src/lib/cooklog/thermoworks.js';

// Real ThermoWorks BBQ-app shape (Appendix A): no preamble; unit is in each
// header suffix (`-°F`/`-°C`); `Time` is `M/D/YY H:MM` and its column position
// varies (last in multi-probe, first in single-probe) — locate it by name.
const MULTI = [
  'Probe1 -°F,Probe 2 -°F,Time',
  '150,225,10/12/18 15:12',
  '151,226,10/12/18 15:13',
  '152,227,10/12/18 15:14',
].join('\n');

const SINGLE_C = [
  'Time,Temp -°C',
  '10/16/18 11:52,65',
  '10/16/18 11:53,70',
].join('\n');

describe('thermoworksAdapter', () => {
  it('detects by the unit-suffixed temp header + a Time column', () => {
    expect(thermoworksAdapter.detect(MULTI)).toBe(true);
    expect(thermoworksAdapter.detect(SINGLE_C)).toBe(true);
    // FireBoard-style bare labels have no `-°F` suffix → not ThermoWorks.
    expect(thermoworksAdapter.detect('Time,Traeger\n07/03/16 15:06:00,225')).toBe(false);
  });

  it('parses multi-probe (°F, Time last), stripping the unit from the label', () => {
    const log = thermoworksAdapter.parse(MULTI);
    expect(log.format).toBe('thermoworks');
    expect(log.channels).toEqual([
      { id: '0', label: 'Probe1', role: 'unknown',
        samples: [{ tMin: 0, tempF: 150 }, { tMin: 1, tempF: 151 }, { tMin: 2, tempF: 152 }] },
      { id: '1', label: 'Probe 2', role: 'unknown',
        samples: [{ tMin: 0, tempF: 225 }, { tMin: 1, tempF: 226 }, { tMin: 2, tempF: 227 }] },
    ]);
  });

  it('converts a °C-suffixed column to °F (Time first)', () => {
    const log = thermoworksAdapter.parse(SINGLE_C);
    expect(log.channels).toEqual([
      { id: '1', label: 'Temp', role: 'unknown',
        samples: [{ tMin: 0, tempF: 149 }, { tMin: 1, tempF: 158 }] },
    ]);
  });
});
