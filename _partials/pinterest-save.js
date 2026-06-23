/* pinterest-save.js — "Save to Pinterest" control for calculator results.

   The pin IMAGE is the page's static vertical og:image (a Rich Pin). The user's
   actual RESULT is carried in the pin's description, composed live from the
   rendered result stat-cards, so a pinned result reads back the real numbers.
   The click-through url is location.href, which the calculators keep in sync
   with the plan query string (see plan-url.js) so opening the pin reproduces
   the result.

   Pure progressive enhancement: it only acts when a #results modal exists, so
   it is a no-op on non-calculator pages that also load the tool footer. No
   third-party scripts; the link is a first-party pinterest.com/pin/create link. */
(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  ready(function () {
    var modal = document.getElementById('results');
    if (!modal || modal.querySelector('.pin-save')) return;

    function text(el) { return el ? (el.textContent || '').trim() : ''; }

    function metaContent(selector) {
      var el = document.querySelector(selector);
      return el ? (el.getAttribute('content') || '') : '';
    }

    // Compose the pin description from the visible result, falling back to the
    // page's meta description before any calculation has run.
    function describe() {
      var parts = [];
      var cards = modal.querySelectorAll('.stat-card');
      for (var i = 0; i < cards.length; i++) {
        var value = text(cards[i].querySelector('.sc-value'));
        // Skip the em-dash placeholder shown before a result exists.
        if (!value || value === '—' || value === '-') continue;
        var label = text(cards[i].querySelector('.sc-label'));
        parts.push(label ? label + ' ' + value : value);
      }
      var title = text(document.getElementById('resultsModalTitle')) || document.title;
      var desc = parts.length
        ? title + ' — ' + parts.join(' · ')
        : (metaContent('meta[name="description"]') || title);
      return desc.slice(0, 480);
    }

    function buildHref() {
      var params = new URLSearchParams();
      params.set('url', location.href);
      var media = metaContent('meta[property="og:image"]');
      if (media) params.set('media', media);
      var desc = describe();
      if (desc) params.set('description', desc);
      return 'https://www.pinterest.com/pin/create/button/?' + params.toString();
    }

    var link = document.createElement('a');
    link.className = 'print-btn pin-save no-print';
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Save to Pinterest';
    link.href = buildHref();
    // Refresh just-in-time so the pin reflects the latest calculated result.
    link.addEventListener('click', function () {
      try { link.href = buildHref(); } catch (e) { /* keep last good href */ }
    });

    // Place it alongside the existing Print / Copy-plan actions when present,
    // otherwise right after the result stat-cards.
    var actionBtn = modal.querySelector('#printBtn, #copyPlanBtn');
    if (actionBtn && actionBtn.parentNode) {
      actionBtn.parentNode.appendChild(link);
    } else {
      var cards = modal.querySelector('.stat-cards');
      if (cards && cards.parentNode) {
        cards.parentNode.insertBefore(link, cards.nextSibling);
      } else {
        modal.appendChild(link);
      }
    }
  });
})();
