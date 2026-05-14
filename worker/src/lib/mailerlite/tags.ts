// Subscriber tagging helpers. The Best Smoke Days plan committed to
// tag-based segmentation rather than 50 MailerLite groups (one per
// metro), because MailerLite Connect's subscriber custom-fields model
// can carry the same routing data without the group-management
// overhead. Friday-cron segments filter on these fields directly.
//
// The shape is intentionally narrow:
//   metro:<slug>      → routes Friday email to the right metro card
//   cut:<slug>        → drives copy variant (brisket vs ribs vs chicken)
//   cooker:<slug>     → drives equipment-specific tips
//
// We expose two helpers:
//   - formatTags(): canonical string[] form ("metro:kansas-city-mo"),
//     used for logging / event-payload breadcrumbs.
//   - toSubscriberFields(): the object shape POSTed to MailerLite's
//     /api/subscribers endpoint. Field keys match what the dashboard
//     expects so Segments can be authored without code changes.

import type { Cooker, Cut } from '@shared/types';

export interface TagInput {
  metroSlug?: string | null;
  cut?: Cut | null;
  cooker?: Cooker | null;
}

export interface SubscriberFields {
  metro?: string;
  cut?: Cut;
  cooker?: Cooker;
}

const METRO_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Validates that the metro slug matches the same URL-safe shape the
 * migrations 0002_metros_seed.sql enforces. Throws on bad input so
 * upstream typos surface at the API boundary instead of being silently
 * shipped to MailerLite as `metro:` (truncated).
 */
function assertMetroSlug(slug: string): void {
  if (!METRO_SLUG_RE.test(slug)) {
    throw new TypeError(
      `Invalid metro slug ${JSON.stringify(slug)}: expected lowercase letters, digits, dashes`
    );
  }
}

export function formatTags(input: TagInput): string[] {
  const out: string[] = [];
  if (input.metroSlug) {
    assertMetroSlug(input.metroSlug);
    out.push(`metro:${input.metroSlug}`);
  }
  if (input.cut) out.push(`cut:${input.cut}`);
  if (input.cooker) out.push(`cooker:${input.cooker}`);
  return out;
}

export function toSubscriberFields(input: TagInput): SubscriberFields {
  const fields: SubscriberFields = {};
  if (input.metroSlug) {
    assertMetroSlug(input.metroSlug);
    fields.metro = input.metroSlug;
  }
  if (input.cut) fields.cut = input.cut;
  if (input.cooker) fields.cooker = input.cooker;
  return fields;
}
