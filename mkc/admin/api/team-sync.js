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

// The CRM reports 'Super Admin' | 'Admin' | 'Staff'. Map onto our tiers.
//   Super Admin -> super_admin  (roster sync, role assignment, page discoverability)
//   Admin       -> admin        (day-to-day booking ops, no role/visibility control)
//   Staff       -> rep          (self-service only)
const ROLE_MAP = { 'super admin': 'super_admin', 'admin': 'admin', 'staff': 'rep' };
function mapRole(accessLevel) {
  return ROLE_MAP[String(accessLevel || '').trim().toLowerCase()] || 'rep';
}

/* Branch mapping lives in booking.branch_map, not in this file. A rename in
 * ClickUp would silently break discoverability if the map were hardcoded;
 * as data, an unseen label is recorded unmapped and surfaced to a super-admin
 * instead of being guessed at. */
async function loadBranchMap() {
  const rows = await select('booking', 'branch_map', 'select=crm_label,page_slug,label');
  const map = new Map();
  for (const r of rows || []) map.set(r.crm_label, r);
  return map;
}

// The CRM's branch field is a labels type and can hold several; we take the first.
function normaliseBranchLabel(branch) {
  const key = String(branch || '').trim().toLowerCase();
  if (!key) return null;
  return key.split(',')[0].trim() || null;
}

/* Record labels we've never seen so they show up in the UI to be mapped.
 * Fire-and-forget: a bookkeeping failure must not fail a sync. */
async function recordBranchLabels(labels, existing) {
  const now = new Date().toISOString();
  for (const label of labels) {
    if (!label) continue;
    try {
      if (existing.has(label)) {
        const cur = existing.get(label);
        await patch('booking', 'branch_map', `crm_label=eq.${encodeURIComponent(label)}`,
          { seen_count: (cur.seen_count || 0) + 1, last_seen: now });
      } else {
        await insert('booking', 'branch_map',
          { crm_label: label, page_slug: null, label: null, seen_count: 1, last_seen: now },
          { onConflict: 'crm_label' });
      }
    } catch (e) { console.error('branch_map bookkeeping failed for', label, e.message); }
  }
}

/* Native booking link: a stable public slug per rep, generated here and
 * intended to be pushed back into the CRM's Discovery Call Link field so the
 * CRM remains the place people look for "where do I book with X". */
function slugify(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'rep';
}
async function ensureBookingSlug(personId, displayName) {
  const cur = await select('booking', 'rep_preferences', `select=booking_link_slug&rep_id=eq.${personId}`);
  if (cur && cur[0] && cur[0].booking_link_slug) return cur[0].booking_link_slug;
  const base = slugify(displayName);
  let candidate = base;
  for (let n = 2; n < 50; n++) {
    const taken = await select('booking', 'rep_preferences',
      `select=rep_id&booking_link_slug=eq.${encodeURIComponent(candidate)}`);
    if (!taken || taken.length === 0) break;
    candidate = base + '-' + n;
  }
  try { await patch('booking', 'rep_preferences', `rep_id=eq.${personId}`, { booking_link_slug: candidate }); }
  catch (e) { console.error('slug assign failed', e.message); }
  return candidate;
}
function nativeLinkFor(slug) {
  const base = (process.env.BOOKING_SITE_URL || 'https://start.befortune5.com').replace(/\/$/, '');
  return `${base}/?rep=${encodeURIComponent(slug)}`;
}

