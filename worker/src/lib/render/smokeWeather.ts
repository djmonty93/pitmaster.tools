// Server-side HTML render helpers for the smoke-weather feature.
//
// These functions produce markup that visually matches the client-side
// renderers in _partials/smoke-weather-app.js so the Worker can SSR
// the verdict hero / day cards / affiliate slot / hourly tables into
// the metro pages and the chooser tiles, and the client can swap in
// fresh re-renders (on cut/cooker change) with no visual jump.
//
// Parity scope (intentional differences):
//   - The verdict hero, day card outer markup, affiliate card, and
//     score/band text MUST stay byte-identical to the client's output
//     so client re-renders match the initial paint pixel-for-pixel.
//     The unit tests in tests/unit/render/smokeWeather.test.ts pin
//     these against a fixed fixture so a one-sided drift fails CI.
//   - The hourly-table shape DIFFERS by design: SSR bakes the full
//     <table> into each day card (so JS-disabled clients see the data
//     and the per-hour band tints are present from first paint),
//     while the client emits `<div data-hourly-pending="1">` and
//     lazy-loads on toggle. When the client re-renders a day card it
//     re-emits the lazy shape, replacing the SSR'd baked table — no
//     visual regression because the contents look the same when
//     opened.

import { scoreDay, scoreHour } from '@shared/scoring';
import type {
  AffiliateRecommendation,
  Cooker,
  Cut,
  ScoreResult,
  WeatherDay,
  WeatherHour,
} from '@shared/types';

export interface ScoredDay {
  date: string;
  day: WeatherDay;
  score: ScoreResult;
}

export interface HourlyRenderCtx {
  cut: Cut;
  cooker: Cooker;
  confidence: ScoreResult['confidence'];
}

const CONFIDENCE_TOOLTIP =
  'Forecast certainty: high (next 1-2 days), medium (3-4 days), low (5+ days).';
const DEWPOINT_TOOLTIP =
  'Dew point above ~60 °F slows evaporative cooling and lengthens the stall on long cuts.';
const AFFILIATE_DISCLOSURE_HTML =
  '<p class="affiliate-disclosure">' +
    'We may earn a commission on purchases made through links on this page at no additional cost to you. ' +
    '<a href="/smoke-weather/disclosures">See our affiliate disclosure</a>.' +
  '</p>';

