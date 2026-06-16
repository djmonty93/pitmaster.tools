import { describe, expect, it } from 'vitest';
import {
  WEEKLY_TOOLS,
  isoWeekNumber,
  pickWeeklyTool,
  renderDigestEmail,
  type DigestEmailInput,
  type DigestMetro,
} from '../../../src/lib/render/digestEmail';
import type { ScoreResult } from '@shared/types';

function score(band: ScoreResult['band'], n: number): ScoreResult {
  return { score: n, band, stallRiskPct: 0, reasons: [], confidence: 'high' };
}

const METROS: DigestMetro[] = [
  {
    name: 'Atlanta, GA',
    days: [
      { weekday: 'Fri', date: '2026-05-15', score: score('green', 76) },
      { weekday: 'Sat', date: '2026-05-16', score: score('ideal', 91) },
      { weekday: 'Sun', date: '2026-05-17', score: score('green', 78) },
      { weekday: 'Mon', date: '2026-05-18', score: score('yellow', 62) },
    ],
  },
  {
    name: 'Miami, FL',
    days: [
      { weekday: 'Fri', date: '2026-05-15', score: score('yellow', 49) },
      { weekday: 'Sat', date: '2026-05-16', score: score('red', 38) },
      { weekday: 'Sun', date: '2026-05-17', score: score('yellow', 55) },
      { weekday: 'Mon', date: '2026-05-18', score: score('green', 71) },
    ],
  },
];

const INPUT: DigestEmailInput = {
  regionLabel: 'Southeast',
  sendDate: '2026-05-15',
  metros: METROS,
  tool: WEEKLY_TOOLS[0]!,
  detailUrl: 'https://pitmaster.tools/smoke-weather/',
};

describe('renderDigestEmail', () => {
  const html = renderDigestEmail(INPUT);

  it('renders the region label in the header and title', () => {
    expect(html).toContain('Best Smoke Days — Southeast');
  });

  it('lists every metro', () => {
    expect(html).toContain('Atlanta, GA');
    expect(html).toContain('Miami, FL');
  });

  it('shows all four days Fri–Mon per metro (weekday-only labels)', () => {
    expect(html).toContain('>Fri</div>');
    expect(html).toContain('>Sat</div>');
    expect(html).toContain('>Sun</div>');
    expect(html).toContain('>Mon</div>');
  });

  it('brands the masthead with a Pitmaster Tools wordmark linked to the site', () => {
    expect(html).toContain('>Pitmaster&nbsp;Tools</a>');
    expect(html).toContain('href="https://pitmaster.tools"');
  });

  it('uses the weekend-beginning tagline built from the Friday send date', () => {
    expect(html).toContain('the weekend beginning Friday, May 15th');
  });

  it('includes the CAN-SPAM physical postal address in the footer', () => {
    expect(html).toContain('Aureate LLC, 3419 Virginia Beach Blvd #B32, Virginia Beach, VA 23452');
  });

  it('uses the relabeled quality band words, not color names', () => {
    expect(html).toContain('>Ideal<');
    expect(html).toContain('>Good<');
    expect(html).toContain('>Average<');
    expect(html).toContain('>Poor<');
    expect(html).not.toMatch(/>Green</);
    expect(html).not.toMatch(/>Yellow</);
  });

  it('features the rotating tool with link, name, and blurb', () => {
    expect(html).toContain(WEEKLY_TOOLS[0]!.url);
    expect(html).toContain(WEEKLY_TOOLS[0]!.name);
    expect(html).toContain(WEEKLY_TOOLS[0]!.blurb);
  });

  it('deep-links to the detailed forecast landing', () => {
    expect(html).toContain('https://pitmaster.tools/smoke-weather/');
    expect(html).toContain('See your detailed forecast');
  });

  it('discloses the default scoring profile in the footer', () => {
    expect(html).toContain('pork butt on an offset');
  });

  it('includes a per-group unsubscribe link', () => {
    expect(html).toContain('{$unsubscribe}');
    expect(html).toMatch(/Unsubscribe/i);
  });

  it('escapes HTML in metro names', () => {
    const evil = renderDigestEmail({
      ...INPUT,
      metros: [{ name: 'Bad<script>alert(1)</script>', days: METROS[0]!.days }],
    });
    expect(evil).not.toContain('<script>alert(1)</script>');
    expect(evil).toContain('Bad&lt;script&gt;');
  });
});

describe('isoWeekNumber + pickWeeklyTool', () => {
  it('computes known ISO week numbers', () => {
    // 2026-01-01 is a Thursday → ISO week 1 of 2026.
    expect(isoWeekNumber('2026-01-01')).toBe(1);
    // 2026-05-15 is a Friday → ISO week 20.
    expect(isoWeekNumber('2026-05-15')).toBe(20);
  });

  it('returns a tool from the rotation, deterministic per date', () => {
    const a = pickWeeklyTool('2026-05-15');
    const b = pickWeeklyTool('2026-05-15');
    expect(a).toEqual(b);
    expect(WEEKLY_TOOLS).toContainEqual(a);
  });

  it('advances the tool week over week', () => {
    const w1 = pickWeeklyTool('2026-05-15'); // week 20
    const w2 = pickWeeklyTool('2026-05-22'); // week 21
    expect(w1).not.toEqual(w2);
  });
});
