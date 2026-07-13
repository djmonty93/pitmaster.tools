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

async function newRejectedConsentContext(browser) {
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: 'pitmaster_consent',
      value: 'rejected',
      url: 'http://127.0.0.1:4173'
    }
  ]);
  return context;
}

async function newAcceptedConsentContext(browser) {
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: 'pitmaster_consent',
      value: 'accepted',
      url: 'http://127.0.0.1:4173'
    }
  ]);
  return context;
}

async function getThirdPartyScriptCounts(page) {
  return page.evaluate(() => ({
    ga: Array.from(document.scripts).filter((script) => (script.src || '').includes('googletagmanager.com/gtag/js')).length,
    ads: Array.from(document.scripts).filter((script) => (script.src || '').includes('pagead2.googlesyndication.com/pagead/js/adsbygoogle.js')).length
  }));
}

async function expectMeaningfulText(locator) {
  const text = ((await locator.textContent()) || '').replace(/\s+/g, ' ').trim();
  expect(text).not.toBe('');
  expect(text).not.toMatch(/^[—-]+$/);
  expect(text).not.toMatch(/\b(?:NaN|Infinity|undefined|null)\b/i);
  return text;
}

async function dismissCookieBanner(page) {
  const reject = page.locator('#cookieReject');
  if (await reject.isVisible()) {
    await reject.click();
  }
}

async function openHomepageAdvancedSettings(page) {
  const details = page.locator('#advancedSettings');
  if (!(await details.evaluate((element) => element.open))) {
    await details.locator('summary').click();
  }
}

async function getTimelineLabels(page, containerSelector) {
  return (await page.locator(`${containerSelector} .tl-label`).allTextContents())
    .map((text) => text.replace(/\s+/g, ' ').trim());
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
  await expect(trigger).toBeFocused();

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
  await expect(page.getByRole('group', { name: /temperature unit/i })).not.toBeVisible();
  await expect(page.getByRole('group', { name: /weight unit/i })).not.toBeVisible();

  await page.locator('.menu-toggle').click();
  await expect(page.locator('.header-nav')).toBeVisible();
  await expect(page.getByRole('group', { name: /temperature unit/i })).toBeVisible();
  await expect(page.getByRole('group', { name: /weight unit/i })).toBeVisible();
  const trigger = page.locator('.nav-dropdown__trigger').first();
  await trigger.click();
  await expect(page.locator('.nav-dropdown__menu').getByRole('link', { name: 'All Tools' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.menu-toggle')).toBeFocused();
  await expect(page.locator('.menu-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.header-nav')).not.toBeVisible();

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

test('accepted consent loads each third-party script once', async ({ browser }) => {
  const context = await newAcceptedConsentContext(browser);
  const page = await context.newPage();
  const errors = [];
  trackPageErrors(page, errors);

  await page.goto('/');
  await expect.poll(async () => (await getThirdPartyScriptCounts(page)).ga).toBe(1);
  await expect.poll(async () => (await getThirdPartyScriptCounts(page)).ads).toBe(1);
  expect(errors).toEqual([]);

  await context.close();
});

test('no-consent visitor keeps the cold path first-party only', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  trackPageErrors(page, errors);

  await page.goto('/');
  await expect(page.locator('#cookieBanner.visible')).toBeVisible();
  expect(await getThirdPartyScriptCounts(page)).toEqual({ ga: 0, ads: 0 });
  expect(errors).toEqual([]);

  await context.close();
});

test('accepting consent upgrades the current page and stores the choice', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route(/^https:\/\//, (route) => route.abort());

  await page.goto('/');
  await expect(page.locator('#cookieBanner.visible')).toBeVisible();
  expect(await getThirdPartyScriptCounts(page)).toEqual({ ga: 0, ads: 0 });

  await page.locator('#cookieAccept').click();

  await expect(page.locator('#cookieBanner')).not.toBeVisible();
  await expect.poll(async () => getThirdPartyScriptCounts(page)).toEqual({ ga: 1, ads: 1 });
  const consentCookie = (await context.cookies()).find((cookie) => cookie.name === 'pitmaster_consent');
  expect(consentCookie?.value).toBe('accepted');

  await context.close();
});

test('mobile pages have no horizontal overflow and keep the primary task in view', async ({ browser }) => {
  const context = await newRejectedConsentContext(browser);
  const page = await context.newPage();

  for (const viewport of [{ width: 320, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const path of ['/', '/brisket-calculator', '/smoke-weather/', '/tools']) {
      await page.goto(path);
      const widths = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        content: document.documentElement.scrollWidth
      }));
      expect(widths.content, `${path} should not overflow at ${viewport.width}px`).toBe(widths.viewport);
    }

    await page.goto('/');
    const calculatorTop = await page.locator('#calculator').evaluate((el) => el.getBoundingClientRect().top);
    expect(calculatorTop, `calculator should be visible at ${viewport.width}px`).toBeLessThan(viewport.height);
  }
  await context.close();
});

test('mobile consent panel stays compact', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#cookieBanner.visible')).toBeVisible();
  const height = await page.locator('.cookie-banner__inner').evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBeLessThanOrEqual(220);
});

