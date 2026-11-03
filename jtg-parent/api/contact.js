/* POST /api/contact — the contact form on j-tgroup.com and on every JTG branch site
 * (acad.j-tgroup.com, barboost.j-tgroup.com, …). Branch sites post here cross-site and send
 * `site: "<folder name>"`, so the email says which site it came from.
 *
 * Sends two emails through Resend:
 *   1. a notification to NOTIFY_TO, with Reply-To set to the visitor so you can answer directly;
 *   2. a short acknowledgment to the visitor, from the branch's name when it came from a branch site.
 *
 * If Resend isn't configured yet (or is down), the inquiry is still written to the
 * Vercel runtime logs so a lead is never silently lost.
 *
 * Env (Vercel → jtg-jtg-parent → Settings → Environment Variables):
 *   RESEND_API_KEY  re_...                                  required to send
 *   FROM_EMAIL      "Jump Tech Group <support@j-tgroup.com>" must be on a domain verified in Resend
 *   NOTIFY_TO       you@yourinbox.com                        where inquiries go (comma-separate for several)
 *   SITE_URL        https://j-tgroup.com                     optional; used for the logo in emails
 *   ALLOWED_ORIGINS https://example.com                      optional; extra origins allowed to post
 *                                                            (j-tgroup.com, *.j-tgroup.com and fortune5ceo.com always are)
 */

import {
  BRANCHES, EMAIL_RE, clean, oneLine, esc, json, preflight, originAllowed, clientIp, rateLimited,
  readJson, siteFor, notifyList, mailConfigured, fromAs, sendEmail, siteUrl, shell, row, quote, newId
} from '../lib/mail.js';

function notificationEmail(a) {
  const via = a.site ? `<br>Came in through the <strong style="color:#2E3192">${esc(a.site.name)}</strong> site` : '';
  const inner = `
  <div style="font:800 22px/1.3 Arial,sans-serif;color:#16185A;margin:0 0 6px">New inquiry from ${esc(a.name)}</div>
  <div style="font:15px/1.55 Arial,sans-serif;color:#4B5280">Team requested: <strong style="color:#2E3192">${esc(a.branchName)}</strong>${via}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px">
    ${row('Name', a.name)}
    ${row('Email', a.email, `mailto:${a.email}`)}
    ${row('Phone', a.phone, a.phone ? `tel:${a.phone.replace(/[^\d+]/g, '')}` : '')}
    ${row('Business', a.company)}
    ${row('Interested in', a.interest)}
  </table>
  ${quote(a.message)}
  <div style="margin-top:22px;font:13px/1.5 Arial,sans-serif;color:#4B5280">Reply to this email to reach ${esc(a.firstName)} directly.${a.page ? `<br>Sent from ${esc(a.page)}` : ''}</div>`;

  // null = leave the line out; '' = blank line.
  const text = [
    `New inquiry from ${a.name}`,
    `Team requested: ${a.branchName}`,
    a.site ? `Came in through the ${a.site.name} site` : null, '',
    `Email: ${a.email}`,
    a.phone ? `Phone: ${a.phone}` : null,
    a.company ? `Business: ${a.company}` : null,
    a.interest ? `Interested in: ${a.interest}` : null, '',
    a.message, '',
    a.page ? `Sent from ${a.page}` : null
  ].filter((l) => l !== null).join('\n');

  const tag = a.site ? `[${a.site.name}] ` : '';
  return {
    subject: oneLine(`${tag}New inquiry: ${a.name}${a.company ? ` (${a.company})` : ''}${a.branch === 'help' ? ', needs a team match' : ` for ${a.branchName}`}`),
    html: shell(a.siteUrl, inner),
    text
  };
}

