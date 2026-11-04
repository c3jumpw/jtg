/* Jump Tech Group client portal.
 *
 * Signed out: the sign-in form in index.html. A sign-in link arrives as
 * /#signin=<token>; the token is read here, wiped from the address bar, and
 * posted to the server, so it never reaches access logs or browser history.
 * Signed in: the client's published updates. Update pages are shown only via
 * /api/view in a sandboxed iframe — never inserted into this page.
 */

const signinView = document.getElementById('signin-view');
const portalView = document.getElementById('portal-view');
const form = document.getElementById('signin-form');
const emailInput = document.getElementById('email');
const submit = document.getElementById('signin-submit');
const status = document.getElementById('signin-status');

const HINT_KEY = 'jtg_portal_signed_in';
const state = { me: null, companyId: null, updates: null };

const TYPE_LABELS = { update: 'Update', task: 'Task', guide: 'Guide', report: 'Report', meeting: 'Meeting recap' };
const LINK_ERRORS = {
  badlink: 'That sign-in link isn’t valid. Enter your email to get a new one.',
  used: 'That link has already been used. Enter your email to get a new one.',
  expired: 'That link has expired — they last 15 minutes. Enter your email to get a new one.',
  notallowed: 'That email doesn’t have portal access right now. Contact your account manager if you think that’s wrong.',
  slow: 'Too many sign-in attempts. Please wait a few minutes and try again.'
};

/* ---------- helpers ---------- */

function h(tag, attrs, kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of [].concat(kids == null ? [] : kids)) {
    if (kid == null || kid === false) continue;
    el.append(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return el;
}

const hint = {
  get() { try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return false; } },
  set(on) { try { on ? localStorage.setItem(HINT_KEY, '1') : localStorage.removeItem(HINT_KEY); } catch { /* private mode */ } }
};

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  let res;
  try { res = await fetch(path, init); } catch {
    throw Object.assign(new Error('We can’t reach the portal right now. Check your connection and try again.'), { status: 0 });
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw Object.assign(new Error((data && data.error) || 'Something went wrong. Please try again.'), { status: res.status, data });
  return data;
}

function setStatus(text, kind) {
  status.textContent = text || '';
  status.className = `signin__status${kind ? ` is-${kind}` : ''}`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

/* ---------- signed out ---------- */

function showSignin(message, kind = 'error') {
  state.me = null;
  hint.set(false);
  portalView.hidden = true;
  portalView.replaceChildren();
  signinView.hidden = false;
  document.title = 'Client portal · Jump Tech Group';
  setStatus(message, message ? kind : null);
}

let sending = false;
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (sending) return;
  const email = emailInput.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    emailInput.setAttribute('aria-invalid', 'true');
    setStatus('Please enter the email address your team has on file.', 'error');
    emailInput.focus();
    return;
  }
  emailInput.removeAttribute('aria-invalid');
  sending = true;
  submit.disabled = true;
  submit.textContent = 'Sending…';
  setStatus('');
  try {
    const d = await api('/api/auth-request', { method: 'POST', body: { email } });
    submit.textContent = 'Link sent — check your inbox';
    submit.classList.add('btn--sent');
    setStatus(d.message || 'If that email is registered, a sign-in link is on its way.', 'ok');
    // Let them send again after a short wait, in case it went to spam or they mistyped.
    setTimeout(() => {
      sending = false; submit.disabled = false; submit.classList.remove('btn--sent');
      submit.textContent = 'Send another link';
    }, 30000);
  } catch (err) {
    sending = false; submit.disabled = false; submit.textContent = 'Email me a sign-in link';
    setStatus(err.message, 'error');
  }
});
emailInput.addEventListener('input', () => emailInput.removeAttribute('aria-invalid'));

/* ---------- signed in ---------- */

function shell(content) {
  const me = state.me;
  const signOut = h('button', { class: 'btn btn--ghost', type: 'button', onclick: doSignOut }, 'Sign out');
  portalView.replaceChildren(
    h('header', { class: 'topbar' }, h('div', { class: 'topbar__inner' }, [
      h('a', { href: '#/', 'aria-label': 'Your updates' }, h('img', { class: 'topbar__logo', src: '/assets/logo.png', alt: 'Jump Tech Group', width: '108', height: '34' })),
      h('span', { class: 'topbar__spacer' }),
      h('span', { class: 'who', title: me.email }, me.fullName || me.email),
      signOut
    ])),
    h('main', { class: 'wrap', id: 'main', tabindex: '-1' }, [].concat(content).filter(Boolean)),
    h('footer', { class: 'portal-foot' }, h('a', { href: 'https://j-tgroup.com/' }, 'j-tgroup.com'))
  );
  signinView.hidden = true;
  portalView.hidden = false;
}

async function doSignOut() {
  try { await api('/api/me?action=logout', { method: 'POST' }); } catch { /* cookie is cleared server-side either way */ }
  history.replaceState(null, '', '/');
  showSignin('You’re signed out.', 'ok');
}

function currentCompany() {
  return state.me.companies.find((c) => c.id === state.companyId) || state.me.companies[0];
}

