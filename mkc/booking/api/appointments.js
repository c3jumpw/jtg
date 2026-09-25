import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { rpc, insert, patch, select, json, clean, originAllowed, readJson, UUID_RE, EMAIL_RE, rateLimited, clientIp } from '../lib/core.js';
import { computeAvailability, pickRep } from '../lib/availability.js';
import { buildIcs, guestConfirmationEmail, repNotificationEmail, sendEmail, humanTime } from '../lib/emails.js';

// Hash the manage-token to store; the raw token only ever lives in the guest's email link.
const hashToken = (raw) => createHash('sha256').update(raw).digest('hex');
const makeToken = () => randomBytes(24).toString('base64url'); // 32 chars

const SITE_URL = () => (process.env.SITE_URL || 'https://start.befortune5.com').replace(/\/$/, '');
const FROM_EMAIL = () => process.env.FROM_EMAIL || 'The Fortune 5 Agency <bookings@befortune5.com>';
const NOTIFY_FALLBACK = () => process.env.NOTIFY_TO || '';

/* ---------------- CRM sync (MKC CRM 2.0, ClickUp-backed) ----------------
 * When CRM_ENDPOINT_URL and CRM_SHARED_SECRET are set, we POST to the CRM's
 * /api/booking-created endpoint after saving. The CRM does contact resolution
 * (match by email/phone or create a Lead) and logs the booking to that entry.
 * We store the returned entryId on the appointment for cross-reference.
 * Missing env vars = feature off. All errors are captured, never thrown. */

async function syncToCRM({ apptId, repClickupId, repName, guest, meeting }) {
  const endpoint = process.env.CRM_ENDPOINT_URL;
  const secret = process.env.CRM_SHARED_SECRET;
  if (!endpoint || !secret) return; // integration not configured — no-op
  const body = {
    repMkcId: repClickupId,   // may be null if this rep isn't linked to a Team Directory entry yet
    repName,
    attendee: {
      firstName: guest.firstName || '',
      lastName: guest.lastName || '',
      email: guest.email,
      phone: guest.phone || null,
      company: guest.company || null
    },
    meeting: {
      topic: meeting.topic,
      startTime: meeting.startTime,
      endTime: meeting.endTime,
      meetingUrl: meeting.meetingUrl,
      notes: meeting.notes,
      mode: meeting.mode,
      locationText: meeting.locationText
    },
    bookingSource: 'native',
    bookingId: apptId
  };
  let ok = false, entryId = null, entryType = null, errorMsg = null;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Form-Secret': secret },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    if (res.ok) {
      try { const j = text ? JSON.parse(text) : {}; entryId = j.entryId || null; entryType = j.entryType || null; ok = true; }
      catch { ok = true; }
    } else {
      errorMsg = `CRM ${res.status}: ${text.slice(0, 300)}`;
    }
  } catch (e) {
    errorMsg = `CRM request failed: ${e.message}`;
  }
  try {
    await patch('booking', 'appointments', `id=eq.${apptId}`, ok
      ? { crm_entry_id: entryId, crm_entry_type: entryType, crm_synced_at: new Date().toISOString(), crm_sync_error: null }
      : { crm_sync_error: errorMsg });
  } catch (e) {
    console.error('failed to record CRM sync result for', apptId, e.message);
  }
}

/* ---------------- CREATE ---------------- */

