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
 * or has a tool_access row for the booking tool in core.tool_access. */

export function bootstrapEmails() {
  return (process.env.MKC_ADMIN_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export async function getAccessRole(email) {
  const em = (email || '').toLowerCase();
  if (!em) return null;
  if (bootstrapEmails().includes(em)) return 'super_admin';
  try {
    const rows = await select('core', 'people',
      `select=id,tool_access!inner(role,tool)&email=ilike.${encodeURIComponent(em)}&tool_access.tool=eq.booking`
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const ta = (rows[0].tool_access || [])[0] || {};
    return ta.role || null; // 'super_admin' | 'admin' | 'rep'
  } catch (e) {
    console.error('role check failed', e.message);
    return null;
  }
}

export async function isAllowed(email) {
  return (await getAccessRole(email)) !== null;
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
  const role = await getAccessRole(s.email);
  if (!role) throw json(403, { error: 'Access removed.' });
  return { email: s.email, personId: s.person_id, role };
}

export async function requireSuperAdmin(request) {
  const session = await requireSession(request);
  if (session.role !== 'super_admin' && session.role !== 'admin') throw json(403, { error: 'Super-admin access required.' });
  return session;
}

export async function ensurePerson(email, fullNameGuess = '') {
  const em = email.toLowerCase();
  const found = await select('core', 'people', `select=id,full_name,email&email=ilike.${encodeURIComponent(em)}`);
  let person = found && found[0];
  if (!person) {
    const created = await insert('core', 'people', { email, full_name: fullNameGuess || email.split('@')[0] });
    person = created && created[0];
  }
  if (person) {
    const isBootstrap = bootstrapEmails().includes(em);
    const role = isBootstrap ? 'super_admin' : 'admin';
    try {
      await insert('core', 'tool_access', { person_id: person.id, tool: 'booking', role }, { onConflict: 'person_id,tool' });
    } catch (e) { /* already granted */ }
  }
  return person;
}
