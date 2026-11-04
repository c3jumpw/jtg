/* MKC Portal Manager — single-page staff tool.
 *
 * Writes and publishes client portal updates. Every rule about who may see or
 * change what lives on the server (lib/access.js); this file only hides
 * buttons a role can't use, so a stale or edited page still can't do more.
 * Stored client pages are never inserted into this document: they are shown
 * through /api/view in a sandboxed iframe.
 */
import { FORMATS, buildPrompt, formatById, PROMPT_VERSION } from './prompts.js';

const app = document.getElementById('app');
const live = document.getElementById('live');

const state = {
  me: null,
  dirty: false,        // unsaved composer changes
  renderSeq: 0         // guards against a slow response painting over a newer view
};

const AI_LINKS = [
  { label: 'Gemini', url: 'https://gemini.google.com/app' },
  { label: 'Claude', url: 'https://claude.ai/new' },
  { label: 'ChatGPT', url: 'https://chatgpt.com/' }
];

const ROLE_LABELS = {
  super_admin: 'Super admin',
  manager: 'Manager',
  account_manager: 'Account manager',
  supervisor: 'Supervisor'
};
const ROLE_HELP = {
  super_admin: 'Everything, including who has access.',
  manager: 'Every client: write, publish, add clients and assign staff.',
  account_manager: 'Assigned clients only: write and publish.',
  supervisor: 'Assigned clients only: read-only.'
};
const DIVISION_LABELS = { jtg: 'JTG', uny: 'UNY', mco: 'MCO' };
const TYPE_LABELS = { update: 'Update', task: 'Task', guide: 'Guide', report: 'Report', meeting: 'Meeting recap' };
// Which prompt suits each update type by default.
const TYPE_FORMAT = { update: 'update', report: 'update', meeting: 'update', task: 'task', guide: 'guide' };
const CONTACT_ROLES = { owner: 'Owner', member: 'Member', viewer: 'Viewer' };
// One-line descriptions for the composer's format picker (the library shows the full blurb).
const FORMAT_SHORT = { update: 'Progress, results and next steps', task: 'One thing the client needs to do', guide: 'A step-by-step how-to' };

const can = (power) => Boolean(state.me && state.me.can && state.me.can[power]);

/* ---------- DOM helpers ---------- */

function h(tag, attrs, kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'value') value = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of [].concat(kids == null ? [] : kids)) {
    if (kid == null || kid === false) continue;
    el.appendChild(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid);
  }
  // Set after children so a <select>'s options exist first.
  if (value !== undefined) el.value = value;
  return el;
}

/** replaceChildren that skips null/false, which replaceChildren would print
 *  as the text "null" (optional sections are written as cond ? el : null). */
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
}

function announce(msg) {
  live.textContent = '';
  setTimeout(() => { live.textContent = msg; }, 30);
}

function toast(msg, kind = 'ok', ms = 4500) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = h('div', { class: `toast ${kind}`, role: kind === 'err' ? 'alert' : 'status' }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function fmtDate(iso, withTime = true) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const opts = { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}) };
  return d.toLocaleString('en-US', opts);
}

function badge(text, cls) { return h('span', { class: `badge ${cls || ''}` }, text); }

function field(labelText, input, hint, opt) {
  const id = input.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  return h('div', { class: 'field' }, [
    h('label', { for: id }, [labelText, opt ? h('span', { class: 'opt' }, ` ${opt}`) : null]),
    input,
    hint ? h('div', { class: 'hint' }, hint) : null
  ]);
}

/* ---------- clipboard ---------- */

// Synchronous copy, so it still counts as part of the click (some browsers
// refuse clipboard writes once a promise has resolved or focus has moved).
function copySync(text) {
  const ta = h('textarea', { readonly: true, 'aria-hidden': 'true', style: 'position:fixed;top:0;left:-9999px;opacity:0' });
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  return copySync(text);
}

/* ---------- API ---------- */

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw Object.assign(new Error('Can’t reach the server. Check your connection and try again.'), { status: 0 });
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    throw Object.assign(new Error((data && data.error) || `Request failed (${res.status}).`), { status: res.status, data });
  }
  return data;
}

/** Shows an API failure. A lost session sends you to sign-in — unless there
 *  is unsaved work on screen, which would be thrown away. */
function fail(err) {
  if (err && err.status === 401) {
    if (state.dirty) {
      toast('You’ve been signed out. Copy anything you need, then reload to sign in again.', 'err', 12000);
    } else {
      state.me = null;
      renderLogin('Your session ended. Sign in again to continue.');
    }
    return;
  }
  toast((err && err.message) || 'Something went wrong.', 'err', 7000);
}

/* ---------- router ---------- */

function parseHash() {
  const parts = (location.hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  return { route: parts[0] || 'clients', a: parts[1] || null, b: parts[2] || null };
}

let current = parseHash();
let lastHash = location.hash;
let ignoreNextHash = false;

window.addEventListener('hashchange', () => {
  if (ignoreNextHash) { ignoreNextHash = false; return; }
  if (state.dirty && !confirm('You have unsaved changes. Leave without saving?')) {
    ignoreNextHash = true;
    location.hash = lastHash;
    return;
  }
  state.dirty = false;
  lastHash = location.hash;
  current = parseHash();
  if (state.me) renderApp();
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

/** Change the URL without re-rendering (after a new draft gets its id). */
function replaceRoute(hash) {
  history.replaceState(null, '', hash);
  lastHash = hash;
  current = parseHash();
}

/* ---------- boot + sign-in ---------- */

const LOGIN_ERRORS = {
  badlink: 'That sign-in link isn’t valid. Ask for a new one.',
  used: 'That link has already been used. Ask for a new one.',
  expired: 'That link expired. Ask for a new one.',
  notallowed: 'That email doesn’t have Portal Manager access. Ask a super admin to add you.',
  server: 'Something went wrong signing you in. Try again.'
};

const LINK_CODES = {
  badlink: LOGIN_ERRORS.badlink,
  used: LOGIN_ERRORS.used,
  expired: LOGIN_ERRORS.expired,
  notallowed: LOGIN_ERRORS.notallowed,
  slow: 'Too many sign-in attempts. Wait a few minutes and try again.'
};

/** Arrived from an email link (/#signin=<token>). The token is wiped from the
 *  address bar at once and only spent when the person taps Continue, so a
 *  mail scanner that opens the link can't use it up. */
function renderFinishSignin(token) {
  document.title = 'Sign in · Portal Manager';
  const btn = h('button', { class: 'btn btn-primary', type: 'submit', style: 'width:100%;padding:12px' }, 'Continue to Portal Manager');
  const msg = h('div', { class: 'login-msg', role: 'status', 'aria-live': 'polite' });
  const form = h('form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      btn.disabled = true; btn.textContent = 'Signing you in…';
      try {
        await api('/api/auth-callback', { method: 'POST', body: { t: token } });
        boot();
      } catch (err) {
        const code = err.data && err.data.code;
        renderLogin(LINK_CODES[code] || err.message);
      }
    }
  }, [btn]);
  fill(app, h('main', { class: 'login-shell' }, h('div', { class: 'login-card' }, [
    h('div', { class: 'brand' }, h('img', { src: 'assets/logo-dark.png', alt: 'MKC', width: 111, height: 42 })),
    h('h1', {}, 'Finish signing in'),
    h('p', {}, 'Tap below to open the Portal Manager on this device.'),
    form,
    msg
  ])));
  setTimeout(() => btn.focus(), 0);
}

async function boot() {
  const link = location.hash.match(/^#signin=([A-Za-z0-9_-]{20,64})$/);
  if (link) {
    history.replaceState(null, '', location.pathname);
    lastHash = ''; current = parseHash();
    renderFinishSignin(link[1]);
    return;
  }
  const qs = new URLSearchParams(location.search);
  let loginMsg = null;
  if (qs.get('e')) {
    loginMsg = LOGIN_ERRORS[qs.get('e')] || 'Something went wrong. Try again.';
    history.replaceState(null, '', location.pathname + location.hash);
  }
  try {
    const me = await api('/api/auth-me');
    if (me && me.authenticated) { state.me = me; renderApp(); return; }
    renderLogin(me && me.revoked ? 'Your Portal Manager access has been removed. Ask a super admin if that’s a mistake.' : loginMsg);
  } catch (e) {
    renderLogin(e.message || 'Can’t reach the server right now.');
  }
}

function renderLogin(message) {
  document.title = 'Sign in · Portal Manager';
  const email = h('input', { type: 'email', name: 'email', autocomplete: 'email', required: true, placeholder: 'you@company.com', inputmode: 'email' });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit', style: 'width:100%;padding:12px' }, 'Email me a sign-in link');
  const msg = h('div', { class: `login-msg${message ? ' err' : ''}`, role: 'status', 'aria-live': 'polite' }, message || '');
  let busy = false;
  const form = h('form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      if (busy) return;
      const value = email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
        msg.className = 'login-msg err'; msg.textContent = 'Please check that email address.'; email.focus(); return;
      }
      busy = true; submit.disabled = true; submit.textContent = 'Sending…';
      try {
        const d = await api('/api/auth-request', { method: 'POST', body: { email: value } });
        msg.className = 'login-msg';
        msg.textContent = (d && d.message) || 'If that email has access, a sign-in link is on the way.';
        submit.textContent = 'Link sent — check your inbox';
      } catch (err) {
        busy = false; submit.disabled = false; submit.textContent = 'Email me a sign-in link';
        msg.className = 'login-msg err'; msg.textContent = err.message;
      }
    }
  }, [field('Work email', email), submit]);
  fill(app, h('main', { class: 'login-shell' }, h('div', { class: 'login-card' }, [
    h('div', { class: 'brand' }, h('img', { src: 'assets/logo-dark.png', alt: 'MKC', width: 111, height: 42 })),
    h('h1', {}, 'Portal Manager'),
    h('p', {}, 'Write and publish client portal updates. We’ll email you a sign-in link — no password needed.'),
    form,
    msg
  ])));
  setTimeout(() => email.focus(), 0);
}

