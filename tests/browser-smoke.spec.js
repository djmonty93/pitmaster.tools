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
