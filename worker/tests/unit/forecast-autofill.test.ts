import { describe, expect, it } from 'vitest';
import physicsSource from '../../../_partials/smoke-physics.js?raw';
import autofillSource from '../../../_partials/forecast-autofill.js?raw';

function load(): any {
  // eslint-disable-next-line no-new-func
  return new Function(
    physicsSource + '\n;' + autofillSource +
      '\n; return { spForecastToAmbient };'
  )();
}
const A = load();

describe('spForecastToAmbient', () => {
  it('maps temp (mean of high/low), derives RH from dewpoint, and reads wind', () => {
    // 80F high / 60F low -> ambient 70F; dewpoint 60F -> RH ~ 71% at 70F.
    const day = { tempHighF: 80, tempLowF: 60, dewPointMeanF: 60, windMphMean: 8, gustMphMax: 15 };
    const a = A.spForecastToAmbient(day);
    expect(a.ambientF).toBe(70);
    expect(a.ambientRh).toBeGreaterThan(60);
    expect(a.ambientRh).toBeLessThan(80);
    expect(a.windMph).toBe(8);
  });
  it('RH is 100% when dewpoint equals temperature', () => {
    const a = A.spForecastToAmbient({ tempHighF: 70, tempLowF: 70, dewPointMeanF: 70, windMphMean: 0 });
    expect(a.ambientRh).toBeGreaterThan(98);
    expect(a.ambientRh).toBeLessThanOrEqual(100);
  });
  it('returns null for a field the forecast omits (no crash)', () => {
    const a = A.spForecastToAmbient({ tempHighF: 75, tempLowF: 55 });
    expect(a.ambientF).toBe(65);
    expect(a.ambientRh).toBeNull();   // no dewpoint -> cannot derive RH
  });
});