async function signOut() {
  if (state.dirty && !confirm('You have unsaved changes. Sign out anyway?')) return;
  state.dirty = false;
  try { await api('/api/auth-me?action=logout', { method: 'POST' }); } catch { /* cookie is cleared server-side either way */ }
  state.me = null;
  renderLogin('You’re signed out.');
}

/* ---------- shell ---------- */

function navItems() {
  return [
    { id: 'clients', label: 'Clients', icon: '▤' },
    { id: 'prompts', label: 'Prompt library', icon: '✎' },
    (can('manageClients') || can('manageTeam')) ? { id: 'team', label: 'Team', icon: '☰' } : null
  ].filter(Boolean);
}

function activeNav() {
  return ['compose', 'edit'].includes(current.route) ? 'clients' : current.route;
}

function renderApp() {
  const items = navItems();
  if (!items.some((i) => i.id === activeNav())) { current = { route: 'clients', a: null, b: null }; }
  const active = activeNav();
  const me = state.me;

  const sidebar = h('aside', { class: 'sidebar', 'aria-label': 'Main' }, [
    h('a', { class: 'brand', href: '#/clients' }, [
      h('img', { src: 'assets/logo-light.png', alt: 'MKC', width: 69, height: 26 }),
      h('span', { class: 'brand-tag' }, ['Portal', h('br'), 'Manager'])
    ]),
    h('nav', {}, items.map((i) => h('a', { href: `#/${i.id}`, 'aria-current': i.id === active ? 'page' : null }, [
      h('span', { class: 'icon', 'aria-hidden': 'true' }, i.icon), i.label
    ]))),
    h('div', { class: 'foot' }, [
      h('div', { class: 'who' }, me.fullName || me.email),
      h('div', {}, ROLE_LABELS[me.role] || me.role),
      h('button', { type: 'button', onclick: signOut }, 'Sign out')
    ])
  ]);

  const mobileSelect = h('select', {
    'aria-label': 'Go to',
    onchange: (e) => {
      if (e.target.value === '__signout') { e.target.value = active; signOut(); return; }
      location.hash = `#/${e.target.value}`;
    }
  }, [
    ...items.map((i) => h('option', { value: i.id }, i.label)),
    h('option', { value: '__signout' }, 'Sign out')
  ]);
  mobileSelect.value = active;
  const mobilenav = h('div', { class: 'mobilenav' }, [
    h('a', { href: '#/clients', 'aria-label': 'Portal Manager home' }, h('img', { src: 'assets/logo-light.png', alt: 'MKC', width: 58, height: 22 })),
    mobileSelect
  ]);

  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' }, h('div', { class: 'loading' }, 'Loading…'));
  fill(app, h('div', { class: 'app-shell' }, [sidebar, h('div', {}, [mobilenav, main])]));

  const seq = ++state.renderSeq;
  const views = {
    clients: () => (current.a ? viewClient(main, seq, current.a, current.b || 'updates') : viewClients(main, seq)),
    compose: () => viewComposer(main, seq, { companyId: current.a }),
    edit: () => viewComposer(main, seq, { updateId: current.a }),
    prompts: () => viewPrompts(main, seq, current.a),
    team: () => viewTeam(main, seq)
  };
  (views[current.route] || views.clients)();
  window.scrollTo(0, 0);
}

const stale = (seq) => seq !== state.renderSeq;

function showError(main, err) {
  if (err && err.status === 401) { fail(err); return; }
  fill(main, 
    h('div', { class: 'err-box', role: 'alert' }, (err && err.message) || 'Something went wrong.'),
    h('p', {}, h('a', { href: '#/clients' }, '← Back to clients'))
  );
}

function pageHead(title, sub, actions, crumbs) {
  return h('div', {}, [
    crumbs ? h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, crumbs) : null,
    h('div', { class: 'page-head' }, [
      h('div', {}, [h('h1', {}, title), sub ? h('div', { class: 'sub' }, sub) : null]),
      actions && actions.length ? h('div', { class: 'actions' }, actions) : null
    ])
  ]);
}

/* ---------- modal ---------- */

