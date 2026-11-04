import { randomBytes } from 'node:crypto';
import { select, insert, patch, json, readJson, originAllowed, clientIp, rateLimited, route } from '../lib/core.js';
import { hashToken, sessionCookie, clientCompanies, SESSION_TTL_SEC } from '../lib/client-auth.js';
import { auditClient } from '../lib/audit.js';

/* POST { t } — exchanges a sign-in token for a session cookie.
 *
 * The page reads the token from the link's #fragment and posts it here, so a
 * mail scanner that merely opens the link never spends it. Every failure
 * returns a short code the page turns into a plain-English message. */

const fail = (code, status = 400) => json(status, { ok: false, code });

export default route(async (request) => {
  if (!originAllowed(request)) return json(403, { error: 'Not allowed.' });
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' });
  if (rateLimited(`cp-cb:${clientIp(request)}`, 30, 60 * 60_000)) return fail('slow', 429);

  const { body, error } = await readJson(request, 512);
  if (error) return error;
  const raw = typeof body.t === 'string' ? body.t : '';
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(raw)) return fail('badlink');
  const hash = hashToken(raw);

  const rows = await select('portal', 'client_magic_links', `select=contact_id,expires_at,used_at&token_hash=eq.${hash}`);
  const link = rows && rows[0];
  if (!link) return fail('badlink');
  if (link.used_at) return fail('used');
  if (new Date(link.expires_at).getTime() < Date.now()) return fail('expired');

  // Re-check access now, not just when the link was sent: someone removed in
  // the last 15 minutes must not get in.
  const people = await select('portal', 'contacts', `select=id,email,full_name,active&id=eq.${link.contact_id}`);
  const contact = people && people[0];
  if (!contact || contact.active === false || (await clientCompanies(contact.id)).length === 0) return fail('notallowed', 403);

  // Spend the link only if nobody else spent it first (two tabs, a double tap).
  const spent = await patch('portal', 'client_magic_links', `token_hash=eq.${hash}&used_at=is.null`, { used_at: new Date().toISOString() });
  if (!spent || spent.length === 0) return fail('used');

  const session = randomBytes(32).toString('base64url');
  await insert('portal', 'client_sessions', {
    token_hash: hashToken(session),
    contact_id: contact.id,
    expires_at: new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString(),
    ip: clientIp(request),
    user_agent: (request.headers.get('user-agent') || '').slice(0, 300)
  });
  await auditClient({ contactId: contact.id, email: contact.email }, 'client.sign_in', contact.id, {});
  return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(session) });
});
