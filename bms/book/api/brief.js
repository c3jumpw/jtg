import crypto from 'node:crypto';
import { select, insert, patch, json, clean, EMAIL_RE, readJson, rateLimited, clientIp, esc } from '../lib/core.js';
import { sendEmail } from '../lib/emails.js';

/* /api/brief — the Personal Brand Builder intake (pbb.buildmystart-up.com).
 *
 *   POST  save one session's answers, then email the team and the submitter
 *   GET   ?resume=<token>  fetch saved answers so a session can be continued
 *
 * The PBB site proxies /api/brief here, so to the browser this is same-origin.
 * It lives in the booking backend because that project already holds the
 * database and Resend keys and sends from the verified domain.
 *
 * The row is written FIRST and every email is best-effort after it. The first
 * version of this form sent email straight from the browser and stored
 * nothing, so every failure lost the brief outright. Never again. */

const PBB_URL = () => (process.env.PBB_SITE_URL || 'https://pbb.buildmystart-up.com').replace(/\/$/, '');
const TEAM = () => process.env.NOTIFY_TO || 'support@buildmystart-up.com';
const ORIGINS = ['https://pbb.buildmystart-up.com', 'https://jtg-bms-pbb.vercel.app'];

export const SESSIONS = {
  1: 'Your identity and story',
  2: 'Projects and credibility',
  3: 'Offers, voice and visual'
};

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;
const LIMITS = { answers: 150, label: 240, section: 80, value: 6000, total: 80000, name: 120 };

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(24).toString('base64url');
function newRef() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return 'PBB-' + Array.from(crypto.randomBytes(6), (b) => abc[b % abc.length]).join('');
}

function originOk(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true; // server-to-server, curl, tests
  if (ORIGINS.includes(origin)) return true;
  try { return new URL(origin).host === (request.headers.get('host') || ''); } catch { return false; }
}

/* Accepts [{ key, label, section, value }] and returns a clean map, or an error. */
export function readAnswers(list, session) {
  if (!Array.isArray(list)) return { error: 'Your answers did not come through. Please try again.' };
  if (list.length > LIMITS.answers) return { error: 'That submission is too large.' };
  const out = {}; let total = 0;
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    const key = typeof a.key === 'string' ? a.key : '';
    if (!KEY_RE.test(key)) continue;
    const value = clean(a.value, LIMITS.value);
    if (!value) continue;
    total += value.length;
    if (total > LIMITS.total) return { error: 'That submission is too large.' };
    const s = Number(a.session), order = Number(a.order);
    out[key] = {
      label: clean(a.label, LIMITS.label) || key,
      section: clean(a.section, LIMITS.section),
      session: [1, 2, 3].includes(s) ? s : session,   // the session the field sits in
      order: Number.isInteger(order) && order >= 0 && order < 10000 ? order : 9999,
      value
    };
  }
  return { answers: out };
}

function readUtm(u) {
  const out = {};
  if (u && typeof u === 'object') for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    const v = clean(u[k], 100); if (v) out[k] = v;
  }
  return out;
}

/* ---------------- emails ---------------- */

const para = (s) => esc(s).replace(/\r?\n/g, '<br>');

/* jsonb does not keep key order, so answers carry their position on the form. */
function grouped(answers) {
  const list = Object.values(answers || {}).sort((x, y) => (x.session - y.session) || ((x.order ?? 9999) - (y.order ?? 9999)));
  const by = {};
  for (const a of list) (by[a.session] ||= []).push(a);
  return by;
}

