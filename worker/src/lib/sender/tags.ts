// Portfolio-aware Sender.net custom-field schema for BBQ subscribers.
//
// Field keys are prefixed `bbq_*` so a future portfolio site
// (powersizing.com, overlanding.tools, ...) can share a Sender.net
// account without colliding on field names. The prefix lives only on
// the Sender.net side — D1 columns stay unprefixed (region, cut, etc.)
// and this module maps between the two shapes.
//
// What we DON'T emit:
//   - bbq_metro: regional campaigns key on bbq_region; metro-slug
//     routing was a v1 detail that the portfolio refactor removed.
//   - tag-style 'metro:<slug>' strings: replaced by group membership
//     (pitmaster_all + pitmaster_<region>), see groups.ts.

import type { Cooker, Cut } from '@shared/types';
import type { Region } from '../regions/index.js';

/** Inputs the subscribe handler / Friday cron pass in. */
export interface BbqTagInput {
  zip: string;
  /** Display name from the geocoder ("Atlanta, Georgia"). Null on miss. */
  city?: string | null;
  /** Two-letter state code; required because region derives from it. */
  state: string;
  region: Region;
  cut?: Cut | null;
  cooker?: Cooker | null;
  /** IANA timezone for per-region cron scheduling. */
  timezone: string;
  /**
   * Subscription timestamp. Serialized as YYYY-MM-DD because Sender.net
   * date fields drop time-of-day. Defaults to "today" when omitted.
   */
  signupDate?: Date | null;
}

/** Exact key shape POSTed to Sender.net's /api/subscribers `fields` map. */
export interface BbqSubscriberFields {
  bbq_zip: string;
  bbq_city?: string;
  bbq_state: string;
  bbq_region: Region;
  bbq_cut_pref?: Cut;
  bbq_cooker_pref?: Cooker;
  bbq_timezone: string;
  bbq_signup_date?: string;
}

const ZIP_RE = /^\d{5}$/;
const STATE_RE = /^[A-Z]{2}$/;

/**
 * Map domain inputs to the Sender.net-shaped `fields` object. Omits
 * keys with null/undefined values so Sender.net doesn't store empty
 * strings (a stray "" on bbq_cut_pref would still match the conditional
 * merge tag `{$if:bbq_cut_pref=""}` in the email template).
 */
export function toBbqSubscriberFields(input: BbqTagInput): BbqSubscriberFields {
  if (!ZIP_RE.test(input.zip)) {
    throw new TypeError(`Invalid zip: expected 5 digits, got ${JSON.stringify(input.zip)}`);
  }
  if (!STATE_RE.test(input.state)) {
    throw new TypeError(`Invalid state: expected two-letter code, got ${JSON.stringify(input.state)}`);
  }
  const fields: BbqSubscriberFields = {
    bbq_zip: input.zip,
    bbq_state: input.state,
    bbq_region: input.region,
    bbq_timezone: input.timezone,
  };
  if (input.city) fields.bbq_city = input.city;
  if (input.cut) fields.bbq_cut_pref = input.cut;
  if (input.cooker) fields.bbq_cooker_pref = input.cooker;
  if (input.signupDate) fields.bbq_signup_date = formatDate(input.signupDate);
  return fields;
}

function formatDate(d: Date): string {
  // YYYY-MM-DD in UTC. Avoids the local-tz gotcha where a US-east
  // signup at 11pm local rolls into the next day when serialized.
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
