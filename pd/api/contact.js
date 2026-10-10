/* POST /api/contact — the "Tell us about it" design request form on wearepartydesigners.com.
 *
 * Sends two emails through Resend:
 *   1. a notification to NOTIFY_TO, with Reply-To set to the visitor so you can answer directly;
 *   2. a short acknowledgment to the visitor (Reply-To set to you, so they can send files back).
 *
 * If Resend isn't configured yet (or is down), the request is still written to the
 * Vercel runtime logs so a lead is never silently lost.
 *
 * Env (Vercel → jtg-pd → Settings → Environment Variables):
 *   RESEND_API_KEY  re_...                                                    required to send
 *   FROM_EMAIL      "The Party Designers <hello@wearepartydesigners.com>"     must be on a domain verified in Resend
 *   NOTIFY_TO       you@yourinbox.com                                         where requests go (comma-separate for several)
 *   SITE_URL        https://wearepartydesigners.com                           optional; used for the logo in emails
 *   ALLOWED_ORIGINS https://www.wearepartydesigners.com                       optional; extra origins allowed to post
 */

const NEEDS = [
  'Flyers and promo graphics',
  'Teasers',
  'Invitations',
  'Banners and backdrops',
  'Wall signs and displays',
  'Slideshows',
  'Handouts',
  'Event website',
  'Not sure yet'
];

const TURNAROUND = {
  'same-day': 'Same-day',
  'next-day': 'Next-day',
  flexible: 'Has a few days'
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const hits = new Map();

const BLUSH = '#E0C2C2';
const POWDER = '#F5EBEB';
const INK = '#000000';
const SMOKE = '#4D4747';

const clean = (v, max) => (typeof v === 'string' ? v.replace(CTRL, '').trim().slice(0, max) : '');
const oneLine = (s) => s.replace(/[\r\n]+/g, ' ');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function originAllowed(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  let host = '';
  try { host = new URL(origin).host; } catch { return false; }
  if (host === (request.headers.get('host') || new URL(request.url).host)) return true;
  return (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
}

function clientIp(request) {
  return (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    request.headers.get('x-real-ip') || 'unknown';
}

// Best-effort, per-instance limit. Enough to blunt a script hammering the form.
function rateLimited(key, max, windowMs, now = Date.now()) {
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

function prettyDate(iso) {
  if (!DATE_RE.test(iso)) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

async function sendEmail({ to, subject, html, text, replyTo, key }) {
  const { RESEND_API_KEY, FROM_EMAIL } = process.env;
  if (!RESEND_API_KEY || !FROM_EMAIL) return 'Resend is not configured (RESEND_API_KEY / FROM_EMAIL).';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': key
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: Array.isArray(to) ? to : [to],
        subject, html, text,
        ...(replyTo ? { reply_to: replyTo } : {})
      })
    });
    if (res.ok || res.status === 409) return null;
    return `Resend ${res.status}: ${(await res.text()).slice(0, 300)}`;
  } catch (e) {
    return `Resend request failed: ${e.message}`;
  }
}

