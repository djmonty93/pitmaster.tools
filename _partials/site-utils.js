/* ============================================================
   site-utils.js — Shared utilities for all Pitmaster Tools pages.
   Inlined at build time by build.js. Do not load as an external file.
   All functions are global — pages call them directly.
   No IIFE wrapper; no automatic initialization.
   ============================================================ */

/* ----- Site-wide constants ----- */
var SITE_URL = 'https://pitmaster.tools';
var CONSENT_COOKIE_NAME = 'pitmaster_consent';
var CONSENT_COOKIE_DAYS = 365;
var GA_MEASUREMENT_ID = 'G-SJJVV37EWE';
var ADSENSE_CLIENT = 'ca-pub-4265262608577453';

/* ----- State flags ----- */
var analyticsLoaded = false;
var adsLoaded = false;
var consentInitialized = false;
var analyticsScriptEl = null;
var copyLinkResetTimer = null;
var copyEmbedResetTimer = null;
var _modalPrevFocus = null;
var _resultsModalKeydownBound = false;

/* ----- Utility ----- */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shouldDefaultMetric(lang) {
  var normalized = (lang || '').replace('_', '-');
  if (!normalized) return false;
  if (normalized.toLowerCase() === 'en') return false;
  var parts = normalized.split('-');
  var region = parts.length > 1 ? parts[parts.length - 1].toUpperCase() : '';
  if (region) return ['US', 'LR', 'MM'].indexOf(region) === -1;
  return parts[0].toLowerCase() !== 'en';
}

/* ----- Cookie helpers ----- */
function setCookie(name, value, days) {
  var expires = new Date();
  expires.setTime(expires.getTime() + days * 24 * 60 * 60 * 1000);
  document.cookie = name + '=' + encodeURIComponent(value) + '; expires=' + expires.toUTCString() + '; path=/; Secure; SameSite=Lax';
}
function getCookie(name) {
  var prefix = name + '=';
  var parts = document.cookie ? document.cookie.split(';') : [];
  for (var i = 0; i < parts.length; i++) {
    var cookie = parts[i].trim();
    if (cookie.indexOf(prefix) === 0) return decodeURIComponent(cookie.substring(prefix.length));
  }
  return '';
}

