import { esc } from './core.js';

// -------- .ics generation --------

// Format YYYYMMDDTHHmmssZ in UTC.
function icsDateUtc(d) {
  const iso = new Date(d).toISOString();
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// Line-fold per RFC 5545: no line longer than 75 octets.
function fold(line) {
  const out = [];
  let s = line;
  while (Buffer.byteLength(s, 'utf8') > 75) {
    let cut = 75;
    while (cut > 1 && Buffer.byteLength(s.slice(0, cut), 'utf8') > 74) cut--;
    out.push(s.slice(0, cut));
    s = ' ' + s.slice(cut);
  }
  out.push(s);
  return out.join('\r\n');
}

function escText(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/**
 * Build an .ics for the appointment, addressed from the organiser (F5) to the guest.
 * @param {Object} a
 * @param {string} a.uid           unique id, stable across updates for the same appointment
 * @param {string} a.summary       calendar title
 * @param {string} a.description   long description
 * @param {Date|string|number} a.start
 * @param {Date|string|number} a.end
 * @param {string} [a.location]    physical address or meet URL
 * @param {string} [a.url]         primary URL (Meet link, manage link)
 * @param {string} a.organizerName
 * @param {string} a.organizerEmail
 * @param {{name:string,email:string}[]} [a.attendees]
 * @param {'REQUEST'|'CANCEL'} [a.method='REQUEST']
 * @param {number} [a.sequence=0]  bump on updates
 */
export function buildIcs(a) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MKC//Booking//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${a.method || 'REQUEST'}`,
    'BEGIN:VEVENT',
    `UID:${escText(a.uid)}`,
    `DTSTAMP:${icsDateUtc(Date.now())}`,
    `DTSTART:${icsDateUtc(a.start)}`,
    `DTEND:${icsDateUtc(a.end)}`,
    `SEQUENCE:${a.sequence || 0}`,
    `STATUS:${a.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    `SUMMARY:${escText(a.summary)}`,
    a.description ? `DESCRIPTION:${escText(a.description)}` : null,
    a.location ? `LOCATION:${escText(a.location)}` : null,
    a.url ? `URL:${escText(a.url)}` : null,
    `ORGANIZER;CN=${escText(a.organizerName)}:mailto:${a.organizerEmail}`,
    ...(a.attendees || []).map((at) =>
      `ATTENDEE;CN=${escText(at.name)};RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:${at.email}`),
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Reminder',
    'TRIGGER:-PT15M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter(Boolean).map(fold);
  return lines.join('\r\n') + '\r\n';
}

// -------- email templates --------

const SHELL = (siteUrl, inner, preheader) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:0;background:#F1F3F5">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F3F5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#161B26;padding:22px 28px"><img src="${esc(siteUrl)}/assets/logo-light.png" alt="The Fortune 5 Agency" height="30" style="display:block;height:30px;width:auto;border:0"></td></tr>
<tr><td style="padding:28px">${inner}</td></tr>
</table></td></tr></table></body></html>`;

// Format a start time in a readable way for a specific IANA timezone.
export function humanTime(startIso, timezone) {
  const d = new Date(startIso);
  const dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  return { date: dateFmt.format(d), time: timeFmt.format(d) };
}

export function guestConfirmationEmail(a) {
  const t = humanTime(a.startsAt, a.guestTimezone || 'America/New_York');
  const label = a.mode === 'virtual' ? 'Virtual meeting' : 'In-person meeting';
  const where = a.mode === 'virtual'
    ? (a.meetUrl ? `<a href="${esc(a.meetUrl)}" style="color:#0A6DC9">${esc(a.meetUrl)}</a> — a video link will also be in the calendar invite.` : 'A video link will follow separately.')
    : esc(a.locationText || 'Address to follow');

  const html = SHELL(a.siteUrl, `
    <div style="font:800 22px/1.3 Arial,sans-serif;color:#161B26;margin:0 0 8px">You're on the calendar, ${esc(a.guestName)}.</div>
    <div style="font:15px/1.55 Arial,sans-serif;color:#4C5566">${esc(a.pageTitle)} — with ${esc(a.repName)}.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;background:#F4F6F8;border-radius:10px">
      <tr><td style="padding:20px 22px">
        <div style="font:700 12px Arial,sans-serif;color:#0A6DC9;letter-spacing:.14em;text-transform:uppercase;margin-bottom:6px">${esc(label)}</div>
        <div style="font:700 20px Arial,sans-serif;color:#161B26">${esc(t.date)}</div>
        <div style="font:16px Arial,sans-serif;color:#161B26;margin-top:2px">${esc(t.time)} · ${a.durationMin} minutes</div>
        <div style="font:14px Arial,sans-serif;color:#4C5566;margin-top:10px">${where}</div>
      </td></tr>
    </table>
    <div style="margin-top:22px;font:15px/1.55 Arial,sans-serif;color:#161B26">A calendar invitation is attached. Add it in one click.</div>
    <div style="margin-top:20px;font:14px/1.55 Arial,sans-serif;color:#4C5566">Need to reschedule or cancel? <a href="${esc(a.manageUrl)}" style="color:#0A6DC9">Manage this booking</a>.</div>
    ${a.confirmNote ? `<div style="margin-top:22px;padding-top:18px;border-top:1px solid #E4E7EE;font:14px/1.55 Arial,sans-serif;color:#4C5566">${esc(a.confirmNote)}</div>` : ''}`,
    `Booked: ${t.date} at ${t.time}`);
  const text = [
    `You're on the calendar, ${a.guestName}.`, '',
    `${a.pageTitle} — with ${a.repName}`, '',
    `${t.date}`, `${t.time} · ${a.durationMin} minutes`,
    a.mode === 'virtual' ? (a.meetUrl ? `Join: ${a.meetUrl}` : 'A video link will follow separately.') : (a.locationText || 'Address to follow'),
    '', 'A calendar invitation is attached (.ics).',
    `Manage this booking: ${a.manageUrl}`
  ].join('\n');
  return { subject: `Confirmed: ${a.pageTitle} · ${t.date} · ${t.time}`, html, text };
}

export function repNotificationEmail(a) {
  const t = humanTime(a.startsAt, a.repTimezone);
  const html = SHELL(a.siteUrl, `
    <div style="font:800 22px/1.3 Arial,sans-serif;color:#161B26;margin:0 0 6px">New booking</div>
    <div style="font:15px/1.55 Arial,sans-serif;color:#4C5566">${esc(a.pageTitle)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;background:#F4F6F8;border-radius:10px">
      <tr><td style="padding:20px 22px">
        <div style="font:700 20px Arial,sans-serif;color:#161B26">${esc(t.date)}</div>
        <div style="font:16px Arial,sans-serif;color:#161B26;margin-top:2px">${esc(t.time)} · ${a.durationMin} minutes · ${esc(a.mode === 'virtual' ? 'Virtual' : 'In person')}</div>
      </td></tr>
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px">
      <tr><td style="padding:4px 20px 4px 0;font:700 13px Arial,sans-serif;color:#4C5566">Guest</td><td style="padding:4px 0;font:15px Arial,sans-serif;color:#161B26">${esc(a.guestName)}</td></tr>
      <tr><td style="padding:4px 20px 4px 0;font:700 13px Arial,sans-serif;color:#4C5566">Email</td><td style="padding:4px 0;font:15px Arial,sans-serif;color:#161B26"><a href="mailto:${esc(a.guestEmail)}" style="color:#0A6DC9">${esc(a.guestEmail)}</a></td></tr>
      ${a.guestPhone ? `<tr><td style="padding:4px 20px 4px 0;font:700 13px Arial,sans-serif;color:#4C5566">Phone</td><td style="padding:4px 0;font:15px Arial,sans-serif;color:#161B26">${esc(a.guestPhone)}</td></tr>` : ''}
      ${a.guestCompany ? `<tr><td style="padding:4px 20px 4px 0;font:700 13px Arial,sans-serif;color:#4C5566">Company</td><td style="padding:4px 0;font:15px Arial,sans-serif;color:#161B26">${esc(a.guestCompany)}</td></tr>` : ''}
    </table>
    ${a.guestNotes ? `<div style="margin-top:18px;padding:16px 18px;background:#FBFAF7;border-left:3px solid #2297F9;font:15px/1.55 Arial,sans-serif;color:#161B26;white-space:pre-wrap">${esc(a.guestNotes)}</div>` : ''}
    <div style="margin-top:22px;font:14px Arial,sans-serif;color:#4C5566">A calendar invitation is attached. Reply to this email to reach ${esc(a.guestName.split(' ')[0])} directly.</div>`,
    `New booking from ${a.guestName}`);
  const text = [
    `New booking: ${a.pageTitle}`, '',
    `${t.date}`, `${t.time} · ${a.durationMin} minutes · ${a.mode === 'virtual' ? 'Virtual' : 'In person'}`,
    '', `Guest: ${a.guestName} <${a.guestEmail}>`,
    a.guestPhone ? `Phone: ${a.guestPhone}` : '',
    a.guestCompany ? `Company: ${a.guestCompany}` : '',
    a.guestNotes ? `\nNotes: ${a.guestNotes}` : '',
    '', 'Calendar invitation attached (.ics).'
  ].filter(Boolean).join('\n');
  return { subject: `New booking · ${t.date} · ${t.time}`, html, text };
}

export async function sendEmail({ to, subject, html, text, replyTo, key, attachment }, env = process.env, fetchImpl = fetch) {
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) return 'Resend is not configured (RESEND_API_KEY / FROM_EMAIL).';
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({
        from: env.FROM_EMAIL, to: [to], subject, html, text,
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(attachment ? { attachments: [attachment] } : {})
      })
    });
    if (res.ok || res.status === 409) return null;
    return `Resend ${res.status}: ${(await res.text()).slice(0, 300)}`;
  } catch (e) {
    return `Resend request failed: ${e.message}`;
  }
}
