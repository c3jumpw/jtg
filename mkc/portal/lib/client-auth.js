import { createHash } from 'node:crypto';
import { select, json, UUID_RE } from './core.js';

/* Client sign-in for the portal.
 *
 * Clients are portal.contacts, not MKC staff, so they have their own tables
 * (portal.client_magic_links, portal.client_sessions) and their own cookie.
 * A staff session can never be used here and a client session can never be
 * used in the Portal Manager.
 *
 * Which companies a client sees is worked out on the server from their
 * contact record on every request. The browser only ever names a company it
 * wants; it never decides what it may see.
 */

export const COOKIE_NAME = 'portal_sid';
export const SESSION_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

export const hashToken = (raw) => createHash('sha256').update(raw).digest('hex');

/** Divisions this deployment serves. portal.j-tgroup.com serves JTG clients;
 *  a UNY or MCO portal is the same code with a different PORTAL_DIVISIONS. */
export function portalDivisions(env = process.env) {
  const list = String(env.PORTAL_DIVISIONS || 'jtg').split(',').map((s) => s.trim().toLowerCase())
    .filter((d) => ['jtg', 'uny', 'mco'].includes(d));
  return list.length ? list : ['jtg'];
}

export function readCookie(request, name = COOKIE_NAME) {
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

export function sessionCookie(token, { clear = false } = {}) {
  if (clear) return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SEC}`;
}

/** Active companies, in this portal's divisions, that the contact is linked to. */
export async function clientCompanies(contactId, db = { select }, env = process.env) {
  if (!UUID_RE.test(String(contactId || ''))) return [];
  const divisions = portalDivisions(env);
  const rows = await db.select('portal', 'contact_companies',
    `select=role,companies!inner(id,name,division,active,branding)&contact_id=eq.${contactId}` +
    `&companies.active=eq.true&companies.division=in.(${divisions.join(',')})`) || [];
  return rows
    .filter((r) => r.companies && r.companies.active !== false && divisions.includes(r.companies.division))
    .map((r) => ({
      id: r.companies.id,
      name: r.companies.name,
      division: r.companies.division,
      role: r.role,
      accent: (r.companies.branding && /^#[0-9a-f]{6}$/i.test(r.companies.branding.accent || '')) ? r.companies.branding.accent : null
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Returns { contactId, email, fullName } or throws a JSON Response. */
export async function requireClient(request, db = { select }) {
  const token = readCookie(request);
  if (!token) throw json(401, { error: 'Sign in required.' });
  const rows = await db.select('portal', 'client_sessions',
    `select=contact_id,expires_at&token_hash=eq.${hashToken(token)}`);
  const s = rows && rows[0];
  if (!s || new Date(s.expires_at).getTime() <= Date.now()) throw json(401, { error: 'Your session has ended. Sign in again.' });
  const people = await db.select('portal', 'contacts', `select=id,email,full_name,active&id=eq.${s.contact_id}`);
  const contact = people && people[0];
  if (!contact || contact.active === false) throw json(401, { error: 'Your portal access has been switched off.' });
  return { contactId: contact.id, email: contact.email, fullName: contact.full_name || '' };
}

/** The one company a request names, if this client may see it; else 404. */
export async function requireClientCompany(client, companyId, db = { select }, env = process.env) {
  if (!UUID_RE.test(String(companyId || ''))) throw json(400, { error: 'Choose a company.' });
  const companies = await clientCompanies(client.contactId, db, env);
  const company = companies.find((c) => c.id === companyId);
  if (!company) throw json(404, { error: 'Not found.' });
  return company;
}
