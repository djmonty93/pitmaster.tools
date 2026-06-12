// Active-nav marking — site-header.js runtime should tag header + footer
// nav anchors that point at the current page with aria-current="page" and
// add .is-current to the parent nav-dropdown trigger. The function itself
// is closure-private inside site-header.js's IIFE, so we test it through
// the rendered DOM in a real browser. Each spec exercises a specific
// branch of markActiveLinks() so the cumulative suite covers the function
// without needing to extract it for unit testing.

const { test, expect } = require('@playwright/test');

test('about page marks the header About link aria-current', async ({ page }) => {
  await page.goto('/about');

  const headerAbout = page.locator('header nav a[href="/about"]');
  await expect(headerAbout).toHaveAttribute('aria-current', 'page');

  // Other nav links should NOT be marked active.
  await expect(page.locator('header nav a[href="/tools"]')).not.toHaveAttribute('aria-current', 'page');
});

test('query-string in URL does not disrupt path matching', async ({ page }) => {
  // markActiveLinks() reads window.location.pathname, which strips the
  // query string for us, but verify the function actually relies on
  // pathname (not href) so future refactors can't silently regress.
  await page.goto('/about?ref=test&utm_source=ci');
  await expect(page.locator('header nav a[href="/about"]')).toHaveAttribute('aria-current', 'page');
});

test('URL hash fragment does not disrupt path matching', async ({ page }) => {
  // Same idea: pathname-based comparison must ignore hashes.
  await page.goto('/about#governing-law');
  await expect(page.locator('header nav a[href="/about"]')).toHaveAttribute('aria-current', 'page');
});

test('tools page marks the All Tools link active and the dropdown trigger as is-current', async ({ page }) => {
  await page.goto('/tools');

  const allToolsLink = page.locator('header .nav-dropdown__menu a[href="/tools"]');
  await expect(allToolsLink).toHaveAttribute('aria-current', 'page');

  // Parent nav-dropdown trigger picks up .is-current when any child is active.
  await expect(page.locator('header .nav-dropdown__trigger')).toHaveClass(/is-current/);
});

test('privacy-policy marks the footer Privacy Policy link active', async ({ page }) => {
  await page.goto('/privacy-policy');
  await expect(page.locator('footer nav a[href="/privacy-policy"]')).toHaveAttribute('aria-current', 'page');
});

test('external-origin (mailto:) footer link never gets aria-current', async ({ page }) => {
  // Verifies the `url.origin !== window.location.origin` guard in
  // markActiveLinks() — mailto: URLs parse to origin "null" and must
  // be left alone even though they live inside `<footer><nav>`.
  await page.goto('/about');
  const mailto = page.locator('footer nav a[href^="mailto:"]');
  await expect(mailto).not.toHaveAttribute('aria-current', 'page');
});

test('skip-link with hash-only href is left alone (outside nav)', async ({ page }) => {
  // The `<a href="#main-content" class="skip-link">` lives in the body
  // before <header>, OUTSIDE the `header nav a[href], footer nav a[href]`
  // selector. Verify markActiveLinks does not touch it.
  await page.goto('/about');
  await expect(page.locator('a.skip-link')).not.toHaveAttribute('aria-current', 'page');
});

test('header logo link to "/" stays unmarked because it is outside <nav>', async ({ page }) => {
  // The logo is `<a class="logo" href="/">` inside <header> but NOT
  // inside <header><nav>. Selector scoping means it stays unmarked
  // even when window.location.pathname === '/'.
  await page.goto('/');
  await expect(page.locator('header a.logo')).not.toHaveAttribute('aria-current', 'page');
});

// ── Grouped tools dropdown ──────────────────────────────────────────────────
// The tools menu groups its links under non-interactive section labels that
// mirror the section-title categories on /tools. Labels must never be
// focusable or clickable; every tool link must stay reachable both by
// pointer and by Tab order (the menu stays open via :focus-within).

const MENU_LINKS = [
  ['/tools', 'All Tools'],
  ['/brisket-calculator', 'Brisket Calculator'],
  ['/pork-shoulder-calculator', 'Pork Shoulder Calculator'],
  ['/rib-calculator', 'Rib Calculator'],
  ['/turkey-smoking-calculator', 'Turkey Calculator'],
  ['/', 'Meat Smoking Calculator'],
  ['/cook-time-coordinator', 'Cook Time Coordinator'],
  ['/meat-per-person', 'Meat Per Person'],
  ['/catering-calculator', 'Catering Calculator'],
  ['/brine-calculator', 'Brine Calculator'],
  ['/dry-rub-calculator', 'Dry Rub Calculator'],
  ['/charcoal-calculator', 'Charcoal Calculator'],
  ['/bbq-cost-calculator', 'BBQ Cost Calculator'],
  ['/brisket-yield-calculator', 'Brisket Yield Calculator'],
  ['/smoke-weather/', 'Best Smoke Days'],
];

const GROUP_LABELS = [
  'Cut Calculators',
  'Planning & Timing',
  'Ingredient Calculators',
  'Cost & Yield',
  'Smoke Forecast',
];

test('tools dropdown shows 5 group labels and all 15 links', async ({ page }) => {
  await page.goto('/about');
  await page.locator('header .nav-dropdown__trigger').click();

  const labels = page.locator('header .nav-dropdown__menu .nav-dropdown__group-label');
  await expect(labels).toHaveText(GROUP_LABELS);

  const links = page.locator('header .nav-dropdown__menu a');
  await expect(links).toHaveCount(MENU_LINKS.length);
  for (const [href, text] of MENU_LINKS) {
    await expect(
      page.locator(`header .nav-dropdown__menu a[href="${href}"]`),
      `menu link ${href}`
    ).toHaveText(text);
  }
});

test('every tools-menu link is reachable by keyboard; group labels are skipped', async ({ page }) => {
  await page.goto('/about');

  // Focusing the trigger opens the menu via the CSS :focus-within rule, and
  // Tab then walks straight into the menu links in DOM order.
  await page.locator('header .nav-dropdown__trigger').focus();

  const visited = [];
  for (let i = 0; i < MENU_LINKS.length; i++) {
    await page.keyboard.press('Tab');
    visited.push(await page.evaluate(() => {
      const el = document.activeElement;
      return {
        href: el.getAttribute('href'),
        inMenu: !!el.closest('.nav-dropdown__menu'),
        isLabel: el.classList.contains('nav-dropdown__group-label'),
      };
    }));
  }

  for (const stop of visited) {
    expect(stop.inMenu, 'Tab stop should be inside the dropdown menu').toBe(true);
    expect(stop.isLabel, 'group labels must not receive focus').toBe(false);
  }
  expect(visited.map((s) => s.href)).toEqual(MENU_LINKS.map(([href]) => href));
});