function ackEmail(a) {
  const teamText = a.branch === 'help'
    ? 'We’ll read it and point you to the team that fits.'
    : `We’ll pass it to the ${a.branchName} team.`;
  const inner = `
  <div style="font:800 22px/1.3 Arial,sans-serif;color:#16185A;margin:0 0 10px">Thanks, ${esc(a.firstName)}. We got your message.</div>
  <div style="font:15px/1.6 Arial,sans-serif;color:#4B5280">${esc(teamText)} Someone will reply to this address once they’ve read it.</div>
  ${quote(a.message)}
  <div style="margin-top:22px;font:14px Arial,sans-serif;color:#4B5280">If anything changes, just reply to this email.</div>`;
  const footer = a.site
    ? `${esc(a.site.name)} is a Jump Tech Group company · <a href="${esc(a.site.url)}" style="color:#2E3192">${esc(a.site.url.replace(/^https:\/\//, ''))}</a>`
    : '';
  const text = `Thanks, ${a.firstName}. We got your message.\n\n${teamText} Someone will reply to this address once they’ve read it.\n\nYour message:\n${a.message}\n\nIf anything changes, just reply to this email.${a.site ? `\n\n${a.site.name} is a Jump Tech Group company · ${a.site.url}` : ''}`;
  return {
    subject: `We got your message — ${a.site ? a.site.name : 'Jump Tech Group'}`,
    html: shell(a.siteUrl, inner, footer),
    text,
    from: a.site ? fromAs(a.site.name) : undefined
  };
}

async function handler(request) {
  if (request.method === 'OPTIONS') return preflight(request);
  if (request.method !== 'POST') return json(request, 405, { error: 'Use POST to send a message.' });
  if (!originAllowed(request)) return json(request, 403, { error: 'This form only accepts messages from Jump Tech Group sites.' });
  if (rateLimited(`contact:${clientIp(request)}`, 5, 10 * 60_000)) {
    return json(request, 429, { error: 'Too many messages from this network. Wait a few minutes and try again.' });
  }

  const { body, error } = await readJson(request);
  if (error) return error;

  // Honeypot: bots fill every field. Pretend it worked.
  if (typeof body.website === 'string' && body.website.trim()) return json(request, 200, { ok: true });

  const site = siteFor(body);
  const name = oneLine(clean(body.name, 120));
  const email = clean(body.email, 200).toLowerCase();
  const phone = oneLine(clean(body.phone, 40));
  const company = oneLine(clean(body.company, 160));
  const interest = oneLine(clean(body.interest, 120));
  const message = clean(body.message, 4000);
  const branch = Object.prototype.hasOwnProperty.call(BRANCHES, body.branch) ? body.branch : (site ? site.branch : 'help');
  const page = clean(body.page, 300);

  if (!name) return json(request, 400, { error: 'Add your name so we know who to reply to.' });
  if (!EMAIL_RE.test(email)) return json(request, 400, { error: 'Check your email address. We reply by email.' });
  if (!message) return json(request, 400, { error: 'Add a short message about your business.' });

  const a = {
    siteUrl: siteUrl(), site,
    name, firstName: name.split(' ')[0], email, phone, company, interest, message, page,
    branch, branchName: BRANCHES[branch]
  };

  const notifyTo = notifyList();
  const id = newId();

  if (!mailConfigured()) {
    console.error('contact: email not configured; inquiry follows', JSON.stringify({ id, ...a, siteUrl: undefined }));
    return json(request, 503, { error: 'The contact form isn’t connected yet. Please try again soon.' });
  }

  const teamErr = await sendEmail({ to: notifyTo, ...notificationEmail(a), replyTo: email, key: `jtg-contact-${id}-team` });
  if (teamErr) {
    console.error('contact: notification failed', teamErr, JSON.stringify({ id, ...a, siteUrl: undefined }));
    return json(request, 502, { error: 'The message didn’t send. Try again in a moment.' });
  }

  // The acknowledgment is a courtesy; the inquiry already reached the team.
  const ackErr = await sendEmail({ to: email, ...ackEmail(a), replyTo: notifyTo[0], key: `jtg-contact-${id}-ack` });
  if (ackErr) console.error('contact: acknowledgment failed', id, ackErr);

  return json(request, 200, { ok: true });
}

export default { fetch: handler };