async function fetchRoster(includeInactive) {
  const url = CRM_URL();
  const secret = CRM_SECRET();
  if (!url || !secret) {
    const missing = [!url && 'CRM_TEAM_DIRECTORY_URL', !secret && 'CRM_SHARED_SECRET'].filter(Boolean).join(' and ');
    throw new Error(`CRM sync is not configured — ${missing} not set. Add it in Vercel and redeploy.`);
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`CRM_TEAM_DIRECTORY_URL must start with https:// — currently "${url.slice(0, 80)}".`);
  }
  const full = url + (includeInactive ? (url.includes('?') ? '&' : '?') + 'includeInactive=true' : '');
  let res;
  try {
    res = await fetch(full, { headers: { 'X-Form-Secret': secret, Accept: 'application/json' } });
  } catch (e) {
    throw new Error(`Couldn't reach the CRM at ${full} — ${e.message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    // Flatten whatever shape the error is. Vercel's own 404 page returns
    // {error:{code,message}} — an object — which is why a naive concat
    // produced "[object Object]" and told us nothing.
    let detail = '';
    try {
      const j = JSON.parse(text);
      const e = j && j.error;
      if (typeof e === 'string') detail = e + (j.detail ? ` — ${j.detail}` : '');
      else if (e && typeof e === 'object') detail = [e.code, e.message].filter(Boolean).join(': ');
      else detail = JSON.stringify(j).slice(0, 300);
    } catch {
      // Not JSON at all — almost always an HTML error page.
      detail = /<html/i.test(text) ? 'the server returned an HTML page, not JSON' : text.slice(0, 200);
    }
    const hint =
      res.status === 404 ? ` — no endpoint at ${full}. Check the URL and that /api/team-directory is deployed on the CRM.`
      : res.status === 401 ? ' — the shared secret did not match. CRM_SHARED_SECRET here must equal FORM_SECRET there.'
      : res.status === 502 ? ' — the CRM reached ClickUp but ClickUp rejected the request (check CLICKUP_TOKEN there).'
      : res.status === 500 ? ' — the CRM is missing its own env vars (FORM_SECRET or CLICKUP_TOKEN).'
      : '';
    throw new Error(`CRM returned ${res.status}${detail ? `: ${detail}` : ''}${hint}`);
  }
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`CRM returned a response we couldn't parse (first 120 chars: ${text.slice(0, 120)})`); }
  if (!Array.isArray(data.members)) {
    throw new Error(`CRM response had no "members" array. Keys present: ${Object.keys(data || {}).join(', ') || 'none'}.`);
  }
  return data.members;
}

/* ---------- GET: preview roster with a diff ---------- */

async function preview(url) {
  const includeInactive = url.searchParams.get('includeInactive') === 'true';
  const [members, branchMap] = await Promise.all([fetchRoster(includeInactive), loadBranchMap()]);

  const [existingReps, existingPeople] = await Promise.all([
    select('booking', 'reps', 'select=person_id,display_name,clickup_team_dir_id,branch,title,crm_access_level'),
    select('core', 'people', 'select=id,email,full_name')
  ]);
  const byClickup = new Map((existingReps || []).filter((r) => r.clickup_team_dir_id).map((r) => [r.clickup_team_dir_id, r]));
  const peopleByEmail = new Map((existingPeople || []).map((p) => [(p.email || '').toLowerCase(), p]));
  const repByPerson = new Map((existingReps || []).map((r) => [r.person_id, r]));

  const seenLabels = new Set();
  const rows = members.map((m) => {
    const email = (m.email || m.publicEmail || '').toLowerCase();
    let matched = byClickup.get(m.clickupId) || null;
    let matchedBy = matched ? 'clickupId' : null;
    if (!matched && email) {
      const person = peopleByEmail.get(email);
      if (person) { matched = repByPerson.get(person.id) || null; if (matched) matchedBy = 'email'; }
    }
    const rawLabel = normaliseBranchLabel(m.branch);
    if (rawLabel) seenLabels.add(rawLabel);
    const mapping = rawLabel ? branchMap.get(rawLabel) : null;
    const branch = mapping ? mapping.page_slug : null;
    const branchUnmapped = !!rawLabel && (!mapping || !mapping.page_slug);
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
      branchRaw: m.branch || null, branchLabel: rawLabel, branch, branchUnmapped,
      accessLevel: m.accessLevel || null, mappedRole: role,
      bookingLinks: m.bookingLinks || {},
      action: matched ? (changes.length ? 'update' : 'unchanged') : 'create',
      matchedBy, changes,
      importable: !!email && EMAIL_RE.test(email)
    };
  });

  // Bookkeeping so unseen labels appear in the branch-map UI. Non-blocking.
  recordBranchLabels(seenLabels, branchMap).catch(() => {});

  const unmapped = [...new Set(rows.filter((r) => r.branchUnmapped).map((r) => r.branchLabel))];

  return json(200, {
    count: rows.length,
    members: rows,
    unmappedBranches: unmapped,
    summary: {
      create:    rows.filter((r) => r.action === 'create').length,
      update:    rows.filter((r) => r.action === 'update').length,
      unchanged: rows.filter((r) => r.action === 'unchanged').length,
      blocked:   rows.filter((r) => !r.importable).length,
      unmapped:  unmapped.length
    }
  });
}

