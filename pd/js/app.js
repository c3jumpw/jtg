/* The Party Designers — page behaviour.
   1. Header gets a hairline once the page scrolls.
   2. "Ask about an event website" (and any [data-need] link) pre-ticks that option in the form.
   3. The event date suggests a turnaround (today -> same-day, tomorrow -> next-day) until the visitor picks one.
   4. The request form posts JSON to /api/contact and shows a clear result. */

(function () {
  'use strict';

  // ---------- 1. Header hairline ----------
  var header = document.querySelector('.site-header');
  if (header) {
    var onScroll = function () { header.classList.toggle('is-stuck', window.scrollY > 8); };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  var form = document.getElementById('request-form');
  if (!form) return;

  var statusEl = document.getElementById('form-status');
  var doneEl = document.getElementById('request-done');
  var submitBtn = form.querySelector('button[type="submit"]');

  // ---------- 2. Pre-tick a need from links ----------
  document.querySelectorAll('[data-need]').forEach(function (link) {
    link.addEventListener('click', function () {
      var value = link.getAttribute('data-need');
      form.querySelectorAll('input[name="needs"]').forEach(function (box) {
        if (box.value === value) box.checked = true;
      });
    });
  });

  // ---------- 3. Turnaround suggestion from the event date ----------
  var dateInput = document.getElementById('f-date');
  var hint = document.getElementById('turn-hint');
  var turnChosenByVisitor = false;

  function localISO(d) {
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }
  var today = new Date();
  var tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (dateInput) dateInput.min = localISO(today);

  form.querySelectorAll('input[name="turnaround"]').forEach(function (r) {
    r.addEventListener('change', function (e) {
      if (e.isTrusted) { turnChosenByVisitor = true; if (hint) hint.textContent = ''; }
    });
  });

  function setTurn(value) {
    var radio = form.querySelector('input[name="turnaround"][value="' + value + '"]');
    if (radio) radio.checked = true;
  }

  if (dateInput) {
    dateInput.addEventListener('change', function () {
      if (turnChosenByVisitor || !hint) return;
      var v = dateInput.value;
      if (v === localISO(today)) {
        setTurn('same-day');
        hint.textContent = 'Your event is today, so we’ve picked same-day.';
      } else if (v === localISO(tomorrow)) {
        setTurn('next-day');
        hint.textContent = 'Your event is tomorrow, so we’ve picked next-day.';
      } else if (v && v > localISO(tomorrow)) {
        setTurn('flexible');
        hint.textContent = '';
      } else {
        hint.textContent = '';
      }
    });
  }

  // ---------- 4. Submit ----------
  var MESSAGES = {
    name: 'Add your name so we know who to reply to.',
    email: 'Check your email address. We reply by email.',
    message: 'Tell us a little about the event and what you need.'
  };

  function fieldOf(input) { return input.closest('.field'); }

  function clearError(input) {
    var field = fieldOf(input);
    if (!field) return;
    field.classList.remove('is-invalid');
    input.removeAttribute('aria-invalid');
    var err = field.querySelector('.field__error');
    if (err) err.remove();
    input.removeAttribute('aria-describedby');
  }

  function showError(input, text) {
    var field = fieldOf(input);
    if (!field) return;
    clearError(input);
    field.classList.add('is-invalid');
    input.setAttribute('aria-invalid', 'true');
    var err = document.createElement('p');
    err.className = 'field__error';
    err.id = input.id + '-error';
    err.textContent = text;
    field.appendChild(err);
    input.setAttribute('aria-describedby', err.id);
  }

  ['f-name', 'f-email', 'f-msg'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('input', function () { clearError(el); });
  });

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.classList.toggle('is-error', !!isError);
  }

  function validate() {
    var name = form.elements.name;
    var email = form.elements.email;
    var message = form.elements.message;
    var firstBad = null;
    if (!name.value.trim()) { showError(name, MESSAGES.name); firstBad = firstBad || name; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value.trim())) { showError(email, MESSAGES.email); firstBad = firstBad || email; }
    if (!message.value.trim()) { showError(message, MESSAGES.message); firstBad = firstBad || message; }
    if (firstBad) firstBad.focus();
    return !firstBad;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    setStatus('', false);
    if (!validate()) {
      setStatus('Fix the highlighted fields, then send again.', true);
      return;
    }

    var needs = Array.prototype.map.call(form.querySelectorAll('input[name="needs"]:checked'), function (b) { return b.value; });
    var turn = form.querySelector('input[name="turnaround"]:checked');
    var payload = {
      name: form.elements.name.value,
      email: form.elements.email.value,
      phone: form.elements.phone.value,
      company: form.elements.company.value,
      eventName: form.elements.eventName.value,
      eventDate: form.elements.eventDate.value,
      needs: needs,
      turnaround: turn ? turn.value : '',
      message: form.elements.message.value,
      website: form.elements.website.value,
      page: window.location.href
    };

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';

    fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) { return { ok: res.ok, body: body }; });
      })
      .then(function (r) {
        if (!r.ok) throw new Error((r.body && r.body.error) || 'The request didn’t send. Try again in a moment.');
        document.getElementById('done-email').textContent = payload.email.trim();
        form.hidden = true;
        doneEl.hidden = false;
        doneEl.focus();
      })
      .catch(function (err) {
        var msg = err && err.message && err.message !== 'Failed to fetch'
          ? err.message
          : 'The request didn’t send. Check your connection and try again.';
        setStatus(msg, true);
      })
      .then(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send request';
      });
  });

  document.getElementById('send-another').addEventListener('click', function () {
    form.reset();
    turnChosenByVisitor = false;
    if (hint) hint.textContent = '';
    setStatus('', false);
    doneEl.hidden = true;
    form.hidden = false;
    form.elements.name.focus();
  });
})();
