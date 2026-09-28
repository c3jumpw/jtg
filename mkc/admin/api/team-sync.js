import { select, insert, patch, json, clean, EMAIL_RE, readJson } from '../lib/core.js';
import { requireSession } from '../lib/auth.js';

/* Reads the MKC CRM Team Directory (ClickUp-backed) and mirrors it into this
 * system's reps. The CRM is the source of truth for IDENTITY (who someone is,
 * their branch, title, access level). This system stays the source of truth for
 * SCHEDULING (availability, appointments, calendar tokens).
 *
 * Two-step by design: GET previews the roster with a diff against what we hold,
 * POST applies only the members the super-admin picked. No silent bulk writes. */

const CRM_URL = () => (process.env.CRM_TEAM_DIRECTORY_URL || '').trim();
const CRM_SECRET = () => (process.env.CRM_SHARED_SECRET || '').trim();

// The CRM reports 'Super Admin' | 'Admin' | 'Staff'. Map onto our roles.
// Note: a CRM Super Admin is a CRM-wide role, not automatically a Passport
// super-admin — but it's the sensible default, and a super-admin can override.
const ROLE_MAP = { 'super admin': 'super_admin', 'admin': 'admin', 'staff': 'rep' };
function mapRole(accessLevel) {
  return ROLE_MAP[String(accessLevel || '').trim().toLowerCase()] || 'rep';
}

// The CRM's branch field is free-ish text ('Fortune 5', 'Build My Startup').
// Normalise to the page slugs this system uses so discoverability lines up.
const BRANCH_MAP = {
  'fortune 5': 'fortune5', 'fortune5': 'fortune5', 'f5': 'fortune5',
  'the fortune 5 agency': 'fortune5',
  'build my startup': 'bms', 'buildmystartup': 'bms', 'bms': 'bms',
  'jump tech group': 'jtg', 'jtg': 'jtg'
};
function mapBranch(branch) {
  const key = String(branch || '').trim().toLowerCase();
  if (!key) return null;
  // The CRM's labels field can hold several; take the first.
  const first = key.split(',')[0].trim();
  return BRANCH_MAP[first] || first.replace(/[^a-z0-9]+/g, '-') || null;
}

