import { describe, expect, it } from 'vitest';
import { formatTags, toSubscriberFields } from '../../../src/lib/mailerlite/tags';

describe('mailerlite tags', () => {
  it('formatTags emits metro/cut/cooker in canonical order', () => {
    expect(
      formatTags({ metroSlug: 'kansas-city-mo', cut: 'brisket-packer', cooker: 'offset' })
    ).toEqual(['metro:kansas-city-mo', 'cut:brisket-packer', 'cooker:offset']);
  });

  it('formatTags omits absent values', () => {
    expect(formatTags({ cut: 'pork-butt' })).toEqual(['cut:pork-butt']);
    expect(formatTags({})).toEqual([]);
    expect(formatTags({ metroSlug: null, cut: null, cooker: null })).toEqual([]);
  });

  it('formatTags rejects malformed metro slugs', () => {
    expect(() => formatTags({ metroSlug: 'Kansas City' })).toThrow(/Invalid metro slug/);
    expect(() => formatTags({ metroSlug: '' })).not.toThrow(); // empty falsy → omitted
    expect(() => formatTags({ metroSlug: '-leading-dash' })).toThrow(/Invalid metro slug/);
    expect(() => formatTags({ metroSlug: 'trailing-' })).toThrow(/Invalid metro slug/);
  });

  it('toSubscriberFields returns MailerLite-shaped object, no empty keys', () => {
    expect(
      toSubscriberFields({ metroSlug: 'austin-tx', cut: 'spare-ribs', cooker: 'pellet' })
    ).toEqual({ metro: 'austin-tx', cut: 'spare-ribs', cooker: 'pellet' });

    expect(toSubscriberFields({})).toEqual({});
    expect(toSubscriberFields({ cooker: 'kamado' })).toEqual({ cooker: 'kamado' });
  });

  it('toSubscriberFields validates the metro slug', () => {
    expect(() => toSubscriberFields({ metroSlug: 'BAD slug!' })).toThrow(/Invalid metro slug/);
  });
});
