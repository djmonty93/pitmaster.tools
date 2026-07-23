import { describe, expect, it } from 'vitest';
import { normalizeLog } from '../../../src/lib/cooklog/index.js';

const COMBUSTION = [
  'Combustion Inc. Probe Data',
  'CSV version: 4',
  'Created: 2023-09-26 19:50:26',
  '',
  'Timestamp,SessionID,SequenceNumber,VirtualCoreTemperature,VirtualAmbientTemperature',
  '0.000,657681738,0,65,105',
].join('\n');
const FIREBOARD = 'Time,Traeger,Ribs\n07/03/16 15:06:00,225,150';
const THERMOWORKS = 'Probe1 -°F,Time\n150,10/12/18 15:12';
const GENERIC = 'Time,Internal Temp\n2026-07-01T10:00:00Z,150';

describe('normalizeLog', () => {
  it('routes each format to the right adapter (named before generic)', () => {
    expect(normalizeLog(COMBUSTION)?.format).toBe('combustion');
    expect(normalizeLog(FIREBOARD)?.format).toBe('fireboard');
    expect(normalizeLog(THERMOWORKS)?.format).toBe('thermoworks');
    expect(normalizeLog(GENERIC)?.format).toBe('generic-csv');
  });

  it('returns null when no adapter recognizes the file', () => {
    expect(normalizeLog('foo,bar\n1,2')).toBeNull();
  });
});
