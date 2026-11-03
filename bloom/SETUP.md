# Blloom — bloom.j-tgroup.com

One-page site for Blloom, a Jump Tech Group company. Static HTML/CSS/JS, no build step.

```
bloom/            ← Vercel project "jtg-bloom", Root Directory = bloom
├─ index.html          the page
├─ 404.html
├─ css/style.css       brand tokens at the top, shared JTG branch-site layout below
├─ js/app.js           mobile menu + form submit
├─ assets/             logo (header + footer versions), illustrations, icons, fonts, favicons, share image
└─ vercel.json         security headers (Content-Security-Policy etc.)
```

Pushing to `main` deploys to production.

## Domain

`bloom.j-tgroup.com` is added to Vercel → jtg-bloom → Settings → Domains. At GoDaddy (DNS for j-tgroup.com) add
the `CNAME` record Vercel shows on that page for the name `bloom`. The domain turns green
in Vercel once the record resolves, and Vercel issues the SSL certificate on its own.

## Form → email (no setup needed here)

The contact form posts to `https://j-tgroup.com/api/contact` on the parent site, which sends the email through
Jump Tech Group's Resend account — the `RESEND_API_KEY`, `FROM_EMAIL` and `NOTIFY_TO` already set on the
**jtg-jtg-parent** project. This project needs no environment variables.

- Each message emails the team (subject starts with `[Blloom]`, Reply-To = the visitor) and sends the visitor an acknowledgment from "Blloom" at the `FROM_EMAIL` address.
- The parent accepts posts from `*.j-tgroup.com`, `fortune5ceo.com` and this project's `jtg-bloom.vercel.app` address.
- To move this site to its own Resend setup later, copy `api/` and `lib/` from `jtg-parent/`, add the three env vars here, and change `data-endpoint` on the form in `index.html` to `/api/contact`.

## Editing content

- All copy is in `index.html`. The form's interest chips are free to change; their labels arrive in the email as typed.
- Colours and fonts: the `:root` block at the top of `css/style.css`.
- Illustrations are flat SVGs in `assets/illustrations/` (no text inside, so they never need translating).
- Fonts are self-hosted in `assets/fonts/` because the Content-Security-Policy only allows same-origin fonts,
  scripts and styles (no inline `style=""` either).
