import { select, insert, patch, json, clean, EMAIL_RE, UUID_RE, originAllowed, readJson, rateLimited, clientIp, esc } from '../lib/core.js';
import { sendEmail } from '../lib/emails.js';

/* POST /api/inquiry — "none of these times work" / "nobody is bookable yet".
 *
 * The booking calendar can come up empty for four different reasons, and all
 * of them look the same to a visitor: a brand with no reps configured, a fully
 * booked horizon, a rep who paused, or offered times that simply don't suit.
 * Every one of those is someone who wanted a meeting and left. This catches
 * them.
 *
 * The row is written FIRST and everything else is best-effort after. A request
 * must survive Resend being down, the CRM being down, or both — losing a lead
 * because a notification failed would be the worst possible trade. */

const SITE_URL = () => (process.env.SITE_URL || 'https://book.buildmystart-up.com').replace(/\/$/, '');
const NOTIFY_FALLBACK = () => process.env.NOTIFY_TO || '';

const TIME_PREFS = ['morning', 'afternoon', 'evening', 'flexible'];
const REASONS = ['no_reps', 'no_slots', 'rep_paused', 'none_suit'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const PREF_LABEL = {
  morning: 'Morning (before 12)',
  afternoon: 'Afternoon (12–5)',
  evening: 'Evening (after 5)',
  flexible: 'Flexible'
};
const REASON_LABEL = {
  no_reps: 'no one is bookable on this page yet',
  no_slots: 'no open times in the booking window',
  rep_paused: 'the requested rep has paused bookings',
  none_suit: 'none of the offered times suited them'
};

function niceDate(d) {
  if (!d) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' })
      .format(new Date(d + 'T12:00:00Z'));
  } catch { return d; }
}

function rangeText(from, to) {
  if (from && to) return from === to ? niceDate(from) : `${niceDate(from)} — ${niceDate(to)}`;
  if (from) return `From ${niceDate(from)}`;
  if (to) return `Before ${niceDate(to)}`;
  return 'No date range given';
}

