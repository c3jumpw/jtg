/* Media BC — menu + form. Part of Jump Tech Group. No dependencies.
 * The form posts to the Jump Tech Group endpoint named in its data-endpoint attribute, which sends
 * the email through JTG's Resend account (see SETUP.md). */
(function () {
  'use strict';

  /* ---------- Mobile menu ---------- */
  var header = document.querySelector('.site-header');
  var navToggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('site-nav');

  function setMenu(open, refocus) {
    header.classList.toggle('is-open', open);
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open && refocus) navToggle.focus();
  }
  function menuOpen() { return header.classList.contains('is-open'); }

  if (header && navToggle && nav) {
    navToggle.addEventListener('click', function () { setMenu(!menuOpen()); });
    nav.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('a')) setMenu(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && menuOpen()) setMenu(false, true); });
    document.addEventListener('click', function (e) { if (menuOpen() && !header.contains(e.target)) setMenu(false); });
    header.addEventListener('focusout', function (e) {
      if (menuOpen() && e.relatedTarget && !header.contains(e.relatedTarget)) setMenu(false);
    });
    var wide = window.matchMedia('(min-width: 821px)');
    var onWide = function (mq) { if (mq.matches) setMenu(false); };
    if (wide.addEventListener) wide.addEventListener('change', onWide);
    else if (wide.addListener) wide.addListener(onWide);
  }

  /* ---------- Links that pre-pick an interest chip (data-pick="value") ---------- */
  document.addEventListener('click', function (e) {
    var link = e.target.closest && e.target.closest('[data-pick]');
    if (!link) return;
    var box = document.querySelector('.chip input[value="' + link.getAttribute('data-pick') + '"]');
    if (box) box.checked = true;
  });

  var year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());

  /* ---------- Form ---------- */
  var form = document.getElementById('lead-form');
  if (!form) return;
  var status = document.getElementById('form-status');
  var submit = form.querySelector('[type="submit"]');
  var submitLabel = submit.querySelector('span') || submit;
  var idleLabel = submitLabel.textContent;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var kind = form.getAttribute('data-kind') || 'contact';

  function field(n) { return form.elements.namedItem(n); }
  function val(n) { var f = field(n); return f && typeof f.value === 'string' ? f.value.trim() : ''; }
  function setStatus(msg, isError) {
    status.textContent = msg || '';
    status.classList.toggle('form__status--error', !!isError);
  }
  function mark(f, bad) { if (!f) return; if (bad) f.setAttribute('aria-invalid', 'true'); else f.removeAttribute('aria-invalid'); }
  function picked() {
    return Array.prototype.map.call(form.querySelectorAll('.chip input:checked'), function (b) { return b.value; });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var data = {
      site: form.getAttribute('data-site'),
      branch: form.getAttribute('data-branch'),
      email: val('email'),
      website: val('website'),
      page: location.href
    };
    var problems = [];
    var badEmail = !EMAIL_RE.test(data.email);
    mark(field('email'), badEmail);

    if (kind === 'subscribe') {
      data.name = val('name');
      data.interests = picked();
      if (badEmail) problems.push([field('email'), 'Check your email address.']);
    } else {
      data.name = val('name');
      data.phone = val('phone');
      data.company = val('company');
      data.interest = picked().join(', ');
      data.message = val('message');
      mark(field('name'), !data.name);
      mark(field('message'), !data.message);
      if (!data.name) problems.push([field('name'), 'Add your name so we know who to reply to.']);
      if (badEmail) problems.push([field('email'), 'Check your email address. We reply by email.']);
      if (!data.message) problems.push([field('message'), 'Add a short note about what you need.']);
    }
    if (problems.length) {
      setStatus(problems[0][1], true);
      problems[0][0].focus();
      return;
    }

    submit.disabled = true;
    submitLabel.textContent = 'Sending…';
    setStatus('');

    fetch(form.getAttribute('data-endpoint'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) { return { ok: res.ok, body: body }; });
      })
      .then(function (r) {
        if (!r.ok) throw new Error(r.body && r.body.error ? r.body.error : 'That didn’t send. Try again in a moment.');
        var first = (data.name || '').split(' ')[0];
        var done = document.createElement('div');
        done.className = 'form-done';
        done.setAttribute('tabindex', '-1');
        done.setAttribute('role', 'status');
        var icon = document.createElement('div');
        icon.className = 'form-done__icon';
        icon.innerHTML = '<svg class="icon" aria-hidden="true" focusable="false"><use href="/assets/icons.svg#i-check"></use></svg>';
        var h = document.createElement('h3');
        var p = document.createElement('p');
        if (kind === 'subscribe') {
          h.textContent = first ? 'You’re on the list, ' + first + '.' : 'You’re on the list.';
          p.textContent = 'We’ll email ' + data.email + ' when the first stories go live. Check your inbox for a confirmation.';
        } else {
          h.textContent = 'Message sent';
          p.textContent = 'Thanks' + (first ? ', ' + first : '') + '. We’ll reply to ' + data.email + ' soon. A copy of your message is on its way to your inbox.';
        }
        done.appendChild(icon); done.appendChild(h); done.appendChild(p);
        form.replaceWith(done);
        done.focus();
      })
      .catch(function (err) {
        submit.disabled = false;
        submitLabel.textContent = idleLabel;
        setStatus(err && err.message && err.message !== 'Failed to fetch'
          ? err.message
          : 'That didn’t send. Check your connection and try again.', true);
      });
  });

})();
