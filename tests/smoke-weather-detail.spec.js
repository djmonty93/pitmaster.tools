const { test, expect } = require('@playwright/test');

// Step 9 detail/hourly view (F3/F4/F5).
//
// The verdict landing must surface three pieces of additional context
// without bloating the initial paint:
//
//   F3 confidence label → already in the day-card footer; this spec
//      asserts the explanatory tooltip is wired so the user knows
//      what high/medium/low actually mean.
//   F4 dew-point row    → small line under the score with a tooltip
//      explaining the link to stall risk on long cooks.
//   F5 hourly view      → a <details> element per card whose body is
//      lazy-populated on first open. Two reasons we test "lazy":
//        1. Initial DOM weight stays small (a 7-day forecast with 24h
//           each would otherwise add ~170 rows up front).
//        2. The renderer is the only place that converts the upstream
//           hourly array to localized hour labels — proving the body
//           is empty pre-toggle and populated post-toggle catches the
//           common regression where someone renders eagerly and then
//           the lazy path silently rots.

const HOURLY = [
  { t: '2026-05-16T06:00', tempF: 56, rh: 72, windMph: 4, gustMph: 7, precipProbPct: 5,  precipIn: 0, dewPointF: 44 },
  { t: '2026-05-16T09:00', tempF: 62, rh: 60, windMph: 5, gustMph: 8, precipProbPct: 5,  precipIn: 0, dewPointF: 45 },
  { t: '2026-05-16T12:00', tempF: 70, rh: 45, windMph: 6, gustMph: 9, precipProbPct: 0,  precipIn: 0, dewPointF: 46 },
  { t: '2026-05-16T15:00', tempF: 74, rh: 38, windMph: 7, gustMph: 10, precipProbPct: 0, precipIn: 0, dewPointF: 47 },
  { t: '2026-05-16T18:00', tempF: 70, rh: 42, windMph: 5, gustMph: 8, precipProbPct: 0,  precipIn: 0, dewPointF: 47 },
];

const FIXTURE = {
  zip: '64108',
  metro: 'kansas-city-mo',
  source: 'open-meteo',
  generatedAt: '2026-05-14T18:00:00.000Z',
  days: [
    {
      date: '2026-05-16',
      day: {
        date: '2026-05-16',
        tempHighF: 74,
        tempLowF: 56,
        rhMean: 50,
        windMphMean: 5,
        gustMphMax: 10,
        precipProbPct: 5,
        precipIn: 0,
        dewPointMeanF: 46,
        hourly: HOURLY,
        source: 'open-meteo',
        confidence: 'high',
      },
      score: { score: 92, band: 'ideal', stallRiskPct: 22, reasons: ['Conditions look good'], confidence: 'high' },
    },
    {
      date: '2026-05-17',
      day: {
        date: '2026-05-17',
        tempHighF: 81,
        tempLowF: 60,
        rhMean: 50,
        windMphMean: 8,
        gustMphMax: 14,
        precipProbPct: 20,
        precipIn: 0,
        dewPointMeanF: 55,
        hourly: [],
        source: 'open-meteo',
        confidence: 'medium',
      },
      score: { score: 76, band: 'green', stallRiskPct: 38, reasons: ['Conditions look good'], confidence: 'medium' },
    },
  ],
};

async function mockForecast(page, body = FIXTURE) {
  await page.route('**/api/forecast**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

test.describe('Best Smoke Days — F3/F4/F5 detail view', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('hourly <details> renders empty body until first open, then fills with rows', async ({ page }) => {
    await mockForecast(page);
    await page.goto('/smoke-weather/');

    const card = page.locator('#dayCards .day-card[data-date="2026-05-16"]');
    await expect(card).toBeVisible();

    const details = card.locator('.day-card__hourly');
    await expect(details).toBeVisible();
    // Pre-open: no rows in the body, lazy marker still set. We assert
    // both — the marker is the implementation contract; the row count
    // is the user-visible proof that nothing rendered yet.
    await expect(card.locator('.hourly-table tbody tr')).toHaveCount(0);
    await expect(card.locator('.day-card__hourly-body[data-hourly-pending="1"]')).toHaveCount(1);

    // Tap to expand. Use click on the summary so the test exercises
    // the same code path as a phone tap (the <summary> handles both).
    await card.locator('.day-card__hourly > summary').click();

    // Post-open: the lazy marker is gone, the table is populated, and
    // the row count matches the fixture exactly. If a future change
    // double-renders, this count goes wrong immediately.
    await expect(card.locator('.day-card__hourly-body[data-hourly-pending="1"]')).toHaveCount(0);
    await expect(card.locator('.hourly-table tbody tr')).toHaveCount(HOURLY.length);

    // Spot-check a row to confirm the renderer formatted the
    // upstream UTC hour without timezone-shifting it. 06:00 → "6 AM".
    await expect(card.locator('.hourly-table tbody tr').first().locator('th')).toHaveText('6 AM');
  });

  test('hourly body stays empty when the day has no hourly samples (NWS partial / outage)', async ({ page }) => {
    await mockForecast(page);
    await page.goto('/smoke-weather/');

    const emptyCard = page.locator('#dayCards .day-card[data-date="2026-05-17"]');
    await emptyCard.locator('.day-card__hourly > summary').click();

    // No rows, but the empty-state copy is rendered so the user knows
    // why — silent emptiness reads like a bug.
    await expect(emptyCard.locator('.hourly-table')).toHaveCount(0);
    await expect(emptyCard.locator('.day-card__hourly-empty')).toBeVisible();
  });

  test('confidence pill carries the explanatory tooltip AND a screen-reader description (F3)', async ({ page }) => {
    await mockForecast(page);
    await page.goto('/smoke-weather/');

    const pill = page.locator('#dayCards .day-card[data-date="2026-05-16"] .day-card__confidence');
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute(
      'title',
      /high \(next 1-2 days\), medium \(3-4 days\), low \(5\+ days\)/
    );
    // Also exposed inline via a visually-hidden span so screen readers
    // and keyboard-only users get the same explanation as mouse
    // hoverers — title alone is not reliably announced.
    const sr = pill.locator('.sw-sr-only');
    await expect(sr).toHaveCount(1);
    await expect(sr).toHaveText(/high \(next 1-2 days\), medium \(3-4 days\), low \(5\+ days\)/);
  });

  test('dew-point row carries the stall-risk tooltip AND a screen-reader description (F4)', async ({ page }) => {
    await mockForecast(page);
    await page.goto('/smoke-weather/');

    const dp = page.locator('#dayCards .day-card[data-date="2026-05-16"] .day-card__dewpoint');
    await expect(dp).toBeVisible();
    await expect(dp).toContainText('Dew point 46');
    await expect(dp).toHaveAttribute('title', /slows evaporative cooling/);
    const sr = dp.locator('.sw-sr-only');
    await expect(sr).toHaveCount(1);
    await expect(sr).toHaveText(/slows evaporative cooling/);
  });
});
