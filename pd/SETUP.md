# The Party Designers — wearepartydesigners.com

One-page site for The Party Designers. Static HTML/CSS/JS plus one Vercel function for the design request form.

```
pd/                    ← Vercel project "jtg-pd", Root Directory = pd
├─ index.html          the page (hero, turnaround, what we make, event websites, who it's for, how it works, request form)
├─ 404.html
├─ css/style.css
├─ js/app.js           request form submit, turnaround suggestion from the event date
├─ api/contact.js      POST /api/contact → Resend
├─ assets/             wordmark (dark + light), icons, share image, self-hosted fonts
└─ media/              original uploads (logo, icon)
```

Pushing to `main` deploys to production.

## Domain

`wearepartydesigners.com` and `www.wearepartydesigners.com` (redirects to the bare domain) are already
added to Vercel → jtg-pd → Settings → Domains. DNS is at GoDaddy; replace the parked-page records with:

| Type | Name | Value |
| --- | --- | --- |
| A | `@` | `216.150.1.1` |
| CNAME | `www` | `791e9a087e9bd733.vercel-dns-016.com` |

Delete any other `A` record on `@` (GoDaddy's parking IP `198.12.221.35`). The Domains page in Vercel turns
green once the records resolve, and Vercel issues the SSL certificate on its own.

## Request form (Resend)

`POST /api/contact` emails each request to you (Reply-To set to the visitor) and sends the visitor a
short acknowledgment asking them to reply with any logos, photos or lineup. Same-day and next-day
requests are tagged at the start of the subject line so they stand out in your inbox.

Until the variables below are set, the form shows "The request form isn't connected yet" and the
request is written to the Vercel runtime logs (Vercel → jtg-pd → Logs) so nothing is lost.

Set these in Vercel → jtg-pd → Settings → Environment Variables (Production), then redeploy:

| Name | Example | Notes |
| --- | --- | --- |
| `RESEND_API_KEY` | `re_...` | Resend API key with send access |
| `FROM_EMAIL` | `The Party Designers <hello@wearepartydesigners.com>` | Domain must be verified in Resend (Resend → Domains → add wearepartydesigners.com and its DNS records) |
| `NOTIFY_TO` | `you@example.com` | Where requests go. Comma-separate for several |
| `SITE_URL` | `https://wearepartydesigners.com` | Optional. Used for the logo in emails |
| `ALLOWED_ORIGINS` | `https://www.wearepartydesigners.com` | Optional. Extra origins allowed to post (same-host posts always work) |

## Editing content

- All copy is in `index.html`.
- The "What do you need?" options in the form must match `NEEDS` at the top of `api/contact.js`
  (anything not in that list is dropped).
- The hero pieces (invitation, flyer, wall sign, slideshow) and the event-website phone are drawn in
  HTML/CSS, not images. Their styles are under "The table of proofs" and "Event websites" in `css/style.css`.
  To show real work instead, swap a piece's inner `<div>` for an `<img>` of the same proportions.
- Fonts: Hanken Grotesk (matches the logo's thin/heavy type), with Anton and Instrument Serif used only
  inside the sample pieces. All are self-hosted in `assets/fonts` because the Content-Security-Policy
  in `vercel.json` only allows same-origin fonts, scripts and styles (no inline `style=""` either).
- The wordmark PNGs in `assets/` were cut from `media/Party Design Logo.jpg` with the pink removed.