/* ---------- POST: apply selected members ---------- */

async function apply(body, session) {
  const wanted = Array.isArray(body.clickupIds) ? body.clickupIds.map((s) => String(s)) : [];
  if (wanted.length === 0) return json(400, { error: 'Pick at least one team member to sync.' });
  const includeInactive = body.includeInactive === true;
  const [roster, branchMap] = await Promise.all([fetchRoster(includeInactive), loadBranchMap()]);
  const members = roster.filter((m) => wanted.includes(String(m.clickupId)));
  if (members.length === 0) return json(404, { error: 'None of those members are in the CRM roster.' });

  let created = 0, updated = 0, skipped = 0;
  const detail = [];

  for (const m of members) {
    const email = (m.email || m.publicEmail || '').toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      skipped++; detail.push({ clickupId: m.clickupId, name: m.fullName, result: 'skipped', why: 'no valid email on the CRM record' });
      continue;
    }
    const rawLabel = normaliseBranchLabel(m.branch);
    const mapping = rawLabel ? branchMap.get(rawLabel) : null;
    const branch = mapping ? mapping.page_slug : null;
    const role = mapRole(m.accessLevel);
    const displayName = m.knownAs || m.fullName || email.split('@')[0];

    try {
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
        timezone: (repExisted && repExisted.timezone) || 'America/New_York',
        active: (m.status || 'active') === 'active'
      }, { onConflict: 'person_id' });

      await insert('core', 'tool_access', { person_id: personId, tool: 'booking', role }, { onConflict: 'person_id,tool' });
      try { await insert('booking', 'rep_preferences', { rep_id: personId }, { onConflict: 'rep_id' }); } catch {}

      // Native booking link: assign a stable slug and record the link we want the CRM to hold.
      const slug = await ensureBookingSlug(personId, displayName);
      const native = nativeLinkFor(slug);
      const bl = m.bookingLinks || {};
      try {
        await insert('booking', 'rep_crm_links', {
          rep_id: personId,
          crm_intro: bl.intro || null,
          crm_discovery: bl.discovery || null,
          crm_walkthrough: bl.walkthrough || null,
          native_link: native,
          updated_at: new Date().toISOString()
        }, { onConflict: 'rep_id' });
      } catch (e) { console.error('rep_crm_links upsert failed', e.message); }

      if (branch) {
        const pages = await select('booking', 'pages', `select=id&slug=eq.${encodeURIComponent(branch)}`);
        const page = pages && pages[0];
        if (page) {
          try { await insert('booking', 'rep_pages', { rep_id: personId, page_id: page.id, active: true }, { onConflict: 'rep_id,page_id' }); } catch {}
        }
      }

      const note = { clickupId: m.clickupId, name: m.fullName, role, branch, slug, nativeLink: native };
      if (rawLabel && !branch) note.warning = `branch "${rawLabel}" is not mapped to a page yet`;
      if (repExisted && !isNew) { updated++; detail.push({ ...note, result: 'updated' }); }
      else { created++; detail.push({ ...note, result: 'created' }); }
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