test('homepage upgrades the static Best Smoke Days gauge with live metro data', async ({ page }) => {
  await page.route('**/api/metros', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: '2026-07-13T04:00:00.000Z',
        etDate: '2026-07-13',
        metros: [
          { slug: 'austin-tx', name: 'Austin', state: 'TX', todayScore: 91, todayBand: 'ideal' },
          { slug: 'denver-co', name: 'Denver', state: 'CO', todayScore: 84, todayBand: 'green' }
        ]
      })
    });
  });

  await page.goto('/');

  const gauge = page.locator('#heroGauge');
  await expect(gauge).toHaveClass(/hero-gauge--live/);
  await expect(gauge.locator('.hero-gauge__cell')).toHaveCount(2);
  await expect(gauge.getByRole('link', { name: /Austin, TX/ })).toHaveAttribute('href', '/smoke-weather/austin-tx');
  await expect(gauge.getByText(/91\/100.*Ideal/)).toBeVisible();
  await expect(page.locator('#heroGaugeCaption')).toContainText(/Today.s top 2 smoke cities/);
});

test('homepage cold-load output stays within the frontend budget', async ({ page }) => {
  await page.addInitScript(() => {
    window.__frontendPerformance = { lcp: 0, cls: 0 };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__frontendPerformance.lcp = Math.max(window.__frontendPerformance.lcp, entry.startTime);
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) window.__frontendPerformance.cls += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  const thirdPartyRequests = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4173')) thirdPartyRequests.push(request.url());
  });
  const response = await page.goto('/');
  await page.waitForTimeout(500);
  const documentBytes = (await response.body()).byteLength;
  const metrics = await page.evaluate(() => ({
    domNodes: document.getElementsByTagName('*').length,
    inlineScriptBytes: Array.from(document.scripts).reduce((sum, el) => sum + (el.textContent || '').length, 0),
    inlineStyleBytes: Array.from(document.querySelectorAll('style')).reduce((sum, el) => sum + (el.textContent || '').length, 0),
    resourceTransferBytes: performance.getEntriesByType('resource')
      .reduce((sum, entry) => sum + (entry.transferSize || entry.encodedBodySize || 0), 0),
    lcp: window.__frontendPerformance.lcp,
    cls: window.__frontendPerformance.cls
  }));

  expect(documentBytes).toBeLessThanOrEqual(200000);
  expect(metrics.domNodes).toBeLessThanOrEqual(700);
  expect(metrics.inlineScriptBytes).toBeLessThanOrEqual(100000);
  expect(metrics.inlineStyleBytes).toBeLessThanOrEqual(45000);
  expect(metrics.resourceTransferBytes).toBeLessThanOrEqual(150000);
  expect(metrics.lcp).toBeGreaterThan(0);
  expect(metrics.lcp).toBeLessThanOrEqual(2500);
  expect(metrics.cls).toBeLessThanOrEqual(0.1);
  expect(thirdPartyRequests).toEqual([]);
});

test('embed mode never loads third-party scripts even with accepted consent', async ({ browser }) => {
  const context = await newAcceptedConsentContext(browser);
  const page = await context.newPage();
  const errors = [];
  trackPageErrors(page, errors);

  await page.goto('/?embed=1');
  await expect(page.locator('body')).toHaveClass(/embed-mode/);
  await expect(page.locator('#cookieBanner')).not.toBeVisible();
  expect(await getThirdPartyScriptCounts(page)).toEqual({ ga: 0, ads: 0 });
  expect(errors).toEqual([]);

  await context.close();
});

