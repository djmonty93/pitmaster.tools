/* subscribe-form.js — progressive enhancement for the weekly-forecast
   email capture form. Posts to the already-built POST /api/subscribe
   (Sender.net + D1 + Friday cron live behind it). Self-contained: no
   dependency on site-utils.js globals or script-injection order.

   Client validation mirrors the server's zod rules (trim+lowercase email,
   /^\d{5}$/ zip) so obvious mistakes never round-trip. The server remains
   the source of truth; this is a fast-feedback mirror, not a gate. */
(function () {
  'use strict';

  // Mirror of site-utils isEmbedMode() — inlined so this script has no
  // cross-partial ordering dependency. Inside an embed iframe the form is
  // hidden via CSS; bail out of enhancement too so it can never submit.
  function isEmbed() {
    return /(?:^|[?&])embed=1(?:&|$)/.test(window.location.search);
  }

  // Pragmatic mirror of zod's .email(): non-empty local + domain with a dot.
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var ZIP_RE = /^\d{5}$/;

  function timezone() {
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return tz || 'UTC';
    } catch (_e) {
      return 'UTC';
    }
  }

  // Map a server error code (or absence of one) to a user-facing line.
  function messageForError(code) {
    if (code === 'invalid_body' || code === 'invalid_json') {
      return 'Please enter a valid email and 5-digit ZIP code.';
    }
    if (code === 'sender_rejected') {
      return "We couldn't add that email — it may already be subscribed. Try another?";
    }
    return 'Something went wrong. Please try again in a moment.';
  }

  function init() {
    var form = document.getElementById('subscribeForm');
    if (!form || isEmbed()) return;

    var emailEl = document.getElementById('subEmail');
    var zipEl = document.getElementById('subZip');
    var hpEl = document.getElementById('subHp');
    var btn = form.querySelector('.subscribe-form__btn');
    var status = document.getElementById('subStatus');
    var success = document.getElementById('subSuccess');
    if (!emailEl || !zipEl || !btn || !status) return;

    // The button ships disabled so a no-JS page can never submit (and leak
    // email/ZIP into a URL). Now that JS owns the submit, enable it.
    btn.disabled = false;

    function setStatus(msg, isError) {
      status.textContent = msg || '';
      status.classList.toggle('is-error', !!isError);
    }

    function showSuccess() {
      setStatus('');
      form.classList.add('is-success');
      if (success) {
        // #subSuccess is always present in the a11y tree (empty, collapsed
        // via :empty in CSS), so injecting the text here is a content
        // mutation inside an already-registered aria-live region — reliably
        // announced, with no unhide/populate timing race.
        success.textContent = "You're in. Watch for your first Best Smoke Days email this Friday.";
      }
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();

      // Honeypot tripped → almost certainly a bot. Show a benign success
      // and send nothing, so the bot can't tell it was caught.
      if (hpEl && hpEl.value.trim() !== '') {
        showSuccess();
        return;
      }

      var email = emailEl.value.trim().toLowerCase();
      var zip = zipEl.value.trim();

      if (!EMAIL_RE.test(email)) {
        setStatus('Please enter a valid email address.', true);
        emailEl.focus();
        return;
      }
      if (!ZIP_RE.test(zip)) {
        setStatus('Please enter a 5-digit US ZIP code.', true);
        zipEl.focus();
        return;
      }

      btn.disabled = true;
      setStatus('Signing you up…', false);

      // Abort after 15s so a hung connection (server accepts but never
      // responds) can't leave the button stuck disabled on the spinner
      // forever — the abort rejects the fetch and flows through .catch.
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, 15000) : null;

      fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, zip: zip, timezone: timezone() }),
        signal: controller ? controller.signal : undefined
      })
        .then(function (res) {
          if (res.ok) {
            showSuccess();
            return;
          }
          return res
            .json()
            .catch(function () { return {}; })
            .then(function (data) {
              setStatus(messageForError(data && data.error), true);
              btn.disabled = false;
            });
        })
        .catch(function () {
          setStatus(messageForError(null), true);
          btn.disabled = false;
        })
        .then(function () { if (timer) clearTimeout(timer); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