/* ----- Google services ----- */
// Region-scoped Consent Mode v2 (advanced mode). The consent defaults in
// consent-init.html grant analytics worldwide EXCEPT in the EEA/UK/CH, where it
// stays denied until accept. So gtag.js loads on every non-rejected page view:
// outside the EEA it measures full users; inside, it sends only cookieless
// Consent Mode pings until the visitor accepts. Ads stay denied everywhere
// until explicit accept. This closes the GSC↔GA4 gap while staying
// GDPR-defensible. See docs/analytics-consent-playbook.md.
function updateConsentGranted() {
  gtag('consent', 'update', {
    'ad_storage': 'granted',
    'analytics_storage': 'granted',
    'ad_user_data': 'granted',
    'ad_personalization': 'granted'
  });
}
function deleteCookie(name) {
  var past = '; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  document.cookie = name + '=' + past;
  document.cookie = name + '=' + past + '; domain=' + location.hostname;
  document.cookie = name + '=' + past + '; domain=.' + location.hostname;
}
function deleteAnalyticsCookies() {
  var parts = document.cookie ? document.cookie.split(';') : [];
  for (var i = 0; i < parts.length; i++) {
    var name = parts[i].split('=')[0].trim();
    if (name === '_ga' || name === '_gid' || name.indexOf('_ga_') === 0 || name.indexOf('_gat') === 0) {
      deleteCookie(name);
    }
  }
}
function purgeAnalyticsCookies() {
  // Delete now; delete again once gtag.js loads (fast-reject race where the
  // queued config writes _ga AFTER this pass); plus a timed fallback. The
  // load-event binding lives ONLY on the reject path — binding it inside
  // loadAnalytics would purge cookies for accepted users too.
  deleteAnalyticsCookies();
  if (analyticsScriptEl && !analyticsScriptEl.__purgeBound) {
    analyticsScriptEl.__purgeBound = true;
    analyticsScriptEl.addEventListener('load', deleteAnalyticsCookies);
  }
  if (typeof setTimeout === 'function') setTimeout(deleteAnalyticsCookies, 1500);
}
function updateConsentDenied() {
  if (typeof gtag === 'function') {
    gtag('consent', 'update', {
      'ad_storage': 'denied',
      'analytics_storage': 'denied',
      'ad_user_data': 'denied',
      'ad_personalization': 'denied'
    });
  }
  purgeAnalyticsCookies();
}
function addPreconnect(url) {
  if (document.querySelector('link[rel="preconnect"][href="' + url + '"]')) return;
  var link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = url;
  document.head.appendChild(link);
}
function loadAnalytics() {
  if (GA_MEASUREMENT_ID === 'GA_MEASUREMENT_ID') return;
  if (document.querySelector('script[src="https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_MEASUREMENT_ID) + '"]')) {
    analyticsLoaded = true;
    return;
  }
  if (analyticsLoaded) return;
  analyticsLoaded = true;
  addPreconnect('https://www.googletagmanager.com');
  gtag('js', new Date());
  gtag('config', GA_MEASUREMENT_ID);
  var script = document.createElement('script');
  script.async = true;
  script.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_MEASUREMENT_ID);
  analyticsScriptEl = script;
  document.head.appendChild(script);
}
function loadAds() {
  if (document.querySelector('script[src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + encodeURIComponent(ADSENSE_CLIENT) + '"]')) {
    adsLoaded = true;
    return;
  }
  if (adsLoaded) return;
  adsLoaded = true;
  // Ad-domain preconnect is consent-gated here so we never touch an advertising
  // origin before the visitor explicitly accepts ads.
  addPreconnect('https://pagead2.googlesyndication.com');
  // Suppress placeholder ad-slot processing until real ad-slot IDs ship.
  // Each page emits an inline script that calls adsbygoogle.push({}) after
  // every <ins>. That runs during HTML parse, before loadAds() ever fires,
  // so by now window.adsbygoogle is an Array with one queued {} per slot.
  // When the AdSense library loads it intercepts the array and processes
  // the queue: each queued push expects an unfilled <ins>, but the
  // placeholder slots are display:none via the .ad-slot:has() CSS rule, so
  // AdSense throws TagError "Y" (minified) for every one.
  // Fix: wipe the queue AND remove the placeholder <ins> elements before
  // loading the library. AdSense then initializes with an empty array and
  // no <ins> to process. Once real slot IDs ship, none of this matches
  // and AdSense fills normally.
  window.adsbygoogle = [];
  var placeholderIns = document.querySelectorAll('ins.adsbygoogle[data-ad-slot="XXXXXXXXXX"]');
  for (var i = 0; i < placeholderIns.length; i++) placeholderIns[i].remove();
  var script = document.createElement('script');
  script.async = true;
  script.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + encodeURIComponent(ADSENSE_CLIENT);
  script.crossOrigin = 'anonymous';
  document.head.appendChild(script);
}
function loadGoogleServices() {
  if (isEmbedMode()) return;
  loadAnalytics();
  loadAds();
}

/* ----- Consent banner ----- */
function setConsentState(value) {
  setCookie(CONSENT_COOKIE_NAME, value, CONSENT_COOKIE_DAYS);
  if (value === 'accepted') {
    updateConsentGranted();
    loadGoogleServices();
  } else if (value === 'rejected') {
    // Fully honor reject: deny consent and purge any GA cookies already set
    // (e.g. for a non-EEA visitor who was measured by default before clicking).
    updateConsentDenied();
  }
  hideCookieBanner();
}
function showCookieBanner() {
  var banner = document.getElementById('cookieBanner');
  if (banner) banner.classList.add('visible');
}
function hideCookieBanner() {
  var banner = document.getElementById('cookieBanner');
  if (banner) banner.classList.remove('visible');
}
function initConsentBanner() {
  // Idempotent: footer partials call this, and some pages also call it directly.
  if (consentInitialized) return;
  consentInitialized = true;
  // 3rd-party iframes (?embed=1): no analytics, no ads, no consent UI.
  if (isEmbedMode()) { hideCookieBanner(); return; }

  var acceptBtn = document.getElementById('acceptCookies') || document.getElementById('cookieAccept');
  var rejectBtn = document.getElementById('rejectCookies') || document.getElementById('cookieReject');
  if (acceptBtn) acceptBtn.addEventListener('click', function() {
    setConsentState('accepted');
  });
  if (rejectBtn) rejectBtn.addEventListener('click', function() {
    setConsentState('rejected');
  });

  var storedConsent = getCookie(CONSENT_COOKIE_NAME);
  // Fully honor a prior reject: deny + purge + do NOT load gtag.js at all.
  if (storedConsent === 'rejected') { updateConsentDenied(); hideCookieBanner(); return; }
  if (storedConsent === 'accepted') updateConsentGranted();

  // Every non-rejected page view loads analytics. Region-scoped consent defaults
  // decide cookies vs cookieless pings (see loadAnalytics comment).
  loadAnalytics();

  if (storedConsent === 'accepted') { loadAds(); hideCookieBanner(); return; }
  showCookieBanner();
}
/* Alias for rib-calculator.html which uses the old name */
var initCookieBanner = initConsentBanner;

/* ----- Modal ----- */
function openResultsModal() {
  _modalPrevFocus = document.activeElement;
  document.getElementById('results').classList.add('visible');
  document.body.classList.add('modal-open');
  var modal = document.querySelector('.results-modal');
  setTimeout(function() { modal.focus(); }, 0);
}
function closeResultsModal() {
  document.getElementById('results').classList.remove('visible');
  document.body.classList.remove('modal-open');
  if (_modalPrevFocus) _modalPrevFocus.focus();
}
function _trapModalFocus(e) {
  if (!document.getElementById('results') || !document.getElementById('results').classList.contains('visible')) return;
  if (e.key === 'Escape') { closeResultsModal(); return; }
  if (e.key !== 'Tab') return;
  var modal = document.querySelector('.results-modal');
  var focusable = Array.prototype.slice.call(modal.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  ));
  if (!focusable.length) return;
  var first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey) {
    if (document.activeElement === first || document.activeElement === modal) { e.preventDefault(); last.focus(); }
  } else {
    if (document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}
function initResultsModal() {
  var results = document.getElementById('results');
  if (!results || results.dataset.modalInit === '1') return;

  var closeButtons = results.querySelectorAll('.results-close, #resultsClose, #closeResultsBtn');
  Array.prototype.forEach.call(closeButtons, function(btn) {
    btn.addEventListener('click', closeResultsModal);
  });

  results.addEventListener('click', function(e) {
    if (e.target === results) closeResultsModal();
  });

  if (!_resultsModalKeydownBound) {
    document.addEventListener('keydown', _trapModalFocus);
    _resultsModalKeydownBound = true;
  }

  results.dataset.modalInit = '1';
}

/* ----- Share / copy buttons ----- */
function initShareButtons() {
  var copyBtn = document.getElementById('copyLinkBtn');
  if (!copyBtn) return;
  copyBtn.addEventListener('click', function() {
    navigator.clipboard.writeText(SITE_URL).then(function() {
      copyBtn.textContent = 'Copied!';
      copyBtn.classList.add('copy-confirmed');
      clearTimeout(copyLinkResetTimer);
      copyLinkResetTimer = setTimeout(function() { copyBtn.textContent = 'Copy link'; copyBtn.classList.remove('copy-confirmed'); }, 2000);
    }).catch(function() {
      copyBtn.textContent = 'Copy failed';
      copyBtn.classList.add('copy-confirmed');
      clearTimeout(copyLinkResetTimer);
      copyLinkResetTimer = setTimeout(function() { copyBtn.textContent = 'Copy link'; copyBtn.classList.remove('copy-confirmed'); }, 2000);
    });
  });
}
function isEmbedMode() {
  return /(?:^|[?&])embed=1(?:&|$)/.test(window.location.search);
}
function initEmbedMode() {
  if (!isEmbedMode()) return;
  document.body.classList.add('embed-mode');
}
function initEmbedSection() {
  var copyBtn = document.getElementById('copyEmbedBtn');
  var textarea = document.getElementById('embedCode');
  if (!copyBtn || !textarea) return;
  copyBtn.addEventListener('click', function() {
    navigator.clipboard.writeText(textarea.value).then(function() {
      copyBtn.textContent = 'Copied!';
      copyBtn.classList.add('copy-confirmed');
      clearTimeout(copyEmbedResetTimer);
      copyEmbedResetTimer = setTimeout(function() { copyBtn.textContent = 'Copy embed code'; copyBtn.classList.remove('copy-confirmed'); }, 2000);
    }).catch(function() {
      copyBtn.textContent = 'Copy failed';
      copyBtn.classList.add('copy-confirmed');
      clearTimeout(copyEmbedResetTimer);
      copyEmbedResetTimer = setTimeout(function() { copyBtn.textContent = 'Copy embed code'; copyBtn.classList.remove('copy-confirmed'); }, 2000);
    });
  });
}