function modal({ title, sub, body, submitLabel = 'Save', submitClass = 'btn-primary', onSubmit }) {
  const prevFocus = document.activeElement;
  const errBox = h('div', { class: 'form-err', role: 'alert' });
  const submitBtn = h('button', { class: `btn ${submitClass}`, type: 'submit' }, submitLabel);
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); if (prevFocus && prevFocus.focus) prevFocus.focus(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const form = h('form', {
    class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title', novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      if (submitBtn.disabled) return;
      errBox.textContent = '';
      submitBtn.disabled = true;
      const label = submitBtn.textContent;
      submitBtn.textContent = 'Working…';
      try {
        await onSubmit();
        close();
      } catch (err) {
        if (err && err.status === 401) { close(); fail(err); return; }
        errBox.textContent = (err && err.message) || 'Something went wrong.';
        submitBtn.disabled = false; submitBtn.textContent = label;
      }
    }
  }, [
    h('h2', { id: 'modal-title' }, title),
    sub ? h('p', { class: 'sub' }, sub) : null,
    h('div', { class: 'form-body' }, body),
    errBox,
    h('div', { class: 'modal-actions' }, [
      h('button', { class: 'btn btn-secondary', type: 'button', onclick: close }, 'Cancel'),
      submitBtn
    ])
  ]);
  const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(); } }, form);
  document.body.appendChild(back);
  document.addEventListener('keydown', onKey);
  const first = form.querySelector('input, select, textarea, button[type=submit]');
  setTimeout(() => first && first.focus(), 0);
  return close;
}

/* ---------- Clients ---------- */

async function viewClients(main, seq) {
  document.title = 'Clients · Portal Manager';
  let data;
  try { data = await api('/api/companies'); } catch (e) { if (!stale(seq)) showError(main, e); return; }
  if (stale(seq)) return;
  const companies = data.companies || [];

  const actions = can('manageClients') ? [h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openClientModal() }, '+ Add client')] : [];
  const head = pageHead('Clients', can('seeAll') ? 'Every client portal across JTG, UNY and MCO.' : 'The clients assigned to you.', actions);

  if (companies.length === 0) {
    fill(main, head, h('div', { class: 'empty' }, can('manageClients')
      ? ['No clients yet. Add the first one to start publishing updates.', h('br'), h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openClientModal() }, '+ Add client')]
      : 'No clients are assigned to you yet. Ask a manager to assign you.'));
    return;
  }

  let division = 'all';
  const search = h('input', { type: 'search', placeholder: 'Search clients', 'aria-label': 'Search clients' });
  const countLine = h('div', { class: 'muted', role: 'status', style: 'font-size:13px;color:var(--steel)' });
  const rows = companies.map((c) => {
    const tr = h('tr', { class: 'clickable', onclick: (e) => { if (e.target.closest('a')) return; location.hash = `#/clients/${c.id}`; } }, [
      h('td', { class: 'primary-cell' }, [
        h('a', { href: `#/clients/${c.id}` }, c.name),
        c.active === false ? [' ', badge('Inactive', 'off')] : null
      ].flat()),
      h('td', { 'data-label': 'Division' }, badge(DIVISION_LABELS[c.division] || c.division, c.division)),
      h('td', { 'data-label': 'Contacts' }, String(c.contacts)),
      h('td', { 'data-label': 'Drafts' }, c.drafts ? badge(`${c.drafts} draft${c.drafts === 1 ? '' : 's'}`, 'draft') : h('span', { class: 'muted' }, '—')),
      h('td', { 'data-label': 'Last published' }, fmtDate(c.lastPublishedAt, false)),
      h('td', { 'data-label': 'Owner' }, c.owner ? c.owner.name : h('span', { class: 'muted' }, 'Unassigned'))
    ]);
    tr._match = `${c.name} ${c.clickupAccountId || ''}`.toLowerCase();
    tr._division = c.division;
    return tr;
  });

  // Filter in place so the search box keeps focus while typing.
  function apply() {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const tr of rows) {
      const ok = (!q || tr._match.includes(q)) && (division === 'all' || tr._division === division);
      tr.hidden = !ok;
      if (ok) shown++;
    }
    countLine.textContent = shown === rows.length ? `${rows.length} client${rows.length === 1 ? '' : 's'}` : `Showing ${shown} of ${rows.length}`;
  }
  search.addEventListener('input', apply);

  const divisionsPresent = ['jtg', 'uny', 'mco'].filter((d) => companies.some((c) => c.division === d));
  const seg = divisionsPresent.length > 1 ? h('div', { class: 'seg', role: 'group', 'aria-label': 'Division' },
    ['all', ...divisionsPresent].map((d) => h('button', {
      type: 'button', 'aria-pressed': d === division ? 'true' : 'false',
      onclick: (e) => {
        division = d;
        e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b === e.currentTarget ? 'true' : 'false'));
        apply();
      }
    }, d === 'all' ? 'All' : DIVISION_LABELS[d]))) : null;

  fill(main, 
    head,
    h('div', { class: 'toolbar' }, [search, seg, countLine]),
    h('div', { class: 'card', style: 'padding:6px 8px' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data stackable' }, [
      h('thead', {}, h('tr', {}, ['Client', 'Division', 'Contacts', 'Drafts', 'Last published', 'Owner'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, rows)
    ])))
  );
  apply();
}

function openClientModal(existing) {
  const c = existing || {};
  const name = h('input', { type: 'text', maxlength: 200, value: c.name || '', autocomplete: 'off' });
  const division = h('select', {}, [
    h('option', { value: '' }, 'Choose…'),
    h('option', { value: 'jtg' }, 'JTG — Jump Tech Group'),
    h('option', { value: 'uny' }, 'UNY'),
    h('option', { value: 'mco' }, 'MCO')
  ]);
  division.value = c.division || '';
  const clickup = h('input', { type: 'text', maxlength: 64, value: c.clickupAccountId || '', autocomplete: 'off', spellcheck: 'false' });
  modal({
    title: existing ? 'Edit client' : 'Add client',
    sub: existing ? null : 'Clients see only the updates you publish for them, after you add their contacts.',
    body: [
      field('Client name', name),
      field('Division', division, 'Sets the portal branding and the default colours in prompts.'),
      field('ClickUp account ID', clickup, 'Links this client to their ClickUp account for task sync later.', '(optional)')
    ],
    submitLabel: existing ? 'Save' : 'Add client',
    onSubmit: async () => {
      if (!name.value.trim()) { name.focus(); throw new Error('Enter the client’s name.'); }
      if (!division.value) { division.focus(); throw new Error('Choose a division.'); }
      const body = { name: name.value, division: division.value, clickupAccountId: clickup.value };
      if (existing) {
        await api(`/api/companies?id=${existing.id}`, { method: 'PATCH', body });
        toast('Client saved.');
        renderApp();
      } else {
        const d = await api('/api/companies', { method: 'POST', body });
        toast('Client added. Next: add the people who should see their portal.');
        location.hash = `#/clients/${d.id}/contacts`;
      }
    }
  });
}

/* ---------- One client ---------- */

async function viewClient(main, seq, companyId, tab) {
  let detail;
  try { detail = await api(`/api/companies?id=${encodeURIComponent(companyId)}`); } catch (e) { if (!stale(seq)) showError(main, e); return; }
  if (stale(seq)) return;
  const c = detail.company;
  document.title = `${c.name} · Portal Manager`;

  const tabs = [
    { id: 'updates', label: 'Updates' },
    { id: 'contacts', label: `Contacts (${detail.contacts.length})` },
    { id: 'staff', label: 'Staff' },
    can('manageClients') ? { id: 'settings', label: 'Settings' } : null
  ].filter(Boolean);
  if (!tabs.some((t) => t.id === tab)) tab = 'updates';

  const actions = can('edit') ? [h('a', { class: 'btn btn-primary', href: `#/compose/${c.id}` }, '+ New update')] : [];
  const head = pageHead(c.name, null, actions, [h('a', { href: '#/clients' }, 'Clients'), h('span', { 'aria-hidden': 'true' }, '›'), h('span', {}, c.name)]);
  head.querySelector('h1').append(' ', badge(DIVISION_LABELS[c.division] || c.division, c.division), c.active === false ? badge('Inactive', 'off') : '');

  const body = h('div', {}, h('div', { class: 'loading' }, 'Loading…'));
  fill(main, 
    head,
    h('nav', { class: 'tabs', 'aria-label': 'Client sections' }, tabs.map((t) => h('a', { href: `#/clients/${c.id}/${t.id}`, 'aria-current': t.id === tab ? 'page' : null }, t.label))),
    body
  );

  if (tab === 'updates') return tabUpdates(body, seq, c);
  if (tab === 'contacts') return tabContacts(body, c, detail.contacts);
  if (tab === 'staff') return tabStaff(body, c, detail.staff);
  if (tab === 'settings') return tabSettings(body, c);
}

