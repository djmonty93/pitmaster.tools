const { test, expect } = require('@playwright/test');

// Shareable cook-plan URLs (Milestone 3). Configuring the calculator mirrors
// the inputs into the query string (history.replaceState); a shared/bookmarked
// URL hydrates the inputs and renders the timeline on load. The pure
// encode/decode logic is unit-tested in scripts/plan-url.test.js — these
// specs exercise the real wiring in the browser.

test('homepage: calculating writes the plan to the URL', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#meatType', 'pork-butt-pulled');
  await page.fill('#weight', '8');
  await page.fill('#numPeople', '10');
  await page.selectOption('#smokerTemp', '250');
  await page.fill('#serveTime', '17:30');
  await page.locator('#calcBtn').click();

  await expect(page.locator('#results')).toHaveClass(/visible/);
  const params = new URLSearchParams(new URL(page.url()).search);
  expect(params.get('cut')).toBe('pork-butt-pulled');
  expect(params.get('ppl')).toBe('10');
  expect(params.get('temp')).toBe('250');
  expect(params.get('serve')).toBe('17:30');
  expect(params.get('wu')).toBeTruthy();
  // pork-butt-pulled is not two-phase, so no inapplicable sear/grill noise.
  expect(params.get('sear')).toBeNull();
  expect(params.get('grill')).toBeNull();
});

test('homepage: Copy plan link copies the current plan URL', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.selectOption('#meatType', 'spare-ribs');
  await page.fill('#numPeople', '4');
  await page.locator('#calcBtn').click();

  const btn = page.locator('#copyPlanBtn');
  await btn.click();
  await expect(btn).toHaveText('Copied!');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('cut=spare-ribs');
});

test('homepage: a shared plan URL hydrates inputs and renders the timeline on load', async ({ page }) => {
  await page.goto('/?cut=brisket-pulled&wt=14&wu=lbs&ppl=12&temp=275&ck=offset&serve=16:00&wrap=paper&bone=0&inj=1&sz=hungry&tu=F');

  await expect(page.locator('#meatType')).toHaveValue('brisket-pulled');
  await expect(page.locator('#weight')).toHaveValue('14');
  await expect(page.locator('#numPeople')).toHaveValue('12');
  await expect(page.locator('#smokerTemp')).toHaveValue('275');
  await expect(page.locator('#cookerType')).toHaveValue('offset');
  await expect(page.locator('#serveTime')).toHaveValue('16:00');
  await expect(page.locator('#wrapMethod')).toHaveValue('paper');
  await expect(page.locator('#injected')).toHaveValue('yes');
  // Timeline rendered without the user clicking anything.
  await expect(page.locator('#results')).toHaveClass(/visible/);
});

test('homepage: round trip through a fresh page yields identical inputs', async ({ page, context }) => {
  await page.goto('/');
  await page.selectOption('#meatType', 'whole-turkey');
  await page.fill('#weight', '16');
  await page.fill('#numPeople', '14');
  await page.fill('#serveTime', '13:00');
  await page.locator('#calcBtn').click();
  const url = page.url();
  expect(url).toContain('cut=whole-turkey');

  const page2 = await context.newPage();
  await page2.goto(url);
  await expect(page2.locator('#meatType')).toHaveValue('whole-turkey');
  await expect(page2.locator('#weight')).toHaveValue('16');
  await expect(page2.locator('#numPeople')).toHaveValue('14');
  await expect(page2.locator('#serveTime')).toHaveValue('13:00');
  await expect(page2.locator('#results')).toHaveClass(/visible/);
  await page2.close();
});

test('homepage: plan params and ?embed=1 coexist (embed preserved)', async ({ page }) => {
  await page.goto('/?embed=1&cut=tri-tip&wt=3&ppl=2&serve=12:00');
  await expect(page.locator('#meatType')).toHaveValue('tri-tip');
  await expect(page.locator('body')).toHaveClass(/embed-mode/);

  // Auto-calc on load re-syncs the URL through encodePlanParams, which must
  // preserve the foreign embed=1 param while writing the plan keys.
  await expect(page).toHaveURL(/[?&]embed=1(&|$)/);
  await expect(page).toHaveURL(/cut=tri-tip/);
});

test('homepage: a garbage plan URL is ignored, not applied', async ({ page }) => {
  // Unknown cut + out-of-range numbers must be dropped; the select keeps its
  // default rather than landing on a phantom value.
  await page.goto('/?cut=dragon-flank&temp=999&ppl=-5');
  await expect(page.locator('#meatType')).toHaveValue('brisket-sliced'); // default
});

test('homepage: an over-ceiling weight is rejected, not silently clamped into the URL', async ({ page }) => {
  // The calculator must refuse weights above the shareable schema max (999) so
  // a copied plan can never differ from the displayed calculation.
  await page.goto('/');
  await page.fill('#weight', '1500');
  await page.locator('#calcBtn').click();
  await expect(page.locator('#vmsg')).toContainText(/999/);
  await expect(page.locator('#results')).not.toHaveClass(/visible/);
  expect(new URL(page.url()).search).toBe(''); // nothing written
});

test('homepage: a URL wrap for a no-stall cut is ignored (control is hidden)', async ({ page }) => {
  // pork-loin has hasStall:false, so onMeatChange() hides the wrap control and
  // forces "none". A URL wrap=paper must not set a hidden field that would
  // silently change the cook time.
  await page.goto('/?cut=pork-loin&wrap=paper');
  await expect(page.locator('#meatType')).toHaveValue('pork-loin');
  await expect(page.locator('#wrapMethod').locator('xpath=ancestor::*[contains(@class,"form-group")]')).toBeHidden();
  await expect(page.locator('#wrapMethod')).toHaveValue('none');
});

