import { describe, expect, it } from 'vitest';
import { combustionAdapter } from '../../../src/lib/cooklog/combustion.js';

// Real Combustion export shape (Appendix A): 9 metadata lines + 1 blank, then
// the header, then data. Timestamp = elapsed seconds; temps are °C. °C values
// here are multiples of 5 so °C→°F is exact for toEqual.
const HEADER =
  'Timestamp,SessionID,SequenceNumber,T1,T2,T3,T4,T5,T6,T7,T8,' +
  'VirtualCoreTemperature,VirtualSurfaceTemperature,VirtualAmbientTemperature,' +
  'EstimatedCoreTemperature,PredictionSetPoint,VirtualCoreSensor,VirtualSurfaceSensor,' +
  'VirtualAmbientSensor,PredictionState,PredictionMode,PredictionType,PredictionValueSeconds';

const FILE = [
  'Combustion Inc. Probe Data',
  'App: inc.combustion.app v1.4.1 debug',
  'CSV version: 4',
  'Probe S/N: 10000170',
  'Probe FW version: v1.2.1',
  'Probe HW revision: v0.35',
  'Framework: Android v1.2.0 debug',
  'Sample Period: 5000',
  'Created: 2023-09-26 19:50:26',
  '',
  HEADER,
  '0.000,657681738,0,19,19,19,19,20,20,20,20,65,80,105,64,0,T1,T4,T7,Probe Not Inserted,None,None,131071',
  '60.000,657681738,12,19,19,19,19,20,20,20,20,70,82,110,69,0,T1,T4,T7,Cooking,None,None,131071',
].join('\n');

describe('combustionAdapter', () => {
  it('detects a Combustion export by its banner', () => {
    expect(combustionAdapter.detect(FILE)).toBe(true);
    expect(combustionAdapter.detect('Time,Temp\n1,2')).toBe(false);
  });

  it('maps VirtualCore→core and VirtualAmbient→ambient, elapsed-seconds→tMin, °C→°F', () => {
    const log = combustionAdapter.parse(FILE);
    expect(log.format).toBe('combustion');
    expect(log.channels).toEqual([
      { id: 'VirtualCoreTemperature', label: 'VirtualCoreTemperature', role: 'core',
        samples: [{ tMin: 0, tempF: 149 }, { tMin: 1, tempF: 158 }] },
      { id: 'VirtualAmbientTemperature', label: 'VirtualAmbientTemperature', role: 'ambient',
        samples: [{ tMin: 0, tempF: 221 }, { tMin: 1, tempF: 230 }] },
    ]);
  });
});
