(function initSiteHeader(){
  var MOBILE_BREAKPOINT = 700;

  function closeDropdowns(scope) {
    var dropdowns = (scope || document).querySelectorAll('.nav-dropdown');
    dropdowns.forEach(function(dropdown){
      dropdown.classList.remove('is-open');
      var trigger = dropdown.querySelector('.nav-dropdown__trigger');
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
    });
  }

  function setupHeader(header) {
    var nav = header.querySelector('.header-nav, .nav-links');
    if (!nav || header.querySelector('.menu-toggle')) return;
    var unitControls = header.querySelector('.unit-controls');
    var unitParent = unitControls ? unitControls.parentNode : null;
    var unitNextSibling = unitControls ? unitControls.nextSibling : null;

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu-toggle';
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', 'Open menu');
    button.innerHTML = '<span class="menu-toggle__bars" aria-hidden="true"><span></span><span></span><span></span></span>';

    nav.parentNode.insertBefore(button, nav);

    function placeUnitControls() {
      if (!unitControls || !unitParent) return;
      if (window.innerWidth <= MOBILE_BREAKPOINT) {
        if (unitControls.parentNode !== nav) nav.insertBefore(unitControls, nav.firstChild);
      } else if (unitControls.parentNode !== unitParent) {
        unitParent.insertBefore(unitControls, unitNextSibling);
      }
    }

    function closeMenu(restoreFocus) {
      nav.classList.remove('is-open');
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-label', 'Open menu');
      closeDropdowns(nav);
      if (restoreFocus) button.focus();
    }

    function openMenu() {
      nav.classList.add('is-open');
      button.setAttribute('aria-expanded', 'true');
      button.setAttribute('aria-label', 'Close menu');
    }

    button.addEventListener('click', function(event){
      event.stopPropagation();
      if (nav.classList.contains('is-open')) {
        closeMenu();
      } else {
        openMenu();
      }
    });

    nav.querySelectorAll('a').forEach(function(link){
      link.addEventListener('click', function(){
        if (window.innerWidth <= MOBILE_BREAKPOINT) closeMenu();
      });
    });

    nav.querySelectorAll('.nav-dropdown').forEach(function(dropdown){
      var trigger = dropdown.querySelector('.nav-dropdown__trigger');
      if (!trigger) return;

      trigger.addEventListener('click', function(event){
        event.stopPropagation();

        var isOpen = dropdown.classList.contains('is-open');
        closeDropdowns(nav);

        if (!isOpen) {
          dropdown.classList.add('is-open');
          trigger.setAttribute('aria-expanded', 'true');
        }
      });
    });

    document.addEventListener('click', function(event){
      if (!header.contains(event.target)) {
        // Always close open dropdowns (resets aria-expanded on desktop too)
        closeDropdowns();
        // Only collapse the mobile nav on small screens
        if (window.innerWidth <= MOBILE_BREAKPOINT) closeMenu();
      }
    });

    document.addEventListener('keydown', function(event){
      if (event.key !== 'Escape') return;

      if (nav.classList.contains('is-open')) {
        closeMenu(true);
        return;
      }

      var openDropdown = nav.querySelector('.nav-dropdown.is-open');
      if (openDropdown) {
        closeDropdowns(nav);
        var trigger = openDropdown.querySelector('.nav-dropdown__trigger');
        if (trigger) trigger.focus();
      }
    });

    window.addEventListener('resize', function(){
      if (window.innerWidth > MOBILE_BREAKPOINT) closeMenu();
      placeUnitControls();
    });

    placeUnitControls();
  }

  // ── Active-nav marking ────────────────────────────────────────────────────
  // Mark header/footer nav anchors that point at the current page with
  // aria-current="page", and tag any containing nav-dropdown trigger with
  // .is-current. Lets shared partials stay static — pages don't need to
  // hand-mark their own location in the nav.
  //
  // markActiveLinks() runs once on script load (which is at end-of-body via
  // INJECT:site-header.js:script, so the DOM is fully parsed). It does NOT
  // re-run on history.pushState or hash changes; if the site ever adds
  // client-side routing, this needs to wire up a popstate/click handler that
  // re-invokes it after each navigation.
  function normalizePath(p) {
    if (!p) return '/';
    // Strip trailing slash so '/about/' and '/about' match. Strip .html so
    // the clean-URL form ('/about') matches '/about.html'. Strip a trailing
    // '/index' so '/smoke-weather/index.html' matches '/smoke-weather/'.
    var clean = p.replace(/\/$/, '') || '/';
    if (clean.endsWith('.html')) clean = clean.slice(0, -5);
    if (clean.endsWith('/index')) clean = clean.slice(0, -6) || '/';
    return clean;
  }

  function markActiveLinks() {
    var current = normalizePath(window.location.pathname);
    document.querySelectorAll('header nav a[href], footer nav a[href]').forEach(function(link) {
      var url;
      try { url = new URL(link.getAttribute('href'), window.location.href); }
      catch (e) { return; }
      if (url.origin !== window.location.origin) return;
      if (normalizePath(url.pathname) !== current) return;
      link.setAttribute('aria-current', 'page');
      var dropdown = link.closest('.nav-dropdown');
      if (dropdown) {
        var trigger = dropdown.querySelector('.nav-dropdown__trigger');
        if (trigger) trigger.classList.add('is-current');
      }
    });
  }

  document.querySelectorAll('header').forEach(setupHeader);
  markActiveLinks();
})();
