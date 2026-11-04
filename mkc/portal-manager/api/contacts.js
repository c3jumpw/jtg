import { select, insert, patch, remove, json, clean, readJson, originAllowed, EMAIL_RE, UUID_RE, route } from '../lib/core.js';
import { requireSession } from '../lib/auth.js';
import { requirePower, loadVisibleCompany } from '../lib/access.js';
import { audit } from '../lib/pipeline.js';

/* Client contacts — the people who can sign in to the portal for a company.
 * A contact can belong to several companies; removing them from one company
 * only removes that link, never the person. Whoever can edit a client's
 * updates can manage its contacts. */

const ROLES = ['owner', 'member', 'viewer'];

export default route(async (request) => {
  if (!originAllowed(request)) return json(403, { error: 'Not allowed.' });
  const session = await requireSession(request);
  requirePower(session, 'edit', 'Your role cannot change who has portal access.');
  const url = new URL(request.url);

  if (request.method === 'POST') {
    const { body, error } = await readJson(request, 4000);
    if (error) return error;
    const company = await loadVisibleCompany(session, body.companyId);
    const email = clean(body.email, 200).toLowerCase();
    const fullName = clean(body.fullName, 120);
    const role = ROLES.includes(body.role) ? body.role : 'member';
    if (!EMAIL_RE.test(email)) return json(400, { error: 'Enter a valid email address.' });

    // Find or create the person. Contacts are stored lower-cased (unique on
    // lower(email)), so an exact eq match is right — no ilike wildcards.
    const found = await select('portal', 'contacts', `select=id,full_name,active&email=eq.${encodeURIComponent(email)}`);
    let contact = found && found[0];
    if (!contact) {
      contact = (await insert('portal', 'contacts', { email, full_name: fullName }))[0];
    } else if (fullName && !contact.full_name) {
      await patch('portal', 'contacts', `id=eq.${contact.id}`, { full_name: fullName });
    }
    await insert('portal', 'contact_companies', { contact_id: contact.id, company_id: company.id, role },
      { onConflict: 'contact_id,company_id' });
    await audit(session, 'contact.link', contact.id, { company_id: company.id, email, role });
    return json(201, { id: contact.id });
  }

  const contactId = url.searchParams.get('contactId');
  const companyId = url.searchParams.get('companyId');
  if (!UUID_RE.test(String(contactId || ''))) return json(400, { error: 'A valid contact is required.' });
  const company = await loadVisibleCompany(session, companyId);

  if (request.method === 'PATCH') {
    const { body, error } = await readJson(request, 2000);
    if (error) return error;
    const changes = {};
    if ('role' in body) {
      if (!ROLES.includes(body.role)) return json(400, { error: 'Choose owner, member or viewer.' });
      changes.role = body.role;
    }
    if ('active' in body) {
      // Deactivating stops sign-in everywhere, for every company they belong
      // to — including clients this person may not manage — so it needs the
      // wider power. Removing them from THIS client is the DELETE below.
      requirePower(session, 'manageClients', 'Only managers can switch off a contact everywhere. Remove them from this client instead.');
      await patch('portal', 'contacts', `id=eq.${contactId}`, { active: Boolean(body.active) });
      if (!body.active) await remove('portal', 'client_sessions', `contact_id=eq.${contactId}`);
    }
    if (changes.role) {
      await patch('portal', 'contact_companies', `contact_id=eq.${contactId}&company_id=eq.${company.id}`, changes);
    }
    await audit(session, 'contact.edit', contactId, { company_id: company.id, ...changes, ...('active' in body ? { active: Boolean(body.active) } : {}) });
    return json(200, { ok: true });
  }

  if (request.method === 'DELETE') {
    await remove('portal', 'contact_companies', `contact_id=eq.${contactId}&company_id=eq.${company.id}`);
    await audit(session, 'contact.unlink', contactId, { company_id: company.id });
    return json(200, { ok: true });
  }

  return json(405, { error: 'Method not allowed.' });
});
