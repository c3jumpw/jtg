/* POST /api/subscribe — "Get updates" sign-ups from JTG sites (first used by the Fortune 5 CEO
 * coming-soon page on fortune5ceo.com, which posts here cross-site with `site: "f5-ceo"`).
 *
 * Sends two emails through Resend, using the same env as api/contact.js:
 *   1. a sign-up notice to NOTIFY_TO (Reply-To = the subscriber), so the list lives in your inbox
 *      until a mailing-list tool is connected;
 *   2. a confirmation to the subscriber.
 * Every sign-up is also written to the Vercel runtime logs as one `subscribe:` line.
 */

import {
  EMAIL_RE, clean, oneLine, esc, json, preflight, originAllowed, clientIp, rateLimited,
  readJson, siteFor, notifyList, mailConfigured, fromAs, sendEmail, siteUrl, shell, row, newId
} from '../lib/mail.js';

// What a subscriber can ask to hear about. Anything else sent is dropped.
const INTERESTS = {
  stories: 'Founder stories',
  leadership: 'Leadership and strategy',
  community: 'Community access',
  'share-story': 'Sharing their own story'
};

function teamEmail(a) {
  const inner = `
  <div style="font:800 22px/1.3 Arial,sans-serif;color:#16185A;margin:0 0 6px">New ${esc(a.list)} updates sign-up</div>
  <div style="font:15px/1.55 Arial,sans-serif;color:#4B5280">${esc(a.email)} wants updates${a.interests.length ? '' : '.'}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px">
    ${row('Email', a.email, `mailto:${a.email}`)}
    ${row('Name', a.name)}
    ${row('Interested in', a.interests.join(', '))}
  </table>
  ${a.wantsToShare ? `<div style="margin-top:18px;font:15px/1.55 Arial,sans-serif;color:#16185A"><strong>They’d like to share their story.</strong> Reply to this email to follow up.</div>` : ''}
  <div style="margin-top:22px;font:13px/1.5 Arial,sans-serif;color:#4B5280">${a.page ? `Signed up on ${esc(a.page)}` : ''}</div>`;
  const text = [
    `New ${a.list} updates sign-up`, '',
    `Email: ${a.email}`,
    a.name ? `Name: ${a.name}` : null,
    a.interests.length ? `Interested in: ${a.interests.join(', ')}` : null,
    a.wantsToShare ? '\nThey’d like to share their story. Reply to this email to follow up.' : null,
    a.page ? `\nSigned up on ${a.page}` : null
  ].filter((l) => l !== null).join('\n');
  return { subject: oneLine(`[${a.list}] New updates sign-up: ${a.email}`), html: shell(a.siteUrl, inner), text };
}

function confirmEmail(a) {
  const hello = a.firstName ? `Thanks, ${esc(a.firstName)}.` : 'Thanks for signing up.';
  const share = a.wantsToShare
    ? `<div style="margin-top:16px;font:15px/1.6 Arial,sans-serif;color:#16185A">You said you’d like to share your story. Reply to this email with a few lines about you and what you’re building, and the team will be in touch.</div>`
    : '';
  const inner = `
  <div style="font:800 22px/1.3 Arial,sans-serif;color:#16185A;margin:0 0 10px">${hello} You’re on the list.</div>
  <div style="font:15px/1.6 Arial,sans-serif;color:#4B5280">We’ll email you when ${esc(a.list)} launches, with the first stories and how to join the community.</div>
  ${share}`;
  const footer = `${esc(a.list)} is part of Jump Tech Group · <a href="${esc(a.siteLink)}" style="color:#2E3192">${esc(a.siteLink.replace(/^https:\/\//, ''))}</a><br>Don’t want these emails? Reply “unsubscribe” and we’ll take you off the list.`;
  const text = `${a.firstName ? `Thanks, ${a.firstName}.` : 'Thanks for signing up.'} You’re on the list.\n\nWe’ll email you when ${a.list} launches, with the first stories and how to join the community.${a.wantsToShare ? '\n\nYou said you’d like to share your story. Reply to this email with a few lines about you and what you’re building, and the team will be in touch.' : ''}\n\n${a.list} is part of Jump Tech Group · ${a.siteLink}\nDon’t want these emails? Reply “unsubscribe” and we’ll take you off the list.`;
  return { subject: `You’re on the list — ${a.list}`, html: shell(a.siteUrl, inner, footer), text, from: fromAs(a.list) };
}

async function handler(request) {
  if (request.method === 'OPTIONS') return preflight(request);
  if (request.method !== 'POST') return json(request, 405, { error: 'Use POST to sign up.' });
  if (!originAllowed(request)) return json(request, 403, { error: 'This form only accepts sign-ups from Jump Tech Group sites.' });
  if (rateLimited(`subscribe:${clientIp(request)}`, 5, 10 * 60_000)) {
    return json(request, 429, { error: 'Too many sign-ups from this network. Wait a few minutes and try again.' });
  }

  const { body, error } = await readJson(request, 4000);
  if (error) return error;
  if (typeof body.website === 'string' && body.website.trim()) return json(request, 200, { ok: true });

  const site = siteFor(body);
  const email = clean(body.email, 200).toLowerCase();
  const name = oneLine(clean(body.name, 120));
  const keys = Array.isArray(body.interests) ? body.interests.filter((k) => typeof k === 'string' && INTERESTS[k]) : [];
  const interests = [...new Set(keys)].map((k) => INTERESTS[k]);
  if (!EMAIL_RE.test(email)) return json(request, 400, { error: 'Check your email address.' });

  const a = {
    siteUrl: siteUrl(),
    list: site ? site.name : 'Jump Tech Group',
    siteLink: site ? site.url : siteUrl(),
    email, name, firstName: name.split(' ')[0], interests,
    wantsToShare: keys.includes('share-story'),
    page: clean(body.page, 300)
  };
  const id = newId();
  console.log('subscribe:', JSON.stringify({ id, list: a.list, email, name, interests, page: a.page }));

  if (!mailConfigured()) {
    console.error('subscribe: email not configured; sign-up kept in the log line above', id);
    return json(request, 503, { error: 'Sign-ups aren’t connected yet. Please try again soon.' });
  }

  const notifyTo = notifyList();
  const teamErr = await sendEmail({ to: notifyTo, ...teamEmail(a), replyTo: email, key: `jtg-subscribe-${id}-team` });
  if (teamErr) {
    console.error('subscribe: notification failed', id, teamErr);
    return json(request, 502, { error: 'That didn’t go through. Try again in a moment.' });
  }
  const confirmErr = await sendEmail({ to: email, ...confirmEmail(a), replyTo: notifyTo[0], key: `jtg-subscribe-${id}-confirm` });
  if (confirmErr) console.error('subscribe: confirmation failed', id, confirmErr);

  return json(request, 200, { ok: true });
}

export default { fetch: handler };