async function create(request) {
  if (rateLimited(`bk:${clientIp(request)}`, 12, 60 * 60_000)) {
    return json(429, { error: 'Too many bookings from this network. Please try again later.' });
  }
  const { body, error } = await readJson(request);
  if (error) return error;

  // Bots love hidden fields. Say thanks and drop.
  if (typeof body.hp === 'string' && body.hp.trim()) return json(200, { ok: true });

  const meetingTypeId = clean(body.meetingTypeId, 64);
  const startIso = clean(body.startsAt, 40);
  const guest = body.guest || {};
  const guestName = clean(guest.name, 120);
  const guestEmail = clean(guest.email, 200).toLowerCase();
  const guestPhone = clean(guest.phone, 40);
  const guestCompany = clean(guest.company, 160);
  const guestNotes = clean(guest.notes, 4000);
  const guestTimezone = clean(guest.timezone, 80) || 'America/New_York';
  const discoveryFolder = clean(body.discoveryFolder, 64) || null;
  const consent = body.consent === true;

  if (!UUID_RE.test(meetingTypeId)) return json(400, { error: 'Bad meeting type.' });
  const startMs = new Date(startIso).getTime();
  if (!Number.isFinite(startMs)) return json(400, { error: 'Please pick a time.' });
  if (!guestName) return json(400, { error: 'Please add your name.' });
  if (!EMAIL_RE.test(guestEmail)) return json(400, { error: 'Please check your email address.' });
  if (!consent) return json(400, { error: 'Please tick the consent box so we can contact you.' });
  if (discoveryFolder && !UUID_RE.test(discoveryFolder)) return json(400, { error: 'Bad reference.' });

  // Re-derive availability at booking time from truth — never trust the client's picked slot alone.
  // We check a narrow window (the slot + one grid step) so busy meetings inserted between availability
  // and confirm are caught.
  const inputs = await rpc('booking', 'get_availability_inputs', {
    p_meeting_type_id: meetingTypeId,
    p_from: new Date(startMs - 60_000).toISOString(),
    p_to: new Date(startMs + 4 * 60 * 60_000).toISOString()
  });
  if (!inputs || !inputs.meeting_type) return json(404, { error: 'That meeting type isn’t available.' });
  const mt = inputs.meeting_type;
  const avail = computeAvailability(inputs, startMs - 60_000, startMs + mt.duration_min * 60_000 + 60_000);
  let match = null;
  for (const d of avail.days) for (const s of d.slots) {
    if (new Date(s.start).getTime() === startMs) { match = s; break; }
    if (match) break;
  }
  if (!match) return json(409, { error: 'That time was just taken. Please pick another.' });

  // Round-robin among the reps who can take this slot: score by recent confirmed bookings (last 30 days).
  const sinceIso = new Date(Date.now() - 30 * 86400_000).toISOString();
  const scoreRows = await select(
    'booking', 'appointments',
    `select=rep_id,starts_at&status=eq.confirmed&starts_at=gte.${encodeURIComponent(sinceIso)}&rep_id=in.(${match.repIds.join(',')})`
  );
  const count = new Map();
  for (const r of scoreRows || []) count.set(r.rep_id, (count.get(r.rep_id) || 0) + 1);
  const repId = pickRep(match.repIds, count);
  const rep = inputs.reps.find((r) => r.person_id === repId);

  // Fetch page + rep email in one shot (we need the rep's email for the notification).
  const pageRows = await select('booking', 'pages', `select=id,slug,title,confirm_note&id=eq.${mt.page_id}`);
  const page = (pageRows || [])[0] || { title: 'Strategy call', confirm_note: null };
  const personRows = await select('core', 'people', `select=email,full_name&id=eq.${repId}`);
  const person = (personRows || [])[0] || {};

  const location = mt.mode === 'in_person' && mt.location_id
    ? ((await select('booking', 'locations', `select=name,address&id=eq.${mt.location_id}`)) || [])[0]
    : null;

  const rawToken = makeToken();
  const insertRow = {
    page_id: mt.page_id,
    meeting_type_id: mt.id,
    rep_id: repId,
    starts_at: new Date(startMs).toISOString(),
    ends_at: new Date(startMs + mt.duration_min * 60_000).toISOString(),
    status: 'confirmed',
    mode: mt.mode,
    location_text: location ? `${location.name} — ${location.address}` : null,
    guest_name: guestName,
    guest_email: guestEmail,
    guest_phone: guestPhone || null,
    guest_company: guestCompany || null,
    guest_notes: guestNotes || null,
    guest_timezone: guestTimezone,
    discovery_folder: discoveryFolder,
    manage_token_hash: hashToken(rawToken),
    source: { referrer: clean(body.referrer, 500), utm: body.utm && typeof body.utm === 'object' ? body.utm : {} }
  };

  let inserted;
  try {
    const rows = await insert('booking', 'appointments', insertRow);
    inserted = rows && rows[0];
  } catch (e) {
    if (String(e.body || '').includes('appointments_no_overlap') || (e.status === 409)) {
      return json(409, { error: 'That time was just taken. Please pick another.' });
    }
    console.error('appointment insert failed', e.message, e.body);
    return json(500, { error: 'We couldn’t save that. Nothing was lost on your side. Please try again.' });
  }
  if (!inserted) return json(500, { error: 'We couldn’t save that. Please try again.' });

  const manageUrl = `${SITE_URL()}/manage?t=${rawToken}`;
  const uid = `${inserted.id}@befortune5.com`;
  const summary = `${page.title} · ${guestName}`;
  const description = [
    `Meeting with ${rep.display_name || person.full_name || 'a specialist'}.`,
    guestNotes ? `\nNotes from ${guestName}:\n${guestNotes}` : '',
    `\nReschedule or cancel: ${manageUrl}`
  ].filter(Boolean).join('');
  const ics = buildIcs({
    uid, summary, description,
    start: insertRow.starts_at, end: insertRow.ends_at,
    location: insertRow.location_text || undefined,
    url: manageUrl,
    organizerName: 'The Fortune 5 Agency',
    organizerEmail: person.email || 'bookings@befortune5.com',
    attendees: [{ name: guestName, email: guestEmail }]
  });
  const icsAttachment = { filename: 'meeting.ics', content: Buffer.from(ics, 'utf8').toString('base64'), contentType: 'text/calendar; charset=utf-8; method=REQUEST' };

  const guestPayload = {
    ...insertRow, ...inserted, siteUrl: SITE_URL(),
    guestName, pageTitle: page.title, repName: rep.display_name || person.full_name || 'a specialist',
    durationMin: mt.duration_min, manageUrl, confirmNote: page.confirm_note
  };
  const repPayload = {
    ...insertRow, ...inserted, siteUrl: SITE_URL(),
    pageTitle: page.title, durationMin: mt.duration_min,
    repTimezone: rep.timezone || 'America/New_York'
  };

  const notifyTo = person.email || NOTIFY_FALLBACK();
  const [guestErr, repErr] = await Promise.all([
    sendEmail({ to: guestEmail, ...guestConfirmationEmail(guestPayload), replyTo: notifyTo || undefined, key: `bk-${inserted.id}-guest`, attachment: icsAttachment }),
    notifyTo ? sendEmail({ to: notifyTo, ...repNotificationEmail(repPayload), replyTo: guestEmail, key: `bk-${inserted.id}-rep`, attachment: icsAttachment }) : Promise.resolve('no rep email on file')
  ]);

  // Log delivery outcomes but don't fail the booking on email issues — the row is stored.
  const errors = [guestErr, repErr].filter(Boolean);
  if (errors.length) {
    console.error('email issues for booking', inserted.id, errors.join(' | '));
    try { await patch('booking', 'appointments', `id=eq.${inserted.id}`, { source: { ...(insertRow.source || {}), email_errors: errors } }); } catch {}
  }

  // Fire-and-forget CRM sync: create/match the Lead or Contact in MKC CRM 2.0 and log this booking
  // against them. Additive — booking is already saved; CRM sync failures are visible but non-fatal.
  syncToCRM({
    apptId: inserted.id,
    repClickupId: rep.clickup_team_dir_id || null, repName: rep.display_name || person.full_name || 'a specialist',
    guest: { firstName: guestName.split(' ')[0], lastName: guestName.split(' ').slice(1).join(' '), email: guestEmail, phone: guestPhone, company: guestCompany },
    meeting: {
      topic: page.title, startTime: insertRow.starts_at, endTime: insertRow.ends_at,
      meetingUrl: insertRow.meet_url || null,
      notes: guestNotes || null,
      mode: mt.mode, locationText: insertRow.location_text || null
    }
  }).catch((e) => console.error('CRM sync scheduling failed for', inserted.id, e.message));

  return json(200, {
    ok: true, id: inserted.id, manageUrl,
    when: humanTime(insertRow.starts_at, guestTimezone),
    durationMin: mt.duration_min, mode: mt.mode,
    location: insertRow.location_text
  });
}

