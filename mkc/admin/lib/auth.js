import { createHash } from 'node:crypto';
import { select, insert, json } from './core.js';

/* Session cookie utilities: HTTP-only, Secure, SameSite=Lax so the callback link works.
 * The cookie's value is the raw session token; the DB stores only its SHA-256 hash. */

export const COOKIE_NAME = 'mkc_sid';
export const SESSION_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

export const hashToken = (raw) => createHash('sha256').update(raw).digest('hex');

export function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq) === name) {
      try { return decodeURIComponent(part.slice(eq + 1)); } catch { return null; }
    }
  }
  return null;
}

export function sessionCookie(token, { maxAge = SESSION_TTL_SEC, clear = false } = {}) {
  if (clear) return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/* Allowlist: an email is allowed if it appears in the MKC_ADMIN_EMAILS env var (bootstrap)
 * or has an admin tool_access row for the booking tool in core.tool_access. */

export function bootstrapEmails() {
  return (process.env.MKC_ADMIN_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export async function isAllowed(email) {
  const em = (email || '').toLowerCase();
  if (!em) return false;
  if (bootstrapEmails().includes(em)) return true;
  // Existing admin in the DB: core.people joined to core.tool_access on booking/admin.
  try {
    const rows = await select('core', 'people',
      `select=id,tool_access:tool_access!inner(role,tool)&email=ilike.${encodeURIComponent(em)}&tool_access.tool=eq.booking&tool_access.role=eq.admin`
    );
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) {
    console.error('allowlist check failed', e.message);
    return false;
  }
}

/* Session verification for API handlers. Returns { email, personId, role } or throws a Response. */

export async function requireSession(request) {
  const token = readCookie(request, COOKIE_NAME);
  if (!token) throw json(401, { error: 'Sign in required.' });
  const rows = await select('core', 'sessions',
    `select=email,person_id,expires_at&token_hash=eq.${hashToken(token)}`);
  const s = rows && rows[0];
  if (!s) throw json(401, { error: 'Session invalid or expired.' });
  if (new Date(s.expires_at).getTime() < Date.now()) throw json(401, { error: 'Session expired.' });
  // Re-check the allowlist on every request so removals take effect immediately.
  const stillAllowed = await isAllowed(s.email);
  if (!stillAllowed) throw json(403, { error: 'Access removed.' });
  return { email: s.email, personId: s.person_id, role: 'admin' };
}

/* Create-or-fetch a core.people record for the signed-in email, and ensure they have tool_access.
 * Called on successful magic-link exchange so future sessions carry a person_id. */
export async function ensurePerson(email, fullNameGuess = '') {
  const em = email.toLowerCase();
  const found = await select('core', 'people', `select=id,full_name,email&email=ilike.${encodeURIComponent(em)}`);
  let person = found && found[0];
  if (!person) {
    const created = await insert('core', 'people', { email, full_name: fullNameGuess || email.split('@')[0] });
    person = created && created[0];
  }
  if (person) {
    // Idempotent tool_access grant so future allowlist checks find them.
    try {
      await insert('core', 'tool_access', { person_id: person.id, tool: 'booking', role: 'admin' }, { onConflict: 'person_id,tool' });
    } catch (e) { /* already granted */ }
  }
  return person;
}
