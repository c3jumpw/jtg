// Talks to the MKC-Admin Supabase project over REST + RPC.
// We use raw fetch (no @supabase/supabase-js) to keep cold starts small.
// Every call goes through the service-role key, so RLS is bypassed intentionally —
// the tables in the `booking` and `core` schemas have no public policies at all.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function requireEnv() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    const missing = [!SUPABASE_URL && 'SUPABASE_URL', !SUPABASE_KEY && 'SUPABASE_SERVICE_ROLE_KEY'].filter(Boolean).join(', ');
    throw new Error(`Booking backend is not fully configured (missing ${missing}). Set the env vars in Vercel and redeploy.`);
  }
}

async function req(path, init) {
  requireEnv();
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init && init.headers)
    }
  });
  const text = await res.text();
  if (!res.ok) {
    const body = text.slice(0, 400);
    throw Object.assign(new Error(`Supabase ${res.status}: ${body}`), { status: res.status, body });
  }
  return text ? JSON.parse(text) : null;
}

/** Call a Postgres function defined in a non-public schema.
 *  Supabase requires the `Content-Profile` / `Accept-Profile` header for that. */
export function rpc(schema, name, args = {}) {
  return req(`/rest/v1/rpc/${name}`, {
    method: 'POST',
    body: JSON.stringify(args),
    headers: { 'Content-Profile': schema, 'Accept-Profile': schema }
  });
}

/** POST to a table with Prefer: return=representation so we get the inserted row back. */
export function insert(schema, table, rows, { onConflict } = {}) {
  const q = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
  return req(`/rest/v1/${table}${q}`, {
    method: 'POST',
    body: JSON.stringify(rows),
    headers: {
      'Content-Profile': schema, 'Accept-Profile': schema,
      Prefer: onConflict ? 'return=representation,resolution=merge-duplicates' : 'return=representation'
    }
  });
}

export function patch(schema, table, filter, changes) {
  return req(`/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    body: JSON.stringify(changes),
    headers: { 'Content-Profile': schema, 'Accept-Profile': schema, Prefer: 'return=representation' }
  });
}

export function select(schema, table, query = '') {
  return req(`/rest/v1/${table}${query ? '?' + query : ''}`, {
    method: 'GET',
    headers: { 'Accept-Profile': schema }
  });
}

/* ---------- validation + reply helpers ---------- */

const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
export function clean(v, max) {
  return typeof v === 'string' ? v.replace(CTRL, '').trim().slice(0, max) : '';
}
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra }
  });
}

// Same-origin check: browsers get one policy; direct API calls (curl, tests) pass.
export function originAllowed(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  let host = '';
  try { host = new URL(origin).host; } catch { return false; }
  if (host === (request.headers.get('host') || new URL(request.url).host)) return true;
  return (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
}

const hits = new Map();
export function rateLimited(key, max, windowMs, now = Date.now()) {
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

export function clientIp(request) {
  return (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    request.headers.get('x-real-ip') || 'unknown';
}

export async function readJson(request, maxChars = 100000) {
  const text = await request.text();
  if (text.length > maxChars) return { error: json(413, { error: 'That request is too large.' }) };
  try { return { body: JSON.parse(text) }; } catch { return { error: json(400, { error: 'Bad request.' }) }; }
}
