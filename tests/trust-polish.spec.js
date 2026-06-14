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

test('tool pages show a visible breadcrumb mirroring the JSON-LD trail', async ({ page }) => {
  await page.goto('/brine-calculator');
  const bc = page.locator('nav.breadcrumb');
  await expect(bc).toBeVisible();
  await expect(bc.locator('a[href="/"]')).toHaveText('Home');
  await expect(bc.locator('a[href="/tools"]')).toHaveText('All Tools');
  await expect(bc.locator('[aria-current="page"]')).toHaveText('Brine Calculator');
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