async function tabUpdates(body, seq, c) {
  let data;
  try { data = await api(`/api/updates?companyId=${c.id}`); } catch (e) { if (!stale(seq)) showError(body, e); return; }
  if (stale(seq)) return;
  const updates = data.updates || [];
  if (updates.length === 0) {
    fill(body, h('div', { class: 'empty' }, [
      `No updates for ${c.name} yet.`,
      can('edit') ? [h('br'), h('a', { class: 'btn btn-primary', href: `#/compose/${c.id}` }, 'Write the first update')] : null
    ].flat()));
    return;
  }
  let filter = 'all';
  const counts = { draft: 0, published: 0, archived: 0 };
  updates.forEach((u) => { counts[u.status] = (counts[u.status] || 0) + 1; });
  const rows = updates.map((u) => {
    const tr = h('tr', { class: 'clickable', onclick: (e) => { if (e.target.closest('a')) return; location.hash = `#/edit/${u.id}`; } }, [
      h('td', { class: 'primary-cell' }, [
        h('a', { href: `#/edit/${u.id}` }, u.title || 'Untitled'),
        u.summary ? h('div', { class: 'muted' }, u.summary.length > 140 ? `${u.summary.slice(0, 140)}…` : u.summary) : null
      ]),
      h('td', { 'data-label': 'Type' }, TYPE_LABELS[u.type] || u.type),
      h('td', { 'data-label': 'Status' }, badge(u.status, u.status)),
      h('td', { 'data-label': 'Last edited' }, fmtDate(u.updatedAt)),
      h('td', { 'data-label': 'Published' }, u.publishedAt ? fmtDate(u.publishedAt) : h('span', { class: 'muted' }, '—'))
    ]);
    tr._status = u.status;
    return tr;
  });
  const apply = () => rows.forEach((tr) => { tr.hidden = filter !== 'all' && tr._status !== filter; });
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' }, [
    ['all', `All (${updates.length})`], ['draft', `Drafts (${counts.draft})`], ['published', `Published (${counts.published})`], ['archived', `Archived (${counts.archived})`]
  ].map(([id, label]) => h('button', {
    type: 'button', 'aria-pressed': id === filter ? 'true' : 'false',
    onclick: (e) => {
      filter = id;
      e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b === e.currentTarget ? 'true' : 'false'));
      apply();
    }
  }, label)));
  fill(body, 
    h('div', { class: 'toolbar' }, seg),
    h('div', { class: 'card', style: 'padding:6px 8px' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data stackable' }, [
      h('thead', {}, h('tr', {}, ['Update', 'Type', 'Status', 'Last edited', 'Published'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, rows)
    ])))
  );
}

function tabContacts(body, c, contacts) {
  const editable = can('edit');
  const list = contacts.length === 0
    ? h('div', { class: 'empty' }, 'No one can sign in to this client’s portal yet.')
    : h('div', { class: 'table-wrap' }, h('table', { class: 'data stackable' }, [
      h('thead', {}, h('tr', {}, ['Name', 'Email', 'Role', editable ? '' : null].filter((t) => t !== null).map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, contacts.map((p) => {
        const role = h('select', {
          'aria-label': `Role for ${p.email}`, disabled: !editable,
          onchange: async (e) => {
            try { await api(`/api/contacts?contactId=${p.id}&companyId=${c.id}`, { method: 'PATCH', body: { role: e.target.value } }); toast('Role updated.'); }
            catch (err) { e.target.value = p.role; fail(err); }
          }
        }, Object.entries(CONTACT_ROLES).map(([v, l]) => h('option', { value: v }, l)));
        role.value = p.role;
        return h('tr', {}, [
          h('td', {}, [p.fullName || h('span', { class: 'muted' }, '—'), p.active === false ? [' ', badge('Switched off', 'off')] : null].flat()),
          h('td', { 'data-label': 'Email', style: 'overflow-wrap:anywhere' }, p.email),
          h('td', { 'data-label': 'Role' }, role),
          editable ? h('td', { class: 'row-actions' }, h('button', {
            class: 'btn btn-danger btn-sm', type: 'button',
            onclick: async () => {
              if (!confirm(`Remove ${p.email} from ${c.name}? They will no longer see this client’s portal.`)) return;
              try { await api(`/api/contacts?contactId=${p.id}&companyId=${c.id}`, { method: 'DELETE' }); toast('Removed.'); renderApp(); }
              catch (err) { fail(err); }
            }
          }, 'Remove')) : null
        ]);
      }))
    ]));

  let addForm = null;
  if (editable) {
    const email = h('input', { type: 'email', autocomplete: 'off', placeholder: 'name@client.com', required: true });
    const name = h('input', { type: 'text', autocomplete: 'off', maxlength: 120 });
    const role = h('select', {}, Object.entries(CONTACT_ROLES).map(([v, l]) => h('option', { value: v }, l)));
    role.value = 'member';
    const btn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add contact');
    addForm = h('form', {
      class: 'card', novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        if (btn.disabled) return;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value.trim())) { toast('Enter a valid email address.', 'err'); email.focus(); return; }
        btn.disabled = true;
        try {
          await api('/api/contacts', { method: 'POST', body: { companyId: c.id, email: email.value, fullName: name.value, role: role.value } });
          toast(`${email.value.trim()} can now sign in to ${c.name}’s portal.`);
          renderApp();
        } catch (err) { btn.disabled = false; fail(err); }
      }
    }, [
      h('h2', {}, 'Give someone portal access'),
      h('p', { class: 'sub' }, 'They sign in at the client portal with this email and see only this client’s published updates.'),
      h('div', { class: 'stack' }, [
        h('div', { class: 'row' }, [field('Email', email), field('Name', name, null, '(optional)')]),
        h('div', { class: 'row' }, [field('Role', role, 'Owners and members are treated the same for now; viewers will be read-only once requests arrive.'), h('div', { style: 'align-self:end' }, btn)])
      ])
    ]);
  }
  fill(body, h('div', { class: 'card' }, [h('h2', {}, 'Who can see this portal'), h('p', { class: 'sub' }, `${contacts.length} contact${contacts.length === 1 ? '' : 's'}`), list]), addForm);
}