test('homepage: a two-phase sear temp round-trips in metric (canonical F in URL)', async ({ page, context }) => {
  await page.goto('/');
  await page.locator('#tempToggle button[data-unit="C"]').click();
  await page.selectOption('#meatType', 'tri-tip'); // two-phase cut → sear shown
  const cVal = await page.locator('#searTemp').inputValue(); // Celsius display
  await page.locator('#calcBtn').click();

  const params = new URLSearchParams(new URL(page.url()).search);
  expect(params.get('tu')).toBe('C');
  // The URL stores canonical Fahrenheit (~500), not the ~260 Celsius display.
  expect(Number(params.get('sear'))).toBeGreaterThan(400);

  const page2 = await context.newPage();
  await page2.goto(page.url());
  await expect(page2.locator('#meatType')).toHaveValue('tri-tip');
  await expect(page2.locator('#searTemp')).toHaveValue(cVal); // same Celsius value back
  await page2.close();
});

// ── brisket-calculator (flat schema + style/thick) ──────────────────────────

test('brisket: a shared plan URL hydrates inputs and renders the timeline', async ({ page }) => {
  await page.goto('/brisket-calculator?style=pulled&wt=14&wu=lbs&temp=275&ck=offset&wrap=paper&serve=12:00&thick=2');
  await expect(page.locator('#weight')).toHaveValue('14');
  await expect(page.locator('#smokerTemp')).toHaveValue('275');
  await expect(page.locator('#cookerType')).toHaveValue('offset');
  await expect(page.locator('#serveTime')).toHaveValue('12:00');
  await expect(page.locator('#meatThickness')).toHaveValue('2');
  await expect(page.locator('.style-btn[data-style="pulled"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.wrap-toggle button[data-wrap="paper"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#results')).toHaveClass(/visible/);
});

test('brisket: calculating writes the plan to the URL', async ({ page }) => {
  await page.goto('/brisket-calculator');
  await page.fill('#weight', '10');
  await page.fill('#serveTime', '15:00');
  await page.locator('.style-btn[data-style="pulled"]').click();
  await page.locator('#calcBtn').click();

  await expect(page.locator('#results')).toHaveClass(/visible/);
  const params = new URLSearchParams(new URL(page.url()).search);
  expect(params.get('style')).toBe('pulled');
  expect(params.get('serve')).toBe('15:00');
  expect(params.get('temp')).toBeTruthy();
});

// ── cook-time-coordinator (variable-length meat list) ───────────────────────

test('coordinator: a shared plan URL hydrates the meat list and renders the schedule', async ({ page }) => {
  await page.goto('/cook-time-coordinator?serve=14:00&wu=lbs&m=brisket-sliced~12~250~paper;pork-butt-pulled~8~225~foil');
  const rows = page.locator('.meat-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.cut-sel')).toHaveValue('brisket-sliced');
  await expect(rows.nth(0).locator('.weight-inp')).toHaveValue('12');
  await expect(rows.nth(0).locator('.temp-sel')).toHaveValue('250');
  await expect(rows.nth(0).locator('.wrap-sel')).toHaveValue('paper');
  await expect(rows.nth(1).locator('.cut-sel')).toHaveValue('pork-butt-pulled');
  await expect(rows.nth(1).locator('.weight-inp')).toHaveValue('8');
  await expect(page.locator('#serveTime')).toHaveValue('14:00');
  await expect(page.locator('#results')).toHaveClass(/visible/);
});

test('coordinator: generating a schedule writes the meat list to the URL', async ({ page }) => {
  await page.goto('/cook-time-coordinator');
  await page.fill('#serveTime', '16:00');
  await page.locator('#calcBtn').click();

  await expect(page.locator('#results')).toHaveClass(/visible/);
  const params = new URLSearchParams(new URL(page.url()).search);
  expect(params.get('serve')).toBe('16:00');
  expect(params.get('m')).toBeTruthy();
  expect(params.get('m')).toContain('~');
});

test('coordinator: a 250 lb shared meat hydrates within the input constraints', async ({ page }) => {
  // The URL schema accepts up to 999 lbs; the row input must agree so a valid
  // shared weight isn't flagged :invalid by its own max attribute.
  await page.goto('/cook-time-coordinator?serve=14:00&m=spare-ribs~250~250~foil');
  const wt = page.locator('.meat-row').first().locator('.weight-inp');
  await expect(wt).toHaveValue('250');
  expect(await wt.evaluate((el) => el.checkValidity())).toBe(true);
});

test('coordinator: a slug-valid but unknown cut is dropped, valid meats survive', async ({ page }) => {
  // decodeCookPlan accepts any slug; the page must drop cuts not in D so a bad
  // URL can't create an empty-select row that crashes the auto-calc.
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/cook-time-coordinator?serve=14:00&m=brisket-sliced~12~250~paper;phantom-cut~5~250~foil');

  const rows = page.locator('.meat-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0).locator('.cut-sel')).toHaveValue('brisket-sliced');
  await expect(page.locator('#results')).toHaveClass(/visible/);
  expect(errors).toEqual([]);
});

test('coordinator: an all-unknown-cut URL falls back to default rows, no crash', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/cook-time-coordinator?serve=14:00&m=phantom-cut~5~250~foil');

  // No valid meats → default rows render, each with a real (non-empty) cut.
  const rows = page.locator('.meat-row');
  expect(await rows.count()).toBeGreaterThan(0);
  await expect(rows.first().locator('.cut-sel')).not.toHaveValue('');
  // No auto-calc (no valid hydrated meats), and nothing threw.
  await expect(page.locator('#results')).not.toHaveClass(/visible/);
  expect(errors).toEqual([]);
});
