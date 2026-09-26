import { select, insert, patch, json, clean, EMAIL_RE, UUID_RE, readJson } from '../lib/core.js';
import { requireSession } from '../lib/auth.js';

async function list(session) {
  const isSuperAdmin = session.role === 'super_admin' || session.role === 'admin';
  const repFilter = isSuperAdmin ? '' : `&person_id=eq.${session.personId}`;
  const reps = await select('booking', 'reps',
    `select=person_id,display_name,title,bio,photo_url,timezone,weight,active,clickup_team_dir_id,branch,updated_at&order=display_name.asc${repFilter}`);
  if (!reps || reps.length === 0) return json(200, { reps: [] });
  const ids = reps.map((r) => r.person_id);
  const [people, links, pages, prefs] = await Promise.all([
    select('core',    'people',            `select=id,email,full_name,phone&id=in.(${ids.join(',')})`),
    select('booking', 'rep_meeting_types', `select=rep_id,meeting_type_id&rep_id=in.(${ids.join(',')})`),
    select('booking', 'rep_pages',         `select=rep_id,page_id,active&rep_id=in.(${ids.join(',')})`),
    select('booking', 'rep_preferences',   `select=rep_id,crm_auto_sync,crm_default_type,notify_email,notify_sms,buffer_before_min,buffer_after_min,booking_link_slug,booking_active,notes&rep_id=in.(${ids.join(',')})`)
  ]);
  const personBy = new Map((people || []).map((p) => [p.id, p]));
  const mtsBy = new Map(); const pagesBy = new Map(); const prefsBy = new Map((prefs || []).map((p) => [p.rep_id, p]));
  for (const l of links || []) { if (!mtsBy.has(l.rep_id)) mtsBy.set(l.rep_id, []); mtsBy.get(l.rep_id).push(l.meeting_type_id); }
  for (const rp of pages || []) { if (!pagesBy.has(rp.rep_id)) pagesBy.set(rp.rep_id, []); pagesBy.get(rp.rep_id).push({ pageId: rp.page_id, active: rp.active }); }
  return json(200, { reps: reps.map((r) => {
    const p = personBy.get(r.person_id) || {}; const pref = prefsBy.get(r.person_id) || {};
    return {
      id: r.person_id, displayName: r.display_name, title: r.title, bio: r.bio, photoUrl: r.photo_url,
      email: p.email||null, fullName: p.full_name||null, phone: p.phone||null,
      timezone: r.timezone, weight: r.weight, active: r.active, branch: r.branch||null,
      clickupTeamDirId: r.clickup_team_dir_id,
      meetingTypeIds: mtsBy.get(r.person_id) || [],
      pages: pagesBy.get(r.person_id) || [],
      preferences: {
        crmAutoSync: pref.crm_auto_sync ?? true, crmDefaultType: pref.crm_default_type || 'Lead',
        notifyEmail: pref.notify_email ?? true, notifySms: pref.notify_sms ?? false,
        bufferBeforeMin: pref.buffer_before_min ?? null, bufferAfterMin: pref.buffer_after_min ?? null,
        bookingLinkSlug: pref.booking_link_slug || null, bookingActive: pref.booking_active ?? true,
        notes: pref.notes || null
      }
    };
  }) });
}

async function create(body) {
  const email = clean(body.email, 200).toLowerCase();
  const fullName = clean(body.fullName, 200);
  const displayName = clean(body.displayName, 200) || fullName;
  const phone = clean(body.phone, 40);
  const title = clean(body.title, 200);
  const timezone = clean(body.timezone, 80) || 'America/New_York';
  const clickupTeamDirId = clean(body.clickupTeamDirId, 64) || null;
  const branch = clean(body.branch, 40) || null;
  const meetingTypeIds = Array.isArray(body.meetingTypeIds) ? body.meetingTypeIds.filter((x) => UUID_RE.test(x)) : [];
  if (!EMAIL_RE.test(email)) return json(400, { error: 'Please check the email address.' });
  if (!displayName) return json(400, { error: 'Please add a display name.' });
  const existing = await select('core', 'people', `select=id&email=ilike.${encodeURIComponent(email)}`);
  let personId = existing && existing[0] && existing[0].id;
  if (!personId) {
    const created = await insert('core', 'people', { email, full_name: fullName || displayName, phone: phone || null });
    personId = created && created[0] && created[0].id;
    if (!personId) return json(500, { error: "Couldn't create the rep." });
  } else if (fullName || phone) {
    try { await patch('core', 'people', `id=eq.${personId}`, { full_name: fullName||undefined, phone: phone||undefined }); } catch {}
  }
  try { await insert('booking', 'reps', { person_id: personId, display_name: displayName, title: title||null, timezone, clickup_team_dir_id: clickupTeamDirId, branch, active: true }, { onConflict: 'person_id' }); }
  catch (e) { console.error('rep insert failed', e.message, e.body); return json(500, { error: "Couldn't create the rep." }); }
  try { await insert('booking', 'rep_preferences', { rep_id: personId }, { onConflict: 'rep_id' }); } catch {}
  try { await insert('core', 'tool_access', { person_id: personId, tool: 'booking', role: 'rep' }, { onConflict: 'person_id,tool' }); } catch {}
  if (meetingTypeIds.length) {
    try { await insert('booking', 'rep_meeting_types', meetingTypeIds.map((meeting_type_id) => ({ rep_id: personId, meeting_type_id })), { onConflict: 'rep_id,meeting_type_id' }); }
    catch (e) { console.error('rmt insert failed', e.message); }
  }
  return json(200, { ok: true, id: personId });
}

