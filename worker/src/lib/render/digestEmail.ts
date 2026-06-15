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

import { bandLabel, escapeHtml, formatDateLabel } from './smokeWeather.js';
import type { ScoreResult } from '@shared/types';

export interface DigestDay {
  /** 'Sat' | 'Sun' | 'Mon' — the weekend window. */
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

function scoreChip(score: ScoreResult): string {
  const style = BAND_STYLE[score.band];
  return (
    '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:700;' +
      `background:${style.bg};color:${style.fg};">` +
      escapeHtml(bandLabel(score.band)) +
    '</span>'
  );
}

function dayCell(day: DigestDay): string {
  return (
    '<td align="center" style="padding:6px 8px;border:1px solid #EDE7DC;font-family:Arial,Helvetica,sans-serif;">' +
      `<div style="font-size:12px;color:#6B6B6B;">${escapeHtml(formatDateLabel(day.date))}</div>` +
      `<div style="font-size:18px;font-weight:700;color:#2B2B2B;margin:2px 0;">${day.score.score}<span style="font-size:11px;color:#9A9A9A;">/100</span></div>` +
      scoreChip(day.score) +
    '</td>'
  );
}

function metroRow(metro: DigestMetro): string {
  const cells = metro.days.map(dayCell).join('');
  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;border-collapse:collapse;">' +
      '<tr>' +
        '<td colspan="3" style="padding:0 0 4px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#2B2B2B;">' +
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

    // Header
    '<tr><td style="padding:24px 24px 8px;font-family:Georgia,serif;">' +
      `<h1 style="margin:0;font-size:22px;color:#B5651D;">Best Smoke Days — ${escapeHtml(input.regionLabel)}</h1>` +
      `<p style="margin:6px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#6B6B6B;">Your weekend smoking outlook for ${escapeHtml(formatDateLabel(input.sendDate))} and the days after.</p>` +
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

    // Footer
    '<tr><td style="padding:16px 24px 24px;border-top:1px solid #EDE7DC;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#9A9A9A;">' +
      '<p style="margin:0 0 6px;">Scores assume pork butt on an offset smoker. Your detailed forecast scores for your own cut and cooker.</p>' +
      // {$unsubscribe} is Sender.net's per-group unsubscribe merge tag.
      // UNVERIFIED token name — confirm in the Sender.net dashboard.
      '<p style="margin:0;">Pitmaster Tools · <a href="{$unsubscribe}" style="color:#9A9A9A;">Unsubscribe</a></p>' +
    '</td></tr>' +

    '</table></td></tr></table></body></html>'
  );
}
