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

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu-toggle';
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', 'Open menu');
    button.innerHTML = '<span class="menu-toggle__bars" aria-hidden="true"><span></span><span></span><span></span></span>';

    nav.parentNode.insertBefore(button, nav);

    function closeMenu() {
      nav.classList.remove('is-open');
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-label', 'Open menu');
      closeDropdowns(nav);
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

    document.addEventListener('click', function(event){
      if (!header.contains(event.target)) {
        // Always close open dropdowns (resets aria-expanded on desktop too)
        closeDropdowns();
        // Only collapse the mobile nav on small screens
        if (window.innerWidth <= MOBILE_BREAKPOINT) closeMenu();
      }
    });

    document.addEventListener('keydown', function(event){
      if (event.key === 'Escape') closeMenu();
    });

    window.addEventListener('resize', function(){
      if (window.innerWidth > MOBILE_BREAKPOINT) closeMenu();
    });
  }

  document.querySelectorAll('header').forEach(setupHeader);
})();
