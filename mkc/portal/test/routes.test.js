/* End-to-end route tests for the client portal against the fake PostgREST. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fakeBackend, install, call } from './fake-postgrest.js';

const SQL = new URL('../../sql/001_portal_foundation.sql', import.meta.url).pathname;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const future = () => new Date(Date.now() + 86400000).toISOString();
const past = () => new Date(Date.now() - 60000).toISOString();

const K = { pat: 'bbbbbbbb-0000-4000-8000-000000000001', lou: 'bbbbbbbb-0000-4000-8000-000000000002', off: 'bbbbbbbb-0000-4000-8000-000000000003' };
const C = { acme: 'cccccccc-0000-4000-8000-000000000001', globex: 'cccccccc-0000-4000-8000-000000000002', unyco: 'cccccccc-0000-4000-8000-000000000003', closed: 'cccccccc-0000-4000-8000-000000000004' };
const U = { pub: 'dddddddd-0000-4000-8000-000000000001', draft: 'dddddddd-0000-4000-8000-000000000002', other: 'dddddddd-0000-4000-8000-000000000003', old: 'dddddddd-0000-4000-8000-000000000004' };

function world() {
  const b = fakeBackend({
    sqlPath: SQL,
    seed: {
      'portal.contacts': [
        { id: K.pat, email: 'pat@acme.test', full_name: 'Pat', active: true },
        { id: K.lou, email: 'lou@nowhere.test', full_name: 'Lou', active: true },
        { id: K.off, email: 'off@acme.test', full_name: 'Off', active: false }
      ],
      'portal.companies': [
        { id: C.acme, name: 'Acme', division: 'jtg', active: true, branding: {} },
        { id: C.globex, name: 'Globex', division: 'jtg', active: true, branding: {} },
        { id: C.unyco, name: 'Uny Co', division: 'uny', active: true, branding: {} },
        { id: C.closed, name: 'Closed Co', division: 'jtg', active: false, branding: {} }
      ],
      'portal.contact_companies': [
        { contact_id: K.pat, company_id: C.acme, role: 'owner' },
        { contact_id: K.pat, company_id: C.unyco, role: 'member' },
        { contact_id: K.pat, company_id: C.closed, role: 'member' },
        { contact_id: K.lou, company_id: C.unyco, role: 'member' },
        { contact_id: K.off, company_id: C.acme, role: 'member' }
      ],
      'portal.updates': [
        { id: U.pub, company_id: C.acme, type: 'update', title: 'October results', summary: 'Leads up', notes: 'INTERNAL NOTE', body_html: '<h1>Leads up 32%</h1>', status: 'published', published_at: '2026-11-01T10:00:00Z' },
        { id: U.old, company_id: C.acme, type: 'guide', title: 'Older', summary: '', notes: '', body_html: '<p>old</p>', status: 'published', published_at: '2026-10-01T10:00:00Z' },
        { id: U.draft, company_id: C.acme, type: 'task', title: 'Not ready', summary: '', notes: '', body_html: '<p>draft</p>', status: 'draft', published_at: null },
        { id: U.other, company_id: C.globex, type: 'update', title: 'Globex only', summary: '', notes: '', body_html: '<p>globex</p>', status: 'published', published_at: '2026-11-02T10:00:00Z' }
      ],
      'portal.client_sessions': [
        { token_hash: sha('pat-session'), contact_id: K.pat, expires_at: future() },
        { token_hash: sha('off-session'), contact_id: K.off, expires_at: future() },
        { token_hash: sha('stale-session'), contact_id: K.pat, expires_at: past() }
      ],
      'portal.client_magic_links': [
        { token_hash: sha('good-link-token-aaaaaaaaaaaa'), contact_id: K.pat, expires_at: future(), used_at: null },
        { token_hash: sha('old-link-token-aaaaaaaaaaaaa'), contact_id: K.pat, expires_at: past(), used_at: null },
        { token_hash: sha('used-link-token-aaaaaaaaaaaa'), contact_id: K.pat, expires_at: future(), used_at: past() },
        { token_hash: sha('off-link-token-aaaaaaaaaaaaa'), contact_id: K.off, expires_at: future(), used_at: null }
      ]
    }
  });
  install(b, { PORTAL_DIVISIONS: 'jtg', SITE_URL: 'https://portal.j-tgroup.com' });
  return b;
}
const pat = 'portal_sid=pat-session';

const load = async () => ({
  request: (await import('../api/auth-request.js')).default,
  callback: (await import('../api/auth-callback.js')).default,
  me: (await import('../api/me.js')).default,
  updates: (await import('../api/updates.js')).default,
  view: (await import('../api/view.js')).default
});

test('sign-in request: same answer for everyone, email only for real clients of this portal', async () => {
  const b = world();
  const r = await load();
  const ask = (email, ip) => call(r.request, '/api/auth-request', { method: 'POST', body: { email }, ip });
  const known = await (await ask('PAT@acme.test', '192.0.2.1')).json();
  const unknown = await (await ask('nobody@acme.test', '192.0.2.2')).json();
  const otherDivision = await (await ask('lou@nowhere.test', '192.0.2.3')).json();
  const switchedOff = await (await ask('off@acme.test', '192.0.2.4')).json();
  assert.deepEqual(unknown, known);
  assert.deepEqual(otherDivision, known);
  assert.deepEqual(switchedOff, known);
  assert.equal(b.sent.emails.length, 1);
  assert.deepEqual(b.sent.emails[0].to, ['pat@acme.test']);
  assert.match(b.sent.emails[0].html, /https:\/\/portal\.j-tgroup\.com\/#signin=[A-Za-z0-9_-]{32}/);
  assert.doesNotMatch(b.sent.emails[0].html, /\?t=/, 'token must not be in the query string');
  assert.equal(b.db['portal.client_magic_links'].length, 5);
});

test('sign-in link: works once, then reads as used; expired and bad links fail clearly', async () => {
  const b = world();
  const r = await load();
  const spend = (t, ip) => call(r.callback, '/api/auth-callback', { method: 'POST', body: { t }, ip });
  const ok = await spend('good-link-token-aaaaaaaaaaaa', '192.0.2.10');
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /^portal_sid=[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
  assert.equal(b.db['portal.client_sessions'].length, 4);
  assert.equal((await (await spend('good-link-token-aaaaaaaaaaaa', '192.0.2.10')).json()).code, 'used');
  assert.equal((await (await spend('old-link-token-aaaaaaaaaaaaa', '192.0.2.10')).json()).code, 'expired');
  assert.equal((await (await spend('used-link-token-aaaaaaaaaaaa', '192.0.2.10')).json()).code, 'used');
  assert.equal((await (await spend('never-issued-token-aaaaaaaaa', '192.0.2.10')).json()).code, 'badlink');
  assert.equal((await (await spend('../../etc', '192.0.2.10')).json()).code, 'badlink');
  const off = await spend('off-link-token-aaaaaaaaaaaaa', '192.0.2.10');
  assert.equal(off.status, 403);
  assert.equal(b.db['portal.client_magic_links'].find((l) => l.token_hash === sha('off-link-token-aaaaaaaaaaaaa')).used_at, null, 'refused links are not spent');
  assert.equal(b.db['core.audit_log'].filter((a) => a.action === 'client.sign_in').length, 1);

  // The new cookie works.
  const sid = cookie.split(';')[0];
  const me = await (await call(r.me, '/api/me', { cookie: sid })).json();
  assert.equal(me.authenticated, true);
});

test('who-am-I lists only active companies in this portal’s divisions', async () => {
  world();
  const r = await load();
  const me = await (await call(r.me, '/api/me', { cookie: pat })).json();
  assert.deepEqual(me.companies.map((c) => c.name), ['Acme']);
  assert.equal((await (await call(r.me, '/api/me', { cookie: 'portal_sid=stale-session' })).json()).authenticated, false);
  assert.equal((await (await call(r.me, '/api/me', { cookie: 'portal_sid=off-session' })).json()).authenticated, false);
  assert.equal((await (await call(r.me, '/api/me', { cookie: 'mkc_portal_sid=pat-session' })).json()).authenticated, false, 'staff cookie name is not accepted');
});

test('updates: published only, newest first, never staff notes, never another company', async () => {
  world();
  const r = await load();
  const res = await call(r.updates, `/api/updates?companyId=${C.acme}`, { cookie: pat });
  const { updates } = await res.json();
  assert.deepEqual(updates.map((u) => u.title), ['October results', 'Older']);
  assert.doesNotMatch(JSON.stringify(updates), /INTERNAL NOTE|body_html|notes/);
  assert.equal((await call(r.updates, `/api/updates?companyId=${C.globex}`, { cookie: pat })).status, 404);
  assert.equal((await call(r.updates, `/api/updates?companyId=${C.unyco}`, { cookie: pat })).status, 404, 'other division');
  assert.equal((await call(r.updates, `/api/updates?companyId=${C.closed}`, { cookie: pat })).status, 404, 'inactive company');
  assert.equal((await call(r.updates, `/api/updates?companyId=${C.acme}`)).status, 401);
});

test('view: published page in a sandbox; drafts and other companies look identical to missing', async () => {
  const b = world();
  const r = await load();
  const ok = await call(r.view, `/api/view?id=${U.pub}`, { cookie: pat });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-security-policy'), /^sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'/);
  assert.equal(ok.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(await ok.text(), /Leads up 32%/);
  assert.equal(b.db['core.audit_log'].at(-1).action, 'update.view');

  const texts = [];
  for (const id of [U.draft, U.other, 'dddddddd-0000-4000-8000-0000000000ff', 'nope']) {
    const res = await call(r.view, `/api/view?id=${id}`, { cookie: pat });
    assert.equal(res.status, 404);
    texts.push(await res.text());
  }
  assert.equal(new Set(texts).size, 1, 'every hidden case returns the same page');
  assert.equal((await call(r.view, `/api/view?id=${U.pub}`)).status, 401);
});

test('sign out expires the session server-side', async () => {
  const b = world();
  const r = await load();
  const out = await call(r.me, '/api/me?action=logout', { method: 'POST', cookie: pat });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await (await call(r.me, '/api/me', { cookie: pat })).json()).authenticated, false);
  assert.equal(b.db['core.audit_log'].at(-1).action, 'client.sign_out');
});
