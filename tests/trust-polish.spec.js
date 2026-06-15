const { test, expect } = require('@playwright/test');

// Milestone 5 — trust & polish bundle: embed attribution badge, visible
// breadcrumbs on tool pages, the brisket mentor-voice disclaimer, and the
// About brand-persona section.

test('embed mode shows a "Powered by" attribution link with a utm tag', async ({ page }) => {
  await page.goto('/brisket-calculator?embed=1');
  const credit = page.locator('.embed-attribution');
  await expect(credit).toBeVisible();
  await expect(credit).toHaveText(/Powered by pitmaster\.tools/);
  const href = await credit.getAttribute('href');
  expect(href).toContain('/brisket-calculator');
  expect(href).toContain('utm_source=embed');
});

test('non-embed pages carry no attribution badge', async ({ page }) => {
  await page.goto('/brisket-calculator');
  await expect(page.locator('.embed-attribution')).toHaveCount(0);
});

// One per page-template shape: a plain page-hero tool, a print-header tool,
// and the concise-label tool — each breadcrumb must be the first child of
// <main> and mirror that page's BreadcrumbList trail.
const TOOL_BREADCRUMBS = [
  ['/brine-calculator', 'Brine Calculator'],
  ['/brisket-calculator', 'Brisket Smoking Calculator'],
  ['/meat-per-person', 'Meat Per Person'],
];
for (const [path, name] of TOOL_BREADCRUMBS) {
  test(`breadcrumb on ${path} leads <main> and mirrors the trail`, async ({ page }) => {
    await page.goto(path);
    const bc = page.locator('nav.breadcrumb');
    await expect(bc).toBeVisible();
    // It must be the first element inside <main>, not buried elsewhere.
    // matches('nav.breadcrumb') is token-precise — 'not-breadcrumb' or
    // 'breadcrumb-wrapper' would NOT satisfy the .breadcrumb class selector.
    const firstChildIsBreadcrumb = await page.evaluate(() => {
      const main = document.querySelector('main#main-content');
      const first = main && main.firstElementChild;
      return !!first && first.matches('nav.breadcrumb');
    });
    expect(firstChildIsBreadcrumb).toBe(true);
    await expect(bc.locator('a[href="/"]')).toHaveText('Home');
    await expect(bc.locator('a[href="/tools"]')).toHaveText('All Tools');
    await expect(bc.locator('[aria-current="page"]')).toHaveText(name);
  });
}

// The "All Tools" hub is the breadcrumb root for every calculator, so it
// carries its own 2-level trail (Home → All Tools) with the hub as the
// current page rather than a link.
test('breadcrumb on /tools leads <main> and marks the hub as current', async ({ page }) => {
  await page.goto('/tools');
  const bc = page.locator('nav.breadcrumb');
  await expect(bc).toBeVisible();
  const firstChildIsBreadcrumb = await page.evaluate(() => {
    const main = document.querySelector('main#main-content');
    const first = main && main.firstElementChild;
    return !!first && first.matches('nav.breadcrumb');
  });
  expect(firstChildIsBreadcrumb).toBe(true);
  await expect(bc.locator('a[href="/"]')).toHaveText('Home');
  await expect(bc.locator('[aria-current="page"]')).toHaveText('All Tools');
});

test('breadcrumb on a metro page leads <main> and mirrors the smoke-weather trail', async ({ page }) => {
  await page.goto('/smoke-weather/new-york-ny');
  const bc = page.locator('nav.breadcrumb');
  await expect(bc).toBeVisible();
  const firstChildIsBreadcrumb = await page.evaluate(() => {
    const main = document.querySelector('main#main-content');
    const first = main && main.firstElementChild;
    return !!first && first.matches('nav.breadcrumb');
  });
  expect(firstChildIsBreadcrumb).toBe(true);
  await expect(bc.locator('a[href="/"]')).toHaveText('Home');
  await expect(bc.locator('a[href="/smoke-weather/"]')).toHaveText('Best Smoke Days');
  await expect(bc.locator('[aria-current="page"]')).toHaveText('New York, NY');
});

// The /smoke-weather/ hub is the breadcrumb root for every metro page, so it
// carries its own 2-level trail (Home → Best Smoke Days) with the hub as the
// current page rather than a link.
test('breadcrumb on /smoke-weather/ leads <main> and marks the hub as current', async ({ page }) => {
  await page.goto('/smoke-weather/');
  const bc = page.locator('nav.breadcrumb');
  await expect(bc).toBeVisible();
  const firstChildIsBreadcrumb = await page.evaluate(() => {
    const main = document.querySelector('main#main-content');
    const first = main && main.firstElementChild;
    return !!first && first.matches('nav.breadcrumb');
  });
  expect(firstChildIsBreadcrumb).toBe(true);
  await expect(bc.locator('a[href="/"]')).toHaveText('Home');
  await expect(bc.locator('[aria-current="page"]')).toHaveText('Best Smoke Days');
});

test('breadcrumb is hidden inside embeds', async ({ page }) => {
  await page.goto('/brine-calculator?embed=1');
  await expect(page.locator('nav.breadcrumb')).toBeHidden();
});

test('brisket disclaimer is mentor-voice plain language, not jargon', async ({ page }) => {
  await page.goto('/brisket-calculator');
  const note = page.locator('.model-note');
  await expect(note).toContainText('insurance policy');
  await expect(note).toContainText('probes butter-tender');
  // The old jargon must be gone from the disclaimer.
  await expect(note).not.toContainText('collagen breakdown variability');
  await expect(note).not.toContainText('meat geometry');
});

test('about page shows the brand-persona section', async ({ page }) => {
  await page.goto('/about');
  await expect(page.getByRole('heading', { name: 'Who Builds This' })).toBeVisible();
  await expect(page.locator('main')).toContainText('Pitmaster Tools crew');
});
