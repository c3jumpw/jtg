import { createCipheriv, createDecipheriv, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

/* Google Calendar integration for MKC Passport.
 *
 * Two jobs, and they are deliberately separable:
 *   1. READ busy time, so the booking pages stop offering slots when a rep
 *      already has something in their own calendar. This is the one that
 *      prevents real double-bookings.
 *   2. WRITE the event when someone books, so the rep sees it where they
 *      actually live, with a Meet link.
 *
 * Dormant until GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENC_KEY are
 * set. `googleConfigured()` is the single check; every caller short-circuits
 * on it so an unconfigured install behaves exactly as it does today rather
 * than erroring. */

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',  // freebusy
  'https://www.googleapis.com/auth/calendar.events',    // create the meeting
  'openid', 'email'
];

const AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy';
const EVENTS_URL = (calId) => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`;

export const googleConfigured = () =>
  !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.TOKEN_ENC_KEY);

function encKey() {
  const raw = process.env.TOKEN_ENC_KEY || '';
  // Accept base64 or hex; must be exactly 32 bytes for AES-256.
  let buf;
  try { buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64'); }
  catch { buf = Buffer.alloc(0); }
  if (buf.length !== 32) {
    throw new Error('TOKEN_ENC_KEY must decode to exactly 32 bytes (use: openssl rand -base64 32).');
  }
  return buf;
}

/* A refresh token is a long-lived key to someone's calendar. Encrypted at rest
 * with AES-256-GCM so a leaked database row is not a leaked calendar. */
export function encryptToken(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

export function decryptToken(packed) {
  const [ivB, tagB, dataB] = String(packed || '').split('.');
  if (!ivB || !tagB || !dataB) throw new Error('Stored token is malformed.');
  const d = createDecipheriv('aes-256-gcm', encKey(), Buffer.from(ivB, 'base64'));
  d.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([d.update(Buffer.from(dataB, 'base64')), d.final()]).toString('utf8');
}

/* OAuth `state` must prove the callback belongs to the person who started it.
 * Signed with the same key rather than stored, so it needs no extra table and
 * cannot be replayed after it expires. */
export function signState(payload, ttlMs = 15 * 60_000) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString('base64url');
  const sig = createHmac('sha256', encKey()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyState(state) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) return null;
  const expect = createHmac('sha256', encKey()).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let parsed;
  try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!parsed || typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return null;
  return parsed;
}

export function authUrl(redirectUri, state) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',        // we need a refresh token
    prompt: 'consent',             // force one, even on reconnect
    include_granted_scopes: 'true',
    state
  });
  return `${AUTH_URL}?${p.toString()}`;
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) {
    const detail = data.error_description || data.error || text.slice(0, 200);
    throw new Error(`Google token request failed (${res.status}): ${detail}`);
  }
  return data;
}

export function exchangeCode(code, redirectUri) {
  return tokenRequest({
    code, redirect_uri: redirectUri, grant_type: 'authorization_code',
    client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET
  });
}

export function refreshAccessToken(refreshToken) {
  return tokenRequest({
    refresh_token: refreshToken, grant_type: 'refresh_token',
    client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET
  });
}

/* Ask Google which blocks are busy. Returns [{start,end}] in UTC ISO. */
export async function fetchBusy(accessToken, calendarIds, fromIso, toIso) {
  const res = await fetch(FREEBUSY_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timeMin: fromIso, timeMax: toIso,
      items: (calendarIds && calendarIds.length ? calendarIds : ['primary']).map((id) => ({ id }))
    })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google freeBusy failed (${res.status}): ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  const out = [];
  for (const cal of Object.values(data.calendars || {})) {
    for (const b of cal.busy || []) out.push({ start: b.start, end: b.end });
  }
  return out;
}

export async function createEvent(accessToken, calendarId, ev) {
  const url = new URL(EVENTS_URL(calendarId || 'primary'));
  if (ev.withMeet) url.searchParams.set('conferenceDataVersion', '1');
  const body = {
    summary: ev.summary,
    description: ev.description || undefined,
    location: ev.location || undefined,
    start: { dateTime: ev.start },
    end: { dateTime: ev.end },
    attendees: (ev.attendees || []).map((a) => ({ email: a.email, displayName: a.name })),
    reminders: { useDefault: true },
    ...(ev.withMeet ? {
      conferenceData: { createRequest: { requestId: ev.requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } }
    } : {})
  };
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google event create failed (${res.status}): ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/* Merge overlapping busy blocks so the availability engine gets a clean,
 * non-overlapping list. Two calendars reporting the same meeting, or a
 * back-to-back pair, should not be able to produce contradictory gaps. */
export function mergeBusy(blocks) {
  const norm = (blocks || [])
    .map((b) => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const b of norm) {
    const last = out[out.length - 1];
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else out.push({ ...b });
  }
  return out.map((b) => ({ start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString() }));
}