function answersHtml(answers) {
  const bySession = grouped(answers);
  return Object.keys(SESSIONS).filter((s) => bySession[s]).map((s) => {
    let lastSection = null;
    const rows = bySession[s].map((a) => {
      const head = a.section && a.section !== lastSection
        ? `<tr><td colspan="2" style="padding:14px 0 6px;font:700 11px Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#084098">${esc(a.section)}</td></tr>` : '';
      lastSection = a.section;
      return head + `<tr>
        <td style="width:38%;padding:8px 10px 8px 0;border-top:1px solid #E4E7EE;font:600 13px Arial,sans-serif;color:#4C5566;vertical-align:top">${esc(a.label)}</td>
        <td style="padding:8px 0;border-top:1px solid #E4E7EE;font:14px/1.55 Arial,sans-serif;color:#161B26;vertical-align:top">${para(a.value)}</td></tr>`;
    }).join('');
    return `<h3 style="margin:24px 0 4px;font:800 16px Arial,sans-serif;color:#161B26">Session ${s} · ${esc(SESSIONS[s])}</h3>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows}</table>`;
  }).join('');
}

function answersText(answers) {
  const bySession = grouped(answers);
  return Object.keys(SESSIONS).filter((s) => bySession[s]).map((s) =>
    `SESSION ${s}: ${SESSIONS[s].toUpperCase()}\n` + bySession[s].map((a) => `${a.label}\n  ${a.value.replace(/\n/g, '\n  ')}`).join('\n\n')
  ).join('\n\n');
}

function shell(inner) {
  return `<!doctype html><html><body style="margin:0;background:#FBFAF7">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 14px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#fff;border:1px solid #E4E7EE;border-radius:12px">
  <tr><td style="height:6px;background:#084098;border-radius:12px 12px 0 0;font-size:0">&nbsp;</td></tr>
  <tr><td style="padding:26px 28px 30px">${inner}
    <p style="margin:28px 0 0;font:12px Arial,sans-serif;color:#8B93A4">Build My Startup · Personal Brand Builder · <a href="https://buildmystart-up.com" style="color:#084098">buildmystart-up.com</a></p>
  </td></tr></table></td></tr></table></body></html>`;
}

export function teamEmail({ row, session, complete }) {
  const who = row.name || row.email;
  const subject = complete
    ? `Brand brief complete · ${who} · ${row.ref}`
    : `Brand brief · Session ${session} of 3 saved · ${who} · ${row.ref}`;
  const lead = complete
    ? `${esc(who)} finished all three sessions. The full brief is below.`
    : `${esc(who)} saved session ${session} of 3 (${esc(SESSIONS[session])}). Everything they've answered so far is below.`;
  const html = shell(`
    <p style="margin:0 0 6px;font:700 11px Arial,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:#966608">Personal Brand Builder · ${esc(row.ref)}</p>
    <h2 style="margin:0 0 10px;font:800 22px Arial,sans-serif;color:#161B26">${complete ? 'Brand brief complete' : `Session ${session} of 3 saved`}</h2>
    <p style="margin:0 0 16px;font:15px/1.55 Arial,sans-serif;color:#4C5566">${lead}</p>
    <p style="margin:0;font:14px Arial,sans-serif;color:#161B26"><strong>${esc(row.name || '')}</strong> · <a href="mailto:${esc(row.email)}" style="color:#084098">${esc(row.email)}</a></p>
    ${answersHtml(row.answers)}
    <p style="margin:22px 0 0;font:13px Arial,sans-serif;color:#4C5566">Reply to this email to answer ${esc(row.name || 'them')} directly.</p>`);
  const text = `${complete ? 'Brand brief complete' : `Session ${session} of 3 saved`} · ${row.ref}\n${row.name || ''} <${row.email}>\n\n${answersText(row.answers)}`;
  return { subject, html, text };
}

