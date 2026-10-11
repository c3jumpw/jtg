/* Site behaviour: mobile menu, current-section highlight, the phone CTA bar,
 * and gentle scroll reveals. Shared verbatim between the Fortune 5 and Build
 * My Startup sites — if you change one, copy it to the other.
 *
 * Everything here is progressive enhancement. With JavaScript off, the nav
 * renders as a plain list of links and every section is visible. */
(function () {
  'use strict';

  var root = document.documentElement;
  var header = document.querySelector('.site-header');
  var toggle = document.querySelector('.nav-toggle');
  var menu = document.getElementById('site-menu');
  var scrim = document.querySelector('.menu-scrim');
  var desktop = window.matchMedia('(min-width: 960px)');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------- mobile menu ----------------
   * A disclosure, not a modal: focus isn't trapped, but the menu closes the
   * moment focus or a click lands anywhere outside the header. */
  function isOpen() { return toggle && toggle.getAttribute('aria-expanded') === 'true'; }

  function setOpen(open, opts) {
    if (!toggle || !menu) return;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    menu.classList.toggle('is-open', open);
    root.classList.toggle('menu-open', open);
    if (scrim) scrim.hidden = !open;
    if (open) {
      // Move focus into the menu so keyboard and screen-reader users land on
      // the first link rather than having to hunt for where it opened.
      var first = menu.querySelector('a, button');
      if (first) first.focus({ preventScroll: true });
    } else if (opts && opts.returnFocus) {
      toggle.focus({ preventScroll: true });
    }
  }

  if (toggle && menu) {
    toggle.addEventListener('click', function () { setOpen(!isOpen()); });

    // Following a link closes the menu; the browser then scrolls to the anchor.
    menu.addEventListener('click', function (e) {
      if (e.target.closest('a')) setOpen(false);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) setOpen(false, { returnFocus: true });
    });

    if (scrim) scrim.addEventListener('click', function () { setOpen(false); });

    header.addEventListener('focusout', function (e) {
      if (isOpen() && e.relatedTarget && !header.contains(e.relatedTarget)) setOpen(false);
    });

    // Rotating a tablet into landscape can cross the breakpoint with the menu
    // open; don't leave the page scroll-locked behind a menu that's gone.
    var onBreakpoint = function () { if (desktop.matches) setOpen(false); };
    if (desktop.addEventListener) desktop.addEventListener('change', onBreakpoint);
    else if (desktop.addListener) desktop.addListener(onBreakpoint);
  }

  if (!('IntersectionObserver' in window)) return;

  /* ---------------- current section in the nav ---------------- */
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.nav a[href^="#"]'));
  var byId = {};
  navLinks.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
  var tracked = Object.keys(byId).map(function (id) { return document.getElementById(id); }).filter(Boolean);

  if (tracked.length) {
    var visible = {};
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { visible[en.target.id] = en.isIntersecting; });
      // The first tracked section on screen, in document order, wins.
      var current = null;
      for (var i = 0; i < tracked.length; i++) {
        if (visible[tracked[i].id]) { current = tracked[i].id; break; }
      }
      navLinks.forEach(function (a) {
        if (byId[current] === a) a.setAttribute('aria-current', 'true');
        else a.removeAttribute('aria-current');
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    tracked.forEach(function (s) { spy.observe(s); });
  }

  /* ---------------- phone CTA bar ----------------
   * Appears once the hero's own buttons have scrolled away, and steps aside
   * when the closing CTA section or the footer is on screen, so it never
   * duplicates a button the visitor can already see. */
  var bar = document.querySelector('.mobile-cta');
  // Watch the hero's buttons rather than the whole hero: on a phone the hero
  // runs well past the first screen, and the bar should take over as soon as
  // those buttons are gone, not a screen and a half later.
  var hero = document.querySelector('.hero .actions') || document.querySelector('.hero');
  var blockers = Array.prototype.slice.call(document.querySelectorAll('.cta-band, .site-footer'));
  if (bar && hero) {
    var pastHero = false, blocked = {};
    var sync = function () {
      var anyBlocked = Object.keys(blocked).some(function (k) { return blocked[k]; });
      var show = pastHero && !anyBlocked;
      bar.classList.toggle('is-shown', show);
      // Keep it out of the tab order while it's off screen.
      bar.toggleAttribute('inert', !show);
    };
    new IntersectionObserver(function (en) {
      pastHero = !en[0].isIntersecting && en[0].boundingClientRect.top < 0;
      sync();
    }).observe(hero);
    var blockObs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { blocked[blockers.indexOf(en.target)] = en.isIntersecting; });
      sync();
    });
    blockers.forEach(function (b) { blockObs.observe(b); });
    sync();
  }

  /* ---------------- scroll reveals ----------------
   * Only for things that start below the fold. Anything already on screen at
   * load is left alone, so nothing visible ever flickers out and back in. */
  if (reduceMotion) return;
  var fold = window.innerHeight;
  var pending = Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'))
    .filter(function (el) { return el.getBoundingClientRect().top > fold; });
  if (!pending.length) return;
  pending.forEach(function (el) { el.classList.add('reveal-pending'); });
  var revealer = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      var el = en.target;
      el.classList.remove('reveal-pending');
      el.classList.add('reveal-in');
      el.addEventListener('animationend', function done(e) {
        if (e.target !== el) return; // ignore animations bubbling up from children
        el.classList.remove('reveal-in');
        el.removeEventListener('animationend', done);
      });
      revealer.unobserve(el);
    });
  }, { rootMargin: '0px 0px -8% 0px' });
  pending.forEach(function (el) { revealer.observe(el); });
})();