async function tabStaff(body, c, staff) {
  const manage = can('manageClients');
  const list = staff.length === 0
    ? h('div', { class: 'empty' }, 'No staff assigned. Managers and super admins can still see this client.')
    : h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, [
      h('tbody', {}, staff.map((s) => h('tr', {}, [
        h('td', { class: 'primary-cell' }, [s.name, s.isPrimary ? [' ', badge('Primary', 'published')] : null].flat()),
        manage ? h('td', { class: 'row-actions' }, [
          s.isPrimary ? null : h('button', {
            class: 'btn btn-link', type: 'button',
            onclick: async () => {
              try { await api('/api/assignments', { method: 'POST', body: { companyId: c.id, personId: s.personId, isPrimary: true } }); toast(`${s.name} is now the primary contact.`); renderApp(); }
              catch (err) { fail(err); }
            }
          }, 'Make primary'),
          h('button', {
            class: 'btn btn-danger btn-sm', type: 'button',
            onclick: async () => {
              if (!confirm(`Unassign ${s.name} from ${c.name}?`)) return;
              try { await api(`/api/assignments?companyId=${c.id}&personId=${s.personId}`, { method: 'DELETE' }); toast('Unassigned.'); renderApp(); }
              catch (err) { fail(err); }
            }
          }, 'Unassign')
        ]) : null
      ])))
    ]));

  const parts = [h('div', { class: 'card' }, [
    h('h2', {}, 'Staff on this account'),
    h('p', { class: 'sub' }, 'Account managers and supervisors only see clients they are assigned to here.'),
    list
  ])];
  if (manage) {
    let team = [];
    try { team = ((await api('/api/team')).team || []).filter((p) => p.active !== false); } catch (err) { fail(err); }
    const assigned = new Set(staff.map((s) => s.personId));
    const options = team.filter((p) => !assigned.has(p.personId));
    if (options.length) {
      const who = h('select', {}, [h('option', { value: '' }, 'Choose a team member…'), ...options.map((p) => h('option', { value: p.personId }, `${p.fullName || p.email} — ${ROLE_LABELS[p.role] || p.role}`))]);
      const primary = h('input', { type: 'checkbox', id: 'asg-primary' });
      const btn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Assign');
      parts.push(h('form', {
        class: 'card', novalidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          if (!who.value) { toast('Choose a team member.', 'err'); who.focus(); return; }
          btn.disabled = true;
          try { await api('/api/assignments', { method: 'POST', body: { companyId: c.id, personId: who.value, isPrimary: primary.checked } }); toast('Assigned.'); renderApp(); }
          catch (err) { btn.disabled = false; fail(err); }
        }
      }, [
        h('h2', {}, 'Assign staff'),
        h('div', { class: 'stack' }, [
          field('Team member', who),
          h('label', { for: 'asg-primary', style: 'display:flex;gap:8px;align-items:center;font-weight:600' }, [primary, 'Primary contact for this client']),
          h('div', {}, btn)
        ])
      ]));
    }
  }
  fill(body, ...parts);
}

