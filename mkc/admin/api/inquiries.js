import { select, patch, json, clean, UUID_RE, readJson } from '../lib/core.js';
import { requireSession } from '../lib/auth.js';

/* Appointment requests captured by the booking pages when the calendar
 * couldn't serve someone. These are leads that would otherwise exist only in
 * an inbox, so they get a first-class view with a status a rep can move. */

const STATUSES = ['new', 'contacted', 'booked', 'closed'];

async function list(url, session) {
  const status = clean(url.searchParams.get('status'), 20).toLowerCase();
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '100', 10)));
  const parts = [
    'select=id,page_slug,rep_id,guest_name,guest_email,guest_phone,guest_company,guest_timezone,' +
      'guest_notes,earliest_date,latest_date,time_prefs,reason,status,handled_at,handled_note,created_at',
    `limit=${limit}`, 'order=created_at.desc'
  ];
  if (STATUSES.includes(status)) parts.push(`status=eq.${status}`);
  else if (status === 'open') parts.push('status=in.(new,contacted)');

  // A rep sees requests aimed at them personally plus anything unassigned on
  // their pages; an admin sees everything.
  const isAdmin = session.role === 'super_admin' || session.role === 'admin';
  if (!isAdmin) parts.push(`rep_id=eq.${session.personId}`);

  const rows = await select('booking', 'inquiries', parts.join('&'));

  const repIds = [...new Set((rows || []).map((r) => r.rep_id))].filter(Boolean);
  const reps = repIds.length
    ? await select('booking', 'reps', `select=person_id,display_name&person_id=in.(${repIds.join(',')})`)
    : [];
  const repMap = new Map((reps || []).map((r) => [r.person_id, r.display_name]));

  return json(200, {
    inquiries: (rows || []).map((r) => ({ ...r, repName: r.rep_id ? (repMap.get(r.rep_id) || null) : null })),
    counts: {
      new: (rows || []).filter((r) => r.status === 'new').length
    }
  });
}

async function update(body, session) {
  const id = clean(body.id, 64);
  if (!UUID_RE.test(id)) return json(400, { error: 'Bad id.' });
  const status = clean(body.status, 20).toLowerCase();
  if (!STATUSES.includes(status)) return json(400, { error: 'Bad status.' });
  const note = clean(body.note, 500) || null;
  try {
    await patch('booking', 'inquiries', `id=eq.${id}`, {
      status,
      handled_by: session.personId || null,
      handled_at: new Date().toISOString(),
      handled_note: note
    });
  } catch (e) {
    console.error('inquiry update failed', e.message);
    return json(500, { error: 'Couldn’t save that.' });
  }
  return json(200, { ok: true });
}

async function handler(request) {
  let session;
  try { session = await requireSession(request); } catch (e) { return e; }
  const url = new URL(request.url);
  if (request.method === 'GET') return list(url, session);
  if (request.method === 'PATCH') {
    const { body, error } = await readJson(request); if (error) return error;
    return update(body, session);
  }
  return json(405, { error: 'Method not allowed.' });
}

export default { fetch: handler };
