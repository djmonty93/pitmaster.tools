const { test, expect } = require('@playwright/test');

// Step 8 verdict landing — Playwright e2e against `wrangler dev`.
// We mock /api/forecast at the route layer so the test does not depend
// on Open-Meteo / NWS being reachable from CI. This stays faithful to
// what the worker would emit because the response shape is locked by
// packages/shared/src/types.ts (ForecastResponse).
//
// The fixture below is a 4-day forecast where day 2 is the clear best
// (ideal band, score 92). The page should pick it for the verdict
// hero, mark it `is-best`, and render all four day cards in the grid.

const FORECAST_FIXTURE = {
  zip: '64108',
  metro: 'kansas-city-mo',
  source: 'open-meteo',
  generatedAt: '2026-05-14T18:00:00.000Z',
  days: [
    {
      date: '2026-05-15',
      day: {
        date: '2026-05-15',
        tempHighF: 92,
        tempLowF: 68,
        rhMean: 70,
        windMphMean: 18,
        gustMphMax: 32,
        precipProbPct: 70,
        precipIn: 0.4,
        dewPointMeanF: 64,
        hourly: [],
        source: 'open-meteo',
        confidence: 'high',
      },
      score: { score: 28, band: 'red', stallRiskPct: 78, reasons: ['Heavy rain expected (0.40")', 'Gusts to 32 mph (offset sensitivity)', 'Hot afternoon (92 °F high)'], confidence: 'high' },
    },
    {
      date: '2026-05-16',
      day: {
        date: '2026-05-16',
        tempHighF: 74,
        tempLowF: 56,
        rhMean: 35,
        windMphMean: 5,
        gustMphMax: 9,
        precipProbPct: 5,
        precipIn: 0,
        dewPointMeanF: 42,
        hourly: [],
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
    {
      date: '2026-05-18',
      day: {
        date: '2026-05-18',
        tempHighF: 86,
        tempLowF: 64,
        rhMean: 60,
        windMphMean: 10,
        gustMphMax: 18,
        precipProbPct: 35,
        precipIn: 0.05,
        dewPointMeanF: 60,
        hourly: [],
        source: 'open-meteo',
        confidence: 'low',
      },
      score: { score: 62, band: 'yellow', stallRiskPct: 52, reasons: ['Hot afternoon (86 °F high)'], confidence: 'low' },
    },
  ],
};

async function mockForecast(page, body = FORECAST_FIXTURE, status = 200) {
  await page.route('**/api/forecast**', async (route) => {
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

test.describe('Best Smoke Days verdict landing', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('renders verdict hero + 4 day cards on initial load', async ({ page }) => {
    await mockForecast(page);
    await page.goto('/smoke-weather/');

    const hero = page.locator('#verdictHero');
    await expect(hero).toBeVisible();
    await expect(hero).toHaveClass(/band-ideal/);
    await expect(hero.locator('.verdict-hero__verdict')).toContainText('Ideal smoke day');

    const cards = page.locator('#dayCards .day-card');
    await expect(cards).toHaveCount(4);

    // Resolve each card by its data-date so partial-text matches (e.g.
    // "92" appearing in a different card's temps) cannot misroute the
    // assertion.
    const cardForDate = (date) => page.locator(`#dayCards .day-card[data-date="${date}"]`);
    await expect(cardForDate('2026-05-16')).toHaveClass(/is-best/);
    await expect(cardForDate('2026-05-16')).toHaveClass(/band-ideal/);
    await expect(cardForDate('2026-05-15')).toHaveClass(/band-red/);
    await expect(cardForDate('2026-05-17')).toHaveClass(/band-green/);
    await expect(cardForDate('2026-05-18')).toHaveClass(/band-yellow/);
  });

  test('persists zip to localStorage and reuses it on reload', async ({ page }) => {
    await mockForecast(page);
    await page.goto('/smoke-weather/');
    await expect(page.locator('#dayCards .day-card')).toHaveCount(4);

    await page.fill('#zipInput', '90210');
    await page.click('button[type="submit"]');
    await expect.poll(async () =>
      await page.evaluate(() => localStorage.getItem('pitmaster_zip'))
    ).toBe('90210');

    // Wait for the in-flight refetch triggered by submit to complete
    // before reloading; otherwise the navigation aborts the request
    // mid-flight (logs noise, can race the localStorage write on slow
    // CI runners).
    await expect(page.locator('#dayCards .day-card')).toHaveCount(4);

    await page.reload();
    await expect(page.locator('#zipInput')).toHaveValue('90210');
  });

  test('shows an inline error when /api/forecast returns 503', async ({ page }) => {
    await mockForecast(page, { error: 'weather_unavailable' }, 503);
    await page.goto('/smoke-weather/');

    const status = page.locator('#swStatus');
    await expect(status).toBeVisible();
    await expect(status).toHaveClass(/error/);
    await expect(status).toContainText('temporarily unavailable');
    await expect(page.locator('#verdictHero')).toBeHidden();
    await expect(page.locator('#dayCards .day-card')).toHaveCount(0);
  });

  test('rejects an invalid zip without hitting the network and clears prior results', async ({ page }) => {
    let calls = 0;
    await page.route('**/api/forecast**', async (route) => {
      calls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FORECAST_FIXTURE),
      });
    });
    await page.goto('/smoke-weather/');
    await expect(page.locator('#dayCards .day-card')).toHaveCount(4);
    await expect(page.locator('#verdictHero')).toBeVisible();
    const initialCalls = calls;

    await page.fill('#zipInput', '12');
    await page.click('button[type="submit"]');

    await expect(page.locator('#swStatus')).toHaveClass(/error/);
    await expect(page.locator('#swStatus')).toContainText('valid 5-digit US ZIP');
    expect(calls).toBe(initialCalls);
    // Codex review iter 1: previous forecast must be cleared so the
    // user doesn't see a validation error stacked on top of a stale
    // forecast for a different zip.
    await expect(page.locator('#dayCards .day-card')).toHaveCount(0);
    await expect(page.locator('#verdictHero')).toBeHidden();
  });

  test('drops a stale auto-load if the user submits an invalid zip first', async ({ page }) => {
    // Slow the auto-load so the invalid-zip submit lands first.
    let resolveFirst;
    const firstReady = new Promise((r) => { resolveFirst = r; });
    let calls = 0;
    await page.route('**/api/forecast**', async (route) => {
      calls += 1;
      if (calls === 1) {
        await firstReady;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FORECAST_FIXTURE),
      });
    });

    await page.goto('/smoke-weather/');
    await page.fill('#zipInput', '12');
    await page.click('button[type="submit"]');

    await expect(page.locator('#swStatus')).toContainText('valid 5-digit US ZIP');
    // Now release the slow first request — it should be aborted by
    // the invalid-zip handler, so the day cards must NOT appear.
    resolveFirst();
    await page.waitForTimeout(250);
    await expect(page.locator('#dayCards .day-card')).toHaveCount(0);
    await expect(page.locator('#swStatus')).toHaveClass(/error/);
    await expect(page.locator('#swStatus')).toContainText('valid 5-digit US ZIP');
  });

  test('an older 503 does not overwrite a newer successful render', async ({ page }) => {
    // First call (auto-load) hangs until we release it with a 503.
    // Second call (cooker change) returns 200 immediately.
    let resolveFirst;
    const firstReady = new Promise((r) => { resolveFirst = r; });
    let calls = 0;
    await page.route('**/api/forecast**', async (route) => {
      calls += 1;
      if (calls === 1) {
        await firstReady;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'weather_unavailable' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FORECAST_FIXTURE),
      });
    });

    await page.goto('/smoke-weather/');
    // Auto-load is hanging. Trigger a cooker change to start request #2.
    await page.selectOption('#cookerSelect', 'pellet');
    await expect(page.locator('#dayCards .day-card')).toHaveCount(4);
    await expect(page.locator('#swStatus')).toBeHidden();

    // Release the older 503. It must NOT clobber the newer successful
    // render with an error message.
    resolveFirst();
    await page.waitForTimeout(250);
    await expect(page.locator('#dayCards .day-card')).toHaveCount(4);
    await expect(page.locator('#swStatus')).toBeHidden();
  });
});