async function update(repId, body) {
  if (!UUID_RE.test(repId)) return json(400, { error: 'Bad rep id.' });
  const patchRep = {}; const patchPerson = {};
  if (typeof body.displayName === 'string') patchRep.display_name = clean(body.displayName, 200);
  if (typeof body.title === 'string')       patchRep.title        = clean(body.title, 200) || null;
  if (typeof body.bio === 'string')         patchRep.bio          = clean(body.bio, 2000) || null;
  if (typeof body.photoUrl === 'string')    patchRep.photo_url    = clean(body.photoUrl, 500) || null;
  if (typeof body.timezone === 'string')    patchRep.timezone     = clean(body.timezone, 80) || 'America/New_York';
  if (typeof body.weight === 'number' && body.weight >= 0 && body.weight <= 10) patchRep.weight = body.weight | 0;
  if (typeof body.active === 'boolean')     patchRep.active       = body.active;
  if (typeof body.branch === 'string')      patchRep.branch       = clean(body.branch, 40) || null;
  if (typeof body.clickupTeamDirId === 'string') patchRep.clickup_team_dir_id = clean(body.clickupTeamDirId, 64) || null;
  if (typeof body.email === 'string' && EMAIL_RE.test(body.email)) patchPerson.email = body.email.toLowerCase();
  if (typeof body.fullName === 'string')    patchPerson.full_name = clean(body.fullName, 200);
  if (typeof body.phone === 'string')       patchPerson.phone     = clean(body.phone, 40) || null;
  try {
    if (Object.keys(patchRep).length)    await patch('booking', 'reps',   `person_id=eq.${repId}`, patchRep);
    if (Object.keys(patchPerson).length) await patch('core',    'people', `id=eq.${repId}`,        patchPerson);
  } catch (e) { console.error('rep update failed', e.message); return json(500, { error: "Couldn't save that." }); }

  // Sync page discoverability if super_admin passes it.
  if (Array.isArray(body.pages)) {
    for (const pg of body.pages) {
      if (!UUID_RE.test(pg.pageId)) continue;
      try {
        await insert('booking', 'rep_pages', { rep_id: repId, page_id: pg.pageId, active: pg.active !== false }, { onConflict: 'rep_id,page_id' });
      } catch (e) { console.error('rep_pages upsert failed', e.message); }
    }
  }

  // Sync meeting types.
  if (Array.isArray(body.meetingTypeIds)) {
    const wanted = new Set(body.meetingTypeIds.filter((x) => UUID_RE.test(x)));
    const current = await select('booking', 'rep_meeting_types', `select=meeting_type_id&rep_id=eq.${repId}`);
    const currentIds = new Set((current || []).map((r) => r.meeting_type_id));
    const toAdd = [...wanted].filter((x) => !currentIds.has(x));
    const toRemove = [...currentIds].filter((x) => !wanted.has(x));
    try {
      if (toAdd.length) await insert('booking', 'rep_meeting_types', toAdd.map((meeting_type_id) => ({ rep_id: repId, meeting_type_id })), { onConflict: 'rep_id,meeting_type_id' });
      for (const mt of toRemove) {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/rep_meeting_types?rep_id=eq.${repId}&meeting_type_id=eq.${mt}`,
          { method: 'DELETE', headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Profile': 'booking' } });
      }
    } catch (e) { console.error('rmt sync failed', e.message); }
  }
  return json(200, { ok: true });
}

async function handler(request) {
  let session;
  try { session = await requireSession(request); } catch (e) { return e; }
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';
  const isSuperAdmin = session.role === 'super_admin' || session.role === 'admin';
  if (request.method === 'GET') return list(session);
  if (!isSuperAdmin) return json(403, { error: 'Super-admin required.' });
  if (request.method === 'POST') {
    const { body, error } = await readJson(request); if (error) return error;
    return create(body);
  }
  if (request.method === 'PATCH') {
    const { body, error } = await readJson(request); if (error) return error;
    return update(id, body);
  }
  return json(405, { error: 'Method not allowed.' });
}

export default { fetch: handler };
