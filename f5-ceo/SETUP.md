# Fortune 5 CEO — fortune5ceo.com

Coming-soon page for Fortune 5 CEO, a Jump Tech Group company. Static HTML/CSS/JS, no build step.

```
f5-ceo/            ← Vercel project "jtg-f5-ceo", Root Directory = f5-ceo
├─ index.html          the page
├─ 404.html
├─ css/style.css       brand tokens at the top, shared JTG branch-site layout below
├─ js/app.js           mobile menu + form submit
├─ assets/             logo (header + footer versions), illustrations, icons, fonts, favicons, share image
└─ vercel.json         security headers (Content-Security-Policy etc.)
```

Pushing to `main` deploys to production.

## Domain

`fortune5ceo.com` and `www.fortune5ceo.com` are added to Vercel → jtg-f5-ceo → Settings → Domains.
At the DNS provider for fortune5ceo.com, set the records Vercel shows on that page (an `A` record on `@` and a
`CNAME` on `www`), and remove any parking-page records. The domain turns green in Vercel once the records
resolve, and Vercel issues the SSL certificate on its own.

## Form → email (no setup needed here)

The **Get updates** form posts to `https://j-tgroup.com/api/subscribe` on the parent site, which sends the email through
Jump Tech Group's Resend account — the `RESEND_API_KEY`, `FROM_EMAIL` and `NOTIFY_TO` already set on the
**jtg-jtg-parent** project. This project needs no environment variables.

- Each sign-up emails the team (subject starts with `[Fortune 5 CEO]`) and sends the subscriber a confirmation from "Fortune 5 CEO".
- The parent accepts posts from `*.j-tgroup.com`, `fortune5ceo.com` and this project's `jtg-f5-ceo.vercel.app` address.
- To move this site to its own Resend setup later, copy `api/` and `lib/` from `jtg-parent/`, add the three env vars here, and change `data-endpoint` on the form in `index.html` to `/api/subscribe`.

## Editing content

- All copy is in `index.html`. The form's interest chips are free to change; their labels arrive in the email as typed.
- Colours and fonts: the `:root` block at the top of `css/style.css`.
- Illustrations are flat SVGs in `assets/illustrations/` (no text inside, so they never need translating).
- Fonts are self-hosted in `assets/fonts/` because the Content-Security-Policy only allows same-origin fonts,
  scripts and styles (no inline `style=""` either).
