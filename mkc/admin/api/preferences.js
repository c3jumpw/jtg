import { select, patch, json, clean, UUID_RE, readJson } from '../lib/core.js';
import { requireSession } from '../lib/auth.js';

async function get(repId) {
  const [pref, rep, pages, mts] = await Promise.all([
    select('booking', 'rep_preferences', `select=*&rep_id=eq.${repId}`),
    select('booking', 'reps', `select=display_name,title,bio,timezone,active,branch&person_id=eq.${repId}`),
    select('booking', 'rep_pages', `select=page_id,active&rep_id=eq.${repId}`),
    select('booking', 'rep_meeting_types', `select=meeting_type_id&rep_id=eq.${repId}`)
  ]);
  return json(200, {
    preferences: (pref && pref[0]) || {},
    rep: (rep && rep[0]) || {},
    pages: pages || [],
    meetingTypeIds: (mts || []).map((m) => m.meeting_type_id)
  });
}

async function update(repId, body) {
  const p = {};
  if (typeof body.crmAutoSync === 'boolean')    p.crm_auto_sync    = body.crmAutoSync;
  if (typeof body.crmDefaultType === 'string')  p.crm_default_type = clean(body.crmDefaultType, 40) || 'Lead';
  if (typeof body.notifyEmail === 'boolean')    p.notify_email     = body.notifyEmail;
  if (typeof body.notifySms === 'boolean')      p.notify_sms       = body.notifySms;
  if (body.bufferBeforeMin !== undefined)       p.buffer_before_min = body.bufferBeforeMin != null ? (body.bufferBeforeMin | 0) : null;
  if (body.bufferAfterMin !== undefined)        p.buffer_after_min  = body.bufferAfterMin  != null ? (body.bufferAfterMin  | 0) : null;
  if (typeof body.bookingLinkSlug === 'string') p.booking_link_slug = clean(body.bookingLinkSlug, 80).replace(/[^a-z0-9-]/gi, '-').toLowerCase() || null;
  if (typeof body.bookingActive === 'boolean')  p.booking_active   = body.bookingActive;
  p.updated_at = new Date().toISOString();
  try { await patch('booking', 'rep_preferences', `rep_id=eq.${repId}`, p); }
  catch (e) { console.error('prefs update failed', e.message); return json(500, { error: "Couldn't save." }); }
  // Allow rep to update their own display name / bio / timezone too.
  const repP = {};
  if (typeof body.displayName === 'string') repP.display_name = clean(body.displayName, 200);
  if (typeof body.bio === 'string')         repP.bio          = clean(body.bio, 2000) || null;
  if (typeof body.timezone === 'string')    repP.timezone     = clean(body.timezone, 80) || 'America/New_York';
  if (Object.keys(repP).length) {
    try { await patch('booking', 'reps', `person_id=eq.${repId}`, repP); } catch {}
  }
  return json(200, { ok: true });
}

async function handler(request) {
  let session;
  try { session = await requireSession(request); } catch (e) { return e; }
  // A rep can only access their own prefs; admins can access any.
  const url = new URL(request.url);
  let repId = url.searchParams.get('rep') || session.personId;
  if (!repId || !UUID_RE.test(repId)) return json(400, { error: 'Bad rep id.' });
  // Reps can only read/write their own record.
  const isSuperAdmin = session.role === 'super_admin' || session.role === 'admin';
  if (!isSuperAdmin && repId !== session.personId) return json(403, { error: 'You can only edit your own preferences.' });

  if (request.method === 'GET') return get(repId);
  if (request.method === 'PATCH') {
    const { body, error } = await readJson(request); if (error) return error;
    return update(repId, body);
  }
  return json(405, { error: 'Method not allowed.' });
}

export default { fetch: handler };
