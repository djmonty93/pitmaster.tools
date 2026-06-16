// Friday digest email renderer.
//
// Builds the full HTML body for the weekly regional digest the Friday
// cron broadcasts to a `pitmaster_<region>` group. UNLIKE the on-site
// renderers in smokeWeather.ts, this output must survive email clients:
//   - table-based layout, no flexbox/grid
//   - INLINE styles only (Gmail/Outlook strip <style> and external CSS)
//   - self-contained; no dependency on site CSS classes
//
// The email is one HTML for the whole region (a group broadcast can't
// personalise per subscriber), so scores assume a single default
// profile (pork butt on an offset) disclosed in the footer.

import { bandLabel, escapeHtml } from './smokeWeather.js';
import type { ScoreResult } from '@shared/types';

export interface DigestDay {
  /** 'Fri' | 'Sat' | 'Sun' | 'Mon' — the Fri-through-Mon window. */
  weekday: string;
  /** YYYY-MM-DD. */
  date: string;
  score: ScoreResult;
}

export interface DigestMetro {
  name: string;
  days: DigestDay[];
}

export interface WeeklyTool {
  /** Absolute URL on pitmaster.tools. */
  url: string;
  name: string;
  blurb: string;
}

export interface DigestEmailInput {
  /** Display name, e.g. "Southeast". */
  regionLabel: string;
  /** YYYY-MM-DD send date (region anchor-tz Friday). */
  sendDate: string;
  metros: DigestMetro[];
  /** This week's featured calculator (rotation). */
  tool: WeeklyTool;
  /** Deep link to the zip-select forecast landing. */
  detailUrl: string;
}

/**
 * Inline background/foreground per band. The band KEYS are unchanged
 * (ideal/green/yellow/red); the chip TEXT comes from the shared
 * bandLabel (Ideal/Good/Average/Poor). Colors approximate the on-site
 * score palette but are hard-coded hex because email can't use CSS vars.
 */
const BAND_STYLE: Record<ScoreResult['band'], { bg: string; fg: string }> = {
  ideal: { bg: '#1B7F3B', fg: '#FFFFFF' },
  green: { bg: '#2E9E4F', fg: '#FFFFFF' },
  yellow: { bg: '#C8881A', fg: '#FFFFFF' },
  red: { bg: '#B23B2E', fg: '#FFFFFF' },
};

const SENDER_NAME = 'Pitmaster Tools';
// CAN-SPAM requires a valid physical postal address in every commercial
// email. Sender.net may also append its own from account settings; if a
// test send shows a duplicate, drop this block and rely on Sender's.
const SENDER_POSTAL_ADDRESS = 'Aureate LLC, 3419 Virginia Beach Blvd #B32, Virginia Beach, VA 23452';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FULL_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Construct a local Date from YYYY-MM-DD without the Date(ISO-string) tz
// hazard (Safari/Chrome disagree on UTC vs local midnight).
function localDate(iso: string): Date {
  const parts = iso.split('-');
  const y = parseInt(parts[0] ?? '', 10);
  const m = parseInt(parts[1] ?? '', 10);
  const d = parseInt(parts[2] ?? '', 10);
  return new Date(Number.isFinite(y) ? y : 1970, (Number.isFinite(m) ? m : 1) - 1, Number.isFinite(d) ? d : 1);
}

