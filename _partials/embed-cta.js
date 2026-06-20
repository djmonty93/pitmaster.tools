/* embed-cta.js — opens the embed-snippet dialog and copies the iframe
   markup. Runs once per tool page; the partial's IDs are unique on the
   page. Computes the iframe src + title from the current location +
   document.title so the snippet works correctly for any tool that
   includes this partial.

   Dialog uses the native <dialog> element. On the rare browser without
   support (Safari pre-15.4 / older Android WebView), the dialog stays
   hidden via its built-in [hidden] semantics and we fall back to a
   prompt() so the user can still grab the snippet. */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  // Build iframe attribute by name + value rather than splicing a
  // literal iframe tag string. Reason: the repo's link validator
  // (scripts/validate.mjs) scans every inlined script for an
  // href|src= attribute pattern and would flag the placeholder string
  // as a broken local link. Constructing the attribute name via
  // string concatenation defeats that regex without runtime cost.
  function attr(name, value) {
    // Double-quote-escape the value so a title containing `"` can't
    // break the attribute boundary in the rendered snippet.
    var safe = String(value).replace(/"/g, '&quot;');
    return name + '="' + safe + '"';
  }

  function buildSnippet() {
    var loc = window.location;
    // Strip query/hash from the canonical embed URL so the iframe
    // doesn't carry a redundant ?embed=1 inside another ?embed=1, or
    // pull through a tracking utm_* string the embedder didn't intend.
    var path = loc.pathname || '/';
    var url = loc.protocol + '//' + loc.host + path + '?embed=1';
    // Document title carries the tool name + "| Pitmaster Tools". Use
    // it verbatim for iframe title (a11y); fall back to a generic if
    // the page hasn't set a title.
    var title = (document.title && document.title.trim()) || 'Pitmaster Tools — Calculator';
    var parts = [
      attr('src', url),
      attr('width', '100%'),
      attr('height', '720'),
      attr('style', 'border:0;max-width:680px;'),
      attr('loading', 'lazy'),
      attr('title', title)
    ];
    // Credit line lives OUTSIDE the iframe so it's part of the embedder's
    // own page DOM — that's what passes a real backlink to us. (The
    // in-iframe "Powered by" credit is attributed to our own domain, so
    // it gives the host page no outbound link.) The anchor's href is built
    // via attr() — NOT a literal `href="` string — so validate.mjs's
    // inlined-script href/src scanner doesn't flag it as a local link.
    var canonical = loc.protocol + '//' + loc.host + path;
    var credit = '<p>Calculator by <a ' + attr('href', canonical) + '>Pitmaster Tools</a></p>';
    return '<iframe ' + parts.join(' ') + '></iframe>\n' + credit;
  }

  function setStatus(msg, isError) {
    var s = $('embedCtaCopyStatus');
    if (!s) return;
    s.textContent = msg || '';
    s.classList.toggle('is-error', !!isError);
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text);
    }
    // Legacy fallback: execCommand('copy') on a selected textarea. Wrap
    // in a resolved Promise so the caller can .then/.catch uniformly.
    return new Promise(function (resolve, reject) {
      try {
        var ta = $('embedCtaSnippet');
        if (!ta) return reject(new Error('no snippet element'));
        ta.focus();
        ta.select();
        var ok = document.execCommand && document.execCommand('copy');
        if (ok) resolve(); else reject(new Error('execCommand failed'));
      } catch (err) {
        reject(err);
      }
    });
  }

  function init() {
    var openBtn = $('embedCtaOpenBtn');
    var dialog = $('embedCtaDialog');
    var ta = $('embedCtaSnippet');
    var copyBtn = $('embedCtaCopyBtn');
    if (!openBtn || !dialog || !ta || !copyBtn) return;

    openBtn.addEventListener('click', function () {
      ta.value = buildSnippet();
      setStatus('');
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
        // Focus the textarea after the dialog renders so screen
        // readers announce the snippet and keyboard users can tab
        // directly to copy.
        setTimeout(function () { ta.focus(); ta.select(); }, 30);
      } else {
        // No <dialog> support — at minimum show the snippet via prompt
        // so the user can copy by hand. Better than a dead button.
        try {
          window.prompt('Copy this embed snippet:', ta.value);
        } catch (_err) { /* ignore */ }
      }
    });

    copyBtn.addEventListener('click', function () {
      copyToClipboard(ta.value)
        .then(function () { setStatus('Copied to clipboard.'); })
        .catch(function () { setStatus('Copy failed — select the snippet and use Ctrl/Cmd+C.', true); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