/* ---------------- LOOKUP + CANCEL ---------------- */

async function lookup(token) {
  const rows = await select('booking', 'appointments',
    `select=id,starts_at,ends_at,status,mode,guest_name,guest_email,guest_timezone,location_text,meet_url,rep_id,meeting_type_id,page_id&manage_token_hash=eq.${hashToken(token)}`
  );
  const appt = (rows || [])[0];
  if (!appt) return null;
  const [page] = (await select('booking', 'pages', `select=title,confirm_note&id=eq.${appt.page_id}`)) || [];
  const [mt] = (await select('booking', 'meeting_types', `select=duration_min,name,mode&id=eq.${appt.meeting_type_id}`)) || [];
  return { ...appt, pageTitle: page ? page.title : 'Strategy call', durationMin: mt ? mt.duration_min : 30, meetingName: mt ? mt.name : null };
}

async function getByToken(request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get('t') || '';
  if (!raw || raw.length > 128) return json(400, { error: 'Bad link.' });
  try {
    const appt = await lookup(raw);
    if (!appt) return json(404, { error: 'This link is invalid or has expired.' });
    return json(200, { ok: true, appointment: appt });
  } catch (e) {
    console.error('lookup failed', e.message);
    return json(500, { error: 'Couldn’t load this booking right now.' });
  }
}

