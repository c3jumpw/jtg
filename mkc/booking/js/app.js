/* Booking flow — meeting type → date → time → details → done. */
(function () {
  'use strict';

  var CFG = window.MKC_BOOKING || { pageSlug: 'fortune5' };
  var TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  var USE_24H = /^[A-Z]{2}$/.test(navigator.language) ? false : /^(de|fr|es|it|nl|pl|sv|no|da|fi|cs|hu|ro|pt|ru|tr|ja|ko|zh)/i.test(navigator.language || '');

  var state = {
    page: null, meetingTypes: null,
    meetingType: null,
    monthAnchor: null,           // Date pointing at the 1st of the visible month
    days: {},                    // 'YYYY-MM-DD' -> slots for this month
    availabilityLoadedFor: null, // ISO month string
    date: null, slot: null,
    guest: { name: '', email: '', phone: '', company: '', notes: '' },
    consent: false,
    step: 1,                     // 1 type, 2 pick, 3 details, 4 done
    submitting: false, error: '', result: null,
    tz: TZ, use24h: USE_24H
  };
  var app = document.getElementById('app');

  /* -------- utilities -------- */
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    for (var k in attrs) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'html') el.innerHTML = attrs[k];
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

  function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function monthKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
  function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }
  function isSameDay(a, b) { return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }

  function fmtDate(d) { return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }); }
  function fmtMonth(d) { return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); }
  function fmtSlot(iso) {
    return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: !state.use24h, timeZone: state.tz });
  }
  function fmtTz() {
    try {
      var parts = new Intl.DateTimeFormat(undefined, { timeZone: state.tz, timeZoneName: 'short' }).formatToParts(new Date());
      var name = parts.find(function (p) { return p.type === 'timeZoneName'; });
      return (name ? name.value + ' · ' : '') + state.tz;
    } catch (_) { return state.tz; }
  }

  function api(path, body, method) {
    var opts = { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    return fetch(path, opts).then(function (r) {
      return r.text().then(function (t) {
        var data = t ? JSON.parse(t) : null;
        if (!r.ok) throw new Error((data && data.error) || 'Something went wrong.');
        return data;
      });
    });
  }

  /* -------- data loads -------- */
  function loadPage() {
    return api('/api/page?slug=' + encodeURIComponent(CFG.pageSlug)).then(function (d) {
      state.page = d.page;
      state.meetingTypes = d.meeting_types || [];
      if (state.meetingTypes.length === 1) {
        state.meetingType = state.meetingTypes[0];
        state.step = 2;
      }
    });
  }

  function loadAvailabilityForMonth(anchor) {
    var key = monthKey(anchor);
    if (state.availabilityLoadedFor === key) return Promise.resolve();
    var from = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    var to = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
    // For the month that contains today, start from now so the API doesn't return in-the-past days.
    var today = new Date(); today.setHours(0, 0, 0, 0);
    if (from < today) from = today;
    return api('/api/availability', {
      meetingTypeId: state.meetingType.id,
      from: from.toISOString(), to: to.toISOString()
    }).then(function (out) {
      state.days = {};
      (out.days || []).forEach(function (d) { state.days[d.date] = d.slots; });
      state.availabilityLoadedFor = key;
    });
  }

  /* -------- render root -------- */
  function render() {
    app.textContent = '';
    var frag = document.createDocumentFragment();
    if (!state.page) { frag.appendChild(h('div', { class: 'load' }, 'Loading…')); app.appendChild(frag); return; }

    frag.appendChild(h('h1', {}, state.page.title));
    if (state.page.intro) frag.appendChild(h('p', { class: 'lede' }, state.page.intro));

    frag.appendChild(renderSteps());
    if (state.error) frag.appendChild(h('div', { class: 'err-box' }, state.error));

    if (state.step === 1) frag.appendChild(renderPickType());
    else if (state.step === 2) frag.appendChild(renderPickTime());
    else if (state.step === 3) frag.appendChild(renderDetails());
    else if (state.step === 4) frag.appendChild(renderDone());

    app.appendChild(frag);
  }

  function renderSteps() {
    var totalSteps = state.meetingTypes && state.meetingTypes.length > 1 ? 4 : 3;
    var current = state.step;
    if (totalSteps === 3 && current > 1) current = current - 1;
    var wrap = h('div', { class: 'steps' });
    for (var i = 1; i <= totalSteps; i++) {
      var cls = 'step-tick';
      if (i < current) cls += ' done'; else if (i === current) cls += ' on';
      wrap.appendChild(h('span', { class: cls }));
    }
    return wrap;
  }

  /* -------- step 1: pick meeting type -------- */
  function renderPickType() {
    var card = h('div', { class: 'card' });
    card.appendChild(h('h2', { style: 'margin:0 0 16px;font-size:22px' }, 'How would you like to meet?'));
    var grid = h('div', { class: 'mt-grid' });
    state.meetingTypes.forEach(function (mt) {
      var meta = mt.duration_min + ' min';
      if (mt.mode === 'in_person' && mt.location) meta += ' · ' + mt.location.name;
      grid.appendChild(h('button', {
        type: 'button', class: 'mt-chip',
        onclick: function () { state.meetingType = mt; state.step = 2; state.error = ''; render(); loadMonth(new Date()); }
      }, [
        h('div', { class: 'mt-mode' }, mt.mode === 'virtual' ? 'Virtual' : 'In person'),
        h('div', { class: 'mt-name' }, mt.name),
        mt.description ? h('div', { class: 'mt-desc' }, mt.description) : null,
        h('div', { class: 'mt-meta' }, meta)
      ]));
    });
    card.appendChild(grid);
    return card;
  }

  /* -------- step 2: pick date + time -------- */
  function loadMonth(anchor) {
    state.monthAnchor = firstOfMonth(anchor);
    render();
    loadAvailabilityForMonth(state.monthAnchor).then(render).catch(function (e) { state.error = e.message; render(); });
  }

  function renderPickTime() {
    var mt = state.meetingType;
    var card = h('div', { class: 'card' });
    card.appendChild(h('h2', { style: 'margin:0 0 14px;font-size:22px' }, mt.name));
    if (mt.description) card.appendChild(h('p', { class: 'lede', style: 'margin-bottom:22px' }, mt.description));

    var pick = h('div', { class: 'pick' });
    pick.appendChild(renderCalendar());
    pick.appendChild(renderSlots());
    card.appendChild(pick);

    var actions = h('div', { class: 'actions' }, [
      state.meetingTypes.length > 1
        ? h('button', { type: 'button', class: 'btn-link', onclick: function () { state.step = 1; state.slot = null; state.date = null; render(); } }, '← Change meeting type')
        : h('span'),
      h('span')
    ]);
    card.appendChild(actions);
    return card;
  }

  function renderCalendar() {
    var anchor = state.monthAnchor || firstOfMonth(new Date());
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var maxAhead = new Date(); maxAhead.setDate(maxAhead.getDate() + state.meetingType.max_days_ahead);

    var head = h('div', { class: 'cal-head' }, [
      h('button', { type: 'button', class: 'cal-btn', 'aria-label': 'Previous month',
        disabled: anchor <= firstOfMonth(today),
        onclick: function () { if (anchor > firstOfMonth(today)) loadMonth(addMonths(anchor, -1)); } }, '‹'),
      h('div', { class: 'mo' }, fmtMonth(anchor)),
      h('button', { type: 'button', class: 'cal-btn', 'aria-label': 'Next month',
        disabled: addMonths(anchor, 1) > addMonths(firstOfMonth(maxAhead), 1),
        onclick: function () { loadMonth(addMonths(anchor, 1)); } }, '›')
    ]);

    var grid = h('div', { class: 'cal-grid' });
    // Compute weekday order: locale-aware, S M T W T F S for en-US.
    var dowShort = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    dowShort.forEach(function (n) { grid.appendChild(h('div', { class: 'cal-dow' }, n)); });

    var startOfGrid = new Date(anchor);
    startOfGrid.setDate(1 - anchor.getDay()); // roll back to the Sunday
    for (var i = 0; i < 42; i++) {
      (function (day) {
        var inMonth = day.getMonth() === anchor.getMonth();
        var key = ymd(day);
        var hasSlots = !!state.days[key];
        var isPast = day < today;
        var beyond = day > maxAhead;
        var cls = 'cal-day';
        if (!inMonth) cls += ' other';
        if (isPast) cls += ' past';
        if (isSameDay(day, today)) cls += ' today';
        if (hasSlots && !isPast && !beyond) cls += ' has-slots';
        if (state.date && isSameDay(day, state.date)) cls += ' selected';
        if ((!hasSlots || isPast || beyond) && !isSameDay(day, state.date)) cls += ' disabled';
        grid.appendChild(h('button', {
          type: 'button', class: cls, disabled: (!hasSlots || isPast || beyond),
          onclick: function () { state.date = day; state.slot = null; state.error = ''; render(); }
        }, String(day.getDate())));
      })(new Date(startOfGrid.getFullYear(), startOfGrid.getMonth(), startOfGrid.getDate() + i));
    }

    return h('div', { class: 'cal' }, [head, grid]);
  }

  function renderSlots() {
    var panel = h('div', { class: 'slot-panel' });
    if (!state.date) {
      panel.appendChild(h('h3', {}, 'Select a date'));
      panel.appendChild(h('div', { class: 'no-slots' }, 'Pick a day on the left to see times.'));
      return panel;
    }
    panel.appendChild(h('h3', {}, fmtDate(state.date)));
    var slots = state.days[ymd(state.date)] || [];
    if (slots.length === 0) {
      panel.appendChild(h('div', { class: 'no-slots' }, 'No open times on this day.'));
      return panel;
    }
    var list = h('div', { class: 'slot-list' });
    slots.forEach(function (s) {
      var isSel = state.slot && state.slot.start === s.start;
      if (isSel) {
        list.appendChild(h('button', { type: 'button', class: 'slot selected', onclick: function () { state.step = 3; render(); } }, fmtSlot(s.start)));
        list.appendChild(h('button', { type: 'button', class: 'slot confirming', onclick: function () { state.step = 3; render(); } }, ['Continue with ', fmtSlot(s.start), ' →']));
      } else {
        list.appendChild(h('button', { type: 'button', class: 'slot', onclick: function () { state.slot = s; render(); } }, fmtSlot(s.start)));
      }
    });
    panel.appendChild(list);
    panel.appendChild(h('p', { class: 'tz-note' }, ['Times shown in ', fmtTz(), '.', ' ',
      h('button', { type: 'button', onclick: function () { state.use24h = !state.use24h; render(); } },
        state.use24h ? 'Switch to 12-hour' : 'Switch to 24-hour')
    ]));
    return panel;
  }

  /* -------- step 3: details -------- */
  function renderDetails() {
    var mt = state.meetingType, s = state.slot, g = state.guest;
    var card = h('div', { class: 'card' });
    card.appendChild(h('h2', { style: 'margin:0 0 16px;font-size:22px' }, 'Almost there.'));
    card.appendChild(h('div', { class: 'summary' }, [
      h('div', { class: 'k' }, mt.mode === 'virtual' ? 'Virtual meeting' : 'In-person meeting'),
      h('div', { class: 'v' }, fmtDate(state.date) + ' · ' + fmtSlot(s.start)),
      h('div', { class: 'm' }, mt.duration_min + ' minutes' + (mt.location ? ' · ' + mt.location.name : ''))
    ]));

    var form = h('div', { class: 'form' }, [
      h('div', { class: 'row' }, [
        field('name', 'text', 'Your name', true, 'name'),
        field('email', 'email', 'Email', true, 'email')
      ]),
      h('div', { class: 'row' }, [
        field('phone', 'tel', 'Phone', false, 'tel'),
        field('company', 'text', 'Company', false, 'organization')
      ]),
      (function () {
        var f = h('div', { class: 'field' });
        f.appendChild(h('label', { for: 'notes' }, ['Anything we should know? ', h('span', { class: 'opt' }, '(optional)')]));
        f.appendChild(h('textarea', { id: 'notes', name: 'notes', rows: '4', oninput: function (e) { g.notes = e.target.value; } }, g.notes));
        return f;
      })(),
      (function () {
        var wrap = h('label', { class: 'consent' });
        var cb = h('input', { type: 'checkbox', onchange: function (e) { state.consent = e.target.checked; } });
        cb.checked = state.consent;
        wrap.appendChild(cb);
        wrap.appendChild(h('span', { style: 'font-size:14px' }, 'It’s fine for The Fortune 5 Agency to email me about this meeting.'));
        return wrap;
      })(),
      // honeypot
      h('div', { style: 'position:absolute;left:-9999px' }, h('input', { type: 'text', name: 'fax', tabindex: '-1', autocomplete: 'off', oninput: function (e) { state.hp = e.target.value; } }))
    ]);
    card.appendChild(form);

    card.appendChild(h('div', { class: 'actions' }, [
      h('button', { type: 'button', class: 'btn-link', onclick: function () { state.step = 2; state.error = ''; render(); } }, '← Back'),
      h('button', {
        type: 'button', class: 'btn btn-primary',
        disabled: state.submitting,
        onclick: submit
      }, state.submitting ? 'Booking…' : 'Confirm booking')
    ]));
    return card;
  }

  function field(id, type, label, required, autocomplete) {
    var f = h('div', { class: 'field' });
    f.appendChild(h('label', { for: id }, required ? [label, ' ', h('span', { class: 'opt' }, '(required)')] : [label, ' ', h('span', { class: 'opt' }, '(optional)')]));
    f.appendChild(h('input', {
      id: id, type: type, name: id, required: required || false, autocomplete: autocomplete || 'off',
      value: state.guest[id] || '',
      oninput: function (e) { state.guest[id] = e.target.value; }
    }));
    return f;
  }

  /* -------- step 4: done -------- */
  function renderDone() {
    var r = state.result, mt = state.meetingType;
    var card = h('div', { class: 'card' });
    card.appendChild(h('div', { class: 'done-hero' }, [
      h('div', { class: 'mark', 'aria-hidden': 'true' }, '✓'),
      h('h1', {}, 'You’re booked.'),
      h('p', {}, 'Check your inbox for the confirmation and calendar invite.')
    ]));
    card.appendChild(h('div', { class: 'summary' }, [
      h('div', { class: 'k' }, mt.mode === 'virtual' ? 'Virtual meeting' : 'In-person meeting'),
      h('div', { class: 'v' }, r.when.date + ' · ' + r.when.time),
      h('div', { class: 'm' }, r.durationMin + ' minutes' + (r.location ? ' · ' + r.location : ''))
    ]));
    card.appendChild(h('p', { style: 'text-align:center;font-size:14px;color:var(--steel);margin:16px 0 0' }, [
      'Need to change it? ',
      h('a', { href: r.manageUrl }, 'Manage this booking')
    ]));
    return card;
  }

  /* -------- submit -------- */
  function submit() {
    var g = state.guest;
    state.error = '';
    if (!(g.name || '').trim()) return err('Please add your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((g.email || '').trim())) return err('Please check your email address.');
    if (!state.consent) return err('Please tick the consent box.');
    state.submitting = true; render();

    api('/api/appointments', {
      meetingTypeId: state.meetingType.id,
      startsAt: state.slot.start,
      guest: {
        name: g.name.trim(), email: g.email.trim(), phone: g.phone.trim(),
        company: g.company.trim(), notes: g.notes.trim(), timezone: state.tz
      },
      consent: true,
      hp: state.hp || '',
      referrer: document.referrer || '',
      utm: pickUtm()
    }).then(function (d) {
      state.result = d; state.step = 4; state.submitting = false; render();
      history.replaceState({}, '', '?booked=' + encodeURIComponent(d.id));
    }).catch(function (e) {
      state.submitting = false;
      if (/just taken/i.test(e.message)) {
        state.slot = null; state.step = 2; state.availabilityLoadedFor = null;
        state.error = e.message;
        loadAvailabilityForMonth(state.monthAnchor || firstOfMonth(new Date())).then(render).catch(function () { render(); });
      } else {
        state.error = e.message; render();
      }
    });
  }

  function err(msg) { state.error = msg; render(); }

  function pickUtm() {
    var out = {}, q = new URL(location.href).searchParams;
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(function (k) {
      var v = q.get(k); if (v) out[k] = v;
    });
    return out;
  }

  /* -------- go -------- */
  loadPage()
    .then(function () { if (state.step === 2) loadMonth(new Date()); else render(); })
    .catch(function (e) { state.error = e.message; state.page = { title: 'Book a call', intro: '' }; render(); });
})();