async function renderList() {
  const companies = state.me.companies;
  if (companies.length === 0) {
    document.title = 'Client portal · Jump Tech Group';
    shell(h('div', { class: 'empty' }, [
      h('strong', {}, 'Your portal is being set up'),
      'Your team hasn’t linked your account yet. You’ll get an email when your first update is ready.'
    ]));
    return;
  }
  const company = currentCompany();
  state.companyId = company.id;
  document.title = `${company.name} · Client portal`;

  const switcher = companies.length > 1 ? h('div', { class: 'switcher' }, [
    h('label', { for: 'company' }, 'Company'),
    (() => {
      const s = h('select', { id: 'company', onchange: (e) => { state.companyId = e.target.value; state.updates = null; renderList(); } },
        companies.map((c) => h('option', { value: c.id }, c.name)));
      s.value = company.id;
      return s;
    })()
  ]) : null;

  const list = h('div', {}, h('div', { class: 'loading', role: 'status' }, 'Loading your updates…'));
  shell([
    h('h1', { class: 'page-title' }, companies.length > 1 ? 'Your updates' : `${company.name}`),
    h('p', { class: 'page-sub' }, 'Updates, tasks and guides from your Jump Tech Group team.'),
    switcher,
    list
  ]);

  try {
    const d = await api(`/api/updates?companyId=${encodeURIComponent(company.id)}`);
    if (state.companyId !== company.id) return; // switched while loading
    state.updates = d.updates || [];
  } catch (err) {
    if (err.status === 401) { showSignin('Your session has ended. Sign in again to continue.'); return; }
    list.replaceChildren(h('p', { class: 'error', role: 'alert' }, err.message));
    return;
  }
  if (state.updates.length === 0) {
    list.replaceChildren(h('div', { class: 'empty' }, [h('strong', {}, 'Nothing here yet'), 'Your team will post updates here as work progresses.']));
    return;
  }
  list.replaceChildren(h('ul', { class: 'updates' }, state.updates.map((u) => h('li', {}, h('a', { class: 'update-card', href: `#/u/${u.id}` }, [
    h('div', { class: 'update-card__meta' }, [h('span', { class: 'chip' }, TYPE_LABELS[u.type] || 'Update'), h('time', { datetime: u.publishedAt }, fmtDate(u.publishedAt))]),
    h('h2', { class: 'update-card__title' }, u.title),
    u.summary ? h('p', { class: 'update-card__summary' }, u.summary) : null
  ])))));
}

function renderViewer(id) {
  const known = (state.updates || []).find((u) => u.id === id);
  document.title = `${known ? known.title : 'Update'} · Client portal`;
  const frame = h('iframe', {
    class: 'viewer-frame', src: `/api/view?id=${encodeURIComponent(id)}`, title: known ? known.title : 'Update',
    // Same sandbox as the server's CSP: no scripts or forms; links may open a new tab.
    sandbox: 'allow-popups allow-popups-to-escape-sandbox', referrerpolicy: 'no-referrer'
  });
  // The page carries its own heading, so the shell adds only the way back.
  shell([
    h('div', { class: 'viewer-head' }, [h('a', { class: 'back', href: '#/' }, '← All updates')]),
    h('h1', { class: 'sr-only' }, known ? known.title : 'Update'),
    frame
  ]);
}

function route() {
  if (!state.me) return;
  const m = location.hash.match(/^#\/u\/([0-9a-f-]{36})$/i);
  if (m) renderViewer(m[1]); else renderList();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#signin=')) route(); });

/* ---------- boot ---------- */

/** "Finish signing in" step for email links. Resolves true when tapped. */
function confirmSignin() {
  return new Promise((resolve) => {
    signinView.hidden = true;
    portalView.hidden = false;
    const btn = h('button', { class: 'btn btn--primary', type: 'button', onclick: () => { btn.disabled = true; btn.textContent = 'Signing you in…'; resolve(true); } }, 'Open my portal');
    portalView.replaceChildren(h('main', { class: 'finish', id: 'main' }, h('div', { class: 'finish__card' }, [
      h('img', { class: 'finish__logo', src: '/assets/logo.png', alt: 'Jump Tech Group', width: '140', height: '44' }),
      h('h1', { class: 'page-title' }, 'You’re almost in'),
      h('p', { class: 'page-sub' }, 'Tap below to open your client portal on this device.'),
      btn
    ])));
    setTimeout(() => btn.focus(), 0);
  });
}

async function loadMe() {
  const me = await api('/api/me');
  if (!me || !me.authenticated) return false;
  state.me = me;
  hint.set(true);
  return true;
}

async function boot() {
  // Arriving from an email link: spend the token, then continue signed in.
  const signin = location.hash.match(/^#signin=([A-Za-z0-9_-]{20,64})$/);
  if (signin) {
    // Wipe the token from the address bar now; spend it only when the person
    // taps the button, so a mail scanner that opens (and even runs) the link
    // can't use it up or get a session from it.
    history.replaceState(null, '', '/');
    const ok = await confirmSignin();
    if (!ok) return;
    try {
      const r = await api('/api/auth-callback', { method: 'POST', body: { t: signin[1] } });
      if (!r || !r.ok) throw new Error('badlink');
    } catch (err) {
      const code = err.data && err.data.code;
      showSignin(LINK_ERRORS[code] || LINK_ERRORS.badlink);
      emailInput.focus();
      return;
    }
    portalView.replaceChildren(h('div', { class: 'loading', role: 'status' }, 'Loading your portal…'));
  } else if (hint.get()) {
    // Probably still signed in: show a quiet loading state instead of
    // flashing the sign-in form.
    signinView.hidden = true;
    portalView.hidden = false;
    portalView.replaceChildren(h('div', { class: 'loading', role: 'status' }, 'Loading your portal…'));
  }
  try {
    if (await loadMe()) { route(); return; }
    showSignin(signin ? 'Something went wrong signing you in. Enter your email to get a new link.' : '');
  } catch (err) {
    showSignin(err.message);
  }
}

boot();