function notificationEmail(a) {
  const prefs = a.timePrefs.length ? a.timePrefs.map((p) => PREF_LABEL[p] || p).join(', ') : 'No preference given';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#F1F3F5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F3F5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:#161B26;padding:22px 28px"><img src="${esc(a.siteUrl)}/assets/logo-light.png" alt="" height="28" style="display:block;height:28px;width:auto;border:0"></td></tr>
<tr><td style="padding:28px">
  <div style="font:800 22px/1.3 Arial,sans-serif;color:#161B26;margin:0 0 6px">Appointment request</div>
  <div style="font:15px/1.55 Arial,sans-serif;color:#4C5566">${esc(a.guestName)} asked to be contacted — ${esc(REASON_LABEL[a.reason] || 'the calendar could not serve them')}.</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;background:#F4F6F8;border-radius:10px">
    <tr><td style="padding:20px 22px">
      <div style="font:700 12px Arial,sans-serif;color:#0A6DC9;letter-spacing:.14em;text-transform:uppercase;margin-bottom:6px">Preferred dates</div>
      <div style="font:700 18px Arial,sans-serif;color:#161B26">${esc(a.rangeText)}</div>
      <div style="font:15px Arial,sans-serif;color:#161B26;margin-top:8px">${esc(prefs)}</div>
      <div style="font:13px Arial,sans-serif;color:#4C5566;margin-top:8px">Their timezone: ${esc(a.guestTimezone)}</div>
    </td></tr>
  </table>

  <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px">
    <tr><td style="padding:4px 20px 4px 0;font:700 13px Arial,sans-serif;color:#4C5566">Name</td><td style="padding:4px 0;font:15px Arial,sans-serif;color:#161B26">${esc(a.guestName)}</td></tr>
    <tr><td style="padding:4px 20px 4px 0;font:700 13px Arial,sans-serif;color:#4C5566">Email</td><td style="padding:4px 0;font:15px Arial,sans-serif"><a href="mailto:${esc(a.guestEmail)}" style="color:#0A6DC9">${esc(a.guestEmail)}</a></td></tr>
    ${a.guestPhone ? `<tr><td style="padding:4px 20px 4px 0;font:700 13px Arial,sans-serif;color:#4C5566">Phone</td><td style="padding:4px 0;font:15px Arial,sans-serif;color:#161B26">${esc(a.guestPhone)}</td></tr>` : ''}
    ${a.guestCompany ? `<tr><td style="padding:4px 20px 4px 0;font:700 13px Arial,sans-serif;color:#4C5566">Company</td><td style="padding:4px 0;font:15px Arial,sans-serif;color:#161B26">${esc(a.guestCompany)}</td></tr>` : ''}
  </table>

  ${a.guestNotes ? `<div style="margin-top:18px;padding:16px 18px;background:#FBFAF7;border-left:3px solid #2297F9;font:15px/1.55 Arial,sans-serif;color:#161B26;white-space:pre-wrap">${esc(a.guestNotes)}</div>` : ''}
  <div style="margin-top:22px;font:14px Arial,sans-serif;color:#4C5566">Reply to this email to reach ${esc(a.guestName.split(' ')[0])} directly.</div>
</td></tr></table></td></tr></table></body></html>`;

  const text = [
    `Appointment request from ${a.guestName}`,
    `Reason: ${REASON_LABEL[a.reason] || 'calendar unavailable'}`, '',
    `Preferred dates: ${a.rangeText}`,
    `Time of day: ${prefs}`,
    `Their timezone: ${a.guestTimezone}`, '',
    `Email: ${a.guestEmail}`,
    a.guestPhone ? `Phone: ${a.guestPhone}` : '',
    a.guestCompany ? `Company: ${a.guestCompany}` : '',
    a.guestNotes ? `\nNotes: ${a.guestNotes}` : ''
  ].filter(Boolean).join('\n');

  return { subject: `Appointment request · ${a.guestName}`, html, text };
}

function guestAckEmail(a) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#F1F3F5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F3F5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:#161B26;padding:22px 28px"><img src="${esc(a.siteUrl)}/assets/logo-light.png" alt="" height="28" style="display:block;height:28px;width:auto;border:0"></td></tr>
<tr><td style="padding:28px">
  <div style="font:800 22px/1.3 Arial,sans-serif;color:#161B26;margin:0 0 8px">Thanks, ${esc(a.guestName.split(' ')[0])} — we'll be in touch.</div>
  <div style="font:15px/1.55 Arial,sans-serif;color:#4C5566">We have your request and someone will come back to you with times that fit.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;background:#F4F6F8;border-radius:10px">
    <tr><td style="padding:20px 22px">
      <div style="font:700 12px Arial,sans-serif;color:#0A6DC9;letter-spacing:.14em;text-transform:uppercase;margin-bottom:6px">What you asked for</div>
      <div style="font:700 17px Arial,sans-serif;color:#161B26">${esc(a.rangeText)}</div>
      <div style="font:15px Arial,sans-serif;color:#161B26;margin-top:6px">${esc(a.timePrefs.length ? a.timePrefs.map((p) => PREF_LABEL[p] || p).join(', ') : 'Flexible')}</div>
    </td></tr>
  </table>
  <div style="margin-top:22px;font:14px Arial,sans-serif;color:#4C5566">If anything changes, just reply to this email.</div>
</td></tr></table></td></tr></table></body></html>`;
  const text = `Thanks, ${a.guestName.split(' ')[0]} — we'll be in touch.\n\nYou asked for: ${a.rangeText}\n${a.timePrefs.map((p) => PREF_LABEL[p] || p).join(', ')}\n\nSomeone will come back to you with times that fit.`;
  return { subject: 'We got your request — we’ll be in touch', html, text };
}

