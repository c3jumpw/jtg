import { select, insert, patch, json, clean, UUID_RE } from '../lib/core.js';
import { requireSession } from '../lib/auth.js';
import {
  googleConfigured, authUrl, signState, verifyState,
  exchangeCode, refreshAccessToken, encryptToken, decryptToken, GOOGLE_SCOPES
} from '../lib/google.js';

/* Connect a rep's Google Calendar to MKC Passport.
 *
 *   GET  ?action=status     what this rep has connected, if anything
 *   GET  ?action=start      begin the OAuth handshake
 *   GET  ?action=callback   Google returns here with a code
 *   POST ?action=disconnect forget the token
 *
 * A rep can only ever act on their own calendar. An admin may look at status
 * to help someone, but cannot connect on their behalf — a calendar grant has
 * to come from the person who owns the calendar. */

const SITE_URL = () => (process.env.SITE_URL || 'https://mkc-passport.jtgworkspace.com').replace(/\/$/, '');
const redirectUri = () => `${SITE_URL()}/api/google-calendar?action=callback`;

function landing(msg, ok) {
  // Back into the SPA with a message it can surface as a toast.
  const q = new URLSearchParams({ [ok ? 'gcal' : 'gcalerr']: msg });
  return new Response(null, {
    status: 302,
    headers: { Location: `${SITE_URL()}/?${q.toString()}#/my-profile`, 'Cache-Control': 'no-store' }
  });
}

async function status(repId) {
  if (!googleConfigured()) {
    return json(200, { configured: false, connected: false });
  }
  const rows = await select('booking', 'rep_calendars',
    `select=id,provider,account_email,status,scopes,busy_calendar_ids,write_calendar_id,last_error,connected_at,updated_at&rep_id=eq.${repId}&provider=eq.google`);
  const c = rows && rows[0];
  return json(200, {
    configured: true,
    connected: !!c && c.status === 'active',
    calendar: c ? {
      accountEmail: c.account_email, status: c.status,
      connectedAt: c.connected_at, lastError: c.last_error,
      busyCalendarIds: c.busy_calendar_ids, writeCalendarId: c.write_calendar_id
    } : null
  });
}

async function start(session, repId) {
  if (!googleConfigured()) {
    return json(503, { error: 'Google Calendar isn’t set up on this install yet. An admin needs to add the Google credentials.' });
  }
  // Only the owner of the calendar may grant access to it.
  if (repId !== session.personId) {
    return json(403, { error: 'You can only connect your own calendar.' });
  }
  const state = signState({ repId, email: session.email });
  return json(200, { url: authUrl(redirectUri(), state) });
}

async function callback(url) {
  if (!googleConfigured()) return landing('Google Calendar is not configured.', false);

  const err = url.searchParams.get('error');
  if (err) return landing(err === 'access_denied' ? 'Connection cancelled.' : `Google returned: ${err}`, false);

  const code = clean(url.searchParams.get('code'), 512);
  const st = verifyState(url.searchParams.get('state'));
  if (!code) return landing('Google didn’t send an authorisation code.', false);
  // A bad or expired state means this callback can't be trusted to belong to
  // the person who started it — refuse rather than guess whose calendar it is.
  if (!st || !UUID_RE.test(st.repId || '')) return landing('That connection link expired. Please try again.', false);

  let tokens;
  try { tokens = await exchangeCode(code, redirectUri()); }
  catch (e) { console.error('google exchange failed', e.message); return landing('Google wouldn’t complete the connection.', false); }

  if (!tokens.refresh_token) {
    // Without a refresh token we can read the calendar for an hour and then
    // go silently stale, which is worse than not connecting at all.
    return landing('Google didn’t return a refresh token. Remove MKC from your Google account’s third-party access and try again.', false);
  }

  // Identify the account so the rep can see which calendar they connected.
  let accountEmail = st.email || 'unknown';
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    if (r.ok) { const info = await r.json(); if (info.email) accountEmail = info.email; }
  } catch (e) { console.error('google userinfo failed', e.message); }

  try {
    await insert('booking', 'rep_calendars', {
      rep_id: st.repId,
      provider: 'google',
      account_email: accountEmail,
      refresh_token_enc: encryptToken(tokens.refresh_token),
      scopes: GOOGLE_SCOPES,
      status: 'active',
      busy_calendar_ids: ['primary'],
      write_calendar_id: 'primary',
      last_error: null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'rep_id,provider' });
  } catch (e) {
    console.error('rep_calendars upsert failed', e.message, e.body);
    return landing('We couldn’t save the connection.', false);
  }
  return landing(`Connected ${accountEmail}`, true);
}

async function disconnect(session, repId) {
  if (repId !== session.personId && session.role !== 'super_admin') {
    return json(403, { error: 'You can only disconnect your own calendar.' });
  }
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rep_calendars?rep_id=eq.${repId}&provider=eq.google`, {
      method: 'DELETE',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Profile': 'booking'
      }
    });
    if (!res.ok) throw new Error(`delete ${res.status}`);
  } catch (e) {
    console.error('calendar disconnect failed', e.message);
    return json(500, { error: 'Couldn’t disconnect.' });
  }
  return json(200, { ok: true });
}

/* Verify a stored connection still works, and surface the failure on the row
 * so a rep sees "reconnect" rather than silently losing busy-time protection. */
async function verify(repId) {
  const rows = await select('booking', 'rep_calendars',
    `select=refresh_token_enc&rep_id=eq.${repId}&provider=eq.google`);
  const c = rows && rows[0];
  if (!c) return json(404, { error: 'Nothing connected.' });
  try {
    await refreshAccessToken(decryptToken(c.refresh_token_enc));
    await patch('booking', 'rep_calendars', `rep_id=eq.${repId}&provider=eq.google`,
      { status: 'active', last_error: null, updated_at: new Date().toISOString() });
    return json(200, { ok: true });
  } catch (e) {
    await patch('booking', 'rep_calendars', `rep_id=eq.${repId}&provider=eq.google`,
      { status: 'needs_reconnect', last_error: e.message.slice(0, 300), updated_at: new Date().toISOString() });
    return json(200, { ok: false, error: e.message });
  }
}

async function handler(request) {
  const url = new URL(request.url);
  const action = (url.searchParams.get('action') || 'status').toLowerCase();

  // The callback arrives from Google in a top-level browser navigation, so it
  // is authenticated by the signed state rather than the session cookie.
  if (action === 'callback') return callback(url);

  let session;
  try { session = await requireSession(request); } catch (e) { return e; }
  const repId = clean(url.searchParams.get('rep'), 64) || session.personId;
  if (!repId || !UUID_RE.test(repId)) return json(400, { error: 'Bad rep id.' });

  const isAdmin = session.role === 'super_admin' || session.role === 'admin';
  if (repId !== session.personId && !isAdmin) return json(403, { error: 'Not your calendar.' });

  if (request.method === 'GET'  && action === 'status') return status(repId);
  if (request.method === 'GET'  && action === 'start')  return start(session, repId);
  if (request.method === 'POST' && action === 'verify') return verify(repId);
  if (request.method === 'POST' && action === 'disconnect') return disconnect(session, repId);
  return json(405, { error: 'Method not allowed.' });
}

export default { fetch: handler };
