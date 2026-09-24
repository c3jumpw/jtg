// Shared helpers for the three API routes. Pure functions where possible, so they are easy to test.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const MAX_BYTES = 25 * 1024 * 1024;
export const MAX_BODY_CHARS = 200000;
export const GROUPS = ['logos', 'materials'];
export const ALLOWED_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'heic', 'tif', 'tiff',
  'pdf', 'ai', 'eps', 'psd', 'indd', 'fig', 'sketch',
  'doc', 'docx', 'ppt', 'pptx', 'key', 'pages', 'xls', 'xlsx', 'csv', 'txt', 'rtf',
  'zip', 'mp4', 'mov', 'mp3', 'wav', 'otf', 'ttf', 'woff', 'woff2'
]);
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,140}$/;

/* ---------- small utilities ---------- */

export function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra }
  });
}

const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
export function clean(v, max) {
  return typeof v === 'string' ? v.replace(CTRL, '').trim().slice(0, max) : '';
}

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const hits = new Map();
// Best effort only: each warm server instance keeps its own count.
export function rateLimited(key, max, windowMs, now = Date.now()) {
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

export function clientIp(request) {
  return (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    request.headers.get('x-real-ip') || 'unknown';
}

// The site and the API share an origin, so a browser request must come from the same host
// (or from an origin listed in ALLOWED_ORIGINS). Requests with no Origin (curl, tests) pass.
export function originAllowed(request, env = process.env) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  let host = '';
  try { host = new URL(origin).host; } catch { return false; }
  if (host === (request.headers.get('host') || new URL(request.url).host)) return true;
  return (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
}

/* ---------- upload paths ---------- */

// Files live at <folder>/<group>/<name>, where folder is the random id the browser made for this visit.
export function parseUploadPath(pathname) {
  const m = /^([^/]+)\/([^/]+)\/([^/]+)$/.exec(pathname || '');
  if (!m) return null;
  const [, folder, group, name] = m;
  if (!UUID_RE.test(folder) || !GROUPS.includes(group) || !NAME_RE.test(name)) return null;
  if (name.includes('..')) return null;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (!ALLOWED_EXT.has(ext)) return null;
  return { folder, group, name };
}

/* ---------- signed download links ---------- */

const sig = (secret, pathname, exp) =>
  createHmac('sha256', secret).update(`${pathname}\n${exp}`).digest('hex');

// Links expire 7 days out, rounded to a day so a retried submission produces identical links.
export function linkExpiry(now = Date.now()) {
  return (Math.floor(now / 86400000) + 8) * 86400;
}

export function signLink(siteUrl, secret, pathname, exp) {
  const q = new URLSearchParams({ p: pathname, e: String(exp), s: sig(secret, pathname, exp) });
  return `${siteUrl}/api/file?${q}`;
}

export function verifyLink(secret, pathname, exp, given, now = Date.now()) {
  if (!secret || !pathname || !/^\d+$/.test(String(exp)) || !/^[0-9a-f]{64}$/.test(given || '')) return false;
  if (Number(exp) * 1000 < now) return false;
  const a = Buffer.from(sig(secret, pathname, exp), 'hex');
  const b = Buffer.from(given, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ---------- email ---------- */

function groupRows(rows) {
  const out = [];
  for (const r of rows) {
    let g = out.find((x) => x[0] === r.section);
    if (!g) out.push((g = [r.section, []]));
    g[1].push(r);
  }
  return out;
}

export function readRows(input) {
  if (!Array.isArray(input)) return [];
  const rows = [];
  for (const r of input.slice(0, 80)) {
    const row = { section: clean(r && r.section, 80), label: clean(r && r.label, 120), value: clean(r && r.value, 4000) };
    if (row.section && row.label && row.value) rows.push(row);
  }
  return rows;
}

const answersHtml = (rows) => groupRows(rows).map(([section, items]) =>
  `<tr><td style="padding:22px 0 6px;font:800 13px/1.3 Arial,sans-serif;color:#0A6DC9;letter-spacing:.02em">${esc(section)}</td></tr>` +
  items.map((r) =>
    `<tr><td style="padding:10px 0;border-top:1px solid #E6E9EC">` +
    `<div style="font:700 12px/1.4 Arial,sans-serif;color:#6B6D6C">${esc(r.label)}</div>` +
    `<div style="font:15px/1.55 Arial,sans-serif;color:#22262A;white-space:pre-wrap">${esc(r.value)}</div></td></tr>`
  ).join('')
).join('');

const answersText = (rows) => groupRows(rows).map(([section, items]) =>
  `${section.toUpperCase()}\n` + items.map((r) => `${r.label}: ${r.value}`).join('\n')
).join('\n\n');

function shell(siteUrl, inner, preheader) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:0;background:#F1F3F5">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F3F5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#22262A;padding:22px 28px"><img src="${esc(siteUrl)}/assets/logo-light.png" alt="Build My Startup" height="30" style="display:block;height:30px;width:auto;border:0;font:800 18px Arial,sans-serif;color:#ffffff"></td></tr>
<tr><td style="padding:28px">${inner}</td></tr>
</table></td></tr></table></body></html>`;
}

export function ownerEmail({ id, data: d, rows, files, siteUrl, confirmationSent }) {
  const name = [d.firstName, d.lastName].filter(Boolean).join(' ');
  const contact = [
    ['Name', name], ['Role', d.role], ['Business', d.businessName], ['Email', d.email], ['Phone', d.phone],
    ['Website', d.website], ['Location', d.location], ['Prefers', d.contactPref], ['Wants to start', d.timeline]
  ].filter((x) => x[1]);
  const contactHtml = contact.map(([k, v]) =>
    `<tr><td style="padding:3px 16px 3px 0;font:700 13px Arial,sans-serif;color:#6B6D6C;white-space:nowrap">${esc(k)}</td>` +
    `<td style="padding:3px 0;font:15px Arial,sans-serif;color:#22262A">${esc(v)}</td></tr>`).join('');
  const filesHtml = files.length
    ? `<tr><td style="padding:22px 0 6px;font:800 13px Arial,sans-serif;color:#0A6DC9">Files (links work for about 7 days)</td></tr>` +
      files.map((f) =>
        `<tr><td style="padding:6px 0;border-top:1px solid #E6E9EC;font:15px Arial,sans-serif">` +
        (f.url ? `<a href="${esc(f.url)}" style="color:#0A6DC9">${esc(f.name)}</a>` : `${esc(f.name)} (no link)`) +
        ` <span style="color:#6B6D6C;font-size:13px">${esc(f.group)}, ${(f.size / 1048576).toFixed(1)} MB</span></td></tr>`).join('')
    : '';
  const html = shell(siteUrl, `
    <div style="font:800 22px/1.3 Arial,sans-serif;color:#22262A;margin-bottom:4px">New brand discovery</div>
    <div style="font:15px/1.5 Arial,sans-serif;color:#6B6D6C;margin-bottom:16px">${esc(d.businessName)}. Reply to this email to answer ${esc(d.firstName)} directly.</div>
    <table role="presentation" cellpadding="0" cellspacing="0">${contactHtml}</table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${answersHtml(rows)}${filesHtml}</table>
    <div style="margin-top:24px;font:12px Arial,sans-serif;color:#6B6D6C">Submission ${esc(id)}. The attached answers.json has every raw answer.${confirmationSent ? '' : ' A confirmation email was not sent to the submitter.'}</div>`,
    `${d.businessName}: brand discovery from ${name}`);
  const text = [
    `New brand discovery: ${d.businessName}`, '',
    contact.map(([k, v]) => `${k}: ${v}`).join('\n'), '',
    answersText(rows),
    files.length ? '\nFILES (links work for about 7 days)\n' + files.map((f) => `${f.name}: ${f.url || 'no link'}`).join('\n') : '',
    `\nSubmission ${id}`
  ].join('\n');
  return { subject: `New brand discovery: ${d.businessName} (${name})`, html, text };
}

export function confirmationEmail({ data: d, rows, siteUrl, bookingUrl }) {
  const html = shell(siteUrl, `
    <div style="font:800 24px/1.25 Arial,sans-serif;color:#22262A;margin-bottom:10px">Thanks, ${esc(d.firstName)}. We’ve got it.</div>
    <div style="font:16px/1.6 Arial,sans-serif;color:#22262A">Your brand discovery for <strong>${esc(d.businessName)}</strong> is in. A specialist will read every answer before we talk, so we can spend the call on strategy instead of basics.</div>
    <div style="margin:24px 0"><a href="${esc(bookingUrl)}" style="display:inline-block;background:#22262A;color:#ffffff;font:700 15px Arial,sans-serif;text-decoration:none;padding:14px 22px;border-radius:8px;border-bottom:4px solid #2297F9">Book your free strategy call</a></div>
    <div style="font:14px/1.6 Arial,sans-serif;color:#6B6D6C">Free 30-minute call. No commitment required. Just reply to this email if you have questions.</div>
    <div style="margin-top:26px;font:800 15px Arial,sans-serif;color:#22262A;border-top:2px solid #22262A;padding-top:16px">A copy of your answers</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${answersHtml(rows)}</table>`,
    'We received your brand discovery. Here is what happens next.');
  const text = [
    `Thanks, ${d.firstName}. We've got it.`, '',
    `Your brand discovery for ${d.businessName} is in. A specialist will read every answer before we talk.`,
    `Book your free strategy call: ${bookingUrl}`, '',
    'A copy of your answers', '', answersText(rows)
  ].join('\n');
  return { subject: `We got your brand discovery, ${d.firstName}`, html, text };
}

// Returns null on success, or a short error string.
export async function sendEmail({ to, subject, html, text, replyTo, key, attachments }, env = process.env, fetchImpl = fetch) {
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) return 'Resend is not configured (RESEND_API_KEY / FROM_EMAIL).';
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({
        from: env.FROM_EMAIL, to: [to], subject, html, text,
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(attachments ? { attachments } : {})
      })
    });
    // 409 means Resend already has this idempotency key, so an earlier attempt went through.
    if (res.ok || res.status === 409) return null;
    return `Resend ${res.status}: ${(await res.text()).slice(0, 300)}`;
  } catch (e) {
    return `Resend request failed: ${e.message}`;
  }
}
