import { describe, expect, it } from 'vitest';
import { toBbqSubscriberFields } from '../../../src/lib/sender/tags.js';

describe('toBbqSubscriberFields', () => {
  it('emits required keys', () => {
    const fields = toBbqSubscriberFields({
      zip: '23219',
      state: 'VA',
      region: 'southeast',
      timezone: 'America/New_York',
    });
    expect(fields).toEqual({
      bbq_zip: '23219',
      bbq_state: 'VA',
      bbq_region: 'southeast',
      bbq_timezone: 'America/New_York',
    });
  });

  it('omits optional keys when null/undefined', () => {
    const fields = toBbqSubscriberFields({
      zip: '23219', state: 'VA', region: 'southeast', timezone: 'America/New_York',
      city: null, cut: null, cooker: null, signupDate: null,
    });
    expect(fields).not.toHaveProperty('bbq_city');
    expect(fields).not.toHaveProperty('bbq_cut_pref');
    expect(fields).not.toHaveProperty('bbq_cooker_pref');
    expect(fields).not.toHaveProperty('bbq_signup_date');
  });

  it('includes optional keys when provided', () => {
    const fields = toBbqSubscriberFields({
      zip: '23219', state: 'VA', region: 'southeast', timezone: 'America/New_York',
      city: 'Richmond', cut: 'brisket-flat', cooker: 'pellet',
      signupDate: new Date('2026-05-16T12:00:00Z'),
    });
    expect(fields.bbq_city).toBe('Richmond');
    expect(fields.bbq_cut_pref).toBe('brisket-flat');
    expect(fields.bbq_cooker_pref).toBe('pellet');
    expect(fields.bbq_signup_date).toBe('2026-05-16');
  });

  it('rejects invalid zip', () => {
    expect(() => toBbqSubscriberFields({
      zip: '123', state: 'VA', region: 'southeast', timezone: 'America/New_York',
    })).toThrow(/Invalid zip/);
  });

  it('rejects invalid state', () => {
    expect(() => toBbqSubscriberFields({
      zip: '23219', state: 'Virginia', region: 'southeast', timezone: 'America/New_York',
    })).toThrow(/Invalid state/);
  });
});
