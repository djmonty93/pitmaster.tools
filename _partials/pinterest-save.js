/* pinterest-save.js — "Save to Pinterest" control for calculator results.

   Two layers, both progressive enhancement:

   1. Baseline (always works, even if the steps below fail): the link is a
      first-party pinterest.com/pin/create button whose IMAGE is the page's
      static vertical og:image (a Rich Pin) and whose description is composed
      live from the rendered result, so a pinned result reads back the real
      numbers. The click-through url is location.href, which the calculators
      keep in sync with the plan query string (see plan-url.js).

   2. Dynamic image (when a result exists): on click we render the live result
      to a 1000×1500 canvas, upload the PNG to /api/pin-image (R2), and open
      Pinterest's create flow with that hosted image as `media` — so the pin's
      IMAGE shows the real numbers, not just the caption. The cook-time math
      already ran client-side, so this is pure presentation; the worker only
      stores/streams bytes.

   No third-party scripts. The headline font (Anton) is self-hosted and loaded
   lazily on first Save (same-origin → respects the consent rules in CLAUDE.md).
   It is a no-op on pages without a #results modal. */
(function () {
  'use strict';

  var IMG_W = 1000;
  var IMG_H = 1500;
  var UPLOAD_ENDPOINT = '/api/pin-image';
  var FONT_URL = '/og/fonts/anton.woff2';
  var MAX_UPLOAD_BYTES = 600 * 1024;

  // Pin aesthetic mirrors scripts/render-pins.mjs so the dynamic image reads as
  // the same family as the static per-calculator pins.
  var COLORS = {
    bg: '#1c140d',
    cream: '#f3ead8',
    label: '#e8ddc7',
    accent: '#d9542e',
    rule: '#463422',
    muted: '#8a7d66'
  };
  var MONO = 'ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace';
  var SANS = '"Public Sans", system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

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

    // The calculators render results with different markup, so read values from
    // whichever convention a page uses: stat cards (.sc-* and pork-shoulder's
    // BEM .stat-card__*), the catering summary grid (.sum-*), or the
    // coordinator's summary chips (.chip-*). Groups are tried in priority order
    // and the first that yields any value wins, so the pin carries the concise
    // summary rather than every per-row figure.
    var RESULT_GROUPS = [
      { value: '.sc-value, .stat-card__val', label: '.sc-label, .stat-card__label' },
      { value: '.sum-value', label: '.sum-label' },
      { value: '.chip-val', label: '.chip-label' }
    ];

    // Structured {label, value} rows — the single source of truth for both the
    // canvas value rows and the text description.
    function collectResultRows() {
      for (var g = 0; g < RESULT_GROUPS.length; g++) {
        var group = RESULT_GROUPS[g];
        var values = modal.querySelectorAll(group.value);
        if (!values.length) continue;
        var rows = [];
        for (var i = 0; i < values.length && rows.length < 6; i++) {
          var value = text(values[i]);
          // Skip the em-dash placeholder shown before a result exists.
          if (!value || value === '—' || value === '-') continue;
          var parent = values[i].parentNode;
          var label = parent ? text(parent.querySelector(group.label)) : '';
          rows.push({ label: label, value: value });
        }
        if (rows.length) return rows;
      }
      return [];
    }

    function collectResultPairs() {
      return collectResultRows().map(function (r) {
        return r.label ? r.label + ' ' + r.value : r.value;
      });
    }

    function resultTitle() {
      return text(document.getElementById('resultsModalTitle')) || document.title;
    }

    // Compose the pin description from the visible result, falling back to the
    // page's meta description before any calculation has run.
    function describe() {
      var parts = collectResultPairs();
      var title = resultTitle();
      var desc = parts.length
        ? title + ' — ' + parts.join(' · ')
        : (metaContent('meta[name="description"]') || title);
      return desc.slice(0, 480);
    }

    // Pinterest create URL. `media` is the image the pin shows; pass the hosted
    // dynamic image when we have one, else the page's static og:image.
    function buildHref(mediaOverride, urlOverride, descOverride) {
      var params = new URLSearchParams();
      params.set('url', urlOverride || location.href);
      var media = mediaOverride || metaContent('meta[property="og:image"]');
      if (media) params.set('media', media);
      var desc = descOverride || describe();
      if (desc) params.set('description', desc);
      return 'https://www.pinterest.com/pin/create/button/?' + params.toString();
    }

    // ── Canvas rendering ────────────────────────────────────────────────

    var fontPromise = null;
    function loadHeadlineFont() {
      if (fontPromise) return fontPromise;
      // Guard environments without the FontFace API: resolve false so the
      // renderer falls back to a system condensed face.
      if (typeof FontFace === 'undefined' || !document.fonts) {
        fontPromise = Promise.resolve(false);
        return fontPromise;
      }
      try {
        var face = new FontFace('PinAnton', 'url(' + FONT_URL + ')', { style: 'normal', weight: '400' });
        fontPromise = face.load().then(function (loaded) {
          document.fonts.add(loaded);
          return true;
        }).catch(function () { return false; });
      } catch (e) {
        fontPromise = Promise.resolve(false);
      }
      return fontPromise;
    }

    function headlineFont(size, haveAnton) {
      return size + 'px ' + (haveAnton ? '"PinAnton", ' : '') + 'Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif';
    }

    function wrapLines(ctx, str, maxWidth) {
      var words = str.split(/\s+/);
      var lines = [];
      var cur = '';
      for (var i = 0; i < words.length; i++) {
        var test = cur ? cur + ' ' + words[i] : words[i];
        if (cur && ctx.measureText(test).width > maxWidth) {
          lines.push(cur);
          cur = words[i];
        } else {
          cur = test;
        }
      }
      if (cur) lines.push(cur);
      return lines;
    }

    function setSpacing(ctx, px) {
      // letterSpacing is widely supported in evergreen browsers; ignore where
      // absent (text just renders un-tracked).
      try { ctx.letterSpacing = px + 'px'; } catch (e) { /* no-op */ }
    }

    // Draw the result to an offscreen 1000×1500 canvas and resolve a PNG Blob,
    // or null on any failure (caller falls back to the static image).
    function renderToBlob(rows, haveAnton) {
      return new Promise(function (resolve) {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = IMG_W;
          canvas.height = IMG_H;
          var ctx = canvas.getContext('2d');
          if (!ctx) { resolve(null); return; }

          var pad = 70;
          var contentW = IMG_W - pad * 2;

          // Background
          ctx.fillStyle = COLORS.bg;
          ctx.fillRect(0, 0, IMG_W, IMG_H);

          // Brand (top-left)
          ctx.textBaseline = 'alphabetic';
          ctx.textAlign = 'left';
          ctx.fillStyle = COLORS.accent;
          setSpacing(ctx, 4);
          ctx.font = '700 30px ' + MONO;
          ctx.fillText('PITMASTER.TOOLS', pad, 100);

          // Accent ticks (top-right) — three bars, brightest last.
          var tx = IMG_W - pad - 70;
          for (var t = 0; t < 3; t++) {
            ctx.globalAlpha = t === 2 ? 1 : 0.5;
            ctx.fillRect(tx + t * 27, 80, 18, 26);
          }
          ctx.globalAlpha = 1;

          // Eyebrow
          var eyebrow = (document.title.split('|')[0] || '').trim().toUpperCase().slice(0, 40);
          ctx.fillStyle = COLORS.accent;
          setSpacing(ctx, 6);
          ctx.font = '28px ' + MONO;
          ctx.fillText(eyebrow, pad, 300);

          // Headline — shrink to fit at most 3 lines.
          setSpacing(ctx, 1);
          var headline = resultTitle().toUpperCase();
          var size = 120;
          var lines;
          for (; size >= 56; size -= 6) {
            ctx.font = headlineFont(size, haveAnton);
            lines = wrapLines(ctx, headline, contentW);
            if (lines.length <= 3) break;
          }
          // Never draw more than 3 headline lines — a pathologically long
          // title would otherwise push the value rows over the CTA bar.
          if (lines.length > 3) lines = lines.slice(0, 3);
          ctx.fillStyle = COLORS.cream;
          var lineH = size * 0.98;
          var y = 300 + 70 + size;
          for (var li = 0; li < lines.length; li++) {
            ctx.fillText(lines[li], pad, y);
            y += lineH;
          }

          // Value rows — between the headline and the CTA, evenly spaced.
          setSpacing(ctx, 0);
          var ctaTop = IMG_H - 70 - 130;          // CTA bar top
          var footY = IMG_H - 60;
          // Pull the rows block up if a long headline ran past its budget, so
          // value rows always sit above the CTA bar (≥70px per row).
          var rowsTop = Math.min(y + 40, ctaTop - 50 - rows.length * 70);
          var avail = ctaTop - 50 - rowsTop;
          var rowH = Math.min(120, Math.max(70, avail / rows.length));
          var ry = rowsTop;
          for (var r = 0; r < rows.length; r++) {
            // separator rule above each row
            ctx.strokeStyle = COLORS.rule;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(pad, ry);
            ctx.lineTo(IMG_W - pad, ry);
            ctx.stroke();

            var baseline = ry + rowH * 0.66;
            ctx.font = '40px ' + MONO;
            ctx.fillStyle = COLORS.label;
            ctx.textAlign = 'left';
            ctx.fillText(clip(ctx, rows[r].label || '', contentW * 0.58), pad, baseline);

            ctx.fillStyle = COLORS.accent;
            ctx.textAlign = 'right';
            ctx.font = '700 44px ' + MONO;
            ctx.fillText(clip(ctx, rows[r].value || '', contentW * 0.42), IMG_W - pad, baseline);
            ctx.textAlign = 'left';
            ry += rowH;
          }

          // CTA bar
          ctx.fillStyle = COLORS.accent;
          ctx.fillRect(pad, ctaTop, contentW, 100);
          ctx.fillStyle = COLORS.bg;
          ctx.textAlign = 'center';
          setSpacing(ctx, 2);
          ctx.font = '700 36px ' + MONO;
          ctx.fillText('FREE AT PITMASTER.TOOLS', IMG_W / 2, ctaTop + 64);

          // Foot
          ctx.fillStyle = COLORS.muted;
          setSpacing(ctx, 3);
          ctx.font = '26px ' + MONO;
          ctx.fillText('SMOKE • GRILL • BBQ CALCULATORS', IMG_W / 2, footY);
          ctx.textAlign = 'left';
          setSpacing(ctx, 0);

          canvas.toBlob(function (blob) {
            if (blob && blob.size > 0 && blob.size <= MAX_UPLOAD_BYTES) resolve(blob);
            else resolve(null);
          }, 'image/png');
        } catch (e) {
          resolve(null);
        }
      });
    }

    function clip(ctx, str, maxWidth) {
      if (ctx.measureText(str).width <= maxWidth) return str;
      var s = str;
      while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) {
        s = s.slice(0, -1);
      }
      return s + '…';
    }

    // Upload the PNG and resolve the absolute hosted image URL, or null on
    // failure.
    function uploadPin(blob) {
      return fetch(UPLOAD_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: blob
      }).then(function (res) {
        if (!res.ok) return null;
        return res.json();
      }).then(function (data) {
        if (data && typeof data.path === 'string' && data.path.indexOf('/og/r/') === 0) {
          return location.origin + data.path;
        }
        return null;
      }).catch(function () { return null; });
    }

    // ── Button + click handling ─────────────────────────────────────────

    // Pinterest glyph, built with the DOM (no innerHTML) from a static path.
    var SVG_NS = 'http://www.w3.org/2000/svg';
    var PIN_PATH =
      'M12 0C5.37 0 0 5.37 0 12c0 5.08 3.16 9.43 7.63 11.18-.11-.95-.2-2.4.04-3.44.22-.93 1.4-5.96 1.4-5.96s-.36-.72-.36-1.78c0-1.67.97-2.92 2.18-2.92 1.03 0 1.52.77 1.52 1.7 0 1.03-.66 2.58-1 4.01-.28 1.2.6 2.18 1.78 2.18 2.14 0 3.78-2.26 3.78-5.51 0-2.88-2.07-4.9-5.02-4.9-3.42 0-5.43 2.56-5.43 5.21 0 1.03.4 2.14.89 2.74.1.12.11.22.08.34l-.33 1.37c-.05.22-.18.27-.41.16-1.53-.71-2.48-2.94-2.48-4.73 0-3.85 2.8-7.39 8.06-7.39 4.23 0 7.52 3.01 7.52 7.04 0 4.2-2.65 7.58-6.32 7.58-1.23 0-2.39-.64-2.79-1.4l-.76 2.89c-.27 1.06-1.01 2.39-1.51 3.2C9.57 23.81 10.76 24 12 24c6.63 0 12-5.37 12-12S18.63 0 12 0z';

    function pinIcon() {
      var svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      var p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', PIN_PATH);
      svg.appendChild(p);
      return svg;
    }

    var link = document.createElement('a');
    link.className = 'pin-save no-print';
    link.target = '_blank';
    link.rel = 'noopener';
    link.setAttribute('aria-label', 'Save this result to Pinterest');
    link.appendChild(pinIcon());
    var pinLabel = document.createElement('span');
    pinLabel.textContent = 'Save';
    link.appendChild(pinLabel);
    // Baseline href = static-image pin. Always navigable, so Save works even if
    // JS is disabled mid-flight or the dynamic upgrade below is skipped.
    link.href = buildHref();

    link.addEventListener('click', function (e) {
      // Keep the baseline href fresh for the no-JS / fallthrough path.
      try { link.href = buildHref(); } catch (err) { /* keep last good href */ }

      var rows = collectResultRows();
      if (!rows.length) return; // no result yet → default anchor → static pin

      // Snapshot the click-through url + description now, so the pin metadata
      // matches the canvas we render from this same `rows` snapshot — the
      // calculator's plan-url.js can rewrite location.href during the async
      // render+upload window.
      var pinUrl = location.href;
      var pinDesc = describe();

      // Open the destination tab synchronously inside the user gesture so it
      // isn't popup-blocked; we redirect it once the upload resolves. (No
      // 'noopener' here — we need the handle to set its location.)
      var win = window.open('about:blank', '_blank');
      if (!win) return; // popup blocked → let the default anchor open static pin

      e.preventDefault();
      // Sever the new tab's back-reference to us before it ever navigates to
      // pinterest.com — prevents reverse tabnabbing (we can't pass 'noopener'
      // to window.open because we need the handle to set its location).
      try { win.opener = null; } catch (err) { /* ignore */ }
      // Show a lightweight loading state in the blank tab while we render +
      // upload (textContent only — no markup injection).
      try {
        var doc = win.document;
        doc.title = 'Preparing your pin…';
        if (doc.body) {
          doc.body.style.font = '16px system-ui, sans-serif';
          doc.body.style.padding = '24px';
          doc.body.textContent = 'Preparing your pin…';
        }
      } catch (err) { /* tab navigated/closed, ignore */ }

      var fallback = function () {
        try { win.location.href = buildHref(null, pinUrl, pinDesc); } catch (err) { /* tab closed */ }
      };

      loadHeadlineFont()
        .then(function (haveAnton) { return renderToBlob(rows, haveAnton); })
        .then(function (blob) { return blob ? uploadPin(blob) : null; })
        .then(function (mediaUrl) {
          try {
            win.location.href = buildHref(mediaUrl || null, pinUrl, pinDesc);
          } catch (err) { /* tab closed */ }
        })
        .catch(fallback);
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
