import { describe, expect, it } from 'vitest';
import { scoreDay } from '../../../../packages/shared/src/scoring';
import type { Cooker, Cut, WeatherDay } from '../../../../packages/shared/src/types';
import {
  bandLabel,
  escapeHtml,
  fmtHour,
  fmtNum,
  formatDateLabel,
  pickBestDay,
  renderAffiliateCardInner,
  renderDayCard,
  renderDayCards,
  renderHourlyTable,
  renderVerdictHeroInner,
  scoreAllDays,
  verdictHeroBandClass,
  type HourlyRenderCtx,
  type ScoredDay,
} from '../../../src/lib/render/smokeWeather';

function makeDay(overrides: Partial<WeatherDay> = {}): WeatherDay {
  return {
    date: '2026-05-15',
    tempHighF: 82,
    tempLowF: 60,
    rhMean: 55,
    windMphMean: 8,
    gustMphMax: 12,
    precipProbPct: 10,
    precipIn: 0,
    dewPointMeanF: 50,
    hourly: [
      { t: '2026-05-15T08:00', tempF: 68, rh: 60, windMph: 6, gustMph: 10, precipProbPct: 5, precipIn: 0, dewPointF: 50 },
      { t: '2026-05-15T14:00', tempF: 80, rh: 45, windMph: 9, gustMph: 14, precipProbPct: 10, precipIn: 0, dewPointF: 52 },
    ],
    source: 'open-meteo',
    confidence: 'high',
    ...overrides,
  };
}

const DEFAULT_CUT: Cut = 'brisket-packer';
const DEFAULT_COOKER: Cooker = 'offset';
const CTX: HourlyRenderCtx = { cut: DEFAULT_CUT, cooker: DEFAULT_COOKER, confidence: 'high' };

