/* Shared helpers for the j-tgroup.com form endpoints (api/contact.js, api/subscribe.js).
 *
 * The branch sites (acad.j-tgroup.com, barboost.j-tgroup.com, … and fortune5ceo.com) post their
 * forms here, so every site sends through this one Resend setup (RESEND_API_KEY / FROM_EMAIL /
 * NOTIFY_TO on the jtg-jtg-parent project). The functions below handle the cross-site request
 * rules (CORS) for those sites.
 */

export const BRANCHES = {
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

// Branch sites that post to these endpoints: site key → branch key + the site's own address.
export const SITES = {
  'blanket-label': { branch: 'blk', url: 'https://blanket-label.j-tgroup.com' },
  barboost: { branch: 'bb', url: 'https://barboost.j-tgroup.com' },
  bloom: { branch: 'blm', url: 'https://bloom.j-tgroup.com' },
  acad: { branch: 'acad', url: 'https://acad.j-tgroup.com' },
  seeder: { branch: 'sd', url: 'https://seeder.j-tgroup.com' },
  'bc-agency': { branch: 'bc', url: 'https://bc-agency.j-tgroup.com' },
  'media-bc': { branch: 'mbc', url: 'https://media-bc.j-tgroup.com' },
  jumpwebs: { branch: 'jw', url: 'https://jumpwebs.j-tgroup.com' },
  'f5-ceo': { branch: 'f5ceo', url: 'https://fortune5ceo.com' }
};

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const hits = new Map();

export const clean = (v, max) => (typeof v === 'string' ? v.replace(CTRL, '').trim().slice(0, max) : '');
export const oneLine = (s) => s.replace(/[\r\n]+/g, ' ');
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* ---------- Who may post ---------- */

// Hosts of the branch sites and their Vercel addresses (used before the custom domains are live).
const VERCEL_ALIASES = new Set(Object.keys(SITES).map((k) => `jtg-${k}.vercel.app`));

function isTrustedHost(host) {
  return host === 'j-tgroup.com' || host.endsWith('.j-tgroup.com') ||
    host === 'fortune5ceo.com' || host === 'www.fortune5ceo.com' ||
    VERCEL_ALIASES.has(host);
}

/** True when the request comes from this site, a JTG branch site, or an ALLOWED_ORIGINS entry. */
export function originAllowed(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true; // same-origin form posts and server-side calls send no Origin
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (url.host === (request.headers.get('host') || new URL(request.url).host)) return true;
  if (url.protocol === 'https:' && isTrustedHost(url.host)) return true;
  return (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
}

/** CORS headers for an allowed cross-site origin; empty for same-site or disallowed requests. */
export function corsHeaders(request) {
  const origin = request.headers.get('origin');
  if (!origin || !originAllowed(request)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

/** Answer the browser's CORS preflight for a cross-site POST. */
export function preflight(request) {
  if (!originAllowed(request)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export function json(request, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(request) }
  });
}

export function clientIp(request) {
  return (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    request.headers.get('x-real-ip') || 'unknown';
}

// Best-effort, per-instance limit. Enough to blunt a script hammering a form.
export function rateLimited(key, max, windowMs, now = Date.now()) {
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

/** Read and parse a JSON body; returns { body } or { error: Response }. */
export async function readJson(request, maxLength = 20000) {
  try {
    const raw = await request.text();
    if (raw.length > maxLength) return { error: json(request, 413, { error: 'That message is too long. Shorten it and try again.' }) };
    const body = JSON.parse(raw || '{}');
    if (!body || typeof body !== 'object') return { error: json(request, 400, { error: 'The form data couldn’t be read.' }) };
    return { body };
  } catch {
    return { error: json(request, 400, { error: 'The form data couldn’t be read. Refresh the page and try again.' }) };
  }
}

/** The branch site a post came from (by its `site` field), or null for j-tgroup.com itself. */
export function siteFor(body) {
  const key = typeof body.site === 'string' ? body.site : '';
  if (!Object.prototype.hasOwnProperty.call(SITES, key)) return null;
  const s = SITES[key];
  return { key, branch: s.branch, name: BRANCHES[s.branch], url: s.url };
}

/* ---------- Sending ---------- */

export function notifyList() {
  return (process.env.NOTIFY_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function mailConfigured() {
  return Boolean(notifyList().length && process.env.RESEND_API_KEY && process.env.FROM_EMAIL);
}

/** FROM_EMAIL with its display name swapped, e.g. "Acad Branding <support@j-tgroup.com>". */
export function fromAs(displayName) {
  const from = process.env.FROM_EMAIL || '';
  const m = from.match(/<([^>]+)>/);
  const address = (m ? m[1] : from).trim();
  if (!displayName || !address) return from;
  return `${displayName.replace(/[<>"\r\n]/g, '')} <${address}>`;
}

export async function sendEmail({ to, subject, html, text, replyTo, key, from }) {
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
        from: from || FROM_EMAIL,
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

/* ---------- Email layout ---------- */

export const siteUrl = () => (process.env.SITE_URL || 'https://j-tgroup.com').replace(/\/$/, '');

export const shell = (base, inner, footer = '') => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#EEF3FA">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF3FA"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#16185A;padding:22px 28px"><img src="${esc(base)}/assets/logo-light.png" alt="Jump Tech Group" height="36" style="display:block;height:36px;width:auto;border:0"></td></tr>
<tr><td style="padding:28px">${inner}</td></tr>
${footer ? `<tr><td style="padding:0 28px 24px;font:13px/1.5 Arial,sans-serif;color:#4B5280">${footer}</td></tr>` : ''}
</table></td></tr></table></body></html>`;

export function row(label, value, href) {
  if (!value) return '';
  const v = href ? `<a href="${esc(href)}" style="color:#2E3192">${esc(value)}</a>` : esc(value);
  return `<tr><td style="padding:5px 20px 5px 0;font:700 13px Arial,sans-serif;color:#4B5280;vertical-align:top;white-space:nowrap">${esc(label)}</td><td style="padding:5px 0;font:15px Arial,sans-serif;color:#16185A">${v}</td></tr>`;
}

export const quote = (text) =>
  `<div style="margin-top:18px;padding:16px 18px;background:#EEF3FA;border-left:3px solid #00AEEF;font:15px/1.55 Arial,sans-serif;color:#16185A;white-space:pre-wrap">${esc(text)}</div>`;

export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
