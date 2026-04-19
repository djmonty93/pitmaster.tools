const { test, expect } = require('@playwright/test');

function trackPageErrors(page, bucket) {
  page.on('pageerror', (error) => {
    bucket.push(error.message);
  });
}

function parseDurationText(text) {
  const hours = text.match(/(\d+)h/);
  const minutes = text.match(/(\d+)m/);
  return (hours ? parseInt(hours[1], 10) * 60 : 0) + (minutes ? parseInt(minutes[1], 10) : 0);
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

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/rib-calculator.html');
  await expect(page.getByRole('heading', { level: 1, name: /rib smoking calculator/i })).toBeVisible();
  await expect(page.locator('.menu-toggle')).toBeVisible();
  await expect(page.getByRole('group', { name: /temperature unit/i })).toBeVisible();
  await expect(page.getByRole('group', { name: /weight unit/i })).toBeVisible();

  await page.locator('.menu-toggle').click();
  await expect(page.locator('.header-nav')).toBeVisible();
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

test('pork shoulder live resolve recalculates without throwing', async ({ page }) => {
  const errors = [];
  trackPageErrors(page, errors);

  await page.goto('/pork-shoulder-calculator.html');
  await page.locator('#weight').fill('8');
  await page.locator('#serveTime').fill('18:00');
  await page.locator('#calcBtn').click();

  await expect(page.locator('#results')).toBeVisible();
  await page.locator('#currentTemp').fill('160');
  await page.getByRole('button', { name: /^recalculate$/i }).click();

  await expect(page.locator('#resolveResult')).toContainText(/remaining/i);
  expect(errors).toEqual([]);
});

test('wrapped brisket re-solve stays usable inside the stall band', async ({ page }) => {
  const errors = [];
  trackPageErrors(page, errors);

  await page.goto('/brisket-calculator.html');

  const result = await page.evaluate(() => spResolve({
      kmKey: 'brisket-packer',
      weightLbs: 12,
      thicknessIn: 0,
      pitF: 250,
      rh: 4,
      currentF: 155,
      tfF: 195,
      hasStall: true,
      wrapMethod: 'foil',
      wrapTriggerF: 150
    }));

  expect(result.error).toBeNull();
  expect(result.remainingH).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('homepage keeps physics-backed control states honest', async ({ page }) => {
  const errors = [];
  trackPageErrors(page, errors);

  await page.goto('/');

  await page.locator('#meatType').selectOption('whole-turkey');
  await expect(page.locator('#wrapMethod')).not.toBeVisible();

  await page.locator('#meatType').selectOption('pork-butt-pulled');
  await expect(page.locator('#wrapMethod')).toBeVisible();

  await page.locator('#weight').fill('8');
  await page.locator('#serveTime').fill('18:00');
  await page.locator('#boneIn').selectOption('no');
  await page.locator('#injected').selectOption('no');
  await page.locator('#calcBtn').click();
  await expect(page.locator('#results')).toBeVisible();
  const baselineCookTime = await page.locator('#sCookTime').textContent();

  await page.locator('#closeResultsBtn').click();
  await page.locator('#boneIn').selectOption('yes');
  await page.locator('#calcBtn').click();
  await expect(page.locator('#results')).toBeVisible();
  const boneInCookTime = await page.locator('#sCookTime').textContent();

  expect(boneInCookTime).not.toBe(baselineCookTime);
  expect(errors).toEqual([]);
});

test('homepage live resolve reflects bone-in scaling for physics-backed cuts', async ({ page }) => {
  const errors = [];
  trackPageErrors(page, errors);

  await page.goto('/');
  await page.locator('#meatType').selectOption('pork-butt-pulled');
  await page.locator('#weight').fill('8');
  await page.locator('#serveTime').fill('18:00');
  await page.locator('#boneIn').selectOption('no');
  await page.locator('#calcBtn').click();
  await expect(page.locator('#results')).toBeVisible();
  await page.locator('#currentTemp').fill('160');
  await page.getByRole('button', { name: /^recalculate$/i }).click();
  const bonelessRemaining = parseDurationText(await page.locator('#resolveResult').textContent());

  await page.locator('#closeResultsBtn').click();
  await page.locator('#boneIn').selectOption('yes');
  await page.locator('#calcBtn').click();
  await expect(page.locator('#results')).toBeVisible();
  await page.locator('#currentTemp').fill('160');
  await page.getByRole('button', { name: /^recalculate$/i }).click();
  const boneInRemaining = parseDurationText(await page.locator('#resolveResult').textContent());

  expect(boneInRemaining).toBeGreaterThan(bonelessRemaining);
  expect(errors).toEqual([]);
});

test('pork shoulder live resolve reflects the bone-in modifier', async ({ page }) => {
  const errors = [];
  trackPageErrors(page, errors);

  await page.goto('/pork-shoulder-calculator.html');
  if (await page.locator('#cookieReject').isVisible()) {
    await page.locator('#cookieReject').click();
  }
  await page.locator('#weight').fill('8');
  await page.locator('#serveTime').fill('18:00');
  await page.locator('#boneIn').uncheck();
  await page.locator('#calcBtn').click();
  await expect(page.locator('#results')).toBeVisible();
  await page.locator('#currentTemp').fill('160');
  await page.getByRole('button', { name: /^recalculate$/i }).click();
  const bonelessRemaining = parseDurationText(await page.locator('#resolveResult').textContent());

  await page.locator('#editBtn').click();
  await page.locator('#boneIn').check();
  await page.locator('#calcBtn').click();
  await expect(page.locator('#results')).toBeVisible();
  await page.locator('#currentTemp').fill('160');
  await page.getByRole('button', { name: /^recalculate$/i }).click();
  const boneInRemaining = parseDurationText(await page.locator('#resolveResult').textContent());

  expect(boneInRemaining).toBeGreaterThan(bonelessRemaining);
  expect(errors).toEqual([]);
});
