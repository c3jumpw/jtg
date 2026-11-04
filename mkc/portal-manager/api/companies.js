import { select, insert, patch, json, clean, readJson, originAllowed, UUID_RE, route } from '../lib/core.js';
import { requireSession } from '../lib/auth.js';
import { requirePower, visibleCompanyIds, loadVisibleCompany, companyFilter } from '../lib/access.js';
import { audit } from '../lib/pipeline.js';

const DIVISIONS = ['jtg', 'uny', 'mco'];

function readCompany(body, { partial }) {
  const out = {};
  const errors = [];
  if (!partial || 'name' in body) {
    const name = clean(body.name, 201);
    if (!name) errors.push('A client name is required.');
    else if (name.length > 200) errors.push('Keep the name under 200 characters.');
    else out.name = name;
  }
  if (!partial || 'division' in body) {
    if (!DIVISIONS.includes(body.division)) errors.push('Choose which division serves this client.');
    else out.division = body.division;
  }
  if ('clickupAccountId' in body) {
    const id = clean(body.clickupAccountId, 64);
    if (id && !/^[a-z0-9]+$/i.test(id)) errors.push('The ClickUp account ID should be letters and numbers only.');
    else out.clickup_account_id = id || null;
  }
  if ('primaryOwnerPersonId' in body) {
    const pid = body.primaryOwnerPersonId;
    if (pid && !UUID_RE.test(String(pid))) errors.push('Choose a valid account owner.');
    else out.primary_owner_person_id = pid || null;
  }
  if ('accent' in body) {
    const a = clean(body.accent, 7);
    if (a && !/^#[0-9a-f]{6}$/i.test(a)) errors.push('Accent colour must look like #2E3192.');
    else out.accent = a || null;
  }
  if ('active' in body) out.active = Boolean(body.active);
  if (errors.length) throw json(400, { error: errors.join(' ') });
  return out;
}

async function listCompanies(session) {
  const ids = await visibleCompanyIds(session);
  if (ids && ids.length === 0) return [];
  const filter = companyFilter(ids, 'id');
  const companies = await select('portal', 'companies',
    `select=id,name,division,clickup_account_id,primary_owner_person_id,active,updated_at&order=name.asc${filter ? '&' + filter : ''}`) || [];
  if (companies.length === 0) return [];

  // Counts come from the portal.company_overview view (counted in the
  // database), so busy clients aren't cut off at the API's row limit, and
  // people who see every client don't send every id in the URL.
  const ownerIds = [...new Set(companies.map((c) => c.primary_owner_person_id).filter(Boolean))];
  const overviewFilter = companyFilter(ids);
  const [overview, owners] = await Promise.all([
    select('portal', 'company_overview', `select=company_id,contacts,drafts,last_published_at${overviewFilter ? '&' + overviewFilter : ''}`),
    ownerIds.length ? select('core', 'people', `select=id,full_name,email&id=in.(${ownerIds.join(',')})`) : Promise.resolve([])
  ]);
  const stats = Object.fromEntries((overview || []).map((o) => [o.company_id, o]));
  const ownerById = Object.fromEntries((owners || []).map((p) => [p.id, p]));
  return companies.map((c) => ({
    id: c.id, name: c.name, division: c.division, clickupAccountId: c.clickup_account_id, active: c.active,
    owner: c.primary_owner_person_id && ownerById[c.primary_owner_person_id]
      ? { id: c.primary_owner_person_id, name: ownerById[c.primary_owner_person_id].full_name || ownerById[c.primary_owner_person_id].email }
      : null,
    contacts: (stats[c.id] && stats[c.id].contacts) || 0,
    drafts: (stats[c.id] && stats[c.id].drafts) || 0,
    lastPublishedAt: (stats[c.id] && stats[c.id].last_published_at) || null
  }));
}

async function companyDetail(session, id) {
  const c = await loadVisibleCompany(session, id);
  const [links, assignments] = await Promise.all([
    select('portal', 'contact_companies',
      `select=role,created_at,contacts(id,email,full_name,active)&company_id=eq.${c.id}&order=created_at.asc`),
    select('portal', 'staff_company_assignments', `select=person_id,is_primary&company_id=eq.${c.id}`)
  ]);
  const staffIds = (assignments || []).map((a) => a.person_id);
  const people = staffIds.length ? await select('core', 'people', `select=id,full_name,email&id=in.(${staffIds.join(',')})`) : [];
  const byId = Object.fromEntries((people || []).map((p) => [p.id, p]));
  return {
    company: {
      id: c.id, name: c.name, division: c.division, clickupAccountId: c.clickup_account_id,
      primaryOwnerPersonId: c.primary_owner_person_id, active: c.active,
      accent: (c.branding && c.branding.accent) || null
    },
    contacts: (links || []).filter((l) => l.contacts).map((l) => ({
      id: l.contacts.id, email: l.contacts.email, fullName: l.contacts.full_name, active: l.contacts.active, role: l.role
    })),
    staff: (assignments || []).map((a) => ({
      personId: a.person_id, isPrimary: a.is_primary,
      name: (byId[a.person_id] && (byId[a.person_id].full_name || byId[a.person_id].email)) || 'Unknown'
    }))
  };
}

export default route(async (request) => {
  if (!originAllowed(request)) return json(403, { error: 'Not allowed.' });
  const session = await requireSession(request);
  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  if (request.method === 'GET') {
    if (id) return json(200, await companyDetail(session, id));
    return json(200, { companies: await listCompanies(session) });
  }

  if (request.method === 'POST') {
    requirePower(session, 'manageClients', 'Only managers and super admins can add clients.');
    const { body, error } = await readJson(request, 8000);
    if (error) return error;
    const fields = readCompany(body, { partial: false });
    const { accent, ...row } = fields;
    if (accent) row.branding = { accent };
    let created;
    try {
      created = (await insert('portal', 'companies', row))[0];
    } catch (e) {
      if (e.status === 409) return json(409, { error: 'Another client already uses that ClickUp account ID.' });
      throw e;
    }
    await audit(session, 'company.create', created.id, { name: created.name, division: created.division });
    return json(201, { id: created.id });
  }

  if (request.method === 'PATCH') {
    requirePower(session, 'manageClients', 'Only managers and super admins can change client settings.');
    const current = await loadVisibleCompany(session, id);
    const { body, error } = await readJson(request, 8000);
    if (error) return error;
    const fields = readCompany(body, { partial: true });
    const { accent, ...changes } = fields;
    if ('accent' in fields) changes.branding = { ...(current.branding || {}), accent: accent || undefined };
    if (Object.keys(changes).length === 0) return json(200, { ok: true });
    try {
      await patch('portal', 'companies', `id=eq.${current.id}`, changes);
    } catch (e) {
      if (e.status === 409) return json(409, { error: 'Another client already uses that ClickUp account ID.' });
      throw e;
    }
    await audit(session, 'company.edit', current.id, { fields: Object.keys(changes) });
    return json(200, { ok: true });
  }

  return json(405, { error: 'Method not allowed.' });
});