function tabSettings(body, c) {
  const name = h('input', { type: 'text', maxlength: 200, value: c.name });
  const division = h('select', {}, Object.entries(DIVISION_LABELS).map(([v, l]) => h('option', { value: v }, l)));
  division.value = c.division;
  const clickup = h('input', { type: 'text', maxlength: 64, value: c.clickupAccountId || '', spellcheck: 'false' });
  const accentText = h('input', { type: 'text', maxlength: 7, value: c.accent || '', placeholder: 'Division default', spellcheck: 'false', style: 'max-width:160px' });
  const accentPick = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(c.accent || '') ? c.accent : '#2E3192', 'aria-label': 'Pick accent colour', style: 'width:48px;height:40px;padding:2px;border:1px solid var(--line);border-radius:6px;background:#fff' });
  accentPick.addEventListener('input', () => { accentText.value = accentPick.value.toUpperCase(); });
  accentText.addEventListener('input', () => { if (/^#[0-9a-f]{6}$/i.test(accentText.value)) accentPick.value = accentText.value; });
  const active = h('input', { type: 'checkbox', id: 'set-active', checked: c.active !== false });
  const btn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save settings');
  fill(body, h('form', {
    class: 'card', novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      if (!name.value.trim()) { toast('Enter the client’s name.', 'err'); name.focus(); return; }
      btn.disabled = true;
      try {
        await api(`/api/companies?id=${c.id}`, { method: 'PATCH', body: { name: name.value, division: division.value, clickupAccountId: clickup.value, accent: accentText.value.trim(), active: active.checked } });
        toast('Settings saved.');
        renderApp();
      } catch (err) { btn.disabled = false; fail(err); }
    }
  }, [
    h('h2', {}, 'Client settings'),
    h('div', { class: 'stack', style: 'margin-top:12px' }, [
      h('div', { class: 'row' }, [field('Client name', name), field('Division', division)]),
      field('ClickUp account ID', clickup, null, '(optional)'),
      h('div', { class: 'field' }, [
        h('label', { for: accentText.id = 'set-accent' }, ['Accent colour ', h('span', { class: 'opt' }, '(optional)')]),
        h('div', { style: 'display:flex;gap:8px;align-items:center' }, [accentPick, accentText]),
        h('div', { class: 'hint' }, 'Used for headings and highlights in prompts and drafts. Leave empty for the division colour.')
      ]),
      h('label', { for: 'set-active', style: 'display:flex;gap:8px;align-items:center;font-weight:600' }, [active, 'Active — contacts can sign in and see published updates']),
      h('div', {}, btn)
    ])
  ]));
}

/* ---------- Composer ---------- */

async function viewComposer(main, seq, { companyId, updateId }) {
  let doc;
  let detail;
  try {
    if (updateId) {
      doc = (await api(`/api/updates?id=${encodeURIComponent(updateId)}`)).update;
      companyId = doc.companyId;
    } else {
      doc = { id: null, status: 'draft', type: 'update', title: '', summary: '', notes: '', bodyHtml: '', updatedAt: null };
    }
    detail = await api(`/api/companies?id=${encodeURIComponent(companyId)}`);
  } catch (e) { if (!stale(seq)) showError(main, e); return; }
  if (stale(seq)) return;
  const company = detail.company;
  const readOnly = !can('edit') || doc.status === 'archived';
  document.title = `${doc.id ? (doc.title || 'Untitled') : 'New update'} · ${company.name}`;

  // ----- inputs -----
  const type = h('select', { disabled: readOnly }, Object.entries(TYPE_LABELS).map(([v, l]) => h('option', { value: v }, l)));
  type.value = doc.type;
  const title = h('input', { type: 'text', maxlength: 200, value: doc.title, disabled: readOnly, placeholder: 'e.g. October results: leads up 32%' });
  const summary = h('textarea', { maxlength: 1000, rows: 2, value: doc.summary, disabled: readOnly, style: 'min-height:64px', placeholder: 'One or two sentences shown above the page in the client’s list.' });
  const notes = h('textarea', { class: 'notes', maxlength: 20000, value: doc.notes, disabled: readOnly, placeholder: 'Paste call notes, numbers, dates, links — anything the client needs to know. Rough is fine.' });
  const notesCount = h('div', { class: 'count', 'aria-live': 'off' });
  const bodyHtml = h('textarea', { class: 'code', value: doc.bodyHtml, disabled: readOnly, spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', placeholder: '<!doctype html>\n<html>…the page from Gemini, Claude or ChatGPT…</html>' });
  const bodyCount = h('div', { class: 'count' });

  let format = TYPE_FORMAT[doc.type] || 'update';
  let formatChosen = false;

  function updateCounts() {
    notesCount.textContent = `${notes.value.length.toLocaleString('en-US')} / 20,000`;
    notesCount.classList.toggle('over', notes.value.length > 20000);
    const kb = new Blob([bodyHtml.value]).size / 1024;
    bodyCount.textContent = bodyHtml.value ? `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB` : '';
  }

  // ----- prompt helpers -----
  const promptCtx = () => ({
    company: { name: company.name, division: company.division, branding: company.accent ? { accent: company.accent } : {} },
    title: title.value,
    notes: notes.value,
    sender: state.me.fullName && !state.me.fullName.includes('@') ? state.me.fullName : '',
    date: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  });
  const promptPre = h('pre', {});
  const refreshPeek = () => { promptPre.textContent = buildPrompt(format, promptCtx()); };

  const formatCards = h('div', { class: 'format-cards', role: 'group', 'aria-label': 'Page format' }, FORMATS.map((f) => h('button', {
    type: 'button', class: 'format-card', 'aria-pressed': f.id === format ? 'true' : 'false', 'data-format': f.id,
    onclick: () => { format = f.id; formatChosen = true; syncFormatCards(); refreshPeek(); }
  }, [h('strong', {}, f.label), h('span', {}, FORMAT_SHORT[f.id] || f.blurb)])));
  function syncFormatCards() {
    formatCards.querySelectorAll('.format-card').forEach((b) => b.setAttribute('aria-pressed', b.dataset.format === format ? 'true' : 'false'));
  }

  const copyBtn = h('button', {
    class: 'btn btn-primary', type: 'button',
    onclick: async () => {
      if (!notes.value.trim() && !confirm('Your notes are empty, so the prompt will only have a placeholder. Copy it anyway?')) return;
      const ok = await copyText(buildPrompt(format, promptCtx()));
      if (ok) {
        copyBtn.textContent = 'Copied ✓';
        setTimeout(() => { copyBtn.textContent = 'Copy prompt'; }, 2500);
        toast('Prompt copied. Paste it into Gemini, Claude or ChatGPT, then paste the page it writes into Page HTML.');
      } else {
        peek.open = true;
        toast('Your browser blocked copying. Select the prompt under “See the full prompt” and copy it by hand.', 'err', 7000);
      }
    }
  }, 'Copy prompt');

  const gemini = state.me.gemini || { available: false };
  const gemBtn = h('button', {
    class: 'btn btn-gem', type: 'button',
    disabled: !gemini.available || !can('assist'),
    title: gemini.available ? `Drafts with ${gemini.model}` : 'Gemini drafting is paused',
    onclick: () => draftWithGemini()
  }, '✦ Draft with Gemini');
  const gemNote = h('div', { class: 'note gem', hidden: gemini.available });
  function setGemPaused(message) {
    gemBtn.disabled = true;
    gemNote.hidden = false;
    gemNote.textContent = message || 'Gemini drafting is paused until the subscription is renewed. Copy prompt does the same job: paste it into Gemini, Claude or ChatGPT, then paste the page it writes below.';
  }
  if (!gemini.available) setGemPaused(gemini.reason === 'switched_off' ? 'Gemini drafting is switched off for now. Copy prompt does the same job by hand.' : null);

  const peek = h('details', { class: 'prompt-peek', ontoggle: () => { if (peek.open) refreshPeek(); } }, [h('summary', {}, 'See the full prompt'), promptPre]);

  async function draftWithGemini() {
    if (!notes.value.trim()) { toast('Add your notes first — Gemini only writes from what you give it.', 'err'); notes.focus(); return; }
    if (bodyHtml.value.trim() && !confirm('Replace the current page HTML with a new Gemini draft?')) return;
    gemBtn.disabled = true;
    gemBtn.textContent = 'Drafting… (up to a minute)';
    announce('Drafting with Gemini');
    try {
      const d = await api('/api/assist', { method: 'POST', body: { format, companyId: company.id, title: title.value, notes: notes.value } });
      bodyHtml.value = d.html;
      markDirty();
      updateCounts();
      if (doc.status === 'draft') {
        // save() shows its own error (e.g. no title yet); only claim success if it saved.
        if (await save({ quiet: true })) toast('Draft ready and saved. Check the preview, fix any [to confirm] gaps, then publish.');
      } else {
        // A live page is never overwritten by an unreviewed draft.
        toast('Draft ready but NOT saved — this update is live. Review it, then save.', 'ok', 8000);
      }
    } catch (err) {
      if (err.data && err.data.paused) {
        state.me.gemini = { ...gemini, available: false };
        setGemPaused(err.message + ' Copy prompt still works.');
      } else fail(err);
    } finally {
      gemBtn.textContent = '✦ Draft with Gemini';
      if (state.me.gemini && state.me.gemini.available !== false) gemBtn.disabled = !can('assist');
    }
  }

  // ----- preview -----
  let previewMode = 'phone';
  // Same sandbox as the server's CSP: no scripts or forms; links may open a new tab.
  const frame = h('iframe', { class: 'preview-frame phone', title: 'Client page preview', sandbox: 'allow-popups allow-popups-to-escape-sandbox', referrerpolicy: 'no-referrer', loading: 'lazy' });
  const previewEmpty = h('div', { class: 'preview-empty' }, 'Save to see the page exactly as the client will.');
  const previewBox = h('div', {});
  function refreshPreview() {
    if (!doc.id) { fill(previewBox, previewEmpty); return; }
    frame.src = `/api/view?id=${doc.id}&v=${Date.now()}`;
    if (!frame.isConnected) fill(previewBox, frame);
  }
  const modeSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Preview width' }, [['phone', 'Phone'], ['full', 'Full width']].map(([id, label]) => h('button', {
    type: 'button', 'aria-pressed': id === previewMode ? 'true' : 'false',
    onclick: (e) => {
      previewMode = id;
      frame.classList.toggle('phone', id === 'phone');
      e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b === e.currentTarget ? 'true' : 'false'));
    }
  }, label)));

  // ----- status + actions -----
  const statusText = h('span', {});
  const statusBadge = h('span', {});
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => save() });
  const publishBtn = h('button', { class: 'btn btn-go', type: 'button', onclick: () => publish() }, 'Publish…');
  const unpublishBtn = h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => doTransition('unpublish') }, 'Unpublish');
  const archiveBtn = h('button', { class: 'btn btn-link', type: 'button', onclick: () => doTransition('archive') }, 'Archive');
  const restoreBtn = h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => doTransition('restore') }, 'Restore as draft');

  function renderStatus() {
    fill(statusBadge, badge(doc.id ? doc.status : 'new draft', doc.id ? doc.status : 'draft'));
    if (state.dirty) statusText.textContent = doc.status === 'published' ? 'Unsaved — this update is live, saving changes what the client sees' : 'Unsaved changes';
    else if (doc.updatedAt) statusText.textContent = `Saved ${fmtDate(doc.updatedAt)}`;
    else statusText.textContent = '';
    saveBtn.textContent = doc.status === 'published' ? 'Save live changes' : 'Save draft';
    saveBtn.hidden = readOnly;
    publishBtn.hidden = readOnly || !can('publish') || doc.status !== 'draft';
    unpublishBtn.hidden = !can('publish') || doc.status !== 'published';
    archiveBtn.hidden = !can('publish') || !doc.id || doc.status === 'archived';
    restoreBtn.hidden = !can('edit') || doc.status !== 'archived';
  }

  function markDirty() { if (!state.dirty) { state.dirty = true; renderStatus(); } }

  let saving = false;
  async function save({ quiet = false } = {}) {
    if (saving) return false;
    if (!title.value.trim()) { toast('Add a title before saving.', 'err'); title.focus(); return false; }
    saving = true;
    saveBtn.disabled = true;
    const body = { type: type.value, title: title.value, summary: summary.value, notes: notes.value, bodyHtml: bodyHtml.value };
    try {
      if (!doc.id) {
        doc = (await api('/api/updates', { method: 'POST', body: { companyId: company.id, ...body } })).update;
        replaceRoute(`#/edit/${doc.id}`);
      } else {
        doc = (await api(`/api/updates?id=${doc.id}`, { method: 'PATCH', body: { ...body, expectedUpdatedAt: doc.updatedAt } })).update;
      }
      // The server sanitises the page; show what was actually stored.
      if (doc.bodyHtml !== undefined && doc.bodyHtml !== bodyHtml.value) {
        bodyHtml.value = doc.bodyHtml;
        if (!quiet) toast('Saved. Scripts, forms or embeds were removed from the page — they can’t run in the portal.', 'ok', 7000);
      } else if (!quiet) toast(doc.status === 'published' ? 'Saved — the client now sees this version.' : 'Draft saved.');
      state.dirty = false;
      document.title = `${doc.title || 'Untitled'} · ${company.name}`;
      renderStatus();
      updateCounts();
      refreshPreview();
      announce('Saved');
      return true;
    } catch (err) {
      fail(err);
      return false;
    } finally {
      saving = false;
      saveBtn.disabled = false;
    }
  }

  async function doTransition(action) {
    const confirmText = {
      unpublish: `Take “${doc.title}” off ${company.name}’s portal? It goes back to draft.`,
      archive: doc.status === 'published' ? `Archive “${doc.title}”? It will disappear from ${company.name}’s portal.` : `Archive “${doc.title}”?`
    }[action];
    if (confirmText && !confirm(confirmText)) return;
    if (state.dirty && action !== 'restore' && !(await save({ quiet: true }))) return;
    try {
      doc = { ...doc, ...(await api(`/api/updates?id=${doc.id}&action=${action}`, { method: 'POST' })).update };
      toast({ unpublish: 'Unpublished — back to draft.', archive: 'Archived.', restore: 'Restored as a draft.' }[action]);
      state.dirty = false;
      renderApp();
    } catch (err) { fail(err); }
  }

  async function publish() {
    if (state.dirty || !doc.id) { if (!(await save({ quiet: true }))) return; }
    const n = detail.contacts.filter((p) => p.active !== false).length;
    modal({
      title: `Publish to ${company.name}?`,
      sub: n
        ? `${n} contact${n === 1 ? '' : 's'} will see “${doc.title}” in their portal straight away.`
        : `${company.name} has no portal contacts yet, so nobody will see this until you add one on the Contacts tab.`,
      body: [h('p', { style: 'margin:0;font-size:14px;color:var(--steel)' }, 'Check the preview for any [to confirm] gaps first — that marker means the notes didn’t say.')],
      submitLabel: 'Publish now',
      submitClass: 'btn-go',
      onSubmit: async () => {
        doc = { ...doc, ...(await api(`/api/updates?id=${doc.id}&action=publish`, { method: 'POST' })).update };
        toast(`Published to ${company.name}.`);
        state.dirty = false;
        renderStatus();
        refreshPreview();
      }
    });
  }

  // ----- wire-up -----
  for (const el of [type, title, summary, notes, bodyHtml]) el.addEventListener('input', () => { markDirty(); updateCounts(); });
  type.addEventListener('change', () => {
    markDirty();
    if (!formatChosen) { format = TYPE_FORMAT[type.value] || 'update'; syncFormatCards(); }
  });
  let peekTimer;
  for (const el of [title, notes]) el.addEventListener('input', () => { clearTimeout(peekTimer); if (peek.open) peekTimer = setTimeout(refreshPeek, 300); });
  // Ctrl/Cmd+S saves.
  main.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !readOnly) { e.preventDefault(); save(); }
  });

  const crumbs = [
    h('a', { href: '#/clients' }, 'Clients'), h('span', { 'aria-hidden': 'true' }, '›'),
    h('a', { href: `#/clients/${company.id}` }, company.name), h('span', { 'aria-hidden': 'true' }, '›'),
    h('span', {}, doc.id ? 'Edit update' : 'New update')
  ];

  const left = h('div', { class: 'stack' }, [
    h('section', { class: 'card', 'aria-labelledby': 'c-details' }, [
      h('h2', { id: 'c-details' }, 'Details'),
      h('div', { class: 'stack', style: 'margin-top:10px' }, [
        h('div', { class: 'row-3' }, [field('Type', type), field('Title', title)]),
        field('Summary', summary, null, '(optional)')
      ])
    ]),
    h('section', { class: 'card', 'aria-labelledby': 'c-notes' }, [
      h('h2', { id: 'c-notes' }, 'Your notes'),
      h('p', { class: 'sub' }, 'Internal — clients never see these. They’re what the prompt turns into a page.'),
      notes, notesCount
    ]),
    readOnly ? null : h('section', { class: 'card', 'aria-labelledby': 'c-assist' }, [
      h('h2', { id: 'c-assist' }, 'Turn your notes into a page'),
      h('p', { class: 'sub' }, 'Pick a format. Copy prompt fills in your notes, the client and their colours.'),
      formatCards,
      h('div', { class: 'assist-actions' }, [copyBtn, can('assist') ? gemBtn : null]),
      h('div', { class: 'paste-into' }, ['Paste into:', ...AI_LINKS.map((l) => h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, `${l.label} ↗`))]),
      can('assist') ? gemNote : null,
      peek
    ]),
    h('section', { class: 'card', 'aria-labelledby': 'c-html' }, [
      h('h2', { id: 'c-html' }, 'Page HTML'),
      h('p', { class: 'sub' }, readOnly ? 'The stored page.' : 'Paste the complete page here. Scripts, forms and embeds are stripped when you save.'),
      bodyHtml, bodyCount
    ])
  ]);

  const right = h('section', { class: 'preview-col card', 'aria-labelledby': 'c-preview' }, [
    h('div', { class: 'preview-head' }, [
      h('h2', { id: 'c-preview', style: 'margin:0' }, 'Preview'),
      h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, [
        modeSeg,
        h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => (state.dirty && !readOnly ? save() : refreshPreview()) }, state.dirty ? 'Save & refresh' : 'Refresh')
      ])
    ]),
    previewBox
  ]);

  const archivedNote = doc.status === 'archived' ? h('div', { class: 'note warn', style: 'margin-bottom:14px' }, 'This update is archived and read-only. Restore it as a draft to edit or republish.') : null;
  const roNote = !can('edit') ? h('div', { class: 'note', style: 'margin-bottom:14px' }, 'Your role can read updates but not change them.') : null;

  fill(main, 
    pageHead(doc.id ? (doc.title || 'Untitled') : 'New update', `For ${company.name}`, [], crumbs),
    archivedNote, roNote,
    h('div', { class: 'composer' }, [left, right]),
    h('div', { class: 'action-bar' }, [
      h('div', { class: 'status', role: 'status' }, [statusBadge, statusText]),
      archiveBtn, restoreBtn, unpublishBtn, saveBtn, publishBtn
    ])
  );
  renderStatus();
  updateCounts();
  refreshPreview();
  if (!doc.id) setTimeout(() => title.focus(), 0);
}

