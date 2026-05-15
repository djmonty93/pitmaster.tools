import { describe, expect, it } from 'vitest';
import { toBbqSubscriberFields } from '../../../src/lib/mailerlite/tags';

describe('toBbqSubscriberFields', () => {
  it('emits the required bbq_* fields with all inputs present', () => {
    expect(
      toBbqSubscriberFields({
        zip: '78701',
        city: 'Austin, Texas',
        state: 'TX',
        region: 'south_central',
        cut: 'brisket-packer',
        cooker: 'offset',
        timezone: 'America/Chicago',
        signupDate: new Date('2026-05-15T18:00:00Z'),
      })
    ).toEqual({
      bbq_zip: '78701',
      bbq_city: 'Austin, Texas',
      bbq_state: 'TX',
      bbq_region: 'south_central',
      bbq_cut_pref: 'brisket-packer',
      bbq_cooker_pref: 'offset',
      bbq_timezone: 'America/Chicago',
      bbq_signup_date: '2026-05-15',
    });
  });

  it('omits optional fields when null/undefined rather than emitting empty strings', () => {
    expect(
      toBbqSubscriberFields({
        zip: '94102',
        state: 'CA',
        region: 'pacific',
        timezone: 'America/Los_Angeles',
        cut: null,
        cooker: null,
        city: null,
      })
    ).toEqual({
      bbq_zip: '94102',
      bbq_state: 'CA',
      bbq_region: 'pacific',
      bbq_timezone: 'America/Los_Angeles',
    });
  });

  it('serializes signupDate as UTC YYYY-MM-DD (no local-tz drift)', () => {
    // 23:00 in US/Eastern on 2026-05-14 → 03:00 UTC on 2026-05-15.
    // Stamp should reflect UTC date, not the local one.
    const d = new Date('2026-05-15T03:00:00Z');
    const fields = toBbqSubscriberFields({
      zip: '10001',
      state: 'NY',
      region: 'northeast',
      timezone: 'America/New_York',
      signupDate: d,
    });
    expect(fields.bbq_signup_date).toBe('2026-05-15');
  });

  it('rejects malformed zip', () => {
    expect(() =>
      toBbqSubscriberFields({
        zip: '7870',
        state: 'TX',
        region: 'south_central',
        timezone: 'America/Chicago',
      })
    ).toThrow(/Invalid zip/);
  });

  it('rejects malformed state code', () => {
    expect(() =>
      toBbqSubscriberFields({
        zip: '78701',
        state: 'texas',
        region: 'south_central',
        timezone: 'America/Chicago',
      })
    ).toThrow(/Invalid state/);
  });

  it('never emits a bare metro field (no v1 leftover)', () => {
    const fields = toBbqSubscriberFields({
      zip: '64108',
      state: 'MO',
      region: 'south_central',
      timezone: 'America/Chicago',
    });
    expect(fields).not.toHaveProperty('metro');
    expect(fields).not.toHaveProperty('bbq_metro');
  });
});
