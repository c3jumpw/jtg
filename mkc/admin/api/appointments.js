import { select, patch, json, UUID_RE, readJson, clean } from '../lib/core.js';
import { requireSession } from '../lib/auth.js';

async function list(url) {
  const filter = (url.searchParams.get('filter') || 'upcoming').toLowerCase(); // upcoming | past | all | cancelled
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '100', 10)));
  const now = new Date().toISOString();
  const parts = [
    'select=id,starts_at,ends_at,status,mode,location_text,meet_url,guest_name,guest_email,guest_phone,guest_company,guest_notes,guest_timezone,rep_id,meeting_type_id,page_id,crm_entry_id,crm_entry_type,crm_synced_at,crm_sync_error,created_at,cancelled_at,cancel_reason',
    `limit=${limit}`
  ];
  if (filter === 'upcoming') { parts.push('status=eq.confirmed', `starts_at=gte.${encodeURIComponent(now)}`, 'order=starts_at.asc'); }
  else if (filter === 'past') { parts.push('status=eq.confirmed', `starts_at=lt.${encodeURIComponent(now)}`, 'order=starts_at.desc'); }
  else if (filter === 'cancelled') { parts.push('status=eq.cancelled', 'order=starts_at.desc'); }
  else { parts.push('order=starts_at.desc'); }

  const rows = await select('booking', 'appointments', parts.join('&'));

  // Batch-fetch related rep names + meeting type names for display.
  const repIds = [...new Set((rows || []).map((r) => r.rep_id))].filter(Boolean);
  const mtIds  = [...new Set((rows || []).map((r) => r.meeting_type_id))].filter(Boolean);
  const [reps, mts] = await Promise.all([
    repIds.length ? select('booking', 'reps', `select=person_id,display_name&person_id=in.(${repIds.join(',')})`) : Promise.resolve([]),
    mtIds.length  ? select('booking', 'meeting_types', `select=id,name&id=in.(${mtIds.join(',')})`) : Promise.resolve([])
  ]);
  const repMap = new Map((reps || []).map((r) => [r.person_id, r.display_name]));
  const mtMap  = new Map((mts  || []).map((m) => [m.id, m.name]));
  const enriched = (rows || []).map((r) => ({
    ...r,
    repName: repMap.get(r.rep_id) || 'Unknown',
    meetingTypeName: mtMap.get(r.meeting_type_id) || null
  }));
  return json(200, { appointments: enriched });
}

async function cancel(body) {
  const id = clean(body.id, 64);
  if (!UUID_RE.test(id)) return json(400, { error: 'Bad id.' });
  const reason = clean(body.reason, 500) || null;
  try {
    await patch('booking', 'appointments', `id=eq.${id}`,
      { status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: reason });
  } catch (e) { console.error('cancel failed', e.message); return json(500, { error: 'Couldn’t cancel.' }); }
  return json(200, { ok: true });
}

async function handler(request) {
  try { await requireSession(request); } catch (e) { return e; }
  const url = new URL(request.url);
  if (request.method === 'GET') return list(url);
  if (request.method === 'POST' && url.searchParams.get('action') === 'cancel') {
    const { body, error } = await readJson(request); if (error) return error;
    return cancel(body);
  }
  return json(405, { error: 'Method not allowed.' });
}

export default { fetch: handler };