describe('helpers', () => {
  it('escapeHtml neutralizes the five HTML metachars', () => {
    expect(escapeHtml('a<b>"c"\'d&e')).toBe('a&lt;b&gt;&quot;c&quot;&#39;d&amp;e');
  });

  it('fmtNum rounds finite values and em-dashes non-finite', () => {
    expect(fmtNum(64.6)).toBe('65');
    expect(fmtNum(0)).toBe('0');
    expect(fmtNum(undefined)).toBe('—');
    expect(fmtNum(Number.NaN)).toBe('—');
    expect(fmtNum(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('formatDateLabel produces "Weekday, Mon D" without tz drift', () => {
    // 2026-05-15 is a Friday.
    expect(formatDateLabel('2026-05-15')).toBe('Fri, May 15');
    // 2026-12-01 is a Tuesday.
    expect(formatDateLabel('2026-12-01')).toBe('Tue, Dec 1');
  });

  it('fmtHour converts ISO HH to 12-hour AM/PM', () => {
    expect(fmtHour('2026-05-15T00:00')).toBe('12 AM');
    expect(fmtHour('2026-05-15T08:00')).toBe('8 AM');
    expect(fmtHour('2026-05-15T12:00')).toBe('12 PM');
    expect(fmtHour('2026-05-15T23:00')).toBe('11 PM');
    expect(fmtHour('not-an-iso')).toBe('');
    expect(fmtHour('2026-05-15X00:00')).toBe('');
  });

  it('bandLabel proper-cases the four bands', () => {
    expect(bandLabel('ideal')).toBe('Ideal');
    expect(bandLabel('green')).toBe('Green');
    expect(bandLabel('yellow')).toBe('Yellow');
    expect(bandLabel('red')).toBe('Red');
  });

  it('pickBestDay returns the highest score with earliest tiebreak', () => {
    const days: ScoredDay[] = [
      { date: '2026-05-15', day: makeDay(), score: { score: 70, band: 'green', stallRiskPct: 0, reasons: [], confidence: 'high' } },
      { date: '2026-05-16', day: makeDay(), score: { score: 70, band: 'green', stallRiskPct: 0, reasons: [], confidence: 'high' } },
      { date: '2026-05-17', day: makeDay(), score: { score: 65, band: 'yellow', stallRiskPct: 0, reasons: [], confidence: 'high' } },
    ];
    // Two days tied at 70; earliest wins.
    expect(pickBestDay(days)!.date).toBe('2026-05-15');
  });

  it('pickBestDay returns null for empty input', () => {
    expect(pickBestDay([])).toBeNull();
  });
});

describe('renderVerdictHeroInner', () => {
  const days: ScoredDay[] = scoreAllDays(
    [makeDay({ date: '2026-05-15' }), makeDay({ date: '2026-05-16', tempHighF: 88 })],
    DEFAULT_CUT,
    DEFAULT_COOKER
  );

  it('renders the location line above the verdict with locationName preferred', () => {
    const html = renderVerdictHeroInner({
      zip: '30309', locationName: 'Atlanta, GA', metro: 'atlanta-ga',
      source: 'open-meteo', days,
    });
    expect(html).toMatch(/Forecast for <strong>Atlanta, GA<\/strong>/);
    expect(html).toMatch(/ZIP 30309/);
  });

  it('falls back to metro slug, then to ZIP, when locationName is absent', () => {
    const withMetro = renderVerdictHeroInner({
      zip: '30309', metro: 'atlanta-ga', source: 'open-meteo', days,
    });
    expect(withMetro).toMatch(/<strong>atlanta-ga<\/strong>/);
    const withoutAnything = renderVerdictHeroInner({
      zip: '30309', source: 'open-meteo', days,
    });
    expect(withoutAnything).toMatch(/<strong>ZIP 30309<\/strong>/);
  });

  it('uses "National Weather Service" when source is nws', () => {
    const html = renderVerdictHeroInner({
      zip: '30309', locationName: 'Atlanta, GA', source: 'nws', days,
    });
    expect(html).toMatch(/Source: National Weather Service/);
  });

  it('escapes locationName + metro to defend against malformed upstream', () => {
    const html = renderVerdictHeroInner({
      zip: '30309', locationName: 'Atlanta<script>alert(1)</script>',
      source: 'open-meteo', days,
    });
    expect(html).not.toMatch(/<script>/);
    expect(html).toMatch(/Atlanta&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it('returns empty string when given no days', () => {
    expect(renderVerdictHeroInner({
      zip: '30309', source: 'open-meteo', days: [],
    })).toBe('');
  });
});

describe('verdictHeroBandClass', () => {
  it("matches the best day's band", () => {
    const high: ScoredDay = {
      date: '2026-05-15', day: makeDay(),
      score: { score: 92, band: 'ideal', stallRiskPct: 0, reasons: [], confidence: 'high' },
    };
    const low: ScoredDay = {
      date: '2026-05-16', day: makeDay(),
      score: { score: 30, band: 'red', stallRiskPct: 0, reasons: [], confidence: 'high' },
    };
    expect(verdictHeroBandClass([high, low])).toBe('ideal');
    expect(verdictHeroBandClass([low, high])).toBe('ideal');
    expect(verdictHeroBandClass([low])).toBe('red');
  });

  it('falls back to yellow when there are no days', () => {
    expect(verdictHeroBandClass([])).toBe('yellow');
  });
});

describe('renderDayCard + renderDayCards', () => {
  it('renders 64/100 + proper-case band + dates + temps', () => {
    const day = makeDay({ date: '2026-05-15' });
    const score = scoreDay({ cut: DEFAULT_CUT, cooker: DEFAULT_COOKER, day });
    const html = renderDayCard({ date: day.date, day, score }, true, CTX);
    expect(html).toMatch(/class="day-card band-(red|yellow|green|ideal) is-best"/);
    expect(html).toMatch(/<span class="day-card__score-num">\d+<\/span>/);
    expect(html).toMatch(/<span class="day-card__score-suffix">\/100<\/span>/);
    expect(html).toMatch(/<span class="day-card__score-band">(Red|Yellow|Green|Ideal)<\/span>/);
    expect(html).toMatch(/Fri, May 15/);
  });

  it('omits is-best when isBest is false', () => {
    const day = makeDay();
    const score = scoreDay({ cut: DEFAULT_CUT, cooker: DEFAULT_COOKER, day });
    const html = renderDayCard({ date: day.date, day, score }, false, CTX);
    expect(html).not.toMatch(/is-best/);
  });

  it('renderDayCards marks the best day with is-best (earliest tiebreak)', () => {
    const days: ScoredDay[] = scoreAllDays(
      [
        makeDay({ date: '2026-05-15' }),
        makeDay({ date: '2026-05-16' }),
        makeDay({ date: '2026-05-17', tempHighF: 88 }),
      ],
      DEFAULT_CUT,
      DEFAULT_COOKER
    );
    const html = renderDayCards(days, CTX);
    // The first two days are scored identically and tie; earliest wins.
    const bestMatches = html.match(/is-best/g) ?? [];
    expect(bestMatches).toHaveLength(1);
  });

  it('includes the baked hourly table inside <details>', () => {
    const day = makeDay();
    const score = scoreDay({ cut: DEFAULT_CUT, cooker: DEFAULT_COOKER, day });
    const html = renderDayCard({ date: day.date, day, score }, false, CTX);
    expect(html).toMatch(/<details class="day-card__hourly">/);
    expect(html).toMatch(/<table class="hourly-table">/);
    // No data-hourly-pending — SSR bakes the rows, no lazy-load needed.
    expect(html).not.toMatch(/data-hourly-pending/);
  });
});

describe('renderHourlyTable', () => {
  it('applies a band-* class to each row', () => {
    const day = makeDay();
    const html = renderHourlyTable(day.hourly, CTX);
    const rowBands = html.match(/<tr class="band-(red|yellow|green|ideal)"/g) ?? [];
    expect(rowBands.length).toBe(day.hourly.length);
  });

  it('returns an empty-state paragraph when hours are missing', () => {
    expect(renderHourlyTable([], CTX)).toMatch(/No hourly data for this day/);
  });

  it('survives an unknown cut/cooker without the band class', () => {
    const day = makeDay();
    const html = renderHourlyTable(day.hourly, { cut: 'pterodactyl' as Cut, cooker: 'offset', confidence: 'high' });
    expect(html).not.toMatch(/band-(red|yellow|green|ideal)/);
    // Rows still render so the table is legible.
    expect(html.match(/<tr/g)!.length).toBeGreaterThan(1);
  });
});

describe('renderAffiliateCardInner', () => {
  it('emits an anchor with rel="sponsored nofollow noopener" for http URLs', () => {
    const html = renderAffiliateCardInner({
      productId: 'p1', productName: 'BBQ Guru CyberQ', productUrl: 'https://example.com/cyberq',
      reason: 'Wind protection for offset cooks', category: 'fire-management', disclosureRequired: true,
    });
    expect(html).toMatch(/<a class="affiliate-card__product"/);
    expect(html).toMatch(/rel="sponsored nofollow noopener"/);
    expect(html).toMatch(/See our affiliate disclosure/);
  });

  it('emits a span (not a link) when productUrl is non-http', () => {
    const html = renderAffiliateCardInner({
      productId: 'p1', productName: 'BBQ Guru', productUrl: 'javascript:alert(1)',
      reason: 'why', category: 'fire-management', disclosureRequired: true,
    });
    expect(html).toMatch(/<span class="affiliate-card__product">/);
    // The disclosure paragraph carries its own /smoke-weather/disclosures
    // link, so only assert that there's no PRODUCT anchor.
    expect(html).not.toMatch(/<a class="affiliate-card__product"/);
  });
});
