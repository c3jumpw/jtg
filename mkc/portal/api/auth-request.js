import { randomBytes } from 'node:crypto';
import { select, insert, json, clean, EMAIL_RE, rateLimited, clientIp, originAllowed, readJson, route, atLeast } from '../lib/core.js';
import { hashToken, clientCompanies } from '../lib/client-auth.js';
import { signInEmail, sendEmail } from '../lib/emails.js';

/* POST { email } — emails a one-time sign-in link to a known client contact.
 *
 * The answer is the same whether or not the address is known, so the form
 * can't be used to find out who our clients are. The link carries the token
 * in the URL fragment (#signin=…), which browsers never send to a server:
 * it stays out of access logs, and the link scanners many company mail
 * systems run (which fetch links but don't run the page) can't use it up. */

const SITE_URL = () => (process.env.SITE_URL || 'https://portal.j-tgroup.com').replace(/\/$/, '');

export default route(async (request) => {
  if (!originAllowed(request)) return json(403, { error: 'Not allowed.' });
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' });
  const ip = clientIp(request);
  if (rateLimited(`cp-ip:${ip}`, 8, 60 * 60_000)) return json(429, { error: 'Too many requests. Please try again in a little while.' });

  const { body, error } = await readJson(request, 2048);
  if (error) return error;
  const email = clean(body.email, 200).toLowerCase();
  if (!EMAIL_RE.test(email)) return json(400, { error: 'Please check your email address.' });
  if (rateLimited(`cp-em:${email}`, 5, 60 * 60_000)) return json(429, { error: 'Several links have already been sent to that address. Check your inbox, or try again in an hour.' });

  // Same answer, in about the same time, whether or not we know the address.
  const started = Date.now();
  const generic = async () => { await atLeast(1500, started); return json(200, { ok: true, message: 'If that email is registered for a client portal, a sign-in link is on its way.' }); };

  // Contacts are stored lower-cased, so eq is an exact match (no LIKE wildcards).
  const found = await select('portal', 'contacts', `select=id,active&email=eq.${encodeURIComponent(email)}`);
  const contact = found && found[0];
  if (!contact || contact.active === false) return generic();
  if ((await clientCompanies(contact.id)).length === 0) return generic();

  const raw = randomBytes(24).toString('base64url');
  try {
    await insert('portal', 'client_magic_links', { token_hash: hashToken(raw), contact_id: contact.id, ip });
  } catch (e) {
    console.error('client magic link insert failed', e.message);
    return json(500, { error: 'We couldn’t send a link just now. Please try again.' });
  }
  const url = `${SITE_URL()}/#signin=${raw}`;
  const err = await sendEmail({ to: email, ...signInEmail({ url, siteUrl: SITE_URL(), ip }), key: `cp-${hashToken(raw).slice(0, 24)}` });
  if (err) {
    console.error('client sign-in email failed', err);
    return json(500, { error: 'We couldn’t send the email just now. Please try again.' });
  }
  return generic();
});