test('og image asset is published', async ({ request }) => {
  const response = await request.get('http://127.0.0.1:4173/og-image.png');
  expect(response.ok()).toBeTruthy();
  expect(response.headers()['content-type']).toContain('image/png');
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

test('homepage results modal traps keyboard focus', async ({ page }) => {
  const errors = [];
  trackPageErrors(page, errors);

  await page.goto('/');
  await page.locator('#meatType').selectOption('brisket-sliced');
  await page.locator('#weight').fill('12');
  await page.locator('#serveTime').fill('18:00');
  await page.locator('#calcBtn').click();
  await expect(page.locator('#results')).toBeVisible();

  const initialState = await page.evaluate(() => {
    const modal = document.querySelector('.results-modal');
    const selector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusable = Array.from(modal.querySelectorAll(selector));
    focusable[focusable.length - 1].focus();
    return { count: focusable.length };
  });
  expect(initialState.count).toBeGreaterThan(1);

  await page.keyboard.press('Tab');
  const afterTab = await page.evaluate(() => {
    const modal = document.querySelector('.results-modal');
    const selector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusable = Array.from(modal.querySelectorAll(selector));
    return {
      activeIndex: focusable.indexOf(document.activeElement),
      count: focusable.length,
      inside: !!document.activeElement.closest('.results-modal')
    };
  });
  expect(afterTab.inside).toBe(true);
  expect(afterTab.activeIndex).toBe(0);

  await page.evaluate(() => {
    const modal = document.querySelector('.results-modal');
    const selector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusable = Array.from(modal.querySelectorAll(selector));
    focusable[0].focus();
  });
  await page.keyboard.press('Shift+Tab');
  const afterShiftTab = await page.evaluate(() => {
    const modal = document.querySelector('.results-modal');
    const selector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusable = Array.from(modal.querySelectorAll(selector));
    return {
      activeIndex: focusable.indexOf(document.activeElement),
      count: focusable.length,
      inside: !!document.activeElement.closest('.results-modal')
    };
  });
  expect(afterShiftTab.inside).toBe(true);
  expect(afterShiftTab.activeIndex).toBe(afterShiftTab.count - 1);
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

test('brisket timeline distinguishes wrapped and unwrapped stall events', async ({ page }) => {
  const errors = [];
  trackPageErrors(page, errors);

  await page.goto('/brisket-calculator.html');
  await dismissCookieBanner(page);
  await page.locator('#weight').fill('12');
  await page.locator('#serveTime').fill('18:00');
  await page.locator('#calcBtn').click();
  await expect(page.locator('#results')).toBeVisible();

  let labels = await getTimelineLabels(page, '#tlList');
  expect(labels).toContain('Stall — wrap now');
  expect(labels).not.toContain('Stall ends');
  await expect(page.locator('#tlList .tl-item')).toHaveCount(5);
  await expect(page.locator('#tlList .tl-item').filter({ hasText: 'Stall — wrap now' }).locator('.tl-sub'))
    .toContainText(/leave wrapped until pull temp/i);

  await page.locator('#resultsClose').click();
  await page.locator('.wrap-toggle button[data-wrap="none"]').click();
  await page.locator('#calcBtn').click();
  await expect(page.locator('#results')).toBeVisible();

  labels = await getTimelineLabels(page, '#tlList');
  expect(labels).toContain('Stall begins');
  expect(labels).toContain('Stall ends');
  expect(labels).not.toContain('Stall — wrap now');
  await expect(page.locator('#tlList .tl-item')).toHaveCount(6);
  await expect(page.locator('#tlList .tl-item').filter({ hasText: 'Stall begins' }).locator('.tl-sub'))
    .toContainText(/hold steady — no wrap/i);
  expect(errors).toEqual([]);
});

test('homepage keeps physics-backed control states honest', async ({ page }) => {
  const errors = [];
  trackPageErrors(page, errors);

  await page.goto('/');
  await openHomepageAdvancedSettings(page);

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
  await openHomepageAdvancedSettings(page);
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

test('homepage timeline distinguishes wrapped and unwrapped stall events', async ({ page }) => {
  const errors = [];
  trackPageErrors(page, errors);

  await page.goto('/');
  await dismissCookieBanner(page);
  await openHomepageAdvancedSettings(page);
  await page.locator('#meatType').selectOption('brisket-sliced');
  await page.locator('#weight').fill('12');
  await page.locator('#serveTime').fill('18:00');
  await page.locator('#calcBtn').click();
  await expect(page.locator('#results')).toBeVisible();

  let labels = await getTimelineLabels(page, '#tlEl');
  expect(labels).toContain('Stall — wrap now');
  expect(labels).not.toContain('Stall ends');
  await expect(page.locator('#tlEl .tl-item')).toHaveCount(5);
  await expect(page.locator('#tlEl .tl-item').filter({ hasText: 'Stall — wrap now' }).locator('.tl-sub'))
    .toContainText(/leave wrapped until pull temp/i);

  await page.locator('#closeResultsBtn').click();
  await page.locator('#wrapMethod').selectOption('none');
  await page.locator('#calcBtn').click();
  await expect(page.locator('#results')).toBeVisible();

  labels = await getTimelineLabels(page, '#tlEl');
  expect(labels).toContain('Stall begins');
  expect(labels).toContain('Stall ends');
  expect(labels).not.toContain('Stall — wrap now');
  await expect(page.locator('#tlEl .tl-item')).toHaveCount(6);
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

test('pork shoulder timeline distinguishes wrapped and unwrapped stall events', async ({ page }) => {
  const errors = [];
  trackPageErrors(page, errors);

  await page.goto('/pork-shoulder-calculator.html');
  await dismissCookieBanner(page);
  await page.locator('#weight').fill('8');
  await page.locator('#serveTime').fill('18:00');
  await page.locator('#calcBtn').click();
  await expect(page.locator('#results')).toBeVisible();

  let labels = await getTimelineLabels(page, '#tlList');
  expect(labels).toContain('Stall — wrap now');
  expect(labels).not.toContain('Stall ends');
  await expect(page.locator('#tlList .tl-item')).toHaveCount(5);
  await expect(page.locator('#tlList .tl-item').filter({ hasText: 'Stall — wrap now' }).locator('.tl-sub'))
    .toContainText(/leave wrapped until pull temp/i);

  await page.locator('#resultsClose').click();
  await page.locator('#wrapToggle button[data-wrap="none"]').click();
  await page.locator('#calcBtn').click();
  await expect(page.locator('#results')).toBeVisible();

  labels = await getTimelineLabels(page, '#tlList');
  expect(labels).toContain('Stall begins');
  expect(labels).toContain('Stall ends');
  expect(labels).not.toContain('Stall — wrap now');
  await expect(page.locator('#tlList .tl-item')).toHaveCount(6);
  await expect(page.locator('#tlList .tl-item').filter({ hasText: 'Stall begins' }).locator('.tl-sub'))
    .toContainText(/no wrap — full bark development/i);
  expect(errors).toEqual([]);
});

test('each calculator produces meaningful result values', async ({ browser }) => {
  const context = await newRejectedConsentContext(browser);
  const page = await context.newPage();
  const errors = [];
  trackPageErrors(page, errors);

  const calculators = [
    {
      name: 'homepage',
      path: '/',
      validate: async () => {
        await page.locator('#calcBtn').click();
        await expect(page.locator('#results')).toBeVisible();
        await expectMeaningfulText(page.locator('#sCookTime'));
        await expectMeaningfulText(page.locator('#sPullTemp'));
        expect(await page.locator('#tlEl .tl-item').count()).toBeGreaterThan(0);
      }
    },
    {
      name: 'bbq cost calculator',
      path: '/bbq-cost-calculator.html',
      validate: async () => {
        await page.locator('#pricePerUnit').fill('6.00');
        await page.locator('#calcBtn').click();
        await expect(page.locator('#results')).toBeVisible();
        await expectMeaningfulText(page.locator('#sTotalCost'));
        await expectMeaningfulText(page.locator('#sCostPerServing'));
        await expectMeaningfulText(page.locator('#sCostPerLb'));
        await expectMeaningfulText(page.locator('#sServingsAvail'));
        expect(await page.locator('#breakdownBody tr').count()).toBeGreaterThan(0);
      }
    },
    {
      name: 'brine calculator',
      path: '/brine-calculator.html',
      validate: async () => {
        await page.locator('#calcBtn').click();
        await expect(page.locator('#results')).toBeVisible();
        await expectMeaningfulText(page.locator('#sc1Value'));
        await expectMeaningfulText(page.locator('#scSalt'));
        await expectMeaningfulText(page.locator('#sc3Value'));
        await expectMeaningfulText(page.locator('#timeBadge'));
        expect(await page.locator('#detailRows .detail-row').count()).toBeGreaterThan(0);
      }
    },
    {
      name: 'brisket calculator',
      path: '/brisket-calculator.html',
      validate: async () => {
        await page.locator('#calcBtn').click();
        await expect(page.locator('#results')).toBeVisible();
        await expectMeaningfulText(page.locator('#sCookTime'));
        await expectMeaningfulText(page.locator('#sPullTemp'));
        expect(await page.locator('#tlList .tl-item').count()).toBeGreaterThan(0);
      }
    },
    {
      name: 'brisket yield calculator',
      path: '/brisket-yield-calculator.html',
      validate: async () => {
        await page.locator('#calcBtn').click();
        await expect(page.locator('#results')).toBeVisible();
        await expectMeaningfulText(page.locator('#rFlat'));
        await expectMeaningfulText(page.locator('#rYield195'));
        await expectMeaningfulText(page.locator('#rYield203'));
        await expectMeaningfulText(page.locator('#shrinkSummary'));
      }
    },
    {
      name: 'catering calculator',
      path: '/catering-calculator.html',
      validate: async () => {
        await page.locator('#calcBtn').click();
        await expect(page.locator('#results')).toBeVisible();
        expect(await page.locator('#meatCards .meat-card').count()).toBeGreaterThan(0);
        expect(await page.locator('#summaryGrid .sum-item').count()).toBeGreaterThan(0);
        await expectMeaningfulText(page.locator('#summaryGrid .sum-item .sum-value').first());
      }
    },
    {
      name: 'charcoal calculator',
      path: '/charcoal-calculator.html',
      validate: async () => {
        await page.locator('#calcBtn').click();
        await expect(page.locator('#results')).toBeVisible();
        await expectMeaningfulText(page.locator('#scTotal'));
        await expectMeaningfulText(page.locator('#scLit'));
        await expectMeaningfulText(page.locator('#scTopup'));
        expect(await page.locator('#tipsList li').count()).toBeGreaterThan(0);
      }
    },
    {
      name: 'cook time coordinator',
      path: '/cook-time-coordinator.html',
      validate: async () => {
        await page.locator('#calcBtn').click();
        await expect(page.locator('#results')).toBeVisible();
        expect(await page.locator('#ganttRows .gantt-row').count()).toBeGreaterThan(0);
        expect(await page.locator('#scheduleGrid .schedule-card').count()).toBeGreaterThan(0);
        await expectMeaningfulText(page.locator('#scheduleGrid .schedule-card__hrs').first());
      }
    },
    {
      name: 'dry rub calculator',
      path: '/dry-rub-calculator.html',
      validate: async () => {
        await page.locator('#calcBtn').click();
        await expect(page.locator('#results')).toBeVisible();
        await expectMeaningfulText(page.locator('#statTotal'));
        await expectMeaningfulText(page.locator('#statCoverage'));
        await expectMeaningfulText(page.locator('#statIngredients'));
        expect(await page.locator('#rubTableBody tr').count()).toBeGreaterThan(0);
      }
    },
    {
      name: 'meat per person calculator',
      path: '/meat-per-person.html',
      validate: async () => {
        await page.locator('#calcBtn').click();
        await expect(page.locator('#results')).toBeVisible();
        await expectMeaningfulText(page.locator('#statRaw'));
        await expectMeaningfulText(page.locator('#statCooked'));
        await expectMeaningfulText(page.locator('#statShrink'));
        expect(await page.locator('#detailRows .srow').count()).toBeGreaterThan(0);
      }
    },
    {
      name: 'pork shoulder calculator',
      path: '/pork-shoulder-calculator.html',
      validate: async () => {
        await page.locator('#calcBtn').click();
        await expect(page.locator('#results')).toBeVisible();
        await expectMeaningfulText(page.locator('#statCookTime'));
        await expectMeaningfulText(page.locator('#statPullTemp'));
        expect(await page.locator('#tlList .tl-item').count()).toBeGreaterThan(0);
      }
    },
    {
      name: 'rib calculator',
      path: '/rib-calculator.html',
      validate: async () => {
        await page.locator('#calcBtn').click();
        await expect(page.locator('#results')).toBeVisible();
        await expectMeaningfulText(page.locator('#sCookTime'));
        await expectMeaningfulText(page.locator('#sPullTemp'));
        expect(await page.locator('#tlEl .tl-item').count()).toBeGreaterThan(0);
      }
    },
    {
      name: 'turkey calculator',
      path: '/turkey-smoking-calculator.html',
      validate: async () => {
        await page.locator('#calcBtn').click();
        await expect(page.locator('#results')).toBeVisible();
        await expectMeaningfulText(page.locator('#sCookTime'));
        await expectMeaningfulText(page.locator('#sPullTemp'));
        expect(await page.locator('#tlList .tl-item').count()).toBeGreaterThan(0);
      }
    }
  ];

  for (const calculator of calculators) {
    await page.goto(calculator.path);
    await calculator.validate();
  }

  expect(errors).toEqual([]);
  await context.close();
});