async function handler(request) {
  if (!originAllowed(request)) return json(403, { error: 'Not allowed from this site.' });
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' });
  if (rateLimited(`inq:${clientIp(request)}`, 8, 60 * 60_000)) {
    return json(429, { error: 'Too many requests from this network. Please try again later.' });
  }

  const { body, error } = await readJson(request);
  if (error) return error;
  if (typeof body.hp === 'string' && body.hp.trim()) return json(200, { ok: true }); // honeypot

  const pageSlug = clean(body.pageSlug, 64) || 'bms';
  const guestName = clean(body.name, 120);
  const guestEmail = clean(body.email, 200).toLowerCase();
  const guestPhone = clean(body.phone, 40);
  const guestCompany = clean(body.company, 160);
  const guestNotes = clean(body.notes, 4000);
  const guestTimezone = clean(body.timezone, 80) || 'America/New_York';
  const earliest = clean(body.earliestDate, 10);
  const latest = clean(body.latestDate, 10);
  const repId = clean(body.repId, 64);
  const meetingTypeId = clean(body.meetingTypeId, 64);
  const reason = REASONS.includes(body.reason) ? body.reason : 'none_suit';
  const timePrefs = Array.isArray(body.timePrefs)
    ? [...new Set(body.timePrefs.filter((p) => TIME_PREFS.includes(p)))]
    : [];

  if (!guestName) return json(400, { error: 'Please add your name.' });
  if (!EMAIL_RE.test(guestEmail)) return json(400, { error: 'Please check your email address.' });
  if (body.consent !== true) return json(400, { error: 'Please tick the consent box so we can contact you.' });
  if (earliest && !DATE_RE.test(earliest)) return json(400, { error: 'Bad start date.' });
  if (latest && !DATE_RE.test(latest)) return json(400, { error: 'Bad end date.' });
  if (earliest && latest && latest < earliest) return json(400, { error: 'The end date is before the start date.' });
  if (repId && !UUID_RE.test(repId)) return json(400, { error: 'Bad rep.' });
  if (meetingTypeId && !UUID_RE.test(meetingTypeId)) return json(400, { error: 'Bad meeting type.' });

  // Resolve the page for the foreign key, but never fail the request over it —
  // the slug is stored regardless so nothing is lost if the lookup misbehaves.
  let pageId = null;
  try {
    const rows = await select('booking', 'pages', `select=id&slug=eq.${encodeURIComponent(pageSlug)}`);
    pageId = rows && rows[0] ? rows[0].id : null;
  } catch (e) { console.error('inquiry page lookup failed', e.message); }

  let saved;
  try {
    const rows = await insert('booking', 'inquiries', {
      page_id: pageId, page_slug: pageSlug,
      rep_id: repId || null, meeting_type_id: meetingTypeId || null,
      guest_name: guestName, guest_email: guestEmail,
      guest_phone: guestPhone || null, guest_company: guestCompany || null,
      guest_timezone: guestTimezone, guest_notes: guestNotes || null,
      earliest_date: earliest || null, latest_date: latest || null,
      time_prefs: timePrefs, reason,
      source: { referrer: clean(body.referrer, 500), utm: body.utm && typeof body.utm === 'object' ? body.utm : {} }
    });
    saved = rows && rows[0];
  } catch (e) {
    console.error('inquiry insert failed', e.message, e.body);
    return json(500, { error: 'We couldn’t save that. Please try again, or email us directly.' });
  }
  if (!saved) return json(500, { error: 'We couldn’t save that. Please try again.' });

  // Everything below is best-effort. The request is already safe.
  const payload = {
    siteUrl: SITE_URL(), guestName, guestEmail, guestPhone, guestCompany,
    guestNotes, guestTimezone, timePrefs, reason,
    rangeText: rangeText(earliest, latest)
  };

  let notifyTo = NOTIFY_FALLBACK();
  if (repId) {
    try {
      const p = await select('core', 'people', `select=email&id=eq.${repId}`);
      if (p && p[0] && p[0].email) notifyTo = p[0].email;
    } catch (e) { console.error('inquiry rep lookup failed', e.message); }
  }

  const [teamErr, guestErr] = await Promise.all([
    notifyTo
      ? sendEmail({ to: notifyTo, ...notificationEmail(payload), replyTo: guestEmail, key: `inq-${saved.id}-team` })
      : Promise.resolve('no notification address configured'),
    sendEmail({ to: guestEmail, ...guestAckEmail(payload), replyTo: notifyTo || undefined, key: `inq-${saved.id}-guest` })
  ]);

  const errs = [teamErr, guestErr].filter(Boolean);
  if (errs.length) {
    console.error('inquiry email issues', saved.id, errs.join(' | '));
    try {
      await patch('booking', 'inquiries', `id=eq.${saved.id}`,
        { source: { ...(saved.source || {}), email_errors: errs } });
    } catch {}
  }

  return json(200, { ok: true, id: saved.id });
}

export default { fetch: handler };
