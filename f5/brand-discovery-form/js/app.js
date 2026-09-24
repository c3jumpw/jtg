/* ============================================================
   Brand Discovery — APP
   Plain JavaScript, no build step. Reads its questions from
   questions.js and its settings from config.js.
   ============================================================ */
(function () {
  'use strict';

  var CFG = window.F5_CONFIG;
  var CHAPTERS = window.F5_CHAPTERS;
  var PAGES = window.F5_PAGES;

  var STORE_KEY = 'f5.discovery.v1';
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var URL_RE = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i;

  // On these hosts a missing backend is expected, so the flow can be
  // previewed end to end without sending anything.
  var PREVIEW = location.protocol === 'file:' ||
    /(^|\.)github\.io$/.test(location.hostname) ||
    location.hostname === 'localhost' || location.hostname === '127.0.0.1';

  // A static host answers POST with one of these when there is no backend.
  function noBackend(status) { return status === 404 || status === 405 || status === 501; }

  var REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  var root = document.getElementById('app');
  var bar, stage, track;
  var state = load() || fresh();
  var done = null;          // details for the thank-you screen
  var renderToken = 0;      // cancels stale timers when the person moves on
  var autoTimer = null;
  var busy = false;

  /* ---------------- tiny helpers ---------------- */

  function h(tag, attrs) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }
  function empty(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function icon(name) {
    var s = document.createElement('span');
    s.className = 'ico';
    s.setAttribute('aria-hidden', 'true');
    var paths = {
      right: '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10h11M11 5l5 5-5 5"/></svg>',
      left:  '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 10H5M9 5l-5 5 5 5"/></svg>',
      plus:  '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M10 4v12M4 10h12"/></svg>',
      close: '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15"/></svg>',
      upload:'<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>'
    };
    s.innerHTML = paths[name] || '';
    return s;
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var x = Array.prototype.map.call(b, function (n) { return ('0' + n.toString(16)).slice(-2); }).join('');
    return x.slice(0, 8) + '-' + x.slice(8, 12) + '-' + x.slice(12, 16) + '-' + x.slice(16, 20) + '-' + x.slice(20);
  }
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1).replace(/\.0$/, '') + ' MB';
  }
  function extOf(name) { var m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
  function isEmptyVal(v) {
    if (Array.isArray(v)) return v.length === 0;
    return v === undefined || v === null || String(v).trim() === '';
  }

  /* ---------------- state + persistence ---------------- */

  function fresh() {
    return {
      screen: 'welcome', index: 0, data: {}, folder: uuid(),
      files: { logos: [], materials: [] }, startedAt: Date.now(), maxIndex: 0, visited: {}
    };
  }
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || s.v !== 1 || !s.st) return null;
      if (Date.now() - s.savedAt > 14 * 24 * 3600 * 1000) return null;
      var st = s.st;
      st.screen = 'welcome';
      st.files = st.files || { logos: [], materials: [] };
      st.visited = st.visited || {};
      return st;
    } catch (e) { return null; }
  }
  var saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 250);
  }
  function persist() {
    try {
      var copy = JSON.parse(JSON.stringify(state));
      ['logos', 'materials'].forEach(function (g) {
        copy.files[g] = (copy.files[g] || []).filter(function (f) { return f.status === 'done'; });
      });
      localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, savedAt: Date.now(), st: copy }));
    } catch (e) { /* private mode or storage blocked: the form still works */ }
  }
  function clearSaved() { try { localStorage.removeItem(STORE_KEY); } catch (e) {} }
  function hasProgress() {
    return state.maxIndex > 0 || Object.keys(state.data).some(function (k) { return !isEmptyVal(state.data[k]); });
  }

  /* ---------------- shell (header + stage) ---------------- */

  function buildShell() {
    var segs = CHAPTERS.map(function () { return h('span', { class: 'seg' }, h('span', { class: 'fill' })); });
    track = h('div', { class: 'track', 'aria-hidden': 'true' }, segs);
    bar = h('header', { class: 'bar' },
      h('div', { class: 'brand' }, h('img', { src: 'assets/logo-light.png', alt: 'The Fortune 5 Agency', width: '153', height: '28' })),
      h('div', { class: 'bar-meta', id: 'barMeta' }),
      track
    );
    stage = h('main', { class: 'stage', id: 'stage' });
    empty(root);
    root.appendChild(bar);
    root.appendChild(stage);
  }

  function updateBar() {
    var meta = document.getElementById('barMeta');
    empty(meta);
    var page = PAGES[state.index];
    if (state.screen === 'page' && page) {
      meta.appendChild(h('span', { class: 'bar-step' }, page.chapter + ' of ' + CHAPTERS.length));
      meta.appendChild(h('span', { class: 'bar-chapter' }, CHAPTERS[page.chapter - 1].title));
    }
    CHAPTERS.forEach(function (c, i) {
      var pages = PAGES.filter(function (p) { return p.chapter === i + 1; });
      var fill = 0;
      if (state.screen === 'done') fill = 1;
      else if (state.screen === 'page' && page) {
        if (i + 1 < page.chapter) fill = 1;
        else if (i + 1 === page.chapter) fill = (pages.indexOf(page) + 0.5) / pages.length;
      }
      track.children[i].firstChild.style.transform = 'scaleX(' + fill + ')';
    });
  }

  /* ---------------- screen switching ---------------- */

  function swap(build) {
    var token = ++renderToken;
    clearTimeout(autoTimer);
    if (REDUCED || !stage.animate) { build(); return; }
    var out = stage.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 110, fill: 'forwards' });
    out.onfinish = function () {
      out.cancel();
      if (token !== renderToken) return;
      build();
      stage.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
        { duration: 220, easing: 'ease-out' });
    };
  }

  function show(screen, index, opts) {
    opts = opts || {};
    state.screen = screen;
    if (typeof index === 'number') state.index = index;
    if (screen === 'page') state.maxIndex = Math.max(state.maxIndex, state.index);
    document.body.setAttribute('data-screen', screen);
    swap(function () {
      if (screen === 'welcome') renderWelcome();
      else if (screen === 'page') renderPage(opts);
      else renderDone();
      window.scrollTo(0, 0);
    });
    updateBar();
    if (opts.push !== false) {
      try {
        var url = screen === 'page' ? '#' + PAGES[state.index].id : (screen === 'done' ? '#done' : location.pathname + location.search);
        history.pushState({ s: screen, i: state.index }, '', url);
      } catch (e) {}
    }
    save();
  }

  window.addEventListener('popstate', function (e) {
    var s = e.state;
    if (!s || s.s === 'welcome') return show('welcome', 0, { push: false });
    if (s.s === 'done') return show(done ? 'done' : 'welcome', 0, { push: false });
    if (s.s === 'page' && typeof s.i === 'number' && s.i <= state.maxIndex) return show('page', s.i, { push: false });
    show('welcome', 0, { push: false });
  });

  /* ---------------- welcome ---------------- */

  function renderWelcome() {
    var resume = hasProgress();
    var actions = resume
      ? h('div', { class: 'hero-actions' },
          h('button', { type: 'button', class: 'btn btn-light', onclick: function () { show('page', Math.min(state.maxIndex, PAGES.length - 1), { typing: false }); } },
            'Pick up where you left off', icon('right')),
          h('button', { type: 'button', class: 'btn-link', onclick: startOver }, 'Start over'))
      : h('div', { class: 'hero-actions' },
          h('button', { type: 'button', class: 'btn btn-light', onclick: function () { show('page', 0, { typing: true }); } },
            'Start the conversation', icon('right')));

    var chapters = h('ol', { class: 'chapters' }, CHAPTERS.map(function (c, i) {
      return h('li', null,
        h('span', { class: 'n' }, String(i + 1)),
        h('span', { class: 't' }, c.title),
        h('span', { class: 'b' }, c.blurb));
    }));

    var hero = h('section', { class: 'hero' },
      h('div', { class: 'hero-inner' },
        h('div', { class: 'hero-main' },
          h('img', { class: 'hero-mark', src: 'assets/mark.svg', alt: '', 'aria-hidden': 'true' }),
          h('h1', { class: 'hero-title', id: 'ask', tabindex: '-1' }, 'Tell us about your business.'),
          h('p', { class: 'hero-lede' },
            resume
              ? 'Welcome back' + (state.data.firstName ? ', ' + state.data.firstName : '') + '. Your answers are saved on this device.'
              : 'A few minutes of honest answers now means a sharper plan later. Talk to us the way you would talk to a new teammate. Rough is fine.'),
          actions,
          h('p', { class: 'hero-note' }, 'Takes about 10 minutes. Your answers save as you go, and you’ll get a copy by email.')),
        chapters));
    empty(stage).appendChild(hero);
  }

  function startOver() {
    if (!window.confirm('Start over? This clears the answers saved on this device.')) return;
    clearSaved();
    state = fresh();
    show('welcome', 0, { push: false });
  }

  /* ---------------- page rendering ---------------- */

  function safeEcho(page) {
    try { return page && page.echo ? String(page.echo(state.data, state.files) || '') : ''; } catch (e) { return ''; }
  }

  function renderPage(opts) {
    var token = renderToken;
    var page = PAGES[state.index];
    var prev = state.index > 0 ? PAGES[state.index - 1] : null;
    var recap = safeEcho(prev);
    var typed = !!opts.typing && !REDUCED && !state.visited[page.id];

    var thread = h('div', { class: 'thread' + (typed ? ' typed' : '') });
    if (recap) thread.appendChild(h('p', { class: 'reply' }, recap));

    var convo = h('div', { class: 'convo' });
    thread.appendChild(convo);

    var hostBody = h('div', { class: 'host-body' });
    convo.appendChild(h('div', { class: 'host' },
      h('div', { class: 'avatar' }, h('img', { src: 'assets/mark.svg', alt: '', width: '22', height: '28' })),
      hostBody));

    var fieldsEl = h('div', { class: 'fields' });
    page.fields.forEach(function (f) { fieldsEl.appendChild(renderField(f)); });
    convo.appendChild(fieldsEl);

    if (page.last) {
      convo.appendChild(h('div', { class: 'hp', 'aria-hidden': 'true' },
        h('label', null, 'Leave this field empty',
          h('input', { type: 'text', name: 'fax', tabindex: '-1', autocomplete: 'off', oninput: function (e) { state.hp = e.target.value; } }))));
    }

    var nav = renderNav(page);
    var form = h('form', { class: 'wrap', novalidate: true, 'aria-labelledby': 'ask', onsubmit: function (e) { e.preventDefault(); next(); } }, thread, nav);
    empty(stage).appendChild(form);

    function reveal() {
      if (token !== renderToken) return;
      empty(hostBody);
      hostBody.appendChild(h('h1', { class: 'ask', id: 'ask', tabindex: '-1' }, page.host(state.data)));
      if (page.hint) hostBody.appendChild(h('p', { class: 'hint' }, page.hint));
      fieldsEl.hidden = false;
      nav.hidden = false;
      Array.prototype.forEach.call(form.querySelectorAll('textarea'), autosize);
      refreshNext();
      var ask = document.getElementById('ask');
      var f0 = page.fields[0];
      var input = /^(text|email|tel|url|textarea)$/.test(f0.type) ? fieldsEl.querySelector('input:not([type=hidden]), textarea') : null;
      try { (input || ask).focus({ preventScroll: true }); } catch (e) {}
      state.visited[page.id] = 1;
    }

    if (typed) {
      hostBody.appendChild(h('div', { class: 'typing', 'aria-label': 'Typing' }, h('i'), h('i'), h('i')));
      fieldsEl.hidden = true;
      nav.hidden = true;
      setTimeout(reveal, 420);
    } else {
      reveal();
    }
  }

  function renderNav(page) {
    var back = h('button', { type: 'button', class: 'btn-ghost', onclick: goBack }, icon('left'), 'Back');
    var nextBtn = h('button', { type: 'submit', class: 'btn', id: 'nextBtn' });
    return h('div', { class: 'nav' },
      h('p', { class: 'banner', id: 'banner', role: 'alert', hidden: true }),
      h('div', { class: 'nav-row' }, back, nextBtn));
  }

  function pageHasAnswers(page) {
    return page.fields.some(function (f) {
      if (f.type === 'files') return (state.files[f.id] || []).length > 0;
      return answerText(f) !== '';
    });
  }
  function hasRequired(page) { return page.fields.some(function (f) { return f.required; }); }

  function refreshNext() {
    var btn = document.getElementById('nextBtn');
    var page = PAGES[state.index];
    if (!btn || !page || state.screen !== 'page') return;
    var label = page.last ? 'Send my answers' : (!hasRequired(page) && !pageHasAnswers(page) ? 'Skip this one' : 'Continue');
    empty(btn);
    btn.appendChild(document.createTextNode(label));
    if (!page.last) btn.appendChild(icon('right'));
    btn.classList.toggle('is-skip', label === 'Skip this one');
  }

  /* ---------------- fields ---------------- */

  function renderField(f) {
    switch (f.type) {
      case 'single': case 'multi': return fChoice(f);
      case 'repeat': return fRepeat(f);
      case 'files': return fFiles(f);
      case 'consent': return fConsent(f);
      default: return fText(f);
    }
  }

  function fieldShell(f, labelEl, control, hintText) {
    var id = 'f-' + f.id;
    return h('div', { class: 'field field-' + f.type + (f.half ? ' half' : ''), 'data-field': f.id },
      labelEl, control,
      hintText ? h('p', { class: 'hint', id: id + '-hint' }, hintText) : null,
      h('p', { class: 'error', id: id + '-err', role: 'alert', hidden: true }));
  }
  function labelText(f) {
    return [f.label, f.required ? h('span', { class: 'req' }, ' (required)') : null];
  }

  function fText(f) {
    var id = 'f-' + f.id;
    var isArea = f.type === 'textarea';
    var attrs = {
      id: id, name: f.id, maxlength: f.max || (isArea ? 2000 : 200),
      placeholder: f.placeholder, autocomplete: f.autocomplete || 'off',
      'aria-describedby': f.hint ? id + '-hint' : null
    };
    if (isArea) attrs.rows = f.rows || 3;
    else if (f.type === 'url') { attrs.type = 'text'; attrs.inputmode = 'url'; attrs.autocapitalize = 'off'; attrs.spellcheck = 'false'; }
    else attrs.type = f.type || 'text';
    if (f.type === 'email') { attrs.inputmode = 'email'; attrs.autocapitalize = 'off'; attrs.spellcheck = 'false'; }
    var input = h(isArea ? 'textarea' : 'input', attrs);
    input.value = state.data[f.id] || '';
    input.addEventListener('input', function () {
      state.data[f.id] = input.value;
      clearError(f.id);
      if (isArea) autosize(input);
      refreshNext();
      save();
    });
    return fieldShell(f, h('label', { for: id }, labelText(f)), input, f.hint);
  }

  function autosize(t) {
    t.style.height = 'auto';
    if (t.scrollHeight) t.style.height = Math.min(t.scrollHeight + 2, 440) + 'px';
  }

  function fConsent(f) {
    var id = 'f-' + f.id;
    var input = h('input', { type: 'checkbox', id: id, name: f.id });
    input.checked = !!state.data[f.id];
    input.addEventListener('change', function () {
      state.data[f.id] = input.checked; clearError(f.id); save();
    });
    var shell = h('div', { class: 'field field-consent', 'data-field': f.id },
      h('label', { class: 'consent', for: id }, input,
        h('span', { class: 'consent-box', 'aria-hidden': 'true' }), h('span', { class: 'consent-text' }, f.label)),
      h('p', { class: 'hint' }, 'We only use your answers to prepare for and follow up on our conversation.'),
      h('p', { class: 'error', id: id + '-err', role: 'alert', hidden: true }));
    return shell;
  }

  function fChoice(f) {
    var multi = f.type === 'multi';
    var name = 'c-' + f.id;
    var cur = state.data[f.id];
    var grid = h('div', { class: 'chips' + (f.compact ? ' compact' : '') + (f.layout === 'list' ? ' list' : '') });
    var counter = f.max ? h('p', { class: 'count', 'aria-live': 'polite' }) : null;
    var otherWrap = null, otherOpt = null;
    var inputs = [];

    (f.options || []).forEach(function (opt, i) {
      var o = typeof opt === 'string' ? { v: opt } : opt;
      if (o.other) otherOpt = o;
      var input = h('input', { type: multi ? 'checkbox' : 'radio', name: name, value: o.v, id: name + '-' + i });
      input.checked = multi ? (cur || []).indexOf(o.v) > -1 : cur === o.v;
      input.addEventListener('change', function () { onChange(o, input); });
      inputs.push({ input: input, opt: o });
      grid.appendChild(h('label', { class: 'chip' + (multi ? ' is-multi' : ''), for: input.id },
        input,
        h('span', { class: 'chip-box' },
          h('span', { class: 'chip-mark', 'aria-hidden': 'true' }),
          h('span', { class: 'chip-text' },
            h('span', { class: 'chip-label' }, o.v),
            o.d ? h('span', { class: 'chip-desc' }, o.d) : null))));
    });

    if (otherOpt) {
      var oid = 'f-' + f.id + '-other';
      var oi = h('input', { type: 'text', id: oid, name: f.id + 'Other', maxlength: '160', placeholder: 'Tell us more', autocomplete: 'off' });
      oi.value = state.data[f.id + 'Other'] || '';
      oi.addEventListener('input', function () { state.data[f.id + 'Other'] = oi.value; save(); });
      otherWrap = h('div', { class: 'other' }, h('label', { class: 'sr-only', for: oid }, f.label + ': other'), oi);
      otherWrap.hidden = !isOtherOn();
    }

    function isOtherOn() {
      if (!otherOpt) return false;
      return multi ? (state.data[f.id] || []).indexOf(otherOpt.v) > -1 : state.data[f.id] === otherOpt.v;
    }

    function sync() {
      if (multi && f.max) {
        var n = (state.data[f.id] || []).length;
        inputs.forEach(function (x) { if (!x.input.checked) x.input.disabled = n >= f.max; });
        counter.textContent = n ? n + ' of ' + f.max + ' picked' : 'Pick up to ' + f.max;
      }
      if (otherWrap) otherWrap.hidden = !isOtherOn();
    }

    function onChange(o, input) {
      if (multi) {
        state.data[f.id] = inputs.filter(function (x) { return x.input.checked; }).map(function (x) { return x.opt.v; });
      } else {
        state.data[f.id] = o.v;
      }
      sync(); clearError(f.id); refreshNext(); save();
      if (otherWrap && isOtherOn()) { var t = otherWrap.querySelector('input'); if (t) t.focus({ preventScroll: true }); }
      var page = PAGES[state.index];
      if (!multi && page.auto && !o.other && page.fields.length === 1) {
        clearTimeout(autoTimer);
        autoTimer = setTimeout(function () {
          if (state.screen === 'page' && PAGES[state.index] === page && !busy) next();
        }, 420);
      }
    }

    sync();
    var legend = h('legend', null, labelText(f));
    var fs = h('fieldset', { class: 'field field-choice', 'data-field': f.id, 'aria-describedby': f.hint ? 'f-' + f.id + '-hint' : null },
      legend,
      f.hint ? h('p', { class: 'hint', id: 'f-' + f.id + '-hint' }, f.hint) : null,
      grid, counter, otherWrap,
      h('p', { class: 'error', id: 'f-' + f.id + '-err', role: 'alert', hidden: true }));
    return fs;
  }

  function fRepeat(f) {
    var min = f.min || 1, max = f.max || 5;
    var rows = state.data[f.id];
    if (!Array.isArray(rows) || !rows.length) rows = state.data[f.id] = [];
    while (rows.length < min) rows.push({});

    var list = h('div', { class: 'rows' });
    var addBtn = h('button', { type: 'button', class: 'btn-add', onclick: function () {
      if (rows.length >= max) return;
      rows.push({}); draw(rows.length - 1); save();
    } }, icon('plus'), f.addLabel || 'Add another');

    function draw(focusRow) {
      empty(list);
      rows.forEach(function (row, ri) {
        var grid = h('div', { class: 'row-grid' });
        f.sub.forEach(function (s) {
          var sid = 'f-' + f.id + '-' + ri + '-' + s.id;
          var isArea = s.type === 'textarea';
          var el = h(isArea ? 'textarea' : 'input', {
            id: sid, name: f.id + '_' + ri + '_' + s.id, maxlength: s.max || 300,
            placeholder: s.placeholder, autocomplete: 'off', rows: isArea ? (s.rows || 2) : null, type: isArea ? null : 'text'
          });
          el.value = row[s.id] || '';
          el.addEventListener('input', function () {
            row[s.id] = el.value; if (isArea) autosize(el); refreshNext(); save();
          });
          grid.appendChild(h('div', { class: 'sub' + (s.wide ? ' wide' : '') }, h('label', { for: sid }, s.label), el));
        });
        var head = rows.length > min || ri >= min
          ? h('button', { type: 'button', class: 'btn-remove', 'aria-label': 'Remove row ' + (ri + 1), onclick: function () {
              rows.splice(ri, 1); draw(); refreshNext(); save();
            } }, icon('close'), 'Remove')
          : null;
        list.appendChild(h('div', { class: 'row' }, grid, head));
      });
      addBtn.hidden = rows.length >= max;
      Array.prototype.forEach.call(list.querySelectorAll('textarea'), autosize);
      if (typeof focusRow === 'number') {
        var target = list.querySelectorAll('.row')[focusRow];
        var inp = target && target.querySelector('input, textarea');
        if (inp) inp.focus();
      }
    }
    draw();
    return h('div', { class: 'field field-repeat', 'data-field': f.id },
      h('p', { class: 'label', id: 'f-' + f.id + '-lbl' }, labelText(f)),
      list, addBtn,
      h('p', { class: 'error', id: 'f-' + f.id + '-err', role: 'alert', hidden: true }));
  }

  /* ---------------- uploads ---------------- */

  function fFiles(f) {
    var group = f.id;
    var inputId = 'file-' + group;
    var accept = CFG.allowedExt.map(function (e) { return '.' + e; }).join(',');
    var input = h('input', { type: 'file', id: inputId, class: 'sr-only', multiple: true, accept: accept });
    var msg = h('p', { class: 'error', id: 'f-' + group + '-err', role: 'alert', hidden: true });
    var list = h('ul', { class: 'file-list' });

    var drop = h('label', { class: 'drop', for: inputId },
      icon('upload'),
      h('span', { class: 'drop-main' }, 'Drop files here or ', h('span', { class: 'drop-link' }, 'browse')),
      h('span', { class: 'drop-sub' }, 'Up to ' + CFG.maxFilesPerGroup + ' files, ' + CFG.maxFileMB + ' MB each'));

    input.addEventListener('change', function () { addFiles(group, input.files, msg, draw); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) addFiles(group, e.dataTransfer.files, msg, draw);
    });

    function draw() {
      empty(list);
      (state.files[group] || []).forEach(function (fl) {
        var status = fl.status === 'done' ? fmtSize(fl.size) + (fl.preview ? ' (preview, not sent)' : '')
          : fl.status === 'error' ? (fl.error || 'Upload failed')
          : 'Uploading ' + Math.round(fl.progress || 0) + '%';
        list.appendChild(h('li', { class: 'file is-' + fl.status },
          h('span', { class: 'file-name' }, fl.name),
          h('span', { class: 'file-meta' }, status),
          fl.status === 'uploading' ? h('span', { class: 'bar-mini' }, h('span', { style: 'width:' + Math.round(fl.progress || 0) + '%' })) : null,
          h('button', { type: 'button', class: 'file-x', 'aria-label': 'Remove ' + fl.name, onclick: function () {
            fl.removed = true;
            if (fl.abort) { try { fl.abort(); } catch (e) {} }
            state.files[group] = state.files[group].filter(function (x) { return x !== fl; });
            draw(); refreshNext(); save();
          } }, icon('close'))));
      });
    }
    draw();

    var shell = h('div', { class: 'field field-files', 'data-field': group },
      h('p', { class: 'label' }, f.label),
      f.hint ? h('p', { class: 'hint' }, f.hint) : null,
      input, drop, list, msg);
    return shell;
  }

  function addFiles(group, fileList, msgEl, redraw) {
    var files = Array.prototype.slice.call(fileList || []);
    var problems = [];
    msgEl.hidden = true;
    files.forEach(function (file) {
      var cur = state.files[group];
      if (cur.length >= CFG.maxFilesPerGroup) { problems.push('You can add up to ' + CFG.maxFilesPerGroup + ' files here.'); return; }
      if (CFG.allowedExt.indexOf(extOf(file.name)) === -1) { problems.push('“' + file.name + '” isn’t a supported file type.'); return; }
      if (file.size > CFG.maxFileMB * 1048576) { problems.push('“' + file.name + '” is over ' + CFG.maxFileMB + ' MB.'); return; }
      if (file.size === 0) { problems.push('“' + file.name + '” is empty.'); return; }
      var entry = { id: uuid(), name: file.name, size: file.size, status: 'uploading', progress: 0 };
      cur.push(entry);
      uploadOne(group, file, entry, redraw);
    });
    if (problems.length) {
      msgEl.textContent = problems.filter(function (p, i, a) { return a.indexOf(p) === i; }).join(' ');
      msgEl.hidden = false;
    }
    redraw(); refreshNext();
  }

  // The upload client is ~100 KB, so it is only fetched when someone reaches the files page.
  var blobLoader = null;
  function loadBlob() {
    if (window.F5Blob) return Promise.resolve(window.F5Blob);
    if (!blobLoader) {
      blobLoader = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = CFG.blobClient;
        s.onload = function () { window.F5Blob ? resolve(window.F5Blob) : reject(new Error('upload client missing')); };
        s.onerror = function () { blobLoader = null; reject(new Error('upload client failed to load')); };
        document.head.appendChild(s);
      });
    }
    return blobLoader;
  }

  // Letters, numbers, dots, dashes and underscores only. The server accepts nothing else.
  function uploadName(name) {
    var base = String(name || '').replace(/\.[^.]*$/, '').normalize('NFKD')
      .replace(/[^\w.-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
    return (base || 'file') + '.' + extOf(name);
  }

  function uploadOne(group, file, entry, redraw) {
    var ctrl = window.AbortController ? new AbortController() : null;
    entry.abort = ctrl ? function () { ctrl.abort(); } : null;
    function fail(message) {
      if (entry.removed) return;
      entry.abort = null; entry.status = 'error'; entry.error = message; redraw();
    }
    function previewDone() {
      entry.abort = null; entry.status = 'done'; entry.preview = true; progress(100);
      entry.path = state.folder + '/' + group + '/preview-' + entry.name; redraw(); refreshNext(); save();
    }
    function progress(p) { entry.progress = p; }

    loadBlob().then(function (blobClient) {
      return blobClient.upload(state.folder + '/' + group + '/' + uploadName(file.name), file, {
        access: 'private',
        handleUploadUrl: CFG.endpoints.upload,
        contentType: file.type || undefined,
        abortSignal: ctrl ? ctrl.signal : undefined,
        onUploadProgress: function (e) { if (!entry.removed) { progress(e.percentage); redraw(); } }
      });
    }).then(function (blob) {
      if (entry.removed) return;
      entry.abort = null; entry.status = 'done'; entry.path = blob.pathname; progress(100);
      redraw(); refreshNext(); save();
    }).catch(function (err) {
      if (entry.removed) return;
      if (PREVIEW) return previewDone();
      fail(err && /supported|too large|Too many/i.test(err.message || '') ? err.message : 'Upload failed. Try again.');
    });
  }

  /* ---------------- answers -> text ---------------- */

  function answerText(f) {
    var v = state.data[f.id];
    if (f.type === 'single') {
      if (isEmptyVal(v)) return '';
      var other = state.data[f.id + 'Other'];
      return /^(other|something else)$/i.test(v) && other && other.trim() ? v + ': ' + other.trim() : v;
    }
    if (f.type === 'multi') {
      if (isEmptyVal(v)) return '';
      var extra = (state.data[f.id + 'Other'] || '').trim();
      return v.map(function (x) {
        return /^(other|something else)$/i.test(x) && extra ? x + ': ' + extra : x;
      }).join(', ');
    }
    if (f.type === 'repeat') {
      var lines = [];
      (v || []).forEach(function (row) {
        var parts = f.sub.map(function (s) { return (row[s.id] || '').trim(); });
        if (!parts.some(Boolean)) return;
        if (f.id === 'features') lines.push(parts.filter(Boolean).join(' → '));
        else lines.push(f.sub.map(function (s, i) { return parts[i] ? s.label + ': ' + parts[i] : ''; }).filter(Boolean).join('\n'));
      });
      return lines.map(function (l, i) { return lines.length > 1 ? (i + 1) + '. ' + l : l; }).join('\n\n');
    }
    if (f.type === 'consent') return v ? 'Yes' : '';
    if (f.type === 'files') return '';
    return isEmptyVal(v) ? '' : String(v).trim();
  }

  function buildSummary() {
    var out = [];
    PAGES.forEach(function (p) {
      var section = CHAPTERS[p.chapter - 1].title;
      p.fields.forEach(function (f) {
        if (f.type === 'files' || f.type === 'consent') return;
        var val = answerText(f);
        if (val) out.push({ section: section, label: f.short || f.label, value: val });
      });
    });
    return out;
  }

  function cleanData() {
    var d = JSON.parse(JSON.stringify(state.data));
    Object.keys(d).forEach(function (k) {
      if (typeof d[k] === 'string') d[k] = d[k].trim();
    });
    ['features', 'wins'].forEach(function (k) {
      if (Array.isArray(d[k])) {
        d[k] = d[k].map(function (row) {
          var r = {}; Object.keys(row).forEach(function (rk) { if ((row[rk] || '').trim()) r[rk] = row[rk].trim(); }); return r;
        }).filter(function (r) { return Object.keys(r).length; });
      }
    });
    if (d.website && !/^https?:\/\//i.test(d.website)) d.website = 'https://' + d.website;
    return d;
  }

  /* ---------------- validation + navigation ---------------- */

  function clearError(id) {
    var el = document.getElementById('f-' + id + '-err');
    if (el) { el.hidden = true; el.textContent = ''; }
    var field = stage.querySelector('[data-field="' + id + '"]');
    if (field) field.classList.remove('has-error');
    var b = document.getElementById('banner');
    if (b) b.hidden = true;
  }
  function showError(id, msg) {
    var el = document.getElementById('f-' + id + '-err');
    if (el) { el.textContent = msg; el.hidden = false; }
    var field = stage.querySelector('[data-field="' + id + '"]');
    if (field) field.classList.add('has-error');
  }

  function validatePage(page) {
    var firstBad = null;
    page.fields.forEach(function (f) {
      var v = state.data[f.id], msg = '';
      if (f.required && (f.type === 'consent' ? !v : isEmptyVal(v))) msg = f.error || 'This one is required.';
      else if (f.type === 'email' && !isEmptyVal(v) && !EMAIL_RE.test(String(v).trim())) msg = 'That email doesn’t look right. Check for typos.';
      else if (f.type === 'url' && !isEmptyVal(v) && !URL_RE.test(String(v).trim())) msg = 'Enter a web address like yourbrand.com, or leave it blank.';
      if (msg) { showError(f.id, msg); if (!firstBad) firstBad = f; }
    });
    if (firstBad) {
      var el = document.getElementById('f-' + firstBad.id) || stage.querySelector('[data-field="' + firstBad.id + '"] input');
      if (el) { el.focus(); if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: REDUCED ? 'auto' : 'smooth' }); }
      return false;
    }
    return true;
  }

  function uploading() {
    return ['logos', 'materials'].some(function (g) {
      return (state.files[g] || []).some(function (f) { return f.status === 'uploading'; });
    });
  }

  function banner(msg) {
    var b = document.getElementById('banner');
    if (!b) return;
    b.textContent = msg; b.hidden = !msg;
  }

  function next() {
    if (busy || state.screen !== 'page') return;
    clearTimeout(autoTimer);
    var page = PAGES[state.index];
    if (!validatePage(page)) return;
    if (page.id === 'files' && uploading()) { banner('Your files are still uploading. Give it a moment, then continue.'); return; }
    state.visited[page.id] = 1;
    if (page.last) return submit();
    show('page', state.index + 1, { typing: true });
  }

  function goBack() {
    if (busy) return;
    clearTimeout(autoTimer);
    if (state.index === 0) show('welcome', 0);
    else show('page', state.index - 1, { typing: false });
  }

  /* ---------------- submit ---------------- */

  function submit() {
    var btn = document.getElementById('nextBtn');
    busy = true;
    if (btn) { btn.disabled = true; empty(btn).appendChild(document.createTextNode('Sending…')); }
    banner('');

    var files = [];
    ['logos', 'materials'].forEach(function (g) {
      (state.files[g] || []).forEach(function (f) {
        if (f.status === 'done') files.push({ group: g, name: f.name, size: f.size, path: f.path });
      });
    });
    var utm = {};
    try {
      new URLSearchParams(location.search).forEach(function (v, k) { if (/^utm_/.test(k)) utm[k] = v.slice(0, 120); });
    } catch (e) {}
    var data = cleanData();
    var payload = {
      v: 1, folder: state.folder, data: data, summary: buildSummary(), files: files, hp: state.hp || '',
      meta: {
        elapsedSec: Math.round((Date.now() - state.startedAt) / 1000),
        referrer: (document.referrer || '').slice(0, 300), utm: utm,
        tz: (window.Intl && Intl.DateTimeFormat().resolvedOptions().timeZone) || '',
        lang: navigator.language || '', viewport: window.innerWidth + 'x' + window.innerHeight
      }
    };

    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 30000);

    fetch(CFG.endpoints.submit, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { r: r, j: j }; });
    }).then(function (res) {
      clearTimeout(timer);
      if (res.r.ok && res.j.ok) return finish(data, false);
      if (PREVIEW && noBackend(res.r.status)) return finish(data, true);
      failSubmit(res.j && res.j.error);
    }).catch(function () {
      clearTimeout(timer);
      if (PREVIEW) return finish(data, true);
      failSubmit();
    });
  }

  function failSubmit(msg) {
    busy = false;
    var btn = document.getElementById('nextBtn');
    if (btn) btn.disabled = false;
    refreshNext();
    banner((msg ? msg + ' ' : 'That didn’t go through. ') + 'Your answers are saved on this device, so nothing is lost. Try again in a moment.');
  }

  function finish(data, preview) {
    done = { first: data.firstName || '', email: data.email || '', pref: data.contactPref || '', preview: !!preview };
    clearSaved();
    busy = false;
    state = fresh();
    show('done', 0);
    // show() persists state; a finished form must not come back as progress.
    clearTimeout(saveTimer);
    clearSaved();
  }

  /* ---------------- thank-you ---------------- */

  function renderDone() {
    var d = done || { first: '', email: '', pref: '', preview: false };
    var steps = [
      d.preview ? 'This was a preview, so nothing was sent.' : 'Check your inbox. A copy of your answers is on its way' + (d.email ? ' to ' + d.email : '') + '.',
      'A specialist reads everything before we talk.',
      'Pick a time for your free 30-minute strategy call.'
    ];
    var hero = h('section', { class: 'hero hero-done' },
      h('div', { class: 'hero-inner' },
        h('div', { class: 'hero-main' },
          h('img', { class: 'hero-mark', src: 'assets/mark.svg', alt: '', 'aria-hidden': 'true' }),
          h('h1', { class: 'hero-title', id: 'ask', tabindex: '-1' }, 'Thanks' + (d.first ? ', ' + d.first : '') + '. We’ve got it.'),
          h('p', { class: 'hero-lede' }, 'Your brand discovery is in. Here’s what happens next.'),
          h('ol', { class: 'next-steps' }, steps.map(function (s) { return h('li', null, s); })),
          h('div', { class: 'hero-actions' },
            h('a', { class: 'btn btn-light', href: CFG.bookingUrl, target: '_blank', rel: 'noopener' }, 'Book your free strategy call', icon('right'))),
          h('p', { class: 'hero-note' }, 'Free 30-minute call. No commitment required.'))));
    empty(stage).appendChild(hero);
    var ask = document.getElementById('ask');
    if (ask) ask.focus({ preventScroll: true });
  }

  /* ---------------- boot ---------------- */

  // Stop the browser from opening a file that is dropped outside an upload area.
  ['dragover', 'drop'].forEach(function (ev) {
    window.addEventListener(ev, function (e) {
      var t = e.dataTransfer && e.dataTransfer.types;
      if (t && Array.prototype.indexOf.call(t, 'Files') > -1) e.preventDefault();
    });
  });

  buildShell();
  document.body.setAttribute('data-screen', 'welcome');
  try { history.replaceState({ s: 'welcome', i: 0 }, '', location.pathname + location.search); } catch (e) {}
  renderWelcome();
  updateBar();
})();
