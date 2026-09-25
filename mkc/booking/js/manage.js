/* Manage booking flow — view + cancel. */
(function () {
  'use strict';
  var app = document.getElementById('app');
  var token = new URLSearchParams(location.search).get('t') || '';

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    for (var k in attrs) {
      if (k === 'class') el.className = attrs[k];
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (attrs[k] === true) el.setAttribute(k, '');
      else if (attrs[k] != null && attrs[k] !== false) el.setAttribute(k, attrs[k]);
    }
    (Array.isArray(kids) ? kids : (kids != null ? [kids] : [])).forEach(function (kid) {
      if (kid == null || kid === false) return;
      el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    });
    return el;
  }

  function render(state) {
    app.textContent = '';
    if (state.loading) return app.appendChild(h('div', { class: 'load' }, 'Loading…'));
    if (state.error) return app.appendChild(h('div', { class: 'err-box' }, state.error));
    var a = state.appointment;
    var when = new Date(a.starts_at);
    var tz = a.guest_timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    var dateStr = when.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: tz });
    var timeStr = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: tz });

    var card = h('div', { class: 'card' });
    card.appendChild(h('h1', {}, a.status === 'cancelled' ? 'This booking was cancelled.' : 'Your booking'));
    card.appendChild(h('div', { class: 'summary' }, [
      h('div', { class: 'k' }, a.mode === 'virtual' ? 'Virtual meeting' : 'In-person meeting'),
      h('div', { class: 'v' }, dateStr + ' · ' + timeStr),
      h('div', { class: 'm' }, a.durationMin + ' minutes' + (a.location_text ? ' · ' + a.location_text : ''))
    ]));

    if (a.status !== 'confirmed') {
      card.appendChild(h('p', { style: 'color:var(--steel);font-size:14px' }, 'No further action needed.'));
      return app.appendChild(card);
    }
    if (state.cancelled) {
      card.appendChild(h('p', { style: 'color:var(--steel)' }, 'Cancelled. You should get an email confirmation shortly.'));
      return app.appendChild(card);
    }

    var reason = h('textarea', { rows: '3', placeholder: 'Anything you\'d like us to know? (optional)' });
    card.appendChild(h('div', { class: 'field' }, [
      h('label', {}, 'Cancel this booking?'),
      reason
    ]));
    card.appendChild(h('div', { class: 'actions' }, [
      h('a', { href: 'https://befortune5.com', class: 'btn-link' }, '← Back to Fortune 5'),
      h('button', {
        class: 'btn btn-primary', type: 'button',
        onclick: function () {
          if (!confirm('Cancel this meeting?')) return;
          fetch('/api/appointments?action=cancel', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: token, reason: reason.value.trim() })
          }).then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Failed'); return d; }); })
            .then(function () { state.cancelled = true; render(state); })
            .catch(function (e) { state.error = e.message; render(state); });
        }
      }, 'Cancel meeting')
    ]));
    app.appendChild(card);
  }

  if (!token) { app.textContent = ''; app.appendChild(h('div', { class: 'err-box' }, 'This link is missing its token.')); return; }
  var state = { loading: true };
  render(state);
  fetch('/api/appointments?t=' + encodeURIComponent(token))
    .then(function (r) { return r.text().then(function (t) { var d = t ? JSON.parse(t) : null; if (!r.ok) throw new Error((d && d.error) || 'Failed'); return d; }); })
    .then(function (d) { render({ appointment: d.appointment }); })
    .catch(function (e) { render({ error: e.message }); });
})();