/** Short weekday label for a day cell, e.g. "Fri". */
function weekdayShort(iso: string): string {
  return DAY_NAMES[localDate(iso).getDay()] ?? '';
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

/** Full weekday + ordinal date for the masthead tagline, e.g. "Friday, Jun 19th". */
function fridayLabel(iso: string): string {
  const m = parseInt(iso.split('-')[1] ?? '', 10);
  const d = parseInt(iso.split('-')[2] ?? '', 10);
  const dt = localDate(iso);
  return `${FULL_DAY_NAMES[dt.getDay()]}, ${MONTH_NAMES[m - 1]} ${ordinal(d)}`;
}

/**
 * Featured-calculator rotation. Mirrors the canonical tool list in
 * _partials/site-header-tools-menu.html (root-level URLs). The home
 * "Meat Smoking Calculator" (/) and Best Smoke Days (/smoke-weather/,
 * already deep-linked below) are intentionally excluded.
 */
export const WEEKLY_TOOLS: readonly WeeklyTool[] = [
  { url: 'https://pitmaster.tools/brisket-calculator', name: 'Brisket Calculator', blurb: 'Dial in cook time and pull temp for your packer or flat.' },
  { url: 'https://pitmaster.tools/pork-shoulder-calculator', name: 'Pork Shoulder Calculator', blurb: 'Time your pulled pork backward from when you want to eat.' },
  { url: 'https://pitmaster.tools/rib-calculator', name: 'Rib Calculator', blurb: 'Spare or baby back — get the 3-2-1 timing right.' },
  { url: 'https://pitmaster.tools/turkey-smoking-calculator', name: 'Turkey Calculator', blurb: 'Smoke a juicy bird without the food-safety guesswork.' },
  { url: 'https://pitmaster.tools/cook-time-coordinator', name: 'Cook Time Coordinator', blurb: 'Juggle multiple cuts so everything finishes together.' },
  { url: 'https://pitmaster.tools/meat-per-person', name: 'Meat Per Person', blurb: 'Buy the right amount of raw meat for your headcount.' },
  { url: 'https://pitmaster.tools/catering-calculator', name: 'Catering Calculator', blurb: 'Scale the cook for a crowd, with sides and buffer.' },
  { url: 'https://pitmaster.tools/brine-calculator', name: 'Brine Calculator', blurb: 'Get the salt-to-water ratio right for any cut.' },
  { url: 'https://pitmaster.tools/dry-rub-calculator', name: 'Dry Rub Calculator', blurb: 'Build a balanced rub scaled to your meat weight.' },
  { url: 'https://pitmaster.tools/charcoal-calculator', name: 'Charcoal Calculator', blurb: 'Estimate how much charcoal a long cook will burn.' },
  { url: 'https://pitmaster.tools/bbq-cost-calculator', name: 'BBQ Cost Calculator', blurb: 'Price out a cook by cut, weight, and servings.' },
  { url: 'https://pitmaster.tools/brisket-yield-calculator', name: 'Brisket Yield Calculator', blurb: 'See how much cooked brisket a raw packer really yields.' },
];

/**
 * ISO-8601 week number (1-53) for a YYYY-MM-DD date. Used to pick a
 * deterministic featured tool — the same tool for every region in a
 * given week, advancing one per week.
 */
export function isoWeekNumber(dateStr: string): number {
  const parts = dateStr.split('-');
  const y = parseInt(parts[0] ?? '', 10);
  const m = parseInt(parts[1] ?? '', 10);
  const d = parseInt(parts[2] ?? '', 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return 1;
  // Thursday-of-this-week determines the ISO year/week.
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  return 1 + Math.round((date.getTime() - firstThursday.getTime()) / weekMs);
}

/** Deterministic featured tool for the given send date. */
export function pickWeeklyTool(sendDate: string): WeeklyTool {
  const idx = ((isoWeekNumber(sendDate) % WEEKLY_TOOLS.length) + WEEKLY_TOOLS.length) % WEEKLY_TOOLS.length;
  return WEEKLY_TOOLS[idx]!;
}

// Compact, mobile-friendly cell: weekday-only label + score + small band
// chip, each a proportional 25% so the four columns scale down cleanly on a
// phone while staying one short row per metro (keeps the email from getting
// long).
function dayCell(day: DigestDay): string {
  const style = BAND_STYLE[day.score.band];
  return (
    '<td align="center" width="25%" style="padding:8px 3px;border:1px solid #EDE7DC;font-family:Arial,Helvetica,sans-serif;">' +
      `<div style="font-size:12px;font-weight:600;color:#6B6B6B;">${escapeHtml(weekdayShort(day.date))}</div>` +
      `<div style="font-size:19px;font-weight:700;color:#2B2B2B;line-height:1.1;margin:3px 0 5px;">${day.score.score}</div>` +
      `<span style="display:inline-block;padding:1px 7px;border-radius:9px;font-size:11px;font-weight:700;background:${style.bg};color:${style.fg};">${escapeHtml(bandLabel(day.score.band))}</span>` +
    '</td>'
  );
}

function metroRow(metro: DigestMetro): string {
  const cells = metro.days.map(dayCell).join('');
  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;border-collapse:collapse;">' +
      '<tr>' +
        '<td colspan="4" style="padding:0 0 4px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#2B2B2B;">' +
          escapeHtml(metro.name) +
        '</td>' +
      '</tr>' +
      '<tr>' + cells + '</tr>' +
    '</table>'
  );
}

/** Render the full HTML email body. */
export function renderDigestEmail(input: DigestEmailInput): string {
  const metrosHtml = input.metros.map(metroRow).join('');
  const tool = input.tool;
  const detailUrl = escapeHtml(input.detailUrl);

  return (
    '<!DOCTYPE html>' +
    '<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    `<title>Best Smoke Days — ${escapeHtml(input.regionLabel)}</title></head>` +
    '<body style="margin:0;padding:0;background:#FAF7F1;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF7F1;">' +
    '<tr><td align="center" style="padding:24px 12px;">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border:1px solid #EDE7DC;border-radius:8px;">' +

    // Brand masthead (links to the site)
    '<tr><td style="padding:22px 24px 0;">' +
      '<a href="https://pitmaster.tools" style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#B5651D;text-decoration:none;letter-spacing:.3px;">Pitmaster&nbsp;Tools</a>' +
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#9A9A9A;margin-top:3px;">Weather-scored BBQ forecasts</div>' +
      '<div style="height:2px;background:#EDD9AA;margin:14px 0 0;"></div>' +
    '</td></tr>' +

    // Header
    '<tr><td style="padding:16px 24px 8px;font-family:Georgia,serif;">' +
      `<h1 style="margin:0;font-size:20px;color:#2B2B2B;">Best Smoke Days — ${escapeHtml(input.regionLabel)}</h1>` +
      `<p style="margin:6px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#6B6B6B;">Your weekend smoking outlook for the weekend beginning ${escapeHtml(fridayLabel(input.sendDate))}.</p>` +
    '</td></tr>' +

    // Metro scores
    '<tr><td style="padding:12px 24px 4px;">' + metrosHtml + '</td></tr>' +

    // Featured tool (rotation)
    '<tr><td style="padding:8px 24px;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF3E6;border:1px solid #EDD9AA;border-radius:6px;">' +
        '<tr><td style="padding:14px 16px;font-family:Arial,Helvetica,sans-serif;">' +
          '<div style="font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#B5651D;">This week’s tool</div>' +
          `<a href="${escapeHtml(tool.url)}" style="display:inline-block;margin:4px 0 2px;font-size:16px;font-weight:700;color:#B5651D;text-decoration:none;">${escapeHtml(tool.name)} →</a>` +
          `<div style="font-size:13px;color:#5B5B5B;">${escapeHtml(tool.blurb)}</div>` +
        '</td></tr>' +
      '</table>' +
    '</td></tr>' +

    // Detailed forecast CTA
    '<tr><td align="center" style="padding:16px 24px 8px;">' +
      `<a href="${detailUrl}" style="display:inline-block;padding:12px 22px;background:#B5651D;color:#FFFFFF;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;text-decoration:none;border-radius:6px;">See your detailed forecast for your ZIP</a>` +
      '<p style="margin:8px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#9A9A9A;">A longer, hour-by-hour forecast scored for your exact cut and cooker.</p>' +
    '</td></tr>' +

    // Footer — CAN-SPAM: physical postal address + clear opt-out + identity.
    // Sender.net's unsubscribe merge tags are {{unsubscribe_link}} (href) and
    // {{unsubscribe_text}} (link text) — verified: Sender rejects a campaign
    // send (403) whose template lacks the link tag.
    '<tr><td style="padding:16px 24px 24px;border-top:1px solid #EDE7DC;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;color:#9A9A9A;">' +
      '<p style="margin:0 0 10px;">Scores assume pork butt on an offset smoker. Your detailed forecast scores for your own cut and cooker.</p>' +
      '<p style="margin:0 0 10px;">You’re receiving this weekly Best Smoke Days forecast because you signed up at <a href="https://pitmaster.tools" style="color:#9A9A9A;">pitmaster.tools</a>. Not interested anymore? <a href="{{unsubscribe_link}}" style="color:#B5651D;font-weight:700;">Unsubscribe here</a> and we’ll stop sending right away.</p>' +
      `<p style="margin:0 0 4px;"><strong style="color:#6B6B6B;">${escapeHtml(SENDER_NAME)}</strong><br>${escapeHtml(SENDER_POSTAL_ADDRESS)}</p>` +
      '<p style="margin:0;"><a href="https://pitmaster.tools" style="color:#9A9A9A;">pitmaster.tools</a> &middot; <a href="https://pitmaster.tools/tools" style="color:#9A9A9A;">All BBQ calculators</a> &middot; <a href="https://pitmaster.tools/privacy-policy" style="color:#9A9A9A;">Privacy</a> &middot; <a href="{{unsubscribe_link}}" style="color:#9A9A9A;">{{unsubscribe_text}}</a></p>' +
    '</td></tr>' +

    '</table></td></tr></table></body></html>'
  );
}