/* ---------- Prompt library ---------- */

function viewPrompts(main, seq, focusId) {
  document.title = 'Prompt library · Portal Manager';
  const sender = state.me.fullName && !state.me.fullName.includes('@') ? state.me.fullName : '';
  const cards = FORMATS.map((f) => {
    const text = buildPrompt(f.id, { sender });
    const btn = h('button', {
      class: 'btn btn-primary', type: 'button',
      onclick: async () => {
        const ok = await copyText(text);
        if (ok) { btn.textContent = 'Copied ✓'; setTimeout(() => { btn.textContent = 'Copy prompt'; }, 2500); toast('Copied. Replace the [placeholders] and paste your notes at the end.'); }
        else toast('Your browser blocked copying. Select the prompt below and copy it by hand.', 'err', 7000);
      }
    }, 'Copy prompt');
    const linkBtn = h('button', {
      class: 'btn btn-secondary', type: 'button',
      onclick: async () => {
        const url = `${location.origin}${location.pathname}#/prompts/${f.id}`;
        if (await copyText(url)) toast('Link to this prompt copied.'); else toast(url, 'ok', 8000);
      }
    }, 'Copy link');
    return h('section', { class: 'card prompt-card', id: `prompt-${f.id}`, 'aria-labelledby': `ph-${f.id}`, tabindex: '-1', style: focusId === f.id ? 'box-shadow:0 0 0 3px var(--blue)' : null }, [
      h('h2', { id: `ph-${f.id}` }, f.label),
      h('p', { class: 'sub' }, f.blurb),
      h('div', { class: 'assist-actions' }, [btn, linkBtn]),
      h('div', { class: 'paste-into' }, ['Paste into:', ...AI_LINKS.map((l) => h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, `${l.label} ↗`))]),
      h('pre', {}, text)
    ]);
  });
  fill(main, 
    pageHead('Prompt library', `Three prompts that turn rough notes into a client-ready page. Version ${PROMPT_VERSION}.`),
    h('section', { class: 'card', style: 'margin-bottom:16px' }, [
      h('h2', {}, 'Fastest way: from inside an update'),
      h('ol', { class: 'steps', style: 'margin-top:8px' }, [
        h('li', {}, 'Open a client and start a new update. Paste your notes.'),
        h('li', {}, 'Pick a format and press Copy prompt — the client, their colours, your name and your notes are filled in.'),
        h('li', {}, 'Paste it into Gemini, Claude or ChatGPT and copy the HTML page it writes.'),
        h('li', {}, 'Paste that into Page HTML, save, check the preview, then publish.')
      ]),
      h('div', { class: 'note' }, 'Copying from this page gives the bare template: replace the [placeholders] and put your notes between <notes> and </notes>.')
    ]),
    h('div', { class: 'prompt-grid' }, cards)
  );
  if (focusId && formatById(focusId)) {
    const el = document.getElementById(`prompt-${focusId}`);
    if (el) setTimeout(() => { el.scrollIntoView({ block: 'start' }); el.focus({ preventScroll: true }); }, 0);
  }
}

