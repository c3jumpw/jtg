// The three routes as factories, so the real files in api/ wire in the real services
// and tests can wire in fakes.
import {
  MAX_BYTES, MAX_BODY_CHARS, GROUPS, UUID_RE, EMAIL_RE,
  json, clean, rateLimited, clientIp, originAllowed, parseUploadPath, readRows,
  linkExpiry, signLink, verifyLink, ownerEmail, confirmationEmail, sendEmail
} from './core.js';

const guard = (request, env) =>
  originAllowed(request, env) ? null : json(403, { error: 'Not allowed from this site.' });

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return { error: json(413, { error: 'That request is too large.' }) };
  try { return { body: JSON.parse(text) }; } catch { return { error: json(400, { error: 'Bad request.' }) }; }
}

/* ---------- POST /api/upload: hands the browser a short-lived token to upload one file ---------- */

export function makeUpload({ handleUpload, env = process.env, now = Date.now }) {
  return async function upload(request) {
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' });
    const blocked = guard(request, env); if (blocked) return blocked;
    if (rateLimited(`up:${clientIp(request)}`, 80, 10 * 60000, now())) {
      return json(429, { error: 'Too many uploads. Please wait a few minutes.' });
    }
    const { body, error } = await readJson(request);
    if (error) return error;
    try {
      const result = await handleUpload({
        body, request,
        onBeforeGenerateToken: async (pathname) => {
          if (!parseUploadPath(pathname)) throw new Error('That file name or type isn’t supported.');
          return {
            maximumSizeInBytes: MAX_BYTES,
            addRandomSuffix: true,
            allowOverwrite: false,
            validUntil: now() + 30 * 60000
          };
        }
      });
      return json(200, result);
    } catch (e) {
      return json(400, { error: e.message || 'Upload isn’t available right now.' });
    }
  };
}

/* ---------- POST /api/submit: validates, then emails you and the submitter ---------- */

export function makeSubmit({ head, env = process.env, fetchImpl = fetch, now = Date.now, newId = () => crypto.randomUUID() }) {
  return async function submit(request) {
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' });
    const blocked = guard(request, env); if (blocked) return blocked;
    const { body, error } = await readJson(request);
    if (error) return error;

    // Bots tend to fill the hidden field. Say thanks and drop it.
    if (typeof body.hp === 'string' && body.hp.trim()) return json(200, { ok: true });
    if (rateLimited(`sub:${clientIp(request)}`, 8, 60 * 60000, now())) {
      return json(429, { error: 'Too many submissions from this network. Please try again later.' });
    }

    const folder = clean(body.folder, 64);
    const raw = body.data && typeof body.data === 'object' ? body.data : null;
    if (!UUID_RE.test(folder) || !raw) return json(400, { error: 'That submission looked incomplete.' });
    if (JSON.stringify(raw).length > 100000) return json(413, { error: 'That submission is too large.' });

    const d = {
      ...raw,
      firstName: clean(raw.firstName, 80), lastName: clean(raw.lastName, 80),
      businessName: clean(raw.businessName, 160), email: clean(raw.email, 200).toLowerCase(),
      phone: clean(raw.phone, 40), website: clean(raw.website, 200), location: clean(raw.location, 120),
      role: clean(raw.role, 80), contactPref: clean(raw.contactPref, 80), timeline: clean(raw.timeline, 80)
    };
    if (!d.firstName) return json(400, { error: 'Please add your first name.' });
    if (!d.businessName) return json(400, { error: 'Please add your business name.' });
    if (!EMAIL_RE.test(d.email)) return json(400, { error: 'Please check your email address.' });
    if (raw.consent !== true) return json(400, { error: 'Please tick the box so we can contact you.' });

    const rows = readRows(body.summary);
    const siteUrl = (env.SITE_URL || 'https://discovery.befortune5.com').replace(/\/$/, '');
    const bookingUrl = env.BOOKING_URL || 'https://befortune5.com/#book';
    if (!env.NOTIFY_TO) return json(500, { error: 'This form isn’t fully set up yet. Please try again later.' });

    // Keep only files that really exist in storage and belong to this visit's folder.
    const claimed = (Array.isArray(body.files) ? body.files : []).slice(0, 20).map((f) => ({
      group: clean(f && f.group, 20), name: clean(f && f.name, 200), path: clean(f && f.path, 300)
    })).filter((f) => {
      const p = parseUploadPath(f.path);
      return p && p.folder === folder && p.group === f.group && GROUPS.includes(f.group);
    });
    const exp = linkExpiry(now());
    const checked = await Promise.all(claimed.map(async (f) => {
      try {
        const info = await head(f.path);
        return { ...f, size: info.size, url: env.DOWNLOAD_SECRET ? signLink(siteUrl, env.DOWNLOAD_SECRET, f.path, exp) : '' };
      } catch { return null; }
    }));
    const files = checked.filter(Boolean);

    const id = `${folder.slice(0, 8)}-${newId().slice(0, 8)}`;
    const meta = typeof body.meta === 'object' && body.meta ? body.meta : {};
    const record = { id, receivedAt: new Date(now()).toISOString(), data: d, summary: rows, files: files.map(({ url, ...f }) => f), meta };
    const attachment = { filename: 'answers.json', content: Buffer.from(JSON.stringify(record, null, 2)).toString('base64') };

    const errors = [];
    const [ownerErr, confirmErr] = await Promise.all([
      sendEmail({ to: env.NOTIFY_TO, ...ownerEmail({ id, data: d, rows, files, siteUrl, confirmationSent: true }),
        replyTo: d.email, key: `${folder}-owner`, attachments: [attachment] }, env, fetchImpl),
      sendEmail({ to: d.email, ...confirmationEmail({ data: d, rows, siteUrl, bookingUrl }),
        replyTo: env.NOTIFY_TO, key: `${folder}-confirm` }, env, fetchImpl)
    ]);
    if (confirmErr) errors.push(`confirmation: ${confirmErr}`);

    // The owner email is the only record of this submission. If it didn't go, say so, so the browser retries.
    if (ownerErr) {
      console.error('owner email failed', folder, ownerErr);
      return json(502, { error: 'We couldn’t send that. Nothing was lost on your side. Please try again.' });
    }
    if (errors.length) console.error('email issue', folder, errors.join(' | '));
    return json(200, { ok: true, id });
  };
}

/* ---------- GET /api/file: signed download of a private upload ---------- */

export function makeFile({ get, env = process.env, now = Date.now }) {
  return async function file(request) {
    if (request.method !== 'GET') return json(405, { error: 'Method not allowed.' });
    const q = new URL(request.url).searchParams;
    const pathname = q.get('p') || '';
    if (!parseUploadPath(pathname) || !verifyLink(env.DOWNLOAD_SECRET, pathname, q.get('e'), q.get('s'), now())) {
      return json(403, { error: 'This link is invalid or has expired.' });
    }
    const result = await get(pathname, { access: 'private' });
    if (!result || result.statusCode !== 200) return json(404, { error: 'File not found.' });
    const name = pathname.split('/').pop().replace(/"/g, '');
    return new Response(result.stream, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${name}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex'
      }
    });
  };
}