export function submitterEmail({ row, session, complete, resumeUrl }) {
  const first = (row.name || '').split(/\s+/)[0] || 'there';
  const subject = complete
    ? 'Your Personal Brand Kickoff brief is in'
    : `Session ${session} of 3 saved: continue your brand brief when you're ready`;
  const next = complete ? '' : `
    <p style="margin:0 0 18px;font:15px/1.6 Arial,sans-serif;color:#4C5566">Session ${session + 1} is <strong>${esc(SESSIONS[session + 1])}</strong>. Your answers so far are saved, so pick it up whenever suits you, on any device.</p>
    <p style="margin:0 0 8px"><a href="${esc(resumeUrl)}" style="display:inline-block;background:#084098;color:#fff;font:700 15px Arial,sans-serif;text-decoration:none;padding:13px 22px;border-radius:9px">Continue to Session ${session + 1} &rarr;</a></p>
    <p style="margin:0 0 4px;font:12px Arial,sans-serif;color:#8B93A4">This link is yours alone, so keep it private. If the button doesn't work, paste this into your browser:<br><a href="${esc(resumeUrl)}" style="color:#084098;word-break:break-all">${esc(resumeUrl)}</a></p>`;
  const html = shell(`
    <h2 style="margin:0 0 10px;font:800 22px Arial,sans-serif;color:#161B26">${complete ? `Thank you, ${esc(first)}. Your brief is in.` : `Session ${session} saved, ${esc(first)}.`}</h2>
    <p style="margin:0 0 16px;font:15px/1.6 Arial,sans-serif;color:#4C5566">${complete
      ? 'Our team now has your full brief. We\'ll use it to shape your outline: your positioning, your page and the foundation for your content. Expect to hear from us within 1 to 2 business days.'
      : 'Thanks for your answers. Our team has a copy, and so do you, below.'}</p>
    ${next}
    <p style="margin:18px 0 0;font:13px Arial,sans-serif;color:#4C5566">Reference: <strong>${esc(row.ref)}</strong></p>
    <hr style="border:0;border-top:1px solid #E4E7EE;margin:24px 0 4px">
    <p style="margin:0;font:700 11px Arial,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:#966608">Your answers so far</p>
    ${answersHtml(row.answers)}`);
  const text = [
    complete ? `Thank you, ${first}. Your brief is in. We'll be in touch within 1 to 2 business days.` : `Session ${session} saved, ${first}.`,
    complete ? '' : `Continue to Session ${session + 1} (${SESSIONS[session + 1]}): ${resumeUrl}`,
    `Reference: ${row.ref}`, '', 'YOUR ANSWERS SO FAR', '', answersText(row.answers)
  ].filter((l) => l !== null).join('\n');
  return { subject, html, text };
}

/* ---------------- handlers ---------------- */

async function findByToken(token) {
  if (!TOKEN_RE.test(token || '')) return null;
  const rows = await select('booking', 'brand_briefs', `select=*&resume_token_hash=eq.${sha256(token)}&limit=1`);
  return (rows && rows[0]) || null;
}

async function resume(request) {
  if (rateLimited(`brief-get:${clientIp(request)}`, 120, 3600000)) return json(429, { error: 'Too many requests. Please wait a few minutes.' });
  const token = new URL(request.url).searchParams.get('resume') || '';
  let row;
  try { row = await findByToken(token); } catch (e) { console.error('brief resume lookup failed', e.message); return json(503, { error: 'We couldn\'t load your saved answers just now. Please try again in a moment.' }); }
  if (!row) return json(404, { error: 'That link didn\'t match a saved brief. It may have been copied incompletely; try the button in your email again.' });
  const values = Object.fromEntries(Object.entries(row.answers || {}).map(([k, a]) => [k, a.value]));
  const done = row.sessions_done || [];
  const nextSession = [1, 2, 3].find((s) => !done.includes(s)) || 3;
  return json(200, { ok: true, ref: row.ref, name: row.name, email: row.email, answers: values, sessionsDone: done, nextSession, complete: row.status === 'complete' });
}

/* Visitors arrive through the PBB site's proxy rewrite, so many may share one
 * forwarded address. The limits are generous for that reason; the honeypot and
 * size caps do most of the filtering. */
