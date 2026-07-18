/* table-scroll.js — border-safe edge-fade cue for horizontally scrollable
   data tables.

   Wide tables (calculator reference tables, the smoking times chart, the metro
   climate-normals table, the leaderboard) scroll sideways inside their wrapper.
   On mobile a cut-off right edge reads as "clipped", so this adds a soft shadow
   at whichever edge can still scroll, hiding it once you reach that end.

   Why JS rather than a CSS mask: these tables paint opaque cell backgrounds, so
   a background fade sits behind them and never shows; and a `mask-image` on the
   wrapper fades its border-box edge, erasing the side borders / rounded corners
   of the bordered card wrappers. The fix is an overlay on a NON-scrolling parent
   frame, on top of the table — it shows over opaque cells and leaves borders
   intact. If this script never runs, the tables still scroll; they just lose the
   cue (progressive enhancement). */
(function () {
  'use strict';
  var SELECTOR = '.table-scroll, .ref-table-wrap, .rub-table-wrap, .editorial-table-wrap, .normals-scroll';

  function decorate(scroller) {
    if (scroller.dataset.tableScrollReady) return;
    scroller.dataset.tableScrollReady = '1';

    // Wrap the scroll container in a positioned frame and add two edge overlays.
    var frame = document.createElement('div');
    frame.className = 'table-scroll-frame';
    scroller.parentNode.insertBefore(frame, scroller);
    frame.appendChild(scroller);

    var left = document.createElement('span');
    left.className = 'table-fade table-fade--l';
    left.setAttribute('aria-hidden', 'true');
    var right = document.createElement('span');
    right.className = 'table-fade table-fade--r';
    right.setAttribute('aria-hidden', 'true');
    frame.appendChild(left);
    frame.appendChild(right);

    function update() {
      var max = scroller.scrollWidth - scroller.clientWidth;
      var scrollable = max > 1;
      var x = scroller.scrollLeft;
      frame.classList.toggle('has-l', scrollable && x > 1);
      frame.classList.toggle('has-r', scrollable && x < max - 1);
    }

    scroller.addEventListener('scroll', update, { passive: true });
    if (typeof ResizeObserver === 'function') {
      // Fires when the table is populated later (leaderboard) or first revealed.
      new ResizeObserver(update).observe(scroller);
    } else {
      window.addEventListener('resize', update);
    }
    update();
  }

  function init() {
    var scrollers = document.querySelectorAll(SELECTOR);
    for (var i = 0; i < scrollers.length; i++) decorate(scrollers[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
