import { randomBytes } from 'node:crypto';
import { insert, json, clean, EMAIL_RE, rateLimited, clientIp, originAllowed, readJson } from '../lib/core.js';
import { hashToken, isAllowed } from '../lib/auth.js';
import { magicLinkEmail, sendEmail } from '../lib/emails.js';

const SITE_URL = () => (process.env.SITE_URL || 'https://mkc.jtgworkspace.com').replace(/\/$/, '');

async function handler(request) {
  if (!originAllowed(request)) return json(403, { error: 'Not allowed.' });
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' });
  const ip = clientIp(request);
  if (rateLimited(`al:${ip}`, 6, 60 * 60_000)) return json(429, { error: 'Too many requests. Please try again later.' });

  const { body, error } = await readJson(request, 4096);
  if (error) return error;
  const email = clean(body.email, 200).toLowerCase();
  if (!EMAIL_RE.test(email)) return json(400, { error: 'Please check your email address.' });

  // Generic response so we don't leak which emails are on the allowlist.
  const generic = json(200, { ok: true, message: 'If that email is authorised, a sign-in link is on the way.' });
  if (!(await isAllowed(email))) return generic;

  const raw = randomBytes(24).toString('base64url'); // 32 chars
  const link = `${SITE_URL()}/api/auth-callback?t=${raw}`;

  try {
    await insert('core', 'magic_links', { token_hash: hashToken(raw), email, ip });
  } catch (e) {
    console.error('magic_links insert failed', e.message);
    return json(500, { error: 'Couldn’t send a link right now.' });
  }

  const err = await sendEmail({ to: email, ...magicLinkEmail({ url: link, email, ip }), key: `ml-${hashToken(raw).slice(0, 24)}` });
  if (err) { console.error('magic link email failed', err); return json(500, { error: 'Couldn’t send email. Please try again.' }); }
  return generic;
}

export default { fetch: handler };