async function save(request) {
  if (rateLimited(`brief-post:${clientIp(request)}`, 60, 3600000)) return json(429, { error: 'Too many submissions from this network. Please wait a little and try again.' });
  const { body, error } = await readJson(request, 200000);
  if (error) return error;
  if (typeof body.hp === 'string' && body.hp.trim()) return json(200, { ok: true }); // bot

  const session = Number(body.session);
  if (![1, 2, 3].includes(session)) return json(400, { error: 'That session wasn\'t recognised.' });
  const email = clean(body.email, 200).toLowerCase();
  if (!EMAIL_RE.test(email)) return json(400, { error: 'Please check your email address.' });
  const name = clean(body.name, LIMITS.name);
  const { answers, error: aerr } = readAnswers(body.answers, session);
  if (aerr) return json(400, { error: aerr });

  // Continue an existing brief if the token matches; otherwise start a new one.
  let row = null, token = typeof body.token === 'string' ? body.token : '';
  try { row = token ? await findByToken(token) : null; }
  catch (e) { console.error('brief lookup failed', e.message); return json(503, { error: 'We couldn\'t save that just now. Nothing was lost on your side; please try again.' }); }

  const now = new Date().toISOString();
  const complete = session === 3;
  try {
    if (row) {
      const merged = { ...(row.answers || {}), ...answers };
      const done = [...new Set([...(row.sessions_done || []), session])].sort();
      const out = await patch('booking', 'brand_briefs', `id=eq.${row.id}`, {
        email, name: name || row.name, answers: merged, sessions_done: done,
        status: complete ? 'complete' : row.status, completed_at: complete ? (row.completed_at || now) : row.completed_at,
        updated_at: now
      });
      row = out[0];
    } else {
      token = newToken();
      const meta = body.meta && typeof body.meta === 'object' ? body.meta : {};
      const record = {
        ref: newRef(), resume_token_hash: sha256(token), email, name: name || null, answers,
        sessions_done: [session], status: complete ? 'complete' : 'in_progress', completed_at: complete ? now : null,
        source: { referrer: clean(meta.referrer, 300), utm: readUtm(meta.utm), ua: clean(request.headers.get('user-agent'), 200) }
      };
      try { row = (await insert('booking', 'brand_briefs', record))[0]; }
      catch (e) { if (e.status === 409) { record.ref = newRef(); row = (await insert('booking', 'brand_briefs', record))[0]; } else throw e; }
    }
  } catch (e) {
    console.error('brief save failed', e.message, e.body);
    return json(503, { error: 'We couldn\'t save that just now. Nothing was lost on your side; please try again.' });
  }

  // Saved. From here on nothing may fail the request.
  const resumeUrl = `${PBB_URL()}/brief?resume=${encodeURIComponent(token)}`;
  const stamp = Date.now().toString(36);
  const [teamErr, youErr] = await Promise.all([
    sendEmail({ to: TEAM(), ...teamEmail({ row, session, complete }), replyTo: row.email, key: `pbb-${row.id}-s${session}-team-${stamp}` }),
    sendEmail({ to: row.email, ...submitterEmail({ row, session, complete, resumeUrl }), replyTo: TEAM(), key: `pbb-${row.id}-s${session}-you-${stamp}` })
  ]);
  const log = [
    { session, to: 'team', ok: !teamErr, error: teamErr || null, at: now },
    { session, to: 'submitter', ok: !youErr, error: youErr || null, at: now }
  ];
  if (teamErr || youErr) console.error('brief email issue', row.ref, teamErr || '', youErr || '');
  try { await patch('booking', 'brand_briefs', `id=eq.${row.id}`, { email_log: [...(row.email_log || []), ...log] }); }
  catch (e) { console.error('brief email_log write failed', row.ref, e.message); }

  return json(200, {
    ok: true, ref: row.ref, token, session, complete,
    emailed: { team: !teamErr, you: !youErr },
    next: complete ? null : resumeUrl
  });
}

async function handler(request) {
  if (!originOk(request)) return json(403, { error: 'Not allowed from this site.' });
  if (request.method === 'GET') return resume(request);
  if (request.method === 'POST') return save(request);
  return json(405, { error: 'Method not allowed.' });
}

export default { fetch: handler };