/* ---------- Team ---------- */

async function viewTeam(main, seq) {
  document.title = 'Team · Portal Manager';
  let data;
  try { data = await api('/api/team'); } catch (e) { if (!stale(seq)) showError(main, e); return; }
  if (stale(seq)) return;
  const team = data.team || [];
  const manage = can('manageTeam');

  const roleSelect = (value, attrs = {}) => {
    const s = h('select', attrs, Object.entries(ROLE_LABELS).map(([v, l]) => h('option', { value: v }, l)));
    s.value = value;
    return s;
  };

  const rows = team.map((p) => {
    const self = p.personId === state.me.personId;
    const locked = !manage || self || p.bootstrap;
    const sel = roleSelect(p.role, {
      'aria-label': `Role for ${p.fullName || p.email}`, disabled: locked,
      onchange: async (e) => {
        try { await api(`/api/team?personId=${p.personId}`, { method: 'PATCH', body: { role: e.target.value } }); toast('Role updated.'); }
        catch (err) { e.target.value = p.role; fail(err); }
      }
    });
    return h('tr', {}, [
      h('td', { class: 'primary-cell' }, [p.fullName || p.email, self ? ' (you)' : '', p.bootstrap ? [' ', badge('Owner', 'blue')] : null, p.active === false ? [' ', badge('Inactive', 'off')] : null].flat()),
      h('td', { 'data-label': 'Email', style: 'overflow-wrap:anywhere' }, p.email),
      h('td', { 'data-label': 'Role' }, locked ? (ROLE_LABELS[p.role] || p.role) : sel),
      manage ? h('td', { class: 'row-actions' }, locked ? (p.bootstrap ? h('span', { class: 'muted', title: 'Set in the PORTAL_ADMIN_EMAILS setting' }, 'Set in Vercel') : null) : h('button', {
        class: 'btn btn-danger btn-sm', type: 'button',
        onclick: async () => {
          if (!confirm(`Remove ${p.fullName || p.email}’s Portal Manager access? Their client assignments are removed too.`)) return;
          try { await api(`/api/team?personId=${p.personId}`, { method: 'DELETE' }); toast('Access removed.'); renderApp(); }
          catch (err) { fail(err); }
        }
      }, 'Remove')) : null
    ]);
  });

  const actions = manage ? [h('button', {
    class: 'btn btn-primary', type: 'button',
    onclick: () => {
      const email = h('input', { type: 'email', autocomplete: 'off' });
      const name = h('input', { type: 'text', maxlength: 120, autocomplete: 'off' });
      const role = roleSelect('account_manager');
      const help = h('div', { class: 'hint' }, ROLE_HELP.account_manager);
      role.addEventListener('change', () => { help.textContent = ROLE_HELP[role.value]; });
      modal({
        title: 'Add team member',
        sub: 'They sign in with a link sent to this email.',
        body: [field('Email', email), field('Name', name, null, '(optional)'), h('div', { class: 'field' }, [h('label', { for: role.id = 'tm-role' }, 'Role'), role, help])],
        submitLabel: 'Add',
        onSubmit: async () => {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value.trim())) { email.focus(); throw new Error('Enter a valid email address.'); }
          await api('/api/team', { method: 'POST', body: { email: email.value, fullName: name.value, role: role.value } });
          toast('Added. Assign them to clients from each client’s Staff tab.');
          renderApp();
        }
      });
    }
  }, '+ Add team member')] : [];

  fill(main, 
    pageHead('Team', 'Who can use the Portal Manager, and what each role can do.', actions),
    h('div', { class: 'card', style: 'padding:6px 8px' }, team.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data stackable' }, [
      h('thead', {}, h('tr', {}, ['Name', 'Email', 'Role', manage ? '' : null].filter((t) => t !== null).map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, rows)
    ])) : h('div', { class: 'empty' }, 'No one yet.')),
    h('section', { class: 'card' }, [
      h('h2', {}, 'Roles'),
      h('table', { class: 'data' }, h('tbody', {}, Object.entries(ROLE_LABELS).map(([k, l]) => h('tr', {}, [h('td', { style: 'font-weight:700;white-space:nowrap' }, l), h('td', {}, ROLE_HELP[k])]))))
    ])
  );
}

boot();
