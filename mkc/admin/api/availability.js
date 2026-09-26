import { select, insert, json, clean, UUID_RE, readJson } from '../lib/core.js';
import { requireSession } from '../lib/auth.js';

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function del(schema, table, filter) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'DELETE',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Profile': schema, 'Accept-Profile': schema
    }
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`delete ${res.status}: ${t.slice(0, 200)}`); }
}

async function get(repId) {
  if (!UUID_RE.test(repId)) return json(400, { error: 'Bad rep id.' });
  const [rules, overrides] = await Promise.all([
    select('booking', 'availability_rules', `select=id,weekday,start_time,end_time&rep_id=eq.${repId}&order=weekday.asc,start_time.asc`),
    select('booking', 'availability_overrides', `select=id,on_date,start_time,end_time,note&rep_id=eq.${repId}&order=on_date.asc`)
  ]);
  return json(200, { rules: rules || [], overrides: overrides || [] });
}

async function putRules(repId, body) {
  if (!UUID_RE.test(repId)) return json(400, { error: 'Bad rep id.' });
  const rules = Array.isArray(body.rules) ? body.rules : [];
  const rows = [];
  for (const r of rules) {
    if (!Number.isInteger(r.weekday) || r.weekday < 0 || r.weekday > 6) return json(400, { error: 'Bad weekday.' });
    const st = clean(r.start_time, 5), et = clean(r.end_time, 5);
    if (!TIME_RE.test(st) || !TIME_RE.test(et)) return json(400, { error: 'Times must be HH:MM (24-hour).' });
    if (et <= st) return json(400, { error: 'End time must be after start time.' });
    rows.push({ rep_id: repId, weekday: r.weekday, start_time: st, end_time: et });
  }
  try {
    await del('booking', 'availability_rules', `rep_id=eq.${repId}`);
    if (rows.length) await insert('booking', 'availability_rules', rows);
  } catch (e) { console.error('rules write failed', e.message); return json(500, { error: 'Couldn’t save the schedule.' }); }
  return json(200, { ok: true, count: rows.length });
}

async function postOverride(repId, body) {
  if (!UUID_RE.test(repId)) return json(400, { error: 'Bad rep id.' });
  const on_date = clean(body.on_date, 10);
  if (!DATE_RE.test(on_date)) return json(400, { error: 'Please pick a date.' });
  const start = body.start_time == null ? null : clean(body.start_time, 5);
  const end   = body.end_time   == null ? null : clean(body.end_time,   5);
  if ((start && !end) || (!start && end)) return json(400, { error: 'Both times or leave both blank (day off).' });
  if (start && (!TIME_RE.test(start) || !TIME_RE.test(end) || end <= start)) return json(400, { error: 'Bad times.' });
  const note = clean(body.note, 200) || null;
  try {
    // Overrides replace rules for that date; the caller can add multiple rows for split days.
    await insert('booking', 'availability_overrides', { rep_id: repId, on_date, start_time: start, end_time: end, note });
  } catch (e) { console.error('override insert failed', e.message); return json(500, { error: 'Couldn’t save.' }); }
  return json(200, { ok: true });
}

async function deleteOverride(id) {
  if (!UUID_RE.test(id)) return json(400, { error: 'Bad id.' });
  try { await del('booking', 'availability_overrides', `id=eq.${id}`); }
  catch (e) { console.error('override delete failed', e.message); return json(500, { error: 'Couldn’t delete.' }); }
  return json(200, { ok: true });
}

async function handler(request) {
  try { await requireSession(request); } catch (e) { return e; }
  const url = new URL(request.url);
  const repId = url.searchParams.get('rep') || '';
  const overrideId = url.searchParams.get('override') || '';
  const kind = (url.searchParams.get('kind') || '').toLowerCase();

  if (request.method === 'GET') return get(repId);
  if (request.method === 'PUT' && kind === 'rules') {
    const { body, error } = await readJson(request); if (error) return error;
    return putRules(repId, body);
  }
  if (request.method === 'POST' && kind === 'override') {
    const { body, error } = await readJson(request); if (error) return error;
    return postOverride(repId, body);
  }
  if (request.method === 'DELETE' && overrideId) return deleteOverride(overrideId);
  return json(405, { error: 'Method not allowed.' });
}

export default { fetch: handler };
