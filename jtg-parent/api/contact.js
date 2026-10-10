/* POST /api/contact — the "Tell us about your business" form on j-tgroup.com.
 *
 * Sends two emails through Resend:
 *   1. a notification to NOTIFY_TO, with Reply-To set to the visitor so you can answer directly;
 *   2. a short acknowledgment to the visitor.
 *
 * If Resend isn't configured yet (or is down), the inquiry is still written to the
 * Vercel runtime logs so a lead is never silently lost.
 *
 * Env (Vercel → Project → Settings → Environment Variables):
 *   RESEND_API_KEY  re_...                                  required to send
 *   FROM_EMAIL      "Jump Tech Group <hello@j-tgroup.com>"   must be on a domain verified in Resend
 *   NOTIFY_TO       you@yourinbox.com                        where inquiries go (comma-separate for several)
 *   SITE_URL        https://j-tgroup.com                     optional; used for the logo in emails
 *   ALLOWED_ORIGINS https://www.j-tgroup.com                 optional; extra origins allowed to post
 */

const BRANCHES = {
  help: 'Help me choose',
  f5: 'Fortune 5 Agency',
  bms: 'Build My Start-Up',
  blk: 'Blanket Label',
  bb: 'Bar Boost',
  pd: 'Party Designers',
  blm: 'Blloom',
  acad: 'Acad Branding',
  sd: 'Seeder',
  bc: 'BC Agency',
  mbc: 'Media BC',
  jw: 'Jumpwebs',
  f5ceo: 'Fortune 5 CEO'
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const hits = new Map();

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

const shell = (siteUrl, inner) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#EEF3FA">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF3FA"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#16185A;padding:22px 28px"><img src="${esc(siteUrl)}/assets/logo-light.png" alt="Jump Tech Group" height="36" style="display:block;height:36px;width:auto;border:0"></td></tr>
<tr><td style="padding:28px">${inner}</td></tr>
</table></td></tr></table></body></html>`;

function row(label, value, href) {
  if (!value) return '';
  const v = href ? `<a href="${esc(href)}" style="color:#2E3192">${esc(value)}</a>` : esc(value);
  return `<tr><td style="padding:5px 20px 5px 0;font:700 13px Arial,sans-serif;color:#4B5280;vertical-align:top;white-space:nowrap">${esc(label)}</td><td style="padding:5px 0;font:15px Arial,sans-serif;color:#16185A">${v}</td></tr>`;
}

function notificationEmail(a) {
  const inner = `
  <div style="font:800 22px/1.3 Arial,sans-serif;color:#16185A;margin:0 0 6px">New inquiry from ${esc(a.name)}</div>
  <div style="font:15px/1.55 Arial,sans-serif;color:#4B5280">Team requested: <strong style="color:#2E3192">${esc(a.branchName)}</strong></div>
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px">
    ${row('Name', a.name)}
    ${row('Email', a.email, `mailto:${a.email}`)}
    ${row('Phone', a.phone, a.phone ? `tel:${a.phone.replace(/[^\d+]/g, '')}` : '')}
    ${row('Business', a.company)}
  </table>
  <div style="margin-top:18px;padding:16px 18px;background:#EEF3FA;border-left:3px solid #00AEEF;font:15px/1.55 Arial,sans-serif;color:#16185A;white-space:pre-wrap">${esc(a.message)}</div>
  <div style="margin-top:22px;font:13px/1.5 Arial,sans-serif;color:#4B5280">Reply to this email to reach ${esc(a.firstName)} directly.${a.page ? `<br>Sent from ${esc(a.page)}` : ''}</div>`;

  const text = [
    `New inquiry from ${a.name}`,
    `Team requested: ${a.branchName}`, '',
    `Email: ${a.email}`,
    a.phone && `Phone: ${a.phone}`,
    a.company && `Business: ${a.company}`, '',
    a.message, '',
    a.page && `Sent from ${a.page}`
  ].filter((l) => l !== false && l !== null && l !== undefined).join('\n');

  return {
    subject: oneLine(`New inquiry: ${a.name}${a.company ? ` (${a.company})` : ''}${a.branch === 'help' ? ', needs a team match' : ` for ${a.branchName}`}`),
    html: shell(a.siteUrl, inner),
    text
  };
}

function ackEmail(a) {
  const teamText = a.branch === 'help'
    ? 'We’ll read it and point you to the team that fits.'
    : `We’ll pass it to the ${a.branchName} team.`;
  const team = esc(teamText);
  const inner = `
  <div style="font:800 22px/1.3 Arial,sans-serif;color:#16185A;margin:0 0 10px">Thanks, ${esc(a.firstName)}. We got your message.</div>
  <div style="font:15px/1.6 Arial,sans-serif;color:#4B5280">${team} Someone will reply to this address once they’ve read it.</div>
  <div style="margin-top:20px;padding:16px 18px;background:#EEF3FA;border-left:3px solid #00AEEF;font:15px/1.55 Arial,sans-serif;color:#16185A;white-space:pre-wrap">${esc(a.message)}</div>
  <div style="margin-top:22px;font:14px Arial,sans-serif;color:#4B5280">If anything changes, just reply to this email.</div>`;
  const text = `Thanks, ${a.firstName}. We got your message.\n\n${teamText} Someone will reply to this address once they’ve read it.\n\nYour message:\n${a.message}\n\nIf anything changes, just reply to this email.`;
  return { subject: 'We got your message — Jump Tech Group', html: shell(a.siteUrl, inner), text };
}

async function handler(request) {
  if (request.method !== 'POST') return json(405, { error: 'Use POST to send a message.' });
  if (!originAllowed(request)) return json(403, { error: 'This form only accepts messages from j-tgroup.com.' });
  if (rateLimited(`contact:${clientIp(request)}`, 5, 10 * 60_000)) {
    return json(429, { error: 'Too many messages from this network. Wait a few minutes and try again.' });
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
  const message = clean(body.message, 4000);
  const branch = Object.prototype.hasOwnProperty.call(BRANCHES, body.branch) ? body.branch : 'help';
  const page = clean(body.page, 300);

  if (!name) return json(400, { error: 'Add your name so we know who to reply to.' });
  if (!EMAIL_RE.test(email)) return json(400, { error: 'Check your email address. We reply by email.' });
  if (!message) return json(400, { error: 'Add a short message about your business.' });

  const a = {
    siteUrl: (process.env.SITE_URL || 'https://j-tgroup.com').replace(/\/$/, ''),
    name, firstName: name.split(' ')[0], email, phone, company, message, page,
    branch, branchName: BRANCHES[branch]
  };

  const notifyTo = (process.env.NOTIFY_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  if (!notifyTo.length || !process.env.RESEND_API_KEY || !process.env.FROM_EMAIL) {
    console.error('contact: email not configured; inquiry follows', JSON.stringify({ id, ...a, siteUrl: undefined }));
    return json(503, { error: 'The contact form isn’t connected yet. Please try again soon.' });
  }

  const teamErr = await sendEmail({ to: notifyTo, ...notificationEmail(a), replyTo: email, key: `jtg-contact-${id}-team` });
  if (teamErr) {
    console.error('contact: notification failed', teamErr, JSON.stringify({ id, ...a, siteUrl: undefined }));
    return json(502, { error: 'The message didn’t send. Try again in a moment.' });
  }

  // The acknowledgment is a courtesy; the inquiry already reached the team.
  const ackErr = await sendEmail({ to: email, ...ackEmail(a), replyTo: notifyTo[0], key: `jtg-contact-${id}-ack` });
  if (ackErr) console.error('contact: acknowledgment failed', id, ackErr);

  return json(200, { ok: true });
}

export default { fetch: handler };
