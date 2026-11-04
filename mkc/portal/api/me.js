import { patch, json, originAllowed, route } from '../lib/core.js';
import { requireClient, clientCompanies, readCookie, hashToken, sessionCookie } from '../lib/client-auth.js';
import { auditClient } from '../lib/audit.js';

/*  GET               who is signed in, and the companies they can see
 *  POST ?action=logout  ends the session */

export default route(async (request) => {
  const action = new URL(request.url).searchParams.get('action');

  if (request.method === 'POST' && action === 'logout') {
    if (!originAllowed(request)) return json(403, { error: 'Not allowed.' });
    const token = readCookie(request);
    if (token) {
      try {
        const rows = await patch('portal', 'client_sessions', `token_hash=eq.${hashToken(token)}`, { expires_at: new Date(Date.now() - 1000).toISOString() });
        if (rows && rows[0]) await auditClient({ contactId: rows[0].contact_id, email: null }, 'client.sign_out', rows[0].contact_id);
      } catch { /* the cookie is cleared regardless */ }
    }
    return json(200, { ok: true }, { 'Set-Cookie': sessionCookie('', { clear: true }) });
  }
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed.' });

  let client;
  try {
    client = await requireClient(request);
  } catch (e) {
    if (e instanceof Response && e.status === 401) return json(200, { authenticated: false });
    throw e;
  }
  return json(200, {
    authenticated: true,
    email: client.email,
    fullName: client.fullName,
    companies: await clientCompanies(client.contactId)
  });
});
