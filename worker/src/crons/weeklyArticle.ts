// F17 — weekly article cron.
//
// Schedule: `0 12 * * 1` — Mondays at 12:00 UTC. The cron writes one
// `weekly-summary` row to the articles table for the current ISO week;
// the /articles/:slug worker route renders it as a static-shell HTML
// page. Storage in D1 (rather than committed HTML) avoids cron-driven
// git commits while keeping the response indexable — see
// docs/best-smoke-days-plan.md §F17 for the trade-off.
//
// v1 is template-only: no LLM polish, no per-metro live forecast
// injection. The article is national in scope and references each of
// the six regions defined in lib/regions. A future revision can
// PATCH live forecast snippets per region before the write — that's
// out of scope until the template-only output proves inadequate (per
// the plan's "Defaults committed" section).
//
// Idempotency: the slug is deterministic per ISO week, so re-runs in
// the same week UPDATE the existing row (bumps updated_at, keeps the
// original published_at). This makes the cron safe to retry and safe
// to invoke manually for backfills.

import type { Env } from '../index.js';
import { escapeHtml } from '../lib/html.js';

export interface IsoWeekParts {
  /** ISO year — the year of the Thursday in the same week. */
  year: number;
  /** ISO week number 1..53. */
  week: number;
}

export type WeeklyArticleOutcome =
  | { status: 'written'; slug: string }
  | { status: 'updated'; slug: string };

/**
 * ISO 8601 week number for a UTC date. The ISO year is whichever year
 * contains the Thursday of that week, so the last days of December can
 * belong to W01 of the following year and vice versa.
 */
export function isoWeekParts(d: Date): IsoWeekParts {
  // Strip the time-of-day so subsequent arithmetic stays day-aligned.
  const t = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
  // Convert Sun=0..Sat=6 to ISO Mon=1..Sun=7.
  const dayNum = t.getUTCDay() || 7;
  // Roll to the Thursday of the same ISO week — its year is the ISO year.
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const isoYear = t.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return { year: isoYear, week };
}

/**
 * Slug under `/articles/:slug` for the weekly summary. Lowercase and
 * hyphen-only so it satisfies the route's SLUG_RE; zero-padded week so
 * lexical sort matches numerical sort.
 */
export function weeklySummarySlug(parts: IsoWeekParts): string {
  const ww = parts.week.toString().padStart(2, '0');
  return `weekly-summary-${parts.year}-w${ww}`;
}

