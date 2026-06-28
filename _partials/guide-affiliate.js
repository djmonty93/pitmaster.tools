/* guide-affiliate.js — assembles Amazon Associates links at runtime.
 *
 * Authors write product cards / inline links as <a class="amz" data-asin="…">
 * with NO href in the source. This script fills in the href from the ASIN, so:
 *   - the Amazon tag lives in exactly ONE place (AMZ_TAG below),
 *   - no affiliate URL is ever emitted into dist/ (nothing for the link
 *     validator to flag, and affiliate URLs aren't crawled), and
 *   - retargeting to manufacturer links later is a localized edit to BASE/amzUrl.
 *
 * Injected before </body> on guide pages via INJECT:guide-affiliate.js:script.
 */
(function () {
  'use strict';
  // ── SINGLE SOURCE OF TRUTH for the Amazon Associates tag ──
  var AMZ_TAG = 'pitmastertools-20';
  var BASE = 'https://www.amazon.com/dp/';

  function amzUrl(asin) {
    return BASE + encodeURIComponent(asin) + '/?tag=' + encodeURIComponent(AMZ_TAG);
  }

  var links = document.querySelectorAll('a.amz[data-asin]');
  for (var i = 0; i < links.length; i++) {
    var el = links[i];
    var asin = el.getAttribute('data-asin');
    if (!asin) continue;
    el.setAttribute('href', amzUrl(asin));
    el.setAttribute('rel', 'sponsored nofollow noopener');
    el.setAttribute('target', '_blank');
  }
})();
