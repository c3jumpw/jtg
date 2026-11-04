/* End-to-end route tests for the Portal Manager against the fake PostgREST.
 * Each test builds its own world; the env is set before the routes load. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fakeBackend, install, call } from './fake-postgrest.js';

const SQL = new URL('../../sql/001_portal_foundation.sql', import.meta.url).pathname;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const future = () => new Date(Date.now() + 86400000).toISOString();

const P = {
  boss: 'aaaaaaaa-0000-4000-8000-000000000001',
  am: 'aaaaaaaa-0000-4000-8000-000000000002',
  sup: 'aaaaaaaa-0000-4000-8000-000000000003'
};
const C = { acme: 'cccccccc-0000-4000-8000-000000000001', globex: 'cccccccc-0000-4000-8000-000000000002' };

function world(extra = {}) {
  const b = fakeBackend({
    sqlPath: SQL,
    seed: {
      'core.people': [
        { id: P.boss, email: 'boss@mkc.test', full_name: 'Bea Boss', active: true },
        { id: P.am, email: 'am@mkc.test', full_name: 'Avery Manager', active: true },
        { id: P.sup, email: 'sup@mkc.test', full_name: 'Sam Supervisor', active: true }
      ],
      'core.tool_access': [
        { person_id: P.am, tool: 'portal', role: 'account_manager' },
        { person_id: P.sup, tool: 'portal', role: 'supervisor' },
        { person_id: P.boss, tool: 'booking', role: 'admin' }
      ],
      'core.sessions': [
        { token_hash: sha('boss-token'), email: 'boss@mkc.test', person_id: P.boss, expires_at: future() },
        { token_hash: sha('am-token'), email: 'am@mkc.test', person_id: P.am, expires_at: future() },
        { token_hash: sha('sup-token'), email: 'sup@mkc.test', person_id: P.sup, expires_at: future() },
        { token_hash: sha('old-token'), email: 'am@mkc.test', person_id: P.am, expires_at: '2020-01-01T00:00:00Z' }
      ],
      'portal.companies': [
        { id: C.acme, name: 'Acme', division: 'jtg', active: true, branding: {} },
        { id: C.globex, name: 'Globex', division: 'uny', active: true, branding: {} }
      ],
      'portal.staff_company_assignments': [{ person_id: P.am, company_id: C.acme, is_primary: true }, { person_id: P.sup, company_id: C.acme, is_primary: false }],
      ...extra
    },
    gemini: async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '```html\n<!doctype html><html><body><h1>Draft</h1><script>x()</script></body></html>\n```' }] } }] }), { status: 200 })
  });
  install(b, { PORTAL_ADMIN_EMAILS: 'boss@mkc.test', GEMINI_API_KEY: '', GEMINI_PAUSED: '' });
  return b;
}
const as = (who) => `mkc_portal_sid=${who}-token`;

const load = async () => ({
  me: (await import('../api/auth-me.js')).default,
  companies: (await import('../api/companies.js')).default,
  updates: (await import('../api/updates.js')).default,
  view: (await import('../api/view.js')).default,
  assist: (await import('../api/assist.js')).default,
  team: (await import('../api/team.js')).default,
  contacts: (await import('../api/contacts.js')).default,
  assignments: (await import('../api/assignments.js')).default,
  authRequest: (await import('../api/auth-request.js')).default
});

test('who-am-I: signed out, expired, bootstrap owner, and Gemini paused', async () => {
  world();
  const r = await load();
  assert.deepEqual(await (await call(r.me, '/api/auth-me')).json(), { authenticated: false, revoked: false });
  assert.equal((await (await call(r.me, '/api/auth-me', { cookie: as('old') })).json()).authenticated, false);
  const me = await (await call(r.me, '/api/auth-me', { cookie: as('boss') })).json();
  assert.equal(me.role, 'super_admin');
  assert.equal(me.can.manageTeam, true);
  assert.equal(me.gemini.available, false);
  assert.equal(me.gemini.reason, 'no_key');
});

test('account managers see only assigned clients; another client is a 404', async () => {
  world();
  const r = await load();
  const list = await (await call(r.companies, '/api/companies', { cookie: as('am') })).json();
  assert.deepEqual(list.companies.map((c) => c.name), ['Acme']);
  const boss = await (await call(r.companies, '/api/companies', { cookie: as('boss') })).json();
  assert.deepEqual(boss.companies.map((c) => c.name), ['Acme', 'Globex']);
  assert.equal((await call(r.companies, `/api/companies?id=${C.globex}`, { cookie: as('am') })).status, 404);
  assert.equal((await call(r.companies, '/api/companies', { method: 'POST', cookie: as('am'), body: { name: 'X', division: 'jtg' } })).status, 403);
});

test('cross-site requests are refused', async () => {
  world();
  const r = await load();
  assert.equal((await call(r.companies, '/api/companies', { cookie: as('boss'), origin: 'https://evil.example' })).status, 403);
});

test('draft → preview → publish, with the page sanitised and audited', async () => {
  const b = world();
  const r = await load();
  const created = await call(r.updates, '/api/updates', { method: 'POST', cookie: as('am'), body: { companyId: C.acme, type: 'update', title: 'October', notes: 'leads +32%', bodyHtml: '<h1 onclick="x()">Hi</h1><script>steal()</script>' } });
  assert.equal(created.status, 201);
  const { update } = await created.json();
  assert.equal(update.bodyHtml, '<h1>Hi</h1>');

  const preview = await call(r.view, `/api/view?id=${update.id}`, { cookie: as('am') });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('content-security-policy'), /^sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'/);
  assert.match(await preview.text(), /<h1>Hi<\/h1>/);
  assert.equal((await call(r.view, `/api/view?id=${update.id}`, { cookie: as('sup') })).status, 200, 'supervisors can read');

  assert.equal((await call(r.updates, `/api/updates?id=${update.id}&action=publish`, { method: 'POST', cookie: as('sup') })).status, 403);
  const pub = await call(r.updates, `/api/updates?id=${update.id}&action=publish`, { method: 'POST', cookie: as('am') });
  assert.equal(pub.status, 200);
  assert.equal((await pub.json()).update.status, 'published');

  const actions = b.db['core.audit_log'].map((a) => a.action);
  assert.deepEqual(actions, ['update.create', 'update.publish']);
  assert.ok(b.db['core.audit_log'].every((a) => a.tool === 'portal' && a.actor_person_id === P.am));
});

test('stale saves are refused; status and company cannot be changed by PATCH', async () => {
  const b = world();
  const r = await load();
  const { update } = await (await call(r.updates, '/api/updates', { method: 'POST', cookie: as('am'), body: { companyId: C.acme, title: 'A' } })).json();
  const first = await call(r.updates, `/api/updates?id=${update.id}`, { method: 'PATCH', cookie: as('am'), body: { title: 'B', expectedUpdatedAt: update.updatedAt, status: 'published', companyId: C.globex } });
  assert.equal(first.status, 200);
  const row = b.db['portal.updates'][0];
  assert.equal(row.status, 'draft');
  assert.equal(row.company_id, C.acme);
  const second = await call(r.updates, `/api/updates?id=${update.id}`, { method: 'PATCH', cookie: as('am'), body: { title: 'C', expectedUpdatedAt: update.updatedAt } });
  assert.equal(second.status, 409);
});

test('an unassigned client’s update cannot be read, previewed or edited', async () => {
  const b = world({ 'portal.updates': [{ id: 'dddddddd-0000-4000-8000-000000000001', company_id: C.globex, title: 'Secret', status: 'draft', body_html: '<p>secret</p>', notes: 'internal', summary: '', updated_at: new Date().toISOString() }] });
  const r = await load();
  const id = 'dddddddd-0000-4000-8000-000000000001';
  assert.equal((await call(r.updates, `/api/updates?id=${id}`, { cookie: as('am') })).status, 404);
  const v = await call(r.view, `/api/view?id=${id}`, { cookie: as('am') });
  assert.equal(v.status, 404);
  assert.doesNotMatch(await v.text(), /secret/);
  assert.equal((await call(r.updates, `/api/updates?id=${id}`, { method: 'PATCH', cookie: as('am'), body: { title: 'x' } })).status, 404);
  assert.equal(b.db['portal.updates'][0].title, 'Secret');
});

test('Gemini: paused answers 503 paused; live drafts come back sanitised and are audited', async () => {
  const b = world();
  const r = await load();
  const paused = await call(r.assist, '/api/assist', { method: 'POST', cookie: as('am'), body: { format: 'update', companyId: C.acme, title: 'Oct', notes: 'n' } });
  assert.equal(paused.status, 503);
  assert.equal((await paused.json()).paused, true);
  assert.equal(b.sent.gemini.length, 0);

  process.env.GEMINI_API_KEY = 'test-gemini-key';
  const live = await call(r.assist, '/api/assist', { method: 'POST', cookie: as('am'), body: { format: 'task', companyId: C.acme, title: 'Oct', notes: 'Send logo files by Friday' } });
  assert.equal(live.status, 200);
  const d = await live.json();
  assert.match(d.html, /<h1>Draft<\/h1>/);
  assert.doesNotMatch(d.html, /script/);
  const sentPrompt = JSON.parse(b.sent.gemini[0].init.body).contents[0].parts[0].text;
  assert.match(sentPrompt, /Client: Acme/);
  assert.match(sentPrompt, /Their team at Jump Tech Group: Avery Manager/);
  assert.match(sentPrompt, /Send logo files by Friday/);
  assert.equal(b.sent.gemini[0].init.headers['x-goog-api-key'], 'test-gemini-key');
  assert.equal(b.db['core.audit_log'].at(-1).action, 'assist.draft');
  assert.equal((await call(r.assist, '/api/assist', { method: 'POST', cookie: as('sup'), body: { format: 'task', companyId: C.acme, notes: 'n' } })).status, 403);
  assert.equal((await call(r.assist, '/api/assist', { method: 'POST', cookie: as('am'), body: { format: 'task', companyId: C.globex, notes: 'n' } })).status, 404);
  process.env.GEMINI_API_KEY = '';
});

test('contacts: added lower-cased, linked once, removable; supervisors cannot', async () => {
  const b = world();
  const r = await load();
  const add = (cookie, email) => call(r.contacts, '/api/contacts', { method: 'POST', cookie, body: { companyId: C.acme, email, fullName: 'Pat Client', role: 'owner' } });
  assert.equal((await add(as('am'), 'Pat@Client.COM')).status, 201);
  assert.equal((await add(as('am'), 'pat@client.com')).status, 201, 'adding again is idempotent');
  assert.equal(b.db['portal.contacts'].length, 1);
  assert.equal(b.db['portal.contacts'][0].email, 'pat@client.com');
  assert.equal(b.db['portal.contact_companies'].length, 1);
  assert.equal((await add(as('sup'), 'x@client.com')).status, 403);
  const id = b.db['portal.contacts'][0].id;
  assert.equal((await call(r.contacts, `/api/contacts?contactId=${id}&companyId=${C.acme}`, { method: 'PATCH', cookie: as('am'), body: { active: false } })).status, 403, 'switching a contact off everywhere needs a manager');
  assert.equal((await call(r.contacts, `/api/contacts?contactId=${id}&companyId=${C.acme}`, { method: 'DELETE', cookie: as('am') })).status, 200);
  assert.equal(b.db['portal.contact_companies'].length, 0);
});

test('team: only super admins change access, and never their own', async () => {
  const b = world();
  const r = await load();
  assert.equal((await call(r.team, '/api/team', { cookie: as('am') })).status, 403);
  const grant = await call(r.team, '/api/team', { method: 'POST', cookie: as('boss'), body: { email: 'New@MKC.test', fullName: 'New Person', role: 'manager' } });
  assert.equal(grant.status, 201);
  const { personId } = await grant.json();
  assert.ok(b.db['core.tool_access'].some((t) => t.person_id === personId && t.tool === 'portal' && t.role === 'manager'));
  assert.equal((await call(r.team, `/api/team?personId=${P.boss}`, { method: 'PATCH', cookie: as('boss'), body: { role: 'manager' } })).status, 400);
  const list = await (await call(r.team, '/api/team', { cookie: as('boss') })).json();
  assert.ok(list.team.every((p) => p.role), 'every listed person has a portal role');
  assert.ok(!list.team.some((p) => p.email === 'boss@mkc.test' && p.role === 'admin'), 'booking-only roles are not portal roles');
  assert.equal((await call(r.team, `/api/team?personId=${P.am}`, { method: 'DELETE', cookie: as('boss') })).status, 200);
  assert.equal(b.db['portal.staff_company_assignments'].filter((a) => a.person_id === P.am).length, 0);
});

test('assignments: one primary per client', async () => {
  const b = world();
  const r = await load();
  const res = await call(r.assignments, '/api/assignments', { method: 'POST', cookie: as('boss'), body: { companyId: C.acme, personId: P.sup, isPrimary: true } });
  assert.equal(res.status, 201);
  const prim = b.db['portal.staff_company_assignments'].filter((a) => a.company_id === C.acme && a.is_primary);
  assert.deepEqual(prim.map((a) => a.person_id), [P.sup]);
  assert.equal(b.db['portal.companies'].find((c) => c.id === C.acme).primary_owner_person_id, P.sup);
});

test('sign-in links: only for people with portal access, wildcard-safe', async () => {
  const b = world();
  const r = await load();
  // "a_@mkc.test" must not match "am@mkc.test" through LIKE's "_" wildcard.
  const res = await call(r.authRequest, '/api/auth-request', { method: 'POST', body: { email: 'a_@mkc.test' }, ip: '198.51.100.1' });
  assert.equal(res.status, 200);
  assert.equal(b.sent.emails.length, 0);
  await call(r.authRequest, '/api/auth-request', { method: 'POST', body: { email: 'AM@mkc.test' }, ip: '198.51.100.2' });
  assert.equal(b.sent.emails.length, 1);
  assert.equal(b.db['core.magic_links'].length, 1);
  assert.match(b.sent.emails[0].html, /http:\/\/localhost:4801\/#signin=[A-Za-z0-9_-]{32}|\/#signin=[A-Za-z0-9_-]{32}/);
  assert.doesNotMatch(b.sent.emails[0].html, /\?t=/, 'token must not be in the query string');
});

test('sign-in exchange: POST only, spent once, access re-checked first', async () => {
  const b = world({
    'core.magic_links': [
      { token_hash: sha('good-staff-link-aaaaaaaaaaaa'), email: 'am@mkc.test', expires_at: future(), used_at: null },
      { token_hash: sha('nobody-link-aaaaaaaaaaaaaaaa'), email: 'nobody@mkc.test', expires_at: future(), used_at: null }
    ]
  });
  const cb = (await import('../api/auth-callback.js')).default;
  const me = (await import('../api/auth-me.js')).default;
  // A mail scanner opening the link does nothing.
  assert.equal((await call(cb, '/api/auth-callback?t=good-staff-link-aaaaaaaaaaaa')).status, 405);
  assert.equal(b.db['core.magic_links'][0].used_at, null);
  const spend = (t) => call(cb, '/api/auth-callback', { method: 'POST', body: { t }, ip: '198.51.100.20' });
  const [one, two] = await Promise.all([spend('good-staff-link-aaaaaaaaaaaa'), spend('good-staff-link-aaaaaaaaaaaa')]);
  assert.deepEqual([one.status, two.status].sort(), [200, 400], 'two taps at once: exactly one wins');
  const winner = one.status === 200 ? one : two;
  const sid = winner.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await call(me, '/api/auth-me', { cookie: sid })).json()).role, 'account_manager');
  const refused = await spend('nobody-link-aaaaaaaaaaaaaaaa');
  assert.equal((await refused.json()).code, 'notallowed');
  assert.equal(b.db['core.magic_links'][1].used_at, null, 'a refused link is not spent');
  assert.ok(b.db['core.audit_log'].some((a) => a.action === 'staff.sign_in'));
});

test('client list counts come from the overview view', async () => {
  world({ 'portal.updates': [
    { id: 'dddddddd-0000-4000-8000-000000000011', company_id: C.acme, title: 'a', status: 'draft' },
    { id: 'dddddddd-0000-4000-8000-000000000012', company_id: C.acme, title: 'b', status: 'published', published_at: '2026-11-01T00:00:00Z' }
  ] });
  const r = await load();
  const { companies } = await (await call(r.companies, '/api/companies', { cookie: as('boss') })).json();
  const acme = companies.find((c) => c.name === 'Acme');
  assert.equal(acme.drafts, 1);
  assert.equal(acme.lastPublishedAt, '2026-11-01T00:00:00Z');
});