const HTML_ESCAPE_RE = /[&<>"']/g;
const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

export function escapeHtml(s: string): string {
  return String(s).replace(HTML_ESCAPE_RE, (c) => HTML_ESCAPE_MAP[c]!);
}

/**
 * Serialize a value as JSON safe for embedding inside an inline
 * `<script type="application/json">` tag. `JSON.stringify` alone does
 * not escape `</script>` (since `/` and `<` are valid JSON chars),
 * which means a future field carrying that substring would close the
 * outer script element and create an XSS surface. Replace the `<`
 * with its Unicode escape — semantically identical JSON, but no
 * possibility of confusing the HTML parser.
 */
export function jsonForScriptTag(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

// Mirrors fmtNum() in _partials/smoke-weather-app.js: render as rounded
// integer, or em dash when the value is null/undefined/NaN.
export function fmtNum(v: number | null | undefined): string {
  return Number.isFinite(v as number) ? String(Math.round(v as number)) : '—';
}

// Mirrors formatDateLabel() in the client: "Sat, May 16" — built
// without `new Date(YYYY-MM-DD)` since Safari/Chrome disagree on
// whether the ISO date parses as UTC midnight or local midnight, which
// can shift the weekday by one.
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function formatDateLabel(iso: string): string {
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  const y = parseInt(parts[0]!, 10);
  const m = parseInt(parts[1]!, 10) - 1;
  const d = parseInt(parts[2]!, 10);
  const localDate = new Date(y, m, d);
  return DAY_NAMES[localDate.getDay()]! + ', ' + MONTH_NAMES[m]! + ' ' + d;
}

// Mirrors fmtHour(): converts an ISO timestamp's HH portion to a
// 12-hour "8 AM" / "3 PM" label. Slicing avoids the Date-construction
// tz hazard that hits NWS responses (their ISO carries a -05:00 offset
// the local Date constructor would interpret).
export function fmtHour(t: string): string {
  if (typeof t !== 'string' || t.length < 13 || t.charAt(10) !== 'T') return '';
  const hh = parseInt(t.slice(11, 13), 10);
  if (!Number.isFinite(hh) || hh < 0 || hh > 23) return '';
  const period = hh < 12 ? 'AM' : 'PM';
  let h12 = hh % 12;
  if (h12 === 0) h12 = 12;
  return h12 + ' ' + period;
}

// Quality labels for the four score bands. The underlying band keys
// (ideal/green/yellow/red) and their CSS color classes are unchanged;
// only the human-facing text is a quality word rather than a color
// name, so "Good/Average/Poor" reads as a verdict. MUST stay
// byte-identical to the client bandLabel in _partials/smoke-weather-app.js
// and the chooser-tile bandLabel in handlers/metrosChooser.ts.
export function bandLabel(b: ScoreResult['band']): string {
  if (b === 'ideal') return 'Ideal';
  if (b === 'green') return 'Good';
  if (b === 'yellow') return 'Average';
  return 'Poor';
}

// Tie-break: strict `>` keeps the EARLIEST day on a tie so the verdict
// hero suggests the soonest opportunity. Matches the client's
// pickBestDay (same comment in _partials/smoke-weather-app.js).
export function pickBestDay(days: readonly ScoredDay[]): ScoredDay | null {
  let best: ScoredDay | null = null;
  for (const d of days) {
    if (!best || d.score.score > best.score.score) best = d;
  }
  return best;
}

export interface VerdictHeroInput {
  zip: string;
  locationName?: string;
  metro?: string;
  source: 'open-meteo' | 'nws';
  days: readonly ScoredDay[];
}

/**
 * Render the verdict-hero inner content. Caller is responsible for
 * setting the outer `<section id="verdictHero" class="verdict-hero band-X">`
 * and removing its `hidden` attribute. We return only the inner HTML so
 * the same template works through HTMLRewriter's setInnerContent.
 */
export function renderVerdictHeroInner(input: VerdictHeroInput): string {
  const best = pickBestDay(input.days);
  if (!best) return '';
  let verdict: string;
  if (best.score.band === 'ideal')      verdict = 'Ideal smoke day';
  else if (best.score.band === 'green') verdict = 'Good smoke day';
  else if (best.score.band === 'yellow') verdict = 'Workable, plan ahead';
  else                                  verdict = 'Tough conditions';

  const locLabel = input.locationName
    ? input.locationName
    : (input.metro ? input.metro : 'ZIP ' + input.zip);
  const sourceLabel = input.source === 'nws' ? 'National Weather Service' : 'Open-Meteo';

  return (
    '<p class="verdict-hero__location">Forecast for <strong>' + escapeHtml(locLabel) + '</strong> &middot; ZIP ' + escapeHtml(String(input.zip)) + '</p>' +
    '<div class="verdict-hero__label">Best day in the next ' + input.days.length + ' days</div>' +
    '<h2 class="verdict-hero__verdict">' + escapeHtml(verdict) + ' &mdash; ' + escapeHtml(formatDateLabel(best.date)) + '</h2>' +
    '<div class="verdict-hero__meta">' +
      '<span>Score <strong>' + best.score.score + '</strong>/100</span>' +
      '<span>High ' + fmtNum(best.day.tempHighF) + '&deg;F / Low ' + fmtNum(best.day.tempLowF) + '&deg;F</span>' +
    '</div>' +
    '<div class="verdict-hero__source">Source: ' + escapeHtml(sourceLabel) + '</div>'
  );
}

/**
 * The band class to apply to the verdict-hero element itself. Falls
 * back to `band-yellow` when there are no scored days (caller can
 * choose to leave the hero hidden instead).
 */
export function verdictHeroBandClass(days: readonly ScoredDay[]): ScoreResult['band'] {
  const best = pickBestDay(days);
  return best ? best.score.band : 'yellow';
}

/**
 * Render one `<article class="day-card …">` for one scored day. The
 * hourly table is BAKED into the SSR output (rather than the lazy
 * `data-hourly-pending` shape the client uses) — for SSR pages we want
 * the per-hour breakdown to be available with JS disabled too. When
 * the client takes over for a cut/cooker change, it overwrites the
 * day card entirely with its own renderDayCard output, so the lazy
 * shape returns on subsequent re-renders.
 */
export function renderDayCard(
  entry: ScoredDay,
  isBest: boolean,
  ctx: HourlyRenderCtx
): string {
  const bandClass = 'band-' + entry.score.band;
  const cls = 'day-card ' + bandClass + (isBest ? ' is-best' : '');
  const reasons = entry.score.reasons.slice(0, 3);
  let reasonsHtml = '';
  for (const r of reasons) reasonsHtml += '<li>' + escapeHtml(r) + '</li>';

  return (
    '<article class="' + escapeHtml(cls) + '" data-date="' + escapeHtml(entry.date) + '">' +
      '<div class="day-card__date">' + escapeHtml(formatDateLabel(entry.date)) + '</div>' +
      '<div class="day-card__score">' +
        '<span class="day-card__score-num">' + entry.score.score + '</span>' +
        '<span class="day-card__score-suffix">/100</span>' +
        '<span class="day-card__score-band">' + escapeHtml(bandLabel(entry.score.band)) + '</span>' +
      '</div>' +
      '<div class="day-card__temps">' + fmtNum(entry.day.tempHighF) + '&deg;F / ' + fmtNum(entry.day.tempLowF) + '&deg;F &middot; gust ' + fmtNum(entry.day.gustMphMax) + ' mph</div>' +
      '<ul class="day-card__reasons">' + reasonsHtml + '</ul>' +
      '<div class="day-card__dewpoint" title="' + escapeHtml(DEWPOINT_TOOLTIP) + '">Dew point ' + fmtNum(entry.day.dewPointMeanF) + '&deg;F<span class="sw-sr-only"> — ' + escapeHtml(DEWPOINT_TOOLTIP) + '</span></div>' +
      '<details class="day-card__hourly">' +
        '<summary>Hour-by-hour</summary>' +
        '<div class="day-card__hourly-body">' + renderHourlyTable(entry.day.hourly, ctx) + '</div>' +
      '</details>' +
      '<div class="day-card__confidence is-' + escapeHtml(entry.score.confidence) + '" title="' + escapeHtml(CONFIDENCE_TOOLTIP) + '">Confidence: ' + escapeHtml(entry.score.confidence) + '<span class="sw-sr-only"> — ' + escapeHtml(CONFIDENCE_TOOLTIP) + '</span></div>' +
    '</article>'
  );
}

/**
 * Render every scored day as a sequence of `<article>`s. Caller drops
 * the result into the `<div id="dayCards">` container.
 */
export function renderDayCards(days: readonly ScoredDay[], ctx: HourlyRenderCtx): string {
  const best = pickBestDay(days);
  const bestKey = best ? best.date : null;
  let html = '';
  for (const entry of days) {
    html += renderDayCard(entry, entry.date === bestKey, ctx);
  }
  return html;
}

export function renderHourlyTable(hours: readonly WeatherHour[], ctx: HourlyRenderCtx): string {
  if (!Array.isArray(hours) || hours.length === 0) {
    return '<p class="day-card__hourly-empty">No hourly data for this day.</p>';
  }
  let rows = '';
  for (const h of hours) {
    let rowClass = '';
    try {
      const hs = scoreHour({ cut: ctx.cut, cooker: ctx.cooker, hour: h, confidence: ctx.confidence });
      rowClass = ' class="band-' + escapeHtml(hs.band) + '"';
    } catch (_e) {
      // Unknown cut/cooker — leave the row uncolored. Mirrors the
      // client's try/catch swallow.
    }
    rows +=
      '<tr' + rowClass + '>' +
        '<th scope="row">' + escapeHtml(fmtHour(h.t)) + '</th>' +
        '<td>' + fmtNum(h.tempF) + '&deg;F</td>' +
        '<td>' + fmtNum(h.windMph) + '/' + fmtNum(h.gustMph) + '</td>' +
        '<td>' + fmtNum(h.precipProbPct) + '%</td>' +
        '<td>' + fmtNum(h.dewPointF) + '&deg;F</td>' +
      '</tr>';
  }
  return (
    '<div class="hourly-table-scroll">' +
      '<table class="hourly-table">' +
        '<thead><tr>' +
          '<th scope="col">Hour</th>' +
          '<th scope="col">Temp</th>' +
          '<th scope="col">Wind/Gust</th>' +
          '<th scope="col">Rain</th>' +
          '<th scope="col">Dew</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
    '</div>'
  );
}

function isHttpUrl(s: string): boolean {
  return typeof s === 'string' && /^https?:\/\//i.test(s);
}

/**
 * Render the affiliate card inner content. Caller sets the outer
 * `<aside id="affiliateSlot" class="affiliate-card">` and removes
 * `hidden`.
 */
export function renderAffiliateCardInner(rec: AffiliateRecommendation): string {
  const productLine = isHttpUrl(rec.productUrl)
    ? '<a class="affiliate-card__product" ' +
        'href="' + escapeHtml(rec.productUrl) + '" ' +
        'rel="sponsored nofollow noopener" target="_blank">' +
        escapeHtml(rec.productName) +
      '</a>'
    : '<span class="affiliate-card__product">' + escapeHtml(rec.productName) + '</span>';
  return (
    '<div class="affiliate-card__label">Gear that helps for this cook</div>' +
    productLine +
    '<p class="affiliate-card__reason">' + escapeHtml(rec.reason) + '</p>' +
    AFFILIATE_DISCLOSURE_HTML
  );
}

/**
 * Convenience: score all days at the same (cut, cooker). Returns an
 * array shaped like the /api/forecast response's `days` field — the
 * server-side renderers consume this shape directly.
 */
export function scoreAllDays(
  days: readonly WeatherDay[],
  cut: Cut,
  cooker: Cooker
): ScoredDay[] {
  return days.map((day) => ({
    date: day.date,
    day,
    score: scoreDay({ cut, cooker, day }),
  }));
}