async function cancel(request) {
  if (rateLimited(`cx:${clientIp(request)}`, 30, 60 * 60_000)) return json(429, { error: 'Too many cancellations from this network. Please try again later.' });
  const { body, error } = await readJson(request);
  if (error) return error;
  const raw = clean(body.token, 128);
  const reason = clean(body.reason, 500);
  if (!raw) return json(400, { error: 'Bad request.' });
  try {
    const appt = await lookup(raw);
    if (!appt) return json(404, { error: 'This link is invalid or has expired.' });
    if (appt.status !== 'confirmed') return json(200, { ok: true, already: true });
    if (new Date(appt.starts_at).getTime() < Date.now()) return json(400, { error: 'This meeting has already started; contact us to sort it out.' });
    await patch('booking', 'appointments', `id=eq.${appt.id}`, { status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: reason || null });

    // Fire-and-forget CANCEL notice; we don't fail the cancel on email issues.
    try {
      const [rep] = (await select('core', 'people', `select=email,full_name&id=eq.${appt.rep_id}`)) || [];
      const summary = `${appt.pageTitle} · ${appt.guest_name} — CANCELLED`;
      const ics = buildIcs({
        uid: `${appt.id}@befortune5.com`, summary,
        description: reason ? `Cancelled. Reason: ${reason}` : 'Cancelled by guest.',
        start: appt.starts_at, end: appt.ends_at,
        method: 'CANCEL', sequence: 1,
        organizerName: 'The Fortune 5 Agency', organizerEmail: (rep && rep.email) || 'bookings@befortune5.com',
        attendees: [{ name: appt.guest_name, email: appt.guest_email }]
      });
      const att = { filename: 'cancelled.ics', content: Buffer.from(ics, 'utf8').toString('base64'), contentType: 'text/calendar; charset=utf-8; method=CANCEL' };
      const t = humanTime(appt.starts_at, appt.guest_timezone || 'America/New_York');
      const notifyTo = (rep && rep.email) || NOTIFY_FALLBACK();
      const html = `<p style="font:16px Arial,sans-serif;color:#161B26">${appt.guest_name} cancelled the meeting on <strong>${t.date} at ${t.time}</strong>.</p>${reason ? `<p style="font:15px Arial,sans-serif;color:#4C5566">Reason: ${reason}</p>` : ''}`;
      await Promise.all([
        sendEmail({ to: appt.guest_email, subject: `Cancelled: ${appt.pageTitle} · ${t.date}`, html: `<p>You cancelled your meeting on ${t.date} at ${t.time}. If that was a mistake, just book again.</p>`, text: `Cancelled: ${t.date} at ${t.time}.`, key: `cx-${appt.id}-guest`, attachment: att }),
        notifyTo ? sendEmail({ to: notifyTo, subject: `Cancelled by ${appt.guest_name} · ${t.date}`, html, text: `${appt.guest_name} cancelled: ${t.date} at ${t.time}.${reason ? '\nReason: ' + reason : ''}`, key: `cx-${appt.id}-rep`, attachment: att }) : Promise.resolve()
      ]);
    } catch (e) { console.error('cancel email failed', e.message); }

    return json(200, { ok: true, cancelled: true });
  } catch (e) {
    console.error('cancel failed', e.message);
    return json(500, { error: 'Couldn’t cancel right now. Please try again.' });
  }
}

async function handler(request) {
  if (!originAllowed(request)) return json(403, { error: 'Not allowed from this site.' });
  const url = new URL(request.url);
  const action = (url.searchParams.get('action') || '').toLowerCase();

  if (request.method === 'GET') return getByToken(request);
  if (request.method === 'POST' && action === 'cancel') return cancel(request);
  if (request.method === 'POST') return create(request);
  return json(405, { error: 'Method not allowed.' });
}

export default { fetch: handler };
