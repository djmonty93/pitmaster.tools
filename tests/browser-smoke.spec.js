const { test, expect } = require('@playwright/test');

function trackPageErrors(page, bucket) {
  page.on('pageerror', (error) => {
    bucket.push(error.message);
  });
}

async function installCookieWriteTracker(context) {
  await context.addInitScript(() => {
    const writes = [];
    const proto = window.Document && Document.prototype;
    const cookieDescriptor = proto && Object.getOwnPropertyDescriptor(proto, 'cookie');

    if (!cookieDescriptor || !cookieDescriptor.get || !cookieDescriptor.set) {
      window.__cookieWrites = writes;
      return;
    }

    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get() {
        return cookieDescriptor.get.call(document);
      },
      set(value) {
        writes.push(String(value));
        window.__cookieWrites = writes.slice();
        return cookieDescriptor.set.call(document, value);
      }
    });

    window.__cookieWrites = writes;
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

test('rib calculator loads with working navigation and responsive header controls', async ({ page }) => {
  const errors = [];
  trackPageErrors(page, errors);

  await page.goto('/rib-calculator.html');
  await expect(page.getByRole('heading', { level: 1, name: /rib smoking calculator/i })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tools' })).toBeVisible();
  await expect(page.getByRole('group', { name: /temperature unit/i })).toBeVisible();
  await expect(page.getByRole('group', { name: /weight unit/i })).toBeVisible();

  const trigger = page.locator('.nav-dropdown__trigger').first();
  await trigger.click();
  await expect(page.locator('.nav-dropdown__menu').getByRole('link', { name: 'All Tools' })).toBeVisible();
  await page.keyboard.press('Escape');

  expect(errors).toEqual([]);
});

test('embed homepage stays banner-free without attempting a consent write', async ({ browser }) => {
  const context = await browser.newContext();
  await installCookieWriteTracker(context);

  const page = await context.newPage();
  const errors = [];
  trackPageErrors(page, errors);

  await page.goto('/?embed=1');
  await expect(page.locator('body')).toHaveClass(/embed-mode/);
  await expect(page.locator('#cookieBanner')).not.toBeVisible();

  const cookieWrites = await page.evaluate(() => window.__cookieWrites || []);
  expect(cookieWrites.filter((value) => value.includes('pitmaster_consent'))).toEqual([]);

  await page.goto('/');
  await expect(page.locator('#cookieBanner.visible')).toBeVisible();
  expect(errors).toEqual([]);

  await context.close();
});

test('embed brisket flow keeps modal controls visible', async ({ page }) => {
  const errors = [];
  trackPageErrors(page, errors);

  await page.goto('/brisket-calculator.html?embed=1');
  await expect(page.locator('body')).toHaveClass(/embed-mode/);

  await page.locator('#weight').fill('12');
  await page.locator('#serveTime').fill('18:00');
  await page.locator('#calcBtn').click();

  await expect(page.locator('#results')).toBeVisible();
  await expect(page.locator('#resultsClose')).toBeVisible();
  await expect(page.locator('#printBtn')).toBeVisible();
  expect(errors).toEqual([]);
});