/* ---------- branch map management ---------- */

async function getBranchMap() {
  const [rows, pages] = await Promise.all([
    select('booking', 'branch_map', 'select=crm_label,page_slug,label,seen_count,last_seen&order=seen_count.desc,crm_label.asc'),
    select('booking', 'pages', 'select=id,slug,title&order=slug.asc')
  ]);
  return json(200, { branches: rows || [], pages: pages || [] });
}

async function setBranchMap(body) {
  const label = clean(body.crmLabel, 120).toLowerCase();
  if (!label) return json(400, { error: 'Missing branch label.' });
  const pageSlug = body.pageSlug ? clean(body.pageSlug, 64) : null;
  try {
    await insert('booking', 'branch_map',
      { crm_label: label, page_slug: pageSlug, label: clean(body.label, 120) || null },
      { onConflict: 'crm_label' });
  } catch (e) { console.error('branch map write failed', e.message); return json(500, { error: "Couldn't save the mapping." }); }
  return json(200, { ok: true });
}

/* ---------- diagnostics ---------- */

async function diagnose() {
  const url = CRM_URL();
  const secret = CRM_SECRET();
  const out = {
    urlConfigured: !!url,
    url: url || null,
    secretConfigured: !!secret,
    secretLength: secret ? secret.length : 0,
    bookingSiteUrl: process.env.BOOKING_SITE_URL || null
  };
  if (!url || !secret) { out.verdict = 'Not configured — set the missing env var and redeploy.'; return json(200, out); }

  // Probe with the real secret, then deliberately without, so we can tell
  // "endpoint missing" apart from "secret wrong".
  try {
    const withSecret = await fetch(url, { headers: { 'X-Form-Secret': secret, Accept: 'application/json' } });
    out.statusWithSecret = withSecret.status;
    const body = await withSecret.text();
    out.bodyPreview = body.slice(0, 200);
    out.looksLikeJson = (() => { try { JSON.parse(body); return true; } catch { return false; } })();

    const withoutSecret = await fetch(url, { headers: { Accept: 'application/json' } });
    out.statusWithoutSecret = withoutSecret.status;

    if (withSecret.status === 200) out.verdict = 'Working.';
    else if (withSecret.status === 404 && withoutSecret.status === 404) {
      out.verdict = 'The URL 404s with and without a secret, so the endpoint is not deployed at this path. ' +
                    'Confirm api/team-directory.ts is live on the CRM project and that the URL has no typo.';
    } else if (withSecret.status === 401) {
      out.verdict = 'The endpoint exists but rejected our secret. CRM_SHARED_SECRET here must exactly equal FORM_SECRET there ' +
                    '(watch for trailing spaces or newlines when pasting).';
    } else if (withoutSecret.status === 401 && withSecret.status !== 200) {
      out.verdict = `The endpoint exists and enforces auth, but returned ${withSecret.status} with our secret.`;
    } else {
      out.verdict = `Unexpected: ${withSecret.status} with secret, ${withoutSecret.status} without.`;
    }
  } catch (e) {
    out.verdict = `Could not reach the URL at all: ${e.message}`;
  }
  return json(200, out);
}

async function handler(request) {
  let session;
  try { session = await requireSession(request); } catch (e) { return e; }
  const url = new URL(request.url);
  const kind = (url.searchParams.get('kind') || '').toLowerCase();

  // Roster sync and branch mapping change who appears on public pages and who
  // holds which role — super_admin only, not plain admin.
  if (session.role !== 'super_admin') {
    return json(403, { error: 'Super-admin access required.' });
  }

  try {
    if (kind === 'diagnose') return await diagnose();
    if (kind === 'branches') {
      if (request.method === 'GET') return await getBranchMap();
      if (request.method === 'PATCH') {
        const { body, error } = await readJson(request); if (error) return error;
        return await setBranchMap(body);
      }
      return json(405, { error: 'Method not allowed.' });
    }
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
