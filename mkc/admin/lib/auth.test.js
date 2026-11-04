import test from 'node:test';
import assert from 'node:assert/strict';

// A stand-in for Supabase's REST API that records every request and answers
// people lookups the way PostgREST's ilike would (with _ and % as wildcards).
const PEOPLE = [
  { id: 'p-rep', email: 'john@x.test', full_name: 'John', tool_access: [{ role: 'rep', tool: 'booking' }] },
  { id: 'p-boss', email: 'boss@x.test', full_name: 'Boss', tool_access: [] }
];
const calls = [];
function likeRe(p) {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') { re += p[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    re += c === '%' || c === '*' ? '.*' : c === '_' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}
process.env.SUPABASE_URL = 'https://fake.supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
process.env.MKC_ADMIN_EMAILS = 'boss@x.test';
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  calls.push({ method: init.method || 'GET', path: u.pathname, query: u.searchParams, body: init.body });
  if (u.pathname.endsWith('/people') && (init.method || 'GET') === 'GET') {
    const pattern = (u.searchParams.get('email') || '').replace(/^ilike\./, '');
    return new Response(JSON.stringify(PEOPLE.filter((p) => likeRe(pattern).test(p.email))), { status: 200 });
  }
  return new Response('[{"id":"new"}]', { status: 201 });
};

const { getAccessRole, ensurePerson } = await import('./auth.js');

test('an email with "_" cannot borrow the role of an address it wildcard-matches', async () => {
  assert.equal(await getAccessRole('john@x.test'), 'rep');
  assert.equal(await getAccessRole('j_hn@x.test'), null);
  assert.equal(await getAccessRole('%@x.test'), null);
});

test('signing in never changes an existing role (a rep stays a rep)', async () => {
  calls.length = 0;
  await ensurePerson('john@x.test');
  assert.equal(calls.filter((c) => c.path.endsWith('/tool_access')).length, 0);
});

test('bootstrap emails are granted super_admin', async () => {
  calls.length = 0;
  await ensurePerson('boss@x.test');
  const grant = calls.find((c) => c.path.endsWith('/tool_access'));
  assert.ok(grant);
  assert.deepEqual(JSON.parse(grant.body), { person_id: 'p-boss', tool: 'booking', role: 'super_admin' });
});
