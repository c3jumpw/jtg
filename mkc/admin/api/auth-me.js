import { select } from '../lib/core.js';
import { readCookie, hashToken, sessionCookie, COOKIE_NAME, getAccessRole } from '../lib/auth.js';
import { json } from '../lib/core.js';

async function handler(request) {
  const url = new URL(request.url);
  const action = (url.searchParams.get('action') || '').toLowerCase();

  if (request.method === 'POST' && action === 'logout') {
    const token = readCookie(request, COOKIE_NAME);
    if (token) {
      try {
        const { patch } = await import('../lib/core.js');
        // We could delete, but let's expire it so audit history is preserved.
        await patch('core', 'sessions', `token_hash=eq.${hashToken(token)}`, { expires_at: new Date().toISOString() });
      } catch (e) { /* fine */ }
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie('', { clear: true }) }
    });
  }

  if (request.method !== 'GET') return json(405, { error: 'Method not allowed.' });

  const token = readCookie(request, COOKIE_NAME);
  if (!token) return json(200, { authenticated: false });
  try {
    const rows = await select('core', 'sessions',
      `select=email,person_id,expires_at&token_hash=eq.${hashToken(token)}`);
    const s = rows && rows[0];
    if (!s || new Date(s.expires_at).getTime() < Date.now()) return json(200, { authenticated: false });
    const role = await getAccessRole(s.email);
    if (!role) return json(200, { authenticated: false, revoked: true });
    let fullName = s.email;
    let repId = null;
    if (s.person_id) {
      const pr = await select('core', 'people', `select=full_name&id=eq.${s.person_id}`);
      if (pr && pr[0] && pr[0].full_name) fullName = pr[0].full_name;
      // Check if this person is also a rep.
      const rr = await select('booking', 'reps', `select=person_id&person_id=eq.${s.person_id}`);
      if (rr && rr[0]) repId = rr[0].person_id;
    }
    return json(200, { authenticated: true, email: s.email, personId: s.person_id, fullName, role, repId });
  } catch (e) {
    console.error('auth-me failed', e.message);
    return json(500, { error: 'Auth check failed.' });
  }
}

export default { fetch: handler };
