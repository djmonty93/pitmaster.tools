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
var copyLinkResetTimer = null;
var copyEmbedResetTimer = null;
var _modalPrevFocus = null;

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
function updateConsentGranted() {
  gtag('consent', 'update', { 'ad_storage': 'granted', 'analytics_storage': 'granted' });
}
function ensureThirdPartyHints() {
  ['https://www.googletagmanager.com', 'https://pagead2.googlesyndication.com'].forEach(function(url) {
    if (document.querySelector('link[rel="preconnect"][href="' + url + '"]')) return;
    var link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = url;
    document.head.appendChild(link);
  });
}
function loadAnalytics() {
  if (analyticsLoaded || GA_MEASUREMENT_ID === 'GA_MEASUREMENT_ID') return;
  analyticsLoaded = true;
  var script = document.createElement('script');
  script.async = true;
  script.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_MEASUREMENT_ID);
  document.head.appendChild(script);
  gtag('js', new Date());
  gtag('config', GA_MEASUREMENT_ID);
}
function loadAds() {
  if (adsLoaded) return;
  adsLoaded = true;
  var script = document.createElement('script');
  script.async = true;
  script.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + encodeURIComponent(ADSENSE_CLIENT);
  script.crossOrigin = 'anonymous';
  document.head.appendChild(script);
}
function loadGoogleServices() {
  ensureThirdPartyHints();
  loadAnalytics();
  loadAds();
}

/* ----- Consent banner ----- */
function setConsentState(value) {
  setCookie(CONSENT_COOKIE_NAME, value, CONSENT_COOKIE_DAYS);
  if (value === 'accepted') {
    updateConsentGranted();
    loadGoogleServices();
  }
  hideCookieBanner();
}
function showCookieBanner() {
  document.getElementById('cookieBanner').classList.add('visible');
}
function hideCookieBanner() {
  document.getElementById('cookieBanner').classList.remove('visible');
}
function initConsentBanner() {
  var storedConsent = getCookie(CONSENT_COOKIE_NAME);
  document.getElementById('acceptCookies').addEventListener('click', function() {
    setConsentState('accepted');
  });
  document.getElementById('rejectCookies').addEventListener('click', function() {
    setConsentState('rejected');
  });
  if (storedConsent === 'accepted') { updateConsentGranted(); loadGoogleServices(); hideCookieBanner(); return; }
  if (storedConsent === 'rejected') { hideCookieBanner(); return; }
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
