/* MKC Admin — single-file SPA. */
(function () {
  'use strict';

  var app = document.getElementById('app');
  var state = {
    me: null,
    route: 'dashboard',
    routeParams: {},
    loading: false,
    toast: null,
    // caches
    reps: null, appointments: null, settings: null, availability: null // for the active rep
  };

  /* ---------- tiny DOM builder ---------- */
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    for (var k in attrs) {
      var v = attrs[k];
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.indexOf('on') === 0 && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v != null && v !== false) el.setAttribute(k, v);
    }
    (Array.isArray(kids) ? kids : (kids != null ? [kids] : [])).forEach(function (kid) {
      if (kid == null || kid === false) return;
      el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    });
    return el;
  }
  function icon(name) {
    // Simple monogram icons using unicode + CSS classes; no icon library.
    var map = { dashboard: '◆', reps: '☰', availability: '◔', meetings: '▤', bookings: '◱', settings: '⚙' };
    return h('span', { class: 'icon' }, map[name] || '•');
  }

  /* ---------- fetch wrapper ---------- */
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    opts.credentials = 'same-origin';
    if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    return fetch(path, opts).then(function (r) {
      return r.text().then(function (t) {
        var d = t ? JSON.parse(t) : null;
        if (!r.ok) throw Object.assign(new Error((d && d.error) || 'Request failed'), { status: r.status, data: d });
        return d;
      });
    });
  }

  function toast(msg, kind) {
    state.toast = { msg: msg, kind: kind || 'ok' };
    render();
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { state.toast = null; render(); }, 4000);
  }

  /* ---------- router ---------- */
  function parseHash() {
    var raw = (location.hash || '').replace(/^#\/?/, '');
    var parts = raw.split('/');
    var route = parts[0] || 'dashboard';
    var params = {};
    if (parts[1]) params.id = parts[1];
    return { route: route, params: params };
  }
  function nav(to) { location.hash = '#/' + to; }
  window.addEventListener('hashchange', function () {
    var r = parseHash(); state.route = r.route; state.routeParams = r.params; loadForRoute();
  });

  /* ---------- auth boot ---------- */
  function boot() {
    // If the URL has an error query from the auth callback, show it.
    var qs = new URLSearchParams(location.search);
    var err = qs.get('e');
    if (err) {
      history.replaceState({}, '', location.pathname);
      var msgs = { bad: 'That link was malformed.', badlink: 'That sign-in link is invalid.',
        used: 'That link has already been used. Ask for a new one.',
        expired: 'That link expired. Ask for a new one.',
        notallowed: 'This email isn’t on the admin allowlist.',
        server: 'Something went wrong. Try again.' };
      state.pendingLoginErr = msgs[err] || 'Something went wrong.';
    }
    api('/api/auth-me').then(function (d) {
      state.me = d && d.authenticated ? d : null;
      if (state.me) {
        var r = parseHash(); state.route = r.route; state.routeParams = r.params;
        render(); loadForRoute();
      } else {
        renderLogin();
      }
    }).catch(function () { renderLogin(); });
  }

  /* ---------- LOGIN ---------- */
  function renderLogin() {
    app.textContent = '';
    var emailInput = h('input', { type: 'email', id: 'em', placeholder: 'you@company.com', required: true, autofocus: true, autocomplete: 'email' });
    var submit = h('button', { class: 'btn btn-primary', type: 'button', style: 'width:100%;justify-content:center;padding:12px' }, 'Send sign-in link');
    var msg = h('div', { style: 'margin-top:14px;font-size:13px;text-align:center;color:var(--steel);min-height:20px' });
    if (state.pendingLoginErr) { msg.textContent = state.pendingLoginErr; msg.style.color = 'var(--danger)'; state.pendingLoginErr = null; }
    var busy = false;
    submit.addEventListener('click', function () {
      if (busy) return;
      var e = (emailInput.value || '').trim();
      if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) { msg.textContent = 'Please check that email address.'; msg.style.color = 'var(--danger)'; return; }
      busy = true; submit.disabled = true; submit.textContent = 'Sending…';
      api('/api/auth-request', { method: 'POST', body: { email: e } })
        .then(function (d) {
          msg.style.color = 'var(--steel)'; msg.textContent = d.message || 'If that email is authorised, a sign-in link is on the way.';
          submit.textContent = 'Link sent'; submit.style.background = 'var(--success)'; submit.style.borderColor = 'var(--success)';
        })
        .catch(function (e) {
          busy = false; submit.disabled = false; submit.textContent = 'Send sign-in link';
          msg.style.color = 'var(--danger)'; msg.textContent = e.message || 'Something went wrong.';
        });
    });
    emailInput.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') submit.click(); });

    var card = h('div', { class: 'login-card' }, [
      h('div', { class: 'brand' }, h('div', {}, 'MKC Admin')),
      h('h1', {}, 'Sign in'),
      h('p', {}, 'Enter your email. We’ll send you a one-time sign-in link, good for 15 minutes.'),
      h('div', { class: 'field', style: 'gap:10px' }, [
        h('label', { for: 'em' }, 'Work email'),
        emailInput,
        submit
      ]),
      msg
    ]);
    app.appendChild(h('div', { class: 'login-shell' }, card));
  }

  /* ---------- SHELL ---------- */
  function render() {
    if (!state.me) return renderLogin();
    app.textContent = '';
    app.appendChild(h('div', { class: 'app-shell' }, [ sidebar(), main() ]));
    if (state.toast) app.appendChild(h('div', { class: 'toast ' + state.toast.kind }, state.toast.msg));
  }

  function sidebar() {
    var links = [
      ['dashboard', 'Dashboard'],
      ['bookings', 'Bookings'],
      ['reps', 'Team'],
      ['availability', 'Availability'],
      ['meetings', 'Meeting types'],
      ['settings', 'Settings']
    ];
    return h('aside', { class: 'sidebar' }, [
      h('div', { class: 'brand' }, [
        h('span', { class: 'brand-mark' }),
        h('span', { class: 'brand-text' }, 'MKC Admin')
      ]),
      h('nav', {}, links.map(function (l) {
        return h('a', { href: '#/' + l[0], class: state.route === l[0] ? 'on' : '' }, [icon(l[0]), h('span', {}, l[1])]);
      })),
      h('div', { class: 'foot' }, [
        h('div', { class: 'who' }, state.me.fullName || state.me.email),
        h('div', {}, state.me.email),
        h('button', {
          onclick: function () {
            api('/api/auth-me?action=logout', { method: 'POST' }).finally(function () { state.me = null; renderLogin(); });
          }
        }, 'Sign out')
      ])
    ]);
  }

  function main() {
    var wrap = h('div', {});
    // Mobile nav (route switcher)
    var mn = h('div', { class: 'mobilenav' }, [
      h('span', { style: 'font:800 13px;letter-spacing:.14em;text-transform:uppercase' }, 'MKC'),
      h('select', {
        onchange: function (e) { nav(e.target.value); }
      }, ['dashboard','bookings','reps','availability','meetings','settings'].map(function (r) {
        var lbl = { dashboard:'Dashboard', bookings:'Bookings', reps:'Team', availability:'Availability', meetings:'Meeting types', settings:'Settings' }[r];
        var opt = h('option', { value: r }, lbl); if (state.route === r) opt.selected = true; return opt;
      }))
    ]);
    wrap.appendChild(mn);

    var m = h('div', { class: 'main' });
    if (state.route === 'dashboard') m.appendChild(viewDashboard());
    else if (state.route === 'bookings') m.appendChild(viewBookings());
    else if (state.route === 'reps') m.appendChild(viewReps());
    else if (state.route === 'availability') m.appendChild(viewAvailability());
    else if (state.route === 'meetings') m.appendChild(viewMeetingTypes());
    else if (state.route === 'settings') m.appendChild(viewSettings());
    else m.appendChild(h('div', { class: 'empty' }, 'Not found.'));
    wrap.appendChild(m);
    return wrap;
  }

  function loadForRoute() {
    if (!state.me) return;
    if (state.route === 'dashboard') {
      // Dashboard shows both counts — kick off appointment and rep loads together.
      state.loading = true; render();
      Promise.all([
        api('/api/appointments?filter=upcoming&limit=100').then(function (d) { state.appointments = d.appointments; }),
        state.reps ? Promise.resolve() : api('/api/reps').then(function (d) { state.reps = d.reps; })
      ]).then(function () { state.loading = false; render(); })
        .catch(function (e) { state.loading = false; toast(e.message, 'err'); });
      return;
    }
    if (state.route === 'bookings') return loadAppointments();
    if (state.route === 'reps' || state.route === 'availability') return loadReps();
    if (state.route === 'meetings' || state.route === 'settings') return loadSettings();
  }

  function loadAppointments() {
    state.loading = true; render();
    var f = state.route === 'dashboard' ? 'upcoming' : (state._bookingFilter || 'upcoming');
    api('/api/appointments?filter=' + f + '&limit=100')
      .then(function (d) { state.appointments = d.appointments; state.loading = false; render(); })
      .catch(function (e) { state.loading = false; toast(e.message, 'err'); });
  }
  function loadReps() {
    state.loading = true; render();
    api('/api/reps').then(function (d) {
      state.reps = d.reps; state.loading = false;
      // Also need meeting types for the assignment picker in the rep modal.
      if (!state.settings) return api('/api/settings').then(function (s) { state.settings = s; render(); });
      render();
    }).catch(function (e) { state.loading = false; toast(e.message, 'err'); });
  }
  function loadSettings() {
    state.loading = true; render();
    api('/api/settings').then(function (d) { state.settings = d; state.loading = false; render(); })
      .catch(function (e) { state.loading = false; toast(e.message, 'err'); });
  }

  /* ---------- VIEWS ---------- */

  function viewDashboard() {
    var wrap = h('div', {});
    wrap.appendChild(h('div', { class: 'page-head' }, [
      h('div', {}, [h('h1', {}, 'Dashboard'), h('div', { class: 'sub' }, 'Overview of upcoming bookings and team.')])
    ]));
    var appts = state.appointments || [];
    var reps = state.reps || [];
    var now = Date.now();
    var upcoming = appts.filter(function (a) { return new Date(a.starts_at).getTime() >= now && a.status === 'confirmed'; });
    var this7 = upcoming.filter(function (a) { return new Date(a.starts_at).getTime() - now <= 7 * 86400000; });
    wrap.appendChild(h('div', { class: 'grid-cards', style: 'margin-bottom:24px' }, [
      h('div', { class: 'stat' }, [ h('div', { class: 'n' }, String(upcoming.length)), h('div', { class: 'l' }, 'Upcoming') ]),
      h('div', { class: 'stat' }, [ h('div', { class: 'n' }, String(this7.length)), h('div', { class: 'l' }, 'This week') ]),
      h('div', { class: 'stat' }, [ h('div', { class: 'n' }, String(reps.filter(function(r){return r.active;}).length)), h('div', { class: 'l' }, 'Active team') ])
    ]));

    wrap.appendChild(h('div', { class: 'card' }, [
      h('h2', {}, 'Next 5 bookings'),
      upcoming.length ? bookingTable(upcoming.slice(0, 5), false) : h('div', { class: 'empty' }, 'Nothing on the calendar yet.')
    ]));
    return wrap;
  }

  function viewBookings() {
    var wrap = h('div', {});
    var filter = state._bookingFilter || 'upcoming';
    wrap.appendChild(h('div', { class: 'page-head' }, [
      h('div', {}, [h('h1', {}, 'Bookings'), h('div', { class: 'sub' }, 'Every booking, filterable.')]),
      h('div', { class: 'pill-tabs' }, ['upcoming', 'past', 'cancelled', 'all'].map(function (f) {
        return h('button', {
          class: filter === f ? 'on' : '',
          onclick: function () { state._bookingFilter = f; loadAppointments(); }
        }, f[0].toUpperCase() + f.slice(1));
      }))
    ]));
    if (state.loading) wrap.appendChild(h('div', { class: 'loading' }, 'Loading…'));
    else if (!state.appointments || state.appointments.length === 0) wrap.appendChild(h('div', { class: 'empty' }, 'No bookings in this view.'));
    else wrap.appendChild(h('div', { class: 'card' }, bookingTable(state.appointments, true)));
    return wrap;
  }

  function bookingTable(rows, allowCancel) {
    var body = rows.map(function (r) {
      var d = new Date(r.starts_at);
      var when = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' +
                 d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      var tzHint = ' ' + Intl.DateTimeFormat().resolvedOptions().timeZone;
      var statusBadge = r.status === 'confirmed'
        ? h('span', { class: 'badge on' }, r.mode === 'virtual' ? 'Virtual' : 'In person')
        : h('span', { class: 'badge off' }, r.status);
      var crm = r.crm_entry_id
        ? h('span', { class: 'badge blue', title: r.crm_entry_id }, 'CRM')
        : (r.crm_sync_error ? h('span', { class: 'badge warn', title: r.crm_sync_error }, 'CRM err') : null);
      return h('tr', {}, [
        h('td', {}, [ h('div', { style: 'font-weight:700' }, when), h('div', { style: 'font-size:12px;color:var(--steel)' }, tzHint) ]),
        h('td', {}, [
          h('div', { style: 'font-weight:600' }, r.guest_name),
          h('div', { style: 'font-size:13px;color:var(--steel)' }, [ h('a', { href: 'mailto:' + r.guest_email }, r.guest_email) ]),
          r.guest_company ? h('div', { style: 'font-size:12px;color:var(--dim)' }, r.guest_company) : null
        ]),
        h('td', {}, r.repName),
        h('td', {}, [ statusBadge, ' ', crm ]),
        allowCancel ? h('td', { class: 'row-actions' }, r.status === 'confirmed'
          ? h('button', { class: 'btn-link', onclick: cancelBooking.bind(null, r.id) }, 'Cancel')
          : null) : null
      ]);
    });
    return h('table', { class: 'data' }, [
      h('thead', {}, h('tr', {}, [
        h('th', {}, 'When'), h('th', {}, 'Guest'), h('th', {}, 'Rep'), h('th', {}, 'Status'),
        allowCancel ? h('th', { class: 'row-actions' }, '') : null
      ])),
      h('tbody', {}, body)
    ]);
  }

  function cancelBooking(id) {
    if (!confirm('Cancel this booking? The guest will not be notified from here.')) return;
    api('/api/appointments?action=cancel', { method: 'POST', body: { id: id } })
      .then(function () { toast('Booking cancelled.', 'ok'); loadAppointments(); })
      .catch(function (e) { toast(e.message, 'err'); });
  }

  function viewReps() {
    var wrap = h('div', {});
    wrap.appendChild(h('div', { class: 'page-head' }, [
      h('div', {}, [h('h1', {}, 'Team'), h('div', { class: 'sub' }, 'People who take bookings.')]),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', onclick: function () { openRepModal(null); } }, '+ Add team member'))
    ]));
    if (state.loading || !state.reps) return wrap.appendChild(h('div', { class: 'loading' }, 'Loading…')), wrap;
    if (state.reps.length === 0) return wrap.appendChild(h('div', { class: 'empty' }, 'No team members yet.')), wrap;
    var body = state.reps.map(function (r) {
      return h('tr', {}, [
        h('td', {}, [ h('div', { style: 'font-weight:700' }, r.displayName), r.title ? h('div', { style: 'font-size:12px;color:var(--steel)' }, r.title) : null ]),
        h('td', {}, [ h('a', { href: 'mailto:' + r.email }, r.email), r.phone ? h('div', { style: 'font-size:12px;color:var(--steel)' }, r.phone) : null ]),
        h('td', {}, r.timezone),
        h('td', {}, r.active ? h('span', { class: 'badge on' }, 'Active') : h('span', { class: 'badge off' }, 'Off')),
        h('td', {}, r.clickupTeamDirId ? h('span', { class: 'badge blue', title: r.clickupTeamDirId }, 'CRM') : h('span', { class: 'badge' }, '—')),
        h('td', { class: 'row-actions' }, h('button', { class: 'btn-link', onclick: function () { openRepModal(r); } }, 'Edit'))
      ]);
    });
    wrap.appendChild(h('div', { class: 'card' }, h('table', { class: 'data' }, [
      h('thead', {}, h('tr', {}, [ h('th', {}, 'Name'), h('th', {}, 'Contact'), h('th', {}, 'Timezone'), h('th', {}, 'Status'), h('th', {}, 'CRM'), h('th', {}) ])),
      h('tbody', {}, body)
    ])));
    return wrap;
  }

  function openRepModal(rep) {
    var isEdit = !!rep;
    var v = {
      displayName: rep ? rep.displayName : '',
      fullName: rep ? rep.fullName : '',
      email: rep ? rep.email : '',
      phone: rep ? rep.phone : '',
      title: rep ? rep.title : '',
      timezone: rep ? rep.timezone : 'America/New_York',
      active: rep ? rep.active : true,
      clickupTeamDirId: rep ? rep.clickupTeamDirId : '',
      meetingTypeIds: rep ? rep.meetingTypeIds : ((state.settings && state.settings.meetingTypes) || []).map(function (m) { return m.id; })
    };
    var mts = (state.settings && state.settings.meetingTypes) || [];

    var body = h('div', { class: 'form-body' }, [
      inputField('Display name', v, 'displayName', { required: true }),
      inputField('Full name', v, 'fullName', { hint: 'Used internally, defaults to display name if blank' }),
      h('div', { class: 'row' }, [ inputField('Email', v, 'email', { type: 'email', required: true }), inputField('Phone', v, 'phone', { type: 'tel' }) ]),
      inputField('Title', v, 'title', { placeholder: 'e.g., Growth Strategist' }),
      h('div', { class: 'row' }, [ tzField(v), inputField('CRM Team Directory ID', v, 'clickupTeamDirId', { hint: 'ClickUp task id — enables CRM sync on their bookings' }) ]),
      mts.length ? h('div', { class: 'field' }, [
        h('label', {}, 'Meeting types they can take'),
        h('div', { style: 'display:grid;gap:6px' }, mts.map(function (m) {
          var cb = h('input', { type: 'checkbox', onchange: function (e) {
            var s = new Set(v.meetingTypeIds);
            if (e.target.checked) s.add(m.id); else s.delete(m.id);
            v.meetingTypeIds = [...s];
          } });
          cb.checked = v.meetingTypeIds.indexOf(m.id) >= 0;
          return h('label', { style: 'display:flex;align-items:center;gap:8px;font-weight:500' }, [cb, m.name]);
        }))
      ]) : null,
      isEdit ? h('div', { class: 'field' }, [
        h('label', {}, 'Status'),
        h('label', { style: 'display:flex;align-items:center;gap:8px;font-weight:500' }, [
          (function () { var cb = h('input', { type: 'checkbox', onchange: function (e) { v.active = e.target.checked; } }); cb.checked = v.active; return cb; })(),
          'Accepting bookings'
        ])
      ]) : null
    ]);

    openModal(isEdit ? 'Edit team member' : 'Add team member',
      isEdit ? 'Update contact info, timezone or CRM link.' : 'Add a new person who can be booked. They can be linked to a CRM Team Directory record.',
      body, function (close) {
        if (!v.displayName || !v.email) { toast('Name and email are required.', 'err'); return; }
        var req = isEdit
          ? api('/api/reps?id=' + rep.id, { method: 'PATCH', body: v })
          : api('/api/reps', { method: 'POST', body: v });
        req.then(function () { close(); toast(isEdit ? 'Saved.' : 'Added.', 'ok'); loadReps(); })
          .catch(function (e) { toast(e.message, 'err'); });
      });
  }

  /* ---------- Availability view ---------- */
  function viewAvailability() {
    var wrap = h('div', {});
    wrap.appendChild(h('div', { class: 'page-head' }, [
      h('div', {}, [h('h1', {}, 'Availability'), h('div', { class: 'sub' }, 'Weekly hours and per-day overrides for each rep.')])
    ]));

    if (state.loading || !state.reps) return wrap.appendChild(h('div', { class: 'loading' }, 'Loading…')), wrap;
    if (state.reps.length === 0) return wrap.appendChild(h('div', { class: 'empty' }, 'Add a team member first.')), wrap;

    var repId = state._availRepId || state.reps[0].id;
    state._availRepId = repId;
    var rep = state.reps.find(function (r) { return r.id === repId; });

    wrap.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'field', style: 'max-width:360px' }, [
        h('label', {}, 'Rep'),
        h('select', {
          onchange: function (e) { state._availRepId = e.target.value; state.availability = null; loadAvailabilityFor(e.target.value); }
        }, state.reps.map(function (r) { var o = h('option', { value: r.id }, r.displayName + ' (' + r.timezone + ')'); if (r.id === repId) o.selected = true; return o; }))
      ])
    ]));

    if (!state.availability || state.availability.repId !== repId) {
      wrap.appendChild(h('div', { class: 'loading' }, 'Loading schedule…'));
      loadAvailabilityFor(repId);
      return wrap;
    }

    wrap.appendChild(renderScheduleEditor(rep, state.availability));
    wrap.appendChild(renderOverridesEditor(rep, state.availability));
    return wrap;
  }

  function loadAvailabilityFor(repId) {
    api('/api/availability?rep=' + repId).then(function (d) {
      state.availability = { repId: repId, rules: d.rules, overrides: d.overrides };
      render();
    }).catch(function (e) { toast(e.message, 'err'); });
  }

  function renderScheduleEditor(rep, av) {
    // Group rules by weekday for editing.
    var byDay = [[],[],[],[],[],[],[]]; // Sun..Sat
    (av.rules || []).forEach(function (r) { byDay[r.weekday].push({ start_time: r.start_time.slice(0,5), end_time: r.end_time.slice(0,5) }); });

    var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    var container = h('div', { class: 'sched-list' });
    days.forEach(function (day, i) {
      var dayEl = h('div', {});
      dayEl.appendChild(renderDayRow(day, i, byDay, container));
      container.appendChild(dayEl);
    });

    return h('div', { class: 'card' }, [
      h('h2', {}, 'Weekly hours'),
      h('div', { class: 'sub' }, 'Times are in ' + rep.timezone + '. Add multiple windows per day for split schedules.'),
      container,
      h('div', { style: 'margin-top:20px;display:flex;gap:8px;justify-content:flex-end' }, [
        h('button', { class: 'btn btn-primary', onclick: function () {
          var rules = [];
          for (var w = 0; w < 7; w++) byDay[w].forEach(function (r) { rules.push({ weekday: w, start_time: r.start_time, end_time: r.end_time }); });
          api('/api/availability?rep=' + rep.id + '&kind=rules', { method: 'PUT', body: { rules: rules } })
            .then(function () { toast('Schedule saved.', 'ok'); loadAvailabilityFor(rep.id); })
            .catch(function (e) { toast(e.message, 'err'); });
        }}, 'Save schedule')
      ])
    ]);
  }

  function renderDayRow(dayName, dayIdx, byDay, container) {
    var wrapper = h('div', { style: 'padding:14px 0;border-bottom:1px solid var(--line)' });
    var list = h('div', { class: 'sched-list' });
    function draw() {
      list.textContent = '';
      if (byDay[dayIdx].length === 0) {
        list.appendChild(h('div', { style: 'color:var(--steel);font-size:13px' }, 'Off'));
      } else {
        byDay[dayIdx].forEach(function (r, idx) {
          var st = h('input', { type: 'time', value: r.start_time, onchange: function (e) { r.start_time = e.target.value; } });
          var et = h('input', { type: 'time', value: r.end_time,   onchange: function (e) { r.end_time = e.target.value; } });
          var del = h('button', { class: 'btn btn-danger btn-icon', title: 'Remove window', onclick: function () { byDay[dayIdx].splice(idx, 1); draw(); } }, '✕');
          list.appendChild(h('div', { class: 'sched-row' }, [ h('div', { class: 'day sched-day' }, ''), st, et, del ]));
        });
      }
      list.appendChild(h('button', { class: 'btn-link', style: 'justify-self:start;font-size:13px', onclick: function () {
        byDay[dayIdx].push({ start_time: '09:00', end_time: '17:00' }); draw();
      }}, '+ Add hours'));
    }
    wrapper.appendChild(h('div', { class: 'sched-day', style: 'margin-bottom:6px' }, dayName));
    wrapper.appendChild(list);
    draw();
    return wrapper;
  }

  function renderOverridesEditor(rep, av) {
    var card = h('div', { class: 'card' });
    card.appendChild(h('h2', {}, 'Overrides'));
    card.appendChild(h('div', { class: 'sub' }, 'Override the weekly hours for a specific date. Leave times blank to mark the whole day off.'));

    var newOv = { on_date: '', start_time: '', end_time: '', note: '' };
    var newRow = h('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr 1fr auto;gap:8px;align-items:center;margin-bottom:14px' }, [
      h('input', { type: 'date', oninput: function (e) { newOv.on_date = e.target.value; } }),
      h('input', { type: 'time', placeholder: 'Start', oninput: function (e) { newOv.start_time = e.target.value; } }),
      h('input', { type: 'time', placeholder: 'End',   oninput: function (e) { newOv.end_time = e.target.value; } }),
      h('input', { type: 'text', placeholder: 'Note (optional)', maxlength: '200', oninput: function (e) { newOv.note = e.target.value; } }),
      h('button', { class: 'btn btn-primary', onclick: function () {
        if (!newOv.on_date) { toast('Pick a date.', 'err'); return; }
        var body = { on_date: newOv.on_date, note: newOv.note };
        if (newOv.start_time || newOv.end_time) { body.start_time = newOv.start_time; body.end_time = newOv.end_time; }
        else { body.start_time = null; body.end_time = null; }
        api('/api/availability?rep=' + rep.id + '&kind=override', { method: 'POST', body: body })
          .then(function () { toast('Override added.', 'ok'); loadAvailabilityFor(rep.id); })
          .catch(function (e) { toast(e.message, 'err'); });
      }}, 'Add')
    ]);
    card.appendChild(newRow);

    if (!av.overrides || av.overrides.length === 0) {
      card.appendChild(h('div', { style: 'color:var(--steel);font-size:13px;padding:12px 0' }, 'No overrides.'));
    } else {
      var body = av.overrides.map(function (o) {
        return h('tr', {}, [
          h('td', {}, o.on_date),
          h('td', {}, o.start_time ? (o.start_time.slice(0,5) + ' – ' + o.end_time.slice(0,5)) : h('span', { class: 'badge off' }, 'Off')),
          h('td', {}, o.note || ''),
          h('td', { class: 'row-actions' }, h('button', { class: 'btn-link', onclick: function () {
            if (!confirm('Remove this override?')) return;
            api('/api/availability?override=' + o.id, { method: 'DELETE' })
              .then(function () { toast('Removed.', 'ok'); loadAvailabilityFor(rep.id); })
              .catch(function (e) { toast(e.message, 'err'); });
          } }, 'Remove'))
        ]);
      });
      card.appendChild(h('table', { class: 'data' }, [
        h('thead', {}, h('tr', {}, [ h('th', {}, 'Date'), h('th', {}, 'Hours'), h('th', {}, 'Note'), h('th', {}) ])),
        h('tbody', {}, body)
      ]));
    }
    return card;
  }

  /* ---------- Meeting types ---------- */
  function viewMeetingTypes() {
    var wrap = h('div', {});
    wrap.appendChild(h('div', { class: 'page-head' }, [
      h('div', {}, [h('h1', {}, 'Meeting types'), h('div', { class: 'sub' }, 'Configure the meeting options visitors see on each booking page.')])
    ]));
    if (state.loading || !state.settings) return wrap.appendChild(h('div', { class: 'loading' }, 'Loading…')), wrap;
    var mts = state.settings.meetingTypes || [];
    var pages = state.settings.pages || [];
    var locs = state.settings.locations || [];
    if (mts.length === 0) return wrap.appendChild(h('div', { class: 'empty' }, 'No meeting types configured.')), wrap;
    mts.forEach(function (m) {
      var page = pages.find(function (p) { return p.id === m.page_id; }) || {};
      var draft = Object.assign({}, m);
      wrap.appendChild(h('div', { class: 'card' }, [
        h('h2', {}, [ page.title || page.slug, ' · ', m.mode === 'virtual' ? 'Virtual' : 'In person', '  ',
          m.active ? h('span', { class: 'badge on' }, 'Active') : h('span', { class: 'badge off' }, 'Off') ]),
        h('div', { class: 'form-body' }, [
          h('div', { class: 'row' }, [
            inputField('Name', draft, 'name'),
            numField('Duration (minutes)', draft, 'duration_min', 10, 240)
          ]),
          inputField('Description', draft, 'description', { textarea: true }),
          h('div', { class: 'row' }, [
            numField('Buffer before (min)', draft, 'buffer_before_min', 0, 120),
            numField('Buffer after (min)', draft, 'buffer_after_min', 0, 120)
          ]),
          h('div', { class: 'row' }, [
            numField('Min notice (hours)', draft, 'min_notice_hours', 0, 720),
            numField('Max days ahead', draft, 'max_days_ahead', 1, 365)
          ]),
          h('div', { class: 'row' }, [
            numField('Slot step (min)', draft, 'slot_step_min', 5, 120),
            m.mode === 'in_person' ? h('div', { class: 'field' }, [
              h('label', {}, 'Location'),
              (function () {
                var sel = h('select', { onchange: function (e) { draft.location_id = e.target.value || null; } }, [
                  h('option', { value: '' }, 'None')
                ].concat(locs.map(function (l) { var o = h('option', { value: l.id }, l.name); if (l.id === draft.location_id) o.selected = true; return o; })));
                return sel;
              })()
            ]) : h('div', {})
          ]),
          h('label', { style: 'display:flex;align-items:center;gap:8px;font-weight:500' }, [
            (function () { var cb = h('input', { type: 'checkbox', onchange: function (e) { draft.active = e.target.checked; } }); cb.checked = draft.active; return cb; })(),
            'Active'
          ]),
          h('div', { style: 'display:flex;gap:8px;justify-content:flex-end' }, h('button', { class: 'btn btn-primary', onclick: function () {
            api('/api/settings?kind=meeting-type&id=' + m.id, { method: 'PATCH', body: draft })
              .then(function () { toast('Saved.', 'ok'); loadSettings(); })
              .catch(function (e) { toast(e.message, 'err'); });
          }}, 'Save changes'))
        ])
      ]));
    });
    return wrap;
  }

  function viewSettings() {
    var wrap = h('div', {});
    wrap.appendChild(h('div', { class: 'page-head' }, [
      h('div', {}, [h('h1', {}, 'Settings'), h('div', { class: 'sub' }, 'Pages and physical locations.')])
    ]));
    if (state.loading || !state.settings) return wrap.appendChild(h('div', { class: 'loading' }, 'Loading…')), wrap;
    var pages = state.settings.pages || [];
    var locs = state.settings.locations || [];

    // Pages (read-only for now — booking.pages is seeded via SQL for v1)
    wrap.appendChild(h('div', { class: 'card' }, [
      h('h2', {}, 'Booking pages'),
      h('div', { class: 'sub' }, 'Read-only in v1. Add a page in the database when you add a new brand.'),
      pages.length ? h('table', { class: 'data' }, [
        h('thead', {}, h('tr', {}, [ h('th', {}, 'Slug'), h('th', {}, 'Host'), h('th', {}, 'Title'), h('th', {}, 'Status') ])),
        h('tbody', {}, pages.map(function (p) { return h('tr', {}, [
          h('td', {}, p.slug), h('td', {}, p.host), h('td', {}, p.title),
          h('td', {}, p.active ? h('span', { class: 'badge on' }, 'Active') : h('span', { class: 'badge off' }, 'Off'))
        ]); }))
      ]) : h('div', { class: 'empty' }, 'No pages.')
    ]));

    // Locations
    var newLoc = { name: '', address: '', notes: '' };
    wrap.appendChild(h('div', { class: 'card' }, [
      h('h2', {}, 'Locations'),
      h('div', { class: 'sub' }, 'Add a physical location before enabling the in-person meeting type.'),
      locs.length ? h('table', { class: 'data', style: 'margin-bottom:16px' }, [
        h('thead', {}, h('tr', {}, [ h('th', {}, 'Name'), h('th', {}, 'Address'), h('th', {}, 'Notes') ])),
        h('tbody', {}, locs.map(function (l) { return h('tr', {}, [ h('td', {}, l.name), h('td', {}, l.address), h('td', {}, l.notes || '') ]); }))
      ]) : h('div', { class: 'empty', style: 'margin-bottom:16px' }, 'No locations yet.'),
      h('div', { style: 'padding-top:12px;border-top:1px solid var(--line)' }, [
        h('h2', { style: 'margin-top:0;font-size:14px' }, 'Add a location'),
        h('div', { class: 'form-body' }, [
          h('div', { class: 'row' }, [
            inputField('Name', newLoc, 'name', { placeholder: 'Atlanta HQ' }),
            inputField('Address', newLoc, 'address', { placeholder: '123 Peachtree St NE, Atlanta GA' })
          ]),
          inputField('Notes', newLoc, 'notes', { placeholder: 'Parking, floor, etc.', textarea: true }),
          h('div', { style: 'display:flex;justify-content:flex-end' }, h('button', { class: 'btn btn-primary', onclick: function () {
            api('/api/settings?kind=location', { method: 'POST', body: newLoc })
              .then(function () { toast('Location added.', 'ok'); loadSettings(); })
              .catch(function (e) { toast(e.message, 'err'); });
          }}, 'Add location'))
        ])
      ])
    ]));
    return wrap;
  }

  /* ---------- Reusable form fields ---------- */

  function inputField(label, obj, key, opts) {
    opts = opts || {};
    var el;
    if (opts.textarea) {
      el = h('textarea', { rows: '3', oninput: function (e) { obj[key] = e.target.value; } });
      el.value = obj[key] || '';
    } else {
      el = h('input', { type: opts.type || 'text', placeholder: opts.placeholder || '', oninput: function (e) { obj[key] = e.target.value; } });
      el.value = obj[key] || '';
      if (opts.required) el.required = true;
    }
    return h('div', { class: 'field' }, [
      h('label', {}, [label, ' ', opts.required ? h('span', { class: 'opt' }, '(required)') : (opts.hint ? h('span', { class: 'opt' }, '· ' + opts.hint) : null)]),
      el
    ]);
  }

  function numField(label, obj, key, min, max) {
    var el = h('input', { type: 'number', min: String(min), max: String(max), oninput: function (e) { obj[key] = parseInt(e.target.value, 10) || 0; } });
    el.value = obj[key];
    return h('div', { class: 'field' }, [ h('label', {}, label), el ]);
  }

  function tzField(obj) {
    // Small curated list plus the current value if not in the list.
    var zones = ['America/New_York','America/Chicago','America/Denver','America/Los_Angeles','America/Phoenix','America/Anchorage','Pacific/Honolulu','Europe/London','Europe/Paris','Asia/Dubai','Asia/Kolkata','Asia/Singapore','Asia/Tokyo','Australia/Sydney'];
    if (obj.timezone && zones.indexOf(obj.timezone) < 0) zones.unshift(obj.timezone);
    var sel = h('select', { onchange: function (e) { obj.timezone = e.target.value; } }, zones.map(function (z) { var o = h('option', { value: z }, z); if (z === obj.timezone) o.selected = true; return o; }));
    return h('div', { class: 'field' }, [ h('label', {}, 'Timezone'), sel ]);
  }

  /* ---------- Modal ---------- */
  function openModal(title, sub, body, onSave) {
    var back = h('div', { class: 'modal-back', onclick: function (e) { if (e.target === back) close(); } });
    function close() { back.remove(); }
    var m = h('div', { class: 'modal' }, [
      h('h2', {}, title),
      sub ? h('p', { class: 'sub' }, sub) : null,
      body,
      h('div', { class: 'modal-actions' }, [
        h('button', { class: 'btn btn-secondary', onclick: close }, 'Cancel'),
        h('button', { class: 'btn btn-primary', onclick: function () { onSave(close); } }, 'Save')
      ])
    ]);
    back.appendChild(m);
    document.body.appendChild(back);
  }

  /* ---------- boot ---------- */
  boot();
})();