/** Monday of an ISO week, as a UTC midnight Date. */
function isoWeekMonday(parts: IsoWeekParts): Date {
  // Jan 4 is always in ISO week 1 (the year's first Thursday is in
  // week 1, and Jan 4 is at most 3 days from that Thursday).
  const jan4 = new Date(Date.UTC(parts.year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
  const target = new Date(week1Monday);
  target.setUTCDate(week1Monday.getUTCDate() + (parts.week - 1) * 7);
  return target;
}

/**
 * Map UTC month (0=Jan..11=Dec) to a hero band. Coarse seasonal proxy
 * for "is this generally a good month to smoke" in the lower 48 — the
 * /articles/:slug template uses this for a CSS variant strip. Summer is
 * 'ideal', shoulder months 'green', late-fall/early-spring 'yellow',
 * winter 'red'. Deterministic so test fixtures are stable.
 */
function heroBandForMonth(month0: number): 'red' | 'yellow' | 'green' | 'ideal' {
  if (month0 === 5 || month0 === 6 || month0 === 7) return 'ideal';
  if (month0 === 3 || month0 === 4 || month0 === 8 || month0 === 9) return 'green';
  if (month0 === 2 || month0 === 10) return 'yellow';
  return 'red';
}

function formatLongDate(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

interface BuiltArticle {
  title: string;
  bodyHtml: string;
  bodyText: string;
  heroBand: 'red' | 'yellow' | 'green' | 'ideal';
}

function buildArticle(parts: IsoWeekParts, scheduled: Date): BuiltArticle {
  const monday = isoWeekMonday(parts);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const mondayLong = formatLongDate(monday);
  const sundayLong = formatLongDate(sunday);
  const heroBand = heroBandForMonth(scheduled.getUTCMonth());

  const title = `Best smoke days: week of ${mondayLong}`;

  const intro =
    `Welcome to the pitmaster.tools weekly outlook for ${mondayLong} through ${sundayLong}. ` +
    `We pull a weather-aware view of low-and-slow conditions across six U.S. regions, using temperature, dew point, and wind to give you a quick read on whether the upcoming weekend favors brisket, ribs, pork shoulder, or yard work instead. ` +
    `This summary is a template snapshot — for a live, zip-coded forecast tied to your specific cooker, head to pitmaster.tools/smoke-weather and drop in a zip code.`;

  const sections: { heading: string; body: string }[] = [
    {
      heading: 'Northeast (anchor: New York)',
      body:
        `From Maine to Pennsylvania the northeast tends to swing between cool, dry weekends that suit lean cuts and the occasional humid blast that complicates pork shoulder bark. ` +
        `Watch dew point on Friday afternoon: under 55°F is ideal for a brisket flat; above 70°F you will want a smaller cooker or a longer rest to avoid a soggy crust.`,
    },
    {
      heading: 'Southeast (anchor: Atlanta)',
      body:
        `The southeast is humidity central from late spring through October. ` +
        `Long cooks like whole hog and packer brisket run a longer stall when the dew point stays high, because humid air keeps the meat surface wet and evaporating, so plan extra time or wrap to push through it. Expect the smoke ring to feel muted if surface winds are calm. ` +
        `If the forecast shows gusts above 15 mph in Atlanta, Charlotte, or Nashville, plan a wind break or move the offset closer to the house.`,
    },
    {
      heading: 'Midwest (anchor: Chicago)',
      body:
        `Midwest swings are the widest in the country. ` +
        `A Friday morning in the 40s and a Saturday afternoon in the 80s is not unusual in the shoulder seasons. ` +
        `For pellet cookers this means tighter feed-rate tuning across the cook; for stick burners it means keeping a few extra splits dry under cover. ` +
        `Aim for cooks that finish before evening if a cold front is on the radar.`,
    },
    {
      heading: 'South Central (anchor: Kansas City)',
      body:
        `Kansas City, Tulsa, Dallas, and the rest of the south-central corridor are the spiritual heart of competition BBQ. ` +
        `Expect dry heat through summer and stiff winds in spring. ` +
        `Brisket fans should pre-trim and inject before high-wind weekends to keep moisture in; ribs handle the wind better because the cook is shorter and the meat carries less mass.`,
    },
    {
      heading: 'Mountain (anchor: Denver)',
      body:
        `Altitude affects cook time more than weather most weeks. ` +
        `At 5,000+ ft, internal temperatures rise faster, and the region's dry air tends to shorten the stall rather than stretch it, since a dry surface finishes evaporating sooner. ` +
        `Watch overnight lows: a clear sky in Denver, Salt Lake City, or Albuquerque can drop pit temps 30°F between 2 a.m. and 5 a.m., which is why overnight cooks here need an insulated firebox or a controller with low-temp recovery.`,
    },
    {
      heading: 'Pacific (anchor: Los Angeles)',
      body:
        `Coastal California, Oregon, and Washington enjoy some of the most stable smoke weather in the country — marine layers keep mid-day temps moderate and dew point predictable. ` +
        `Inland valleys swing more, especially in mid-summer when triple-digit highs push small cookers past their stable operating range. ` +
        `For Los Angeles, Sacramento, and the Bay Area, plan early starts and a shaded cooker location.`,
    },
  ];

  const cta =
    `Want a zip-coded score for your weekend? Visit pitmaster.tools/smoke-weather and we will surface a 0–100 score for your cut, cooker, and forecast — no signup required. Subscribers also receive a Friday digest tuned to their region.`;

  const disclosure =
    `Affiliate disclosure (FTC): pitmaster.tools may earn a commission from links to cookers, thermometers, and accessories. Recommendations are based on weather suitability, not commercial relationships.`;

  const textParts: string[] = [intro];
  for (const s of sections) textParts.push(`${s.heading}\n${s.body}`);
  textParts.push(cta, disclosure);
  const bodyText = textParts.join('\n\n');

  const htmlParts: string[] = [`<p>${escapeHtml(intro)}</p>`];
  for (const s of sections) {
    htmlParts.push(`<h2>${escapeHtml(s.heading)}</h2>`);
    htmlParts.push(`<p>${escapeHtml(s.body)}</p>`);
  }
  htmlParts.push(`<p>${escapeHtml(cta)}</p>`);
  htmlParts.push(`<p class="affiliate-disclosure">${escapeHtml(disclosure)}</p>`);
  const bodyHtml = htmlParts.join('\n');

  return { title, bodyHtml, bodyText, heroBand };
}

export async function runWeeklyArticleCron(
  env: Env,
  scheduledTime: Date
): Promise<WeeklyArticleOutcome> {
  const parts = isoWeekParts(scheduledTime);
  const slug = weeklySummarySlug(parts);
  const built = buildArticle(parts, scheduledTime);
  const now = scheduledTime.getTime();

  const existing = await env.SMOKE_DB.prepare(
    `SELECT slug FROM articles WHERE slug = ?`
  )
    .bind(slug)
    .first<{ slug: string }>();

  if (existing) {
    await env.SMOKE_DB.prepare(
      `UPDATE articles
          SET title = ?, body_html = ?, body_text = ?, hero_band = ?, updated_at = ?
        WHERE slug = ?`
    )
      .bind(built.title, built.bodyHtml, built.bodyText, built.heroBand, now, slug)
      .run();
    return { status: 'updated', slug };
  }

  await env.SMOKE_DB.prepare(
    `INSERT INTO articles
       (slug, kind, title, body_html, body_text, hero_band, published_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      slug,
      'weekly-summary',
      built.title,
      built.bodyHtml,
      built.bodyText,
      built.heroBand,
      now,
      now
    )
    .run();
  return { status: 'written', slug };
}
