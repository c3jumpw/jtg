import { select, insert, patch, json, clean, UUID_RE, readJson } from '../lib/core.js';
import { requireSession } from '../lib/auth.js';

async function listAll() {
  const [pages, meetingTypes, locations] = await Promise.all([
    select('booking', 'pages', 'select=id,slug,host,title,intro,confirm_note,active&order=slug.asc'),
    select('booking', 'meeting_types',
      'select=id,page_id,mode,name,description,duration_min,buffer_before_min,buffer_after_min,min_notice_hours,max_days_ahead,slot_step_min,location_id,active,sort_order&order=sort_order.asc'),
    select('booking', 'locations', 'select=id,name,address,notes,active&order=name.asc')
  ]);
  return json(200, { pages: pages || [], meetingTypes: meetingTypes || [], locations: locations || [] });
}

async function updateMt(id, body) {
  if (!UUID_RE.test(id)) return json(400, { error: 'Bad id.' });
  const p = {};
  if (typeof body.name === 'string')             p.name              = clean(body.name, 200);
  if (typeof body.description === 'string')      p.description       = clean(body.description, 2000) || null;
  if (typeof body.duration_min === 'number')     p.duration_min      = Math.max(10, Math.min(240, body.duration_min | 0));
  if (typeof body.buffer_before_min === 'number')p.buffer_before_min = Math.max(0, Math.min(120, body.buffer_before_min | 0));
  if (typeof body.buffer_after_min === 'number') p.buffer_after_min  = Math.max(0, Math.min(120, body.buffer_after_min | 0));
  if (typeof body.min_notice_hours === 'number') p.min_notice_hours  = Math.max(0, body.min_notice_hours | 0);
  if (typeof body.max_days_ahead === 'number')   p.max_days_ahead    = Math.max(1, Math.min(365, body.max_days_ahead | 0));
  if (typeof body.slot_step_min === 'number')    p.slot_step_min     = Math.max(5, Math.min(120, body.slot_step_min | 0));
  if (typeof body.active === 'boolean')          p.active            = body.active;
  if (typeof body.location_id === 'string')      p.location_id       = body.location_id ? clean(body.location_id, 64) : null;
  try { await patch('booking', 'meeting_types', `id=eq.${id}`, p); }
  catch (e) { console.error('mt update failed', e.message, e.body); return json(500, { error: 'Couldn’t save that.' }); }
  return json(200, { ok: true });
}

async function createLocation(body) {
  const name = clean(body.name, 200); const address = clean(body.address, 500);
  if (!name || !address) return json(400, { error: 'Name and address are required.' });
  const teamRows = await select('core', 'teams', 'select=id&slug=eq.fortune5&limit=1'); // default to fortune5 team for now
  const team_id = teamRows && teamRows[0] && teamRows[0].id;
  try {
    const rows = await insert('booking', 'locations',
      { team_id, name, address, notes: clean(body.notes, 500) || null, active: true });
    return json(200, { ok: true, id: rows && rows[0] && rows[0].id });
  } catch (e) { console.error('location insert failed', e.message); return json(500, { error: 'Couldn’t save.' }); }
}

async function handler(request) {
  try { await requireSession(request); } catch (e) { return e; }
  const url = new URL(request.url);
  const kind = (url.searchParams.get('kind') || '').toLowerCase();
  const id = url.searchParams.get('id') || '';

  if (request.method === 'GET') return listAll();
  if (request.method === 'PATCH' && kind === 'meeting-type') {
    const { body, error } = await readJson(request); if (error) return error;
    return updateMt(id, body);
  }
  if (request.method === 'POST' && kind === 'location') {
    const { body, error } = await readJson(request); if (error) return error;
    return createLocation(body);
  }
  return json(405, { error: 'Method not allowed.' });
}

export default { fetch: handler };
