import { esc } from './core.js';

/* Client sign-in email, in Jump Tech Group colours. Table layout and inline
 * styles because email clients ignore most CSS. */

export function signInEmail({ url, siteUrl, ip }) {
  const subject = 'Your Jump Tech Group client portal sign-in link';
  const html = `<!doctype html><html><body style="margin:0;background:#EEF3FA;font-family:Arial,Helvetica,sans-serif;color:#16185A">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF3FA;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden">
<tr><td style="background:#16185A;padding:22px 28px"><img src="${esc(siteUrl)}/assets/logo-light.png" width="140" height="44" alt="Jump Tech Group" style="display:block;border:0"></td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#16185A">Sign in to your client portal</h1>
<p style="margin:0 0 22px;font-size:16px;line-height:1.6;color:#4B5280">Tap the button to see the latest updates, tasks and guides from your team. The link works once and expires in 15 minutes.</p>
<p style="margin:0 0 26px"><a href="${esc(url)}" style="display:inline-block;background:#2E3192;color:#ffffff;text-decoration:none;font-weight:bold;font-size:16px;padding:14px 26px;border-radius:999px">Open my portal</a></p>
<p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:#4B5280">If the button doesn’t work, copy this link into your browser:</p>
<p style="margin:0 0 22px;font-size:13px;line-height:1.5;word-break:break-all"><a href="${esc(url)}" style="color:#2E3192">${esc(url)}</a></p>
<p style="margin:0;font-size:12px;line-height:1.5;color:#4B5280">Didn’t ask for this? You can ignore this email — nobody can sign in without the link.${ip ? ` Requested from ${esc(ip)}.` : ''}</p>
</td></tr></table>
<p style="font-size:12px;color:#4B5280;margin:16px 0 0"><a href="https://j-tgroup.com" style="color:#4B5280">j-tgroup.com</a></p>
</td></tr></table></body></html>`;
  const text = `Sign in to your Jump Tech Group client portal\n\nOpen this link (it works once and expires in 15 minutes):\n${url}\n\nDidn't ask for this? Ignore this email — nobody can sign in without the link.`;
  return { subject, html, text };
}

export async function sendEmail({ to, subject, html, text, key }, env = process.env, fetchImpl = fetch) {
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) return 'Email is not configured (RESEND_API_KEY / FROM_EMAIL).';
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        ...(key ? { 'Idempotency-Key': key } : {})
      },
      body: JSON.stringify({ from: env.FROM_EMAIL, to: [to], subject, html, text })
    });
    if (!res.ok) return `Resend ${res.status}: ${(await res.text()).slice(0, 200)}`;
    return null;
  } catch (e) {
    return `Resend unreachable: ${e.message}`;
  }
}
