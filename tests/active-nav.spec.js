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
