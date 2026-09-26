import { randomBytes } from 'node:crypto';
import { select, insert, patch } from '../lib/core.js';
import { hashToken, sessionCookie, SESSION_TTL_SEC, ensurePerson, isAllowed } from '../lib/auth.js';

const SITE_URL = () => (process.env.SITE_URL || 'https://mkc.jtgworkspace.com').replace(/\/$/, '');

function redirect(url, cookie) {
  const headers = { Location: url, 'Cache-Control': 'no-store' };
  if (cookie) headers['Set-Cookie'] = cookie;
  return new Response(null, { status: 302, headers });
}

async function handler(request) {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const url = new URL(request.url);
  const raw = url.searchParams.get('t');
  if (!raw || raw.length > 128) return redirect(`${SITE_URL()}/?e=bad`);

  const th = hashToken(raw);
  const rows = await select('core', 'magic_links', `select=email,expires_at,used_at&token_hash=eq.${th}`);
  const ml = rows && rows[0];
  if (!ml)                                             return redirect(`${SITE_URL()}/?e=badlink`);
  if (ml.used_at)                                      return redirect(`${SITE_URL()}/?e=used`);
  if (new Date(ml.expires_at).getTime() < Date.now())  return redirect(`${SITE_URL()}/?e=expired`);
  if (!(await isAllowed(ml.email)))                    return redirect(`${SITE_URL()}/?e=notallowed`);

  // Mark used first, so a re-click can't create a second session.
  try { await patch('core', 'magic_links', `token_hash=eq.${th}`, { used_at: new Date().toISOString() }); }
  catch (e) { console.error('mark magic link used failed', e.message); }

  const person = await ensurePerson(ml.email);

  const sessionToken = randomBytes(32).toString('base64url'); // 43 chars
  const expiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1000);
  try {
    await insert('core', 'sessions', {
      token_hash: hashToken(sessionToken),
      email: ml.email,
      person_id: person ? person.id : null,
      expires_at: expiresAt.toISOString(),
      ip: (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || null,
      user_agent: (request.headers.get('user-agent') || '').slice(0, 400)
    });
  } catch (e) {
    console.error('session insert failed', e.message);
    return redirect(`${SITE_URL()}/?e=server`);
  }
  return redirect(`${SITE_URL()}/`, sessionCookie(sessionToken));
}

export default { fetch: handler };