const shell = (siteUrl, inner) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:${POWDER}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${POWDER}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:${BLUSH};padding:24px 28px"><img src="${esc(siteUrl)}/assets/wordmark.png" alt="The Party Designers" width="150" style="display:block;width:150px;height:auto;border:0"></td></tr>
<tr><td style="padding:28px">${inner}</td></tr>
</table></td></tr></table></body></html>`;

function row(label, value, href) {
  if (!value) return '';
  const v = href ? `<a href="${esc(href)}" style="color:${INK}">${esc(value)}</a>` : esc(value);
  return `<tr><td style="padding:5px 20px 5px 0;font:700 13px Arial,sans-serif;color:${SMOKE};vertical-align:top;white-space:nowrap">${esc(label)}</td><td style="padding:5px 0;font:15px Arial,sans-serif;color:${INK}">${v}</td></tr>`;
}

function notificationEmail(a) {
  const rush = a.turnaround === 'same-day' ? 'Same-day request' : a.turnaround === 'next-day' ? 'Next-day request' : 'New request';
  const inner = `
  <div style="font:800 22px/1.3 Arial,sans-serif;color:${INK};margin:0 0 6px">${esc(rush)} from ${esc(a.name)}</div>
  ${a.eventName || a.eventDateText ? `<div style="font:15px/1.55 Arial,sans-serif;color:${SMOKE}">${esc([a.eventName, a.eventDateText].filter(Boolean).join(', '))}</div>` : ''}
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px">
    ${row('Name', a.name)}
    ${row('Email', a.email, `mailto:${a.email}`)}
    ${row('Phone', a.phone, a.phone ? `tel:${a.phone.replace(/[^\d+]/g, '')}` : '')}
    ${row('Venue / org', a.company)}
    ${row('Event', a.eventName)}
    ${row('Event date', a.eventDateText)}
    ${row('Turnaround', a.turnaroundText)}
    ${row('Needs', a.needs.join(', '))}
  </table>
  <div style="margin-top:18px;padding:16px 18px;background:${POWDER};border-left:3px solid ${BLUSH};font:15px/1.55 Arial,sans-serif;color:${INK};white-space:pre-wrap">${esc(a.message)}</div>
  <div style="margin-top:22px;font:13px/1.5 Arial,sans-serif;color:${SMOKE}">Reply to this email to reach ${esc(a.firstName)} directly.${a.page ? `<br>Sent from ${esc(a.page)}` : ''}</div>`;

  const text = [
    `${rush} from ${a.name}`, '',
    `Email: ${a.email}`,
    a.phone && `Phone: ${a.phone}`,
    a.company && `Venue / org: ${a.company}`,
    a.eventName && `Event: ${a.eventName}`,
    a.eventDateText && `Event date: ${a.eventDateText}`,
    a.turnaroundText && `Turnaround: ${a.turnaroundText}`,
    a.needs.length && `Needs: ${a.needs.join(', ')}`, '',
    a.message, '',
    a.page && `Sent from ${a.page}`
  ].filter((l) => typeof l === 'string').join('\n');

  const subjectBits = [a.turnaroundText && a.turnaround !== 'flexible' ? `[${a.turnaroundText}]` : '', `Design request: ${a.name}`];
  if (a.eventName) subjectBits.push(`(${a.eventName})`);
  return { subject: oneLine(subjectBits.filter(Boolean).join(' ')), html: shell(a.siteUrl, inner), text };
}

function ackEmail(a) {
  const summary = [a.eventName, a.eventDateText].filter(Boolean).join(', ');
  const inner = `
  <div style="font:800 22px/1.3 Arial,sans-serif;color:${INK};margin:0 0 10px">Thanks, ${esc(a.firstName)}. We got your request.</div>
  <div style="font:15px/1.6 Arial,sans-serif;color:${SMOKE}">We’ll reply to this address to confirm the details and the turnaround.${summary ? ` Request: <strong style="color:${INK}">${esc(summary)}</strong>.` : ''}</div>
  <div style="margin-top:20px;padding:16px 18px;background:${POWDER};border-left:3px solid ${BLUSH};font:15px/1.55 Arial,sans-serif;color:${INK};white-space:pre-wrap">${esc(a.message)}</div>
  <div style="margin-top:22px;font:14px/1.6 Arial,sans-serif;color:${SMOKE}">Have logos, photos or a lineup? Reply to this email and attach them.</div>`;
  const text = `Thanks, ${a.firstName}. We got your request.\n\nWe’ll reply to this address to confirm the details and the turnaround.${summary ? `\nRequest: ${summary}` : ''}\n\nYour message:\n${a.message}\n\nHave logos, photos or a lineup? Reply to this email and attach them.`;
  return { subject: 'We got your request — The Party Designers', html: shell(a.siteUrl, inner), text };
}

async function handler(request) {
  if (request.method !== 'POST') return json(405, { error: 'Use POST to send a request.' });
  if (!originAllowed(request)) return json(403, { error: 'This form only accepts requests from wearepartydesigners.com.' });
  if (rateLimited(`contact:${clientIp(request)}`, 5, 10 * 60_000)) {
    return json(429, { error: 'Too many requests from this network. Wait a few minutes and try again.' });
  }

  let body;
  try {
    const raw = await request.text();
    if (raw.length > 20000) return json(413, { error: 'That message is too long. Shorten it and try again.' });
    body = JSON.parse(raw || '{}');
  } catch {
    return json(400, { error: 'The form data couldn’t be read. Refresh the page and try again.' });
  }
  if (!body || typeof body !== 'object') return json(400, { error: 'The form data couldn’t be read.' });

  // Honeypot: bots fill every field. Pretend it worked.
  if (typeof body.website === 'string' && body.website.trim()) return json(200, { ok: true });

  const name = oneLine(clean(body.name, 120));
  const email = clean(body.email, 200).toLowerCase();
  const phone = oneLine(clean(body.phone, 40));
  const company = oneLine(clean(body.company, 160));
  const eventName = oneLine(clean(body.eventName, 160));
  const eventDate = clean(body.eventDate, 10);
  const message = clean(body.message, 4000);
  const page = clean(body.page, 300);
  const needs = Array.isArray(body.needs) ? [...new Set(body.needs.filter((n) => NEEDS.includes(n)))] : [];
  const turnaround = Object.prototype.hasOwnProperty.call(TURNAROUND, body.turnaround) ? body.turnaround : '';

  if (!name) return json(400, { error: 'Add your name so we know who to reply to.' });
  if (!EMAIL_RE.test(email)) return json(400, { error: 'Check your email address. We reply by email.' });
  if (!message) return json(400, { error: 'Tell us a little about the event and what you need.' });

  const a = {
    siteUrl: (process.env.SITE_URL || 'https://wearepartydesigners.com').replace(/\/$/, ''),
    name, firstName: name.split(' ')[0], email, phone, company, eventName,
    eventDate, eventDateText: prettyDate(eventDate),
    needs, turnaround, turnaroundText: TURNAROUND[turnaround] || '',
    message, page
  };

  const notifyTo = (process.env.NOTIFY_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  if (!notifyTo.length || !process.env.RESEND_API_KEY || !process.env.FROM_EMAIL) {
    console.error('contact: email not configured; request follows', JSON.stringify({ id, ...a, siteUrl: undefined }));
    return json(503, { error: 'The request form isn’t connected yet. Please try again soon.' });
  }

  const teamErr = await sendEmail({ to: notifyTo, ...notificationEmail(a), replyTo: email, key: `pd-contact-${id}-team` });
  if (teamErr) {
    console.error('contact: notification failed', teamErr, JSON.stringify({ id, ...a, siteUrl: undefined }));
    return json(502, { error: 'The request didn’t send. Try again in a moment.' });
  }

  // The acknowledgment is a courtesy; the request already reached the team.
  const ackErr = await sendEmail({ to: email, ...ackEmail(a), replyTo: notifyTo[0], key: `pd-contact-${id}-ack` });
  if (ackErr) console.error('contact: acknowledgment failed', id, ackErr);

  return json(200, { ok: true });
}

export default { fetch: handler };
