import { describe, expect, it } from 'vitest';
import { fireboardAdapter } from '../../../src/lib/cooklog/fireboard.js';

// Real FireBoard export shape (Appendix A): header is line 1, `Time,<label>…`
// with user-named channels; `Time` is `MM/DD/YY HH:MM:SS` local; an empty cell
// means that probe had no reading yet. Roles are unknown (needs a probe map).
const FILE = [
  'Time,Traeger,Ribs',
  '07/03/16 15:06:00,225,',
  '07/03/16 15:07:00,226,150',
  '07/03/16 15:08:00,227,151',
].join('\n');

describe('fireboardAdapter', () => {
  it('detects a FireBoard CSV by its Time header + MM/DD/YY HH:MM:SS stamp', () => {
    expect(fireboardAdapter.detect(FILE)).toBe(true);
    // An ISO-timestamp generic CSV must NOT be grabbed by this adapter.
    expect(fireboardAdapter.detect('Time,Temp\n2026-07-01T10:00:00Z,150')).toBe(false);
  });

  it('emits one unknown-role channel per label; empty cells are skipped', () => {
    const log = fireboardAdapter.parse(FILE);
    expect(log.format).toBe('fireboard');
    expect(log.channels).toEqual([
      { id: '1', label: 'Traeger', role: 'unknown',
        samples: [{ tMin: 0, tempF: 225 }, { tMin: 1, tempF: 226 }, { tMin: 2, tempF: 227 }] },
      { id: '2', label: 'Ribs', role: 'unknown',
        samples: [{ tMin: 1, tempF: 150 }, { tMin: 2, tempF: 151 }] },
    ]);
  });
});