async function fetchRoster(includeInactive) {
  const url = CRM_URL();
  const secret = CRM_SECRET();
  if (!url || !secret) {
    throw new Error('CRM sync is not configured. Set CRM_TEAM_DIRECTORY_URL and CRM_SHARED_SECRET, then redeploy.');
  }
  const full = url + (includeInactive ? (url.includes('?') ? '&' : '?') + 'includeInactive=true' : '');
  let res;
  try {
    res = await fetch(full, { headers: { 'X-Form-Secret': secret, Accept: 'application/json' } });
  } catch (e) {
    throw new Error(`Couldn't reach the CRM: ${e.message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    // Surface the CRM's own message — it distinguishes 401 (bad secret) from 502 (ClickUp down).
    let detail = text.slice(0, 300);
    try { const j = JSON.parse(text); detail = j.error + (j.detail ? ` — ${j.detail}` : ''); } catch {}
    throw new Error(`CRM returned ${res.status}: ${detail}`);
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('CRM returned a response we couldn\'t parse.'); }
  return Array.isArray(data.members) ? data.members : [];
}

/* ---------- GET: preview roster with a diff ---------- */

async function preview(url) {
  const includeInactive = url.searchParams.get('includeInactive') === 'true';
  const members = await fetchRoster(includeInactive);

  // What do we already hold? Match on clickup_team_dir_id first, then email.
  const [existingReps, existingPeople] = await Promise.all([
    select('booking', 'reps', 'select=person_id,display_name,clickup_team_dir_id,branch,title,crm_access_level'),
    select('core', 'people', 'select=id,email,full_name')
  ]);
  const byClickup = new Map((existingReps || []).filter((r) => r.clickup_team_dir_id).map((r) => [r.clickup_team_dir_id, r]));
  const peopleByEmail = new Map((existingPeople || []).map((p) => [(p.email || '').toLowerCase(), p]));
  const repByPerson = new Map((existingReps || []).map((r) => [r.person_id, r]));

  const rows = members.map((m) => {
    const email = (m.email || m.publicEmail || '').toLowerCase();
    let matched = byClickup.get(m.clickupId) || null;
    let matchedBy = matched ? 'clickupId' : null;
    if (!matched && email) {
      const person = peopleByEmail.get(email);
      if (person) { matched = repByPerson.get(person.id) || null; if (matched) matchedBy = 'email'; }
    }
    const branch = mapBranch(m.branch);
    const role = mapRole(m.accessLevel);
    const changes = [];
    if (matched) {
      if ((matched.branch || null) !== branch) changes.push('branch');
      if ((matched.title || '') !== (m.title || '')) changes.push('title');
      if ((matched.crm_access_level || '') !== (m.accessLevel || '')) changes.push('access level');
      if (!matched.clickup_team_dir_id) changes.push('link to CRM');
    }
    return {
      clickupId: m.clickupId, mkcId: m.mkcId || null, status: m.status || null,
      fullName: m.fullName || '', knownAs: m.knownAs || null, title: m.title || null,
      email, publicEmail: m.publicEmail || null, publicPhone: m.publicPhone || null,
      branchRaw: m.branch || null, branch,
      accessLevel: m.accessLevel || null, mappedRole: role,
      bookingLinks: m.bookingLinks || {},
      action: matched ? (changes.length ? 'update' : 'unchanged') : 'create',
      matchedBy, changes,
      importable: !!email && EMAIL_RE.test(email)
    };
  });

  return json(200, {
    count: rows.length,
    members: rows,
    summary: {
      create:    rows.filter((r) => r.action === 'create').length,
      update:    rows.filter((r) => r.action === 'update').length,
      unchanged: rows.filter((r) => r.action === 'unchanged').length,
      blocked:   rows.filter((r) => !r.importable).length
    }
  });
}

/* ---------- POST: apply selected members ---------- */

async function apply(body, session) {
  const wanted = Array.isArray(body.clickupIds) ? body.clickupIds.map((s) => String(s)) : [];
  if (wanted.length === 0) return json(400, { error: 'Pick at least one team member to sync.' });
  const includeInactive = body.includeInactive === true;
  const members = (await fetchRoster(includeInactive)).filter((m) => wanted.includes(String(m.clickupId)));
  if (members.length === 0) return json(404, { error: 'None of those members are in the CRM roster.' });

  let created = 0, updated = 0, skipped = 0;
  const detail = [];

  for (const m of members) {
    const email = (m.email || m.publicEmail || '').toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      skipped++; detail.push({ clickupId: m.clickupId, name: m.fullName, result: 'skipped', why: 'no valid email on the CRM record' });
      continue;
    }
    const branch = mapBranch(m.branch);
    const role = mapRole(m.accessLevel);
    const displayName = m.knownAs || m.fullName || email.split('@')[0];

    try {
      // 1. core.people — match on email, create if new.
      const found = await select('core', 'people', `select=id&email=ilike.${encodeURIComponent(email)}`);
      let personId = found && found[0] && found[0].id;
      let isNew = false;
      if (!personId) {
        const madePerson = await insert('core', 'people', {
          email, full_name: m.fullName || displayName, phone: m.publicPhone || null
        });
        personId = madePerson && madePerson[0] && madePerson[0].id;
        isNew = true;
      } else {
        await patch('core', 'people', `id=eq.${personId}`, {
          full_name: m.fullName || undefined, phone: m.publicPhone || undefined
        });
      }
      if (!personId) { skipped++; detail.push({ clickupId: m.clickupId, name: m.fullName, result: 'skipped', why: 'could not create person' }); continue; }

      // 2. booking.reps — upsert with everything the CRM is authoritative for.
      const existingRep = await select('booking', 'reps', `select=person_id,timezone&person_id=eq.${personId}`);
      const repExisted = existingRep && existingRep[0];
      await insert('booking', 'reps', {
        person_id: personId,
        display_name: displayName,
        title: m.title || null,
        branch,
        clickup_team_dir_id: m.clickupId,
        mkc_id: m.mkcId || null,
        known_as: m.knownAs || null,
        public_email: m.publicEmail || null,
        public_phone: m.publicPhone || null,
        crm_access_level: m.accessLevel || null,
        crm_synced_at: new Date().toISOString(),
        // Don't clobber a timezone someone set here — the CRM doesn't carry one.
        timezone: (repExisted && repExisted.timezone) || 'America/New_York',
        active: (m.status || 'active') === 'active'
      }, { onConflict: 'person_id' });

      // 3. Access role from the CRM's access level.
      await insert('core', 'tool_access', { person_id: personId, tool: 'booking', role }, { onConflict: 'person_id,tool' });

      // 4. Preferences row so the rep can sign in and edit immediately.
      try { await insert('booking', 'rep_preferences', { rep_id: personId }, { onConflict: 'rep_id' }); } catch {}

      // 5. Mirror the CRM's booking links for reference + drift detection.
      const bl = m.bookingLinks || {};
      try {
        await insert('booking', 'rep_crm_links', {
          rep_id: personId,
          crm_intro: bl.intro || null,
          crm_discovery: bl.discovery || null,
          crm_walkthrough: bl.walkthrough || null,
          updated_at: new Date().toISOString()
        }, { onConflict: 'rep_id' });
      } catch (e) { console.error('rep_crm_links upsert failed', e.message); }

      // 6. Discoverability: default them onto their branch's page.
      if (branch) {
        const pages = await select('booking', 'pages', `select=id&slug=eq.${encodeURIComponent(branch)}`);
        const page = pages && pages[0];
        if (page) {
          try { await insert('booking', 'rep_pages', { rep_id: personId, page_id: page.id, active: true }, { onConflict: 'rep_id,page_id' }); } catch {}
        }
      }

      if (repExisted && !isNew) { updated++; detail.push({ clickupId: m.clickupId, name: m.fullName, result: 'updated', role, branch }); }
      else { created++; detail.push({ clickupId: m.clickupId, name: m.fullName, result: 'created', role, branch }); }
    } catch (e) {
      console.error('sync failed for', m.clickupId, e.message);
      skipped++; detail.push({ clickupId: m.clickupId, name: m.fullName, result: 'error', why: e.message.slice(0, 200) });
    }
  }

  try {
    await insert('core', 'sync_log', {
      tool: 'booking', source: 'crm-team-directory', ran_by: session.email,
      created, updated, skipped, detail
    });
  } catch (e) { console.error('sync_log insert failed', e.message); }

  return json(200, { ok: true, created, updated, skipped, detail });
}

async function handler(request) {
  let session;
  try { session = await requireSession(request); } catch (e) { return e; }
  if (session.role !== 'super_admin' && session.role !== 'admin') {
    return json(403, { error: 'Super-admin access required to sync the roster.' });
  }
  const url = new URL(request.url);
  try {
    if (request.method === 'GET') return await preview(url);
    if (request.method === 'POST') {
      const { body, error } = await readJson(request); if (error) return error;
      return await apply(body, session);
    }
  } catch (e) {
    console.error('team-sync failed', e.message);
    return json(502, { error: e.message });
  }
  return json(405, { error: 'Method not allowed.' });
}

export default { fetch: handler };
