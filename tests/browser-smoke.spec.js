const { test, expect } = require('@playwright/test');

function trackPageErrors(page, bucket) {
  page.on('pageerror', (error) => {
    bucket.push(error.message);
  });
}

test('homepage loads, nav opens, and calculator shows results', async ({ page }) => {
  const errors = [];
  trackPageErrors(page, errors);

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: /meat smoking calculator/i })).toBeVisible();

  const trigger = page.locator('.nav-dropdown__trigger').first();
  await trigger.click();
  await expect(page.locator('.nav-dropdown__menu').getByRole('link', { name: 'All Tools' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.locator('#meatType').selectOption('brisket-sliced');
  await page.locator('#weight').fill('12');
  await page.locator('#serveTime').fill('18:00');
  await page.locator('#calcBtn').click();

  await expect(page.locator('#results')).toBeVisible();
  await expect(page.locator('#ptitle')).toContainText(/brisket/i);
  expect(errors).toEqual([]);
});

test('tools page loads, nav opens, and rejected consent path stays clean', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: 'pitmaster_consent',
      value: 'rejected',
      url: 'http://127.0.0.1:4173'
    }
  ]);
  const page = await context.newPage();
  const errors = [];
  trackPageErrors(page, errors);

  await page.goto('/tools.html');
  await expect(page.getByRole('heading', { level: 1, name: /all bbq calculators/i })).toBeVisible();

  const trigger = page.locator('.nav-dropdown__trigger').first();
  await trigger.click();
  await expect(page.locator('.nav-dropdown__menu').getByRole('link', { name: 'Brisket Calculator' })).toBeVisible();
  await page.keyboard.press('Escape');

  await expect(page.getByRole('link', { name: 'Open Calculator' }).first()).toBeVisible();
  expect(errors).toEqual([]);

  await context.close();
});
