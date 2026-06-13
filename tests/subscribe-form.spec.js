const { test, expect } = require('@playwright/test');

// Weekly-forecast email capture form (Milestone 2).
//
// The form is a progressive enhancement over the already-built
// POST /api/subscribe backend. These specs NEVER hit Sender.net — every
// case that expects a network call stubs /api/subscribe via page.route,
// and the no-request cases assert the stub was never invoked.
//
// DOM contract (must stay in sync with _partials/subscribe-form.html):
//   form#subscribeForm.subscribe-form[method=post][action="/api/subscribe"]
//     input#subEmail[name=email][type=email]
//     input#subZip[name=zip][inputmode=numeric][maxlength=5]
//     button.subscribe-form__btn[type=submit]   (ships disabled; JS enables)
//     div.subscribe-form__hp[inert]             (honeypot wrapper)
//       input#subHp[name=subscribe_hp][tabindex=-1][autocomplete=off]
//     p#subStatus[role=status][aria-live=polite]
//     p#subSuccess[role=status][aria-live=polite] (empty until success)
//     a[href="/privacy-policy"]                  (privacy note)
//   On success the form gains .is-success and #subSuccess becomes visible.

// One page per wired surface: homepage (largest inline-script payload,
// distinct injection order), the smoke-weather landing, and a metro page.
const PAGES = ['/', '/smoke-weather/', '/smoke-weather/kansas-city-mo'];

// Stub /api/subscribe and record every request that reaches it so the
// "no request on invalid input" cases can assert zero calls.
async function stubSubscribe(page, { status = 202, body } = {}) {
  const calls = [];
  await page.route('**/api/subscribe', async (route) => {
    calls.push(route.request().postDataJSON());
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(
        body ??
          (status === 202
            ? { status: 'sent', email: 'pit@example.com', region: 'midwest', timezone: 'America/Chicago', espId: '42', token: 't' }
            : { error: 'sender_rejected', message: 'Sender rejected the subscription request' })
      ),
    });
  });
  return calls;
}

for (const path of PAGES) {
  test(`subscribe form renders on ${path}`, async ({ page }) => {
    await page.goto(path);
    const form = page.locator('#subscribeForm');
    await expect(form).toBeVisible();
    await expect(form.locator('input[name="email"]')).toBeVisible();
    await expect(form.locator('input[name="zip"]')).toBeVisible();
    await expect(form.locator('button[type="submit"]')).toBeVisible();
    // Privacy note links the policy.
    await expect(form.locator('a[href="/privacy-policy"]')).toHaveCount(1);
    // aria-live status region present for screen-reader feedback.
    await expect(page.locator('#subStatus')).toHaveAttribute('aria-live', 'polite');
  });
}

test('invalid email/zip shows inline error and fires no request', async ({ page }) => {
  const calls = await stubSubscribe(page);
  await page.goto('/smoke-weather/');

  await page.fill('#subEmail', 'not-an-email');
  await page.fill('#subZip', '123'); // too short
  await page.locator('#subscribeForm button[type="submit"]').click();

  await expect(page.locator('#subStatus')).not.toBeEmpty();
  await expect(page.locator('#subscribeForm')).not.toHaveClass(/is-success/);
  // Give any erroneous fetch a beat to land, then assert none happened.
  await page.waitForTimeout(150);
  expect(calls).toHaveLength(0);
});

// Runs on the homepage AND the smoke-weather landing: the two surfaces
// inject subscribe-form.js in a different order relative to other scripts,
// so exercising the full submit path on both catches injection-order or
// ID-collision regressions the render check alone would miss.
for (const path of ['/', '/smoke-weather/']) {
  test(`valid submit on ${path} POSTs normalized JSON and shows success state`, async ({ page }) => {
    const calls = await stubSubscribe(page, { status: 202 });
    await page.goto(path);

    // Mixed-case + surrounding space must be normalized client-side to match
    // the server's zod preprocess (trim + lowercase).
    await page.fill('#subEmail', '  Pit@Example.COM  ');
    await page.fill('#subZip', '64108');
    await page.locator('#subscribeForm button[type="submit"]').click();

    await expect(page.locator('#subscribeForm')).toHaveClass(/is-success/);
    await expect(page.locator('#subSuccess')).toBeVisible();

    expect(calls).toHaveLength(1);
    expect(calls[0].email).toBe('pit@example.com');
    expect(calls[0].zip).toBe('64108');
    expect(typeof calls[0].timezone).toBe('string');
    expect(calls[0].timezone.length).toBeGreaterThan(0);
  });
}

test('submit button is enabled by JS after enhancement', async ({ page }) => {
  await page.goto('/smoke-weather/');
  await expect(page.locator('#subscribeForm button[type="submit"]')).toBeEnabled();
});

// No-JS safety: with scripts disabled the form must NOT be able to GET-leak
// email/ZIP into a URL. The submit button ships disabled and the form posts
// to the API as a fallback. Locks the static attributes against regression
// (the JS-enabled test above would still pass if `disabled` were removed).
test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('submit button stays disabled and the form posts to the API', async ({ page }) => {
    await page.goto('/smoke-weather/');
    await expect(page.locator('#subscribeForm button[type="submit"]')).toBeDisabled();
    await expect(page.locator('#subscribeForm')).toHaveAttribute('method', /^post$/i);
    await expect(page.locator('#subscribeForm')).toHaveAttribute('action', '/api/subscribe');
  });
});

test('honeypot is autofill-safe: non-profile name, inert, off the tab order', async ({ page }) => {
  await page.goto('/smoke-weather/');
  const hp = page.locator('#subHp');
  await expect(hp).toHaveAttribute('name', 'subscribe_hp'); // not a profile field
  await expect(hp).toHaveAttribute('autocomplete', 'off');
  await expect(hp).toHaveAttribute('tabindex', '-1');
  // Wrapper is inert so browser/password-manager autofill never targets it.
  const wrapperInert = await page.locator('.subscribe-form__hp').evaluate((el) => el.hasAttribute('inert'));
  expect(wrapperInert).toBe(true);
});

test('server rejection surfaces a friendly error, no success state', async ({ page }) => {
  await stubSubscribe(page, { status: 422 });
  await page.goto('/smoke-weather/');

  await page.fill('#subEmail', 'dupe@example.com');
  await page.fill('#subZip', '64108');
  await page.locator('#subscribeForm button[type="submit"]').click();

  await expect(page.locator('#subStatus')).not.toBeEmpty();
  await expect(page.locator('#subscribeForm')).not.toHaveClass(/is-success/);
  // Button must be re-enabled so the user can retry.
  await expect(page.locator('#subscribeForm button[type="submit"]')).toBeEnabled();
});

test('honeypot submission is swallowed: no request, no error', async ({ page }) => {
  const calls = await stubSubscribe(page);
  await page.goto('/smoke-weather/');

  // A bot fills the hidden field. Use evaluate because the field is
  // visually hidden / not user-fillable.
  await page.fill('#subEmail', 'bot@example.com');
  await page.fill('#subZip', '64108');
  await page.evaluate(() => { document.querySelector('#subHp').value = 'Acme Bots Inc'; });
  await page.locator('#subscribeForm button[type="submit"]').click();

  await page.waitForTimeout(150);
  expect(calls).toHaveLength(0);
  // The user (bot) sees a benign success, not an error revealing the trap.
  await expect(page.locator('#subStatus')).not.toContainText(/error|invalid|wrong/i);
});

test('form is hidden in embed mode (?embed=1)', async ({ page }) => {
  await page.goto('/smoke-weather/?embed=1');
  await expect(page.locator('#subscribeForm')).toBeHidden();
});
