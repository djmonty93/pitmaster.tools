/* guide-affiliate.js — assembles Amazon Associates links at runtime, and
 * resolves product-card images by ASIN.
 *
 * Authors write product cards / inline links as <a class="amz" data-asin="…">
 * with NO href in the source. This script fills in the href from the ASIN, so:
 *   - the Amazon tag lives in exactly ONE place (AMZ_TAG below),
 *   - no affiliate URL is ever emitted into dist/ (nothing for the link
 *     validator to flag, and affiliate URLs aren't crawled), and
 *   - retargeting to manufacturer links later is a localized edit to BASE/amzUrl.
 *
 * Product images: card thumbnails are written as
 *   <img class="product-card__img" data-asin="…" src="/img/guides/products/_pending.svg">
 * The real photo is the Amazon product image for that ASIN, pulled from the
 * Amazon Creators API — never created by the owner. The Creators API needs
 * authenticated, server-side calls, so the image is resolved at BUILD time
 * (a generator will write the Amazon image URL / cached file per ASIN) rather
 * than client-side here. Until that API access is available, every card shows
 * the neutral `_pending.svg` placeholder. The optional hook below lets a
 * build-injected `window.__pmProductImages` map (asin → url) swap images in
 * without markup changes once the pipeline is live.
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

  // Affiliate links/CTAs: assemble href from the ASIN.
  var links = document.querySelectorAll('a.amz[data-asin]');
  for (var i = 0; i < links.length; i++) {
    var el = links[i];
    var asin = el.getAttribute('data-asin');
    if (!asin) continue;
    el.setAttribute('href', amzUrl(asin));
    el.setAttribute('rel', 'sponsored nofollow noopener');
    el.setAttribute('target', '_blank');
  }

  // Product images: swap the placeholder for the Amazon Creators API image when
  // a build-injected map is present. No-op (placeholder stays) until then.
  var imgMap = (typeof window !== 'undefined' && window.__pmProductImages) || null;
  if (imgMap) {
    var imgs = document.querySelectorAll('img.product-card__img[data-asin]');
    for (var j = 0; j < imgs.length; j++) {
      var src = imgMap[imgs[j].getAttribute('data-asin')];
      if (src) imgs[j].setAttribute('src', src);
    }
  }
})();
