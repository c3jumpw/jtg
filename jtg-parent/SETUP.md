# Jump Tech Group — j-tgroup.com

The parent-group site for JTG. Static HTML/CSS/JS plus two Vercel functions that send email for this site and the branch sites.

```
jtg-parent/            ← Vercel project "jtg-jtg-parent", Root Directory = jtg-parent
├─ index.html          the page (hero + team finder, services, agency directory, process, contact)
├─ 404.html
├─ css/style.css
├─ js/app.js           finder data/matching + contact form submit
├─ api/contact.js      POST /api/contact → Resend (this site + the branch sites)
├─ api/subscribe.js    POST /api/subscribe → Resend (Fortune 5 CEO "Get updates")
├─ lib/mail.js         shared email helpers + the list of branch sites allowed to post
├─ assets/             logo, light logo, icons, share image, self-hosted fonts
│  ├─ brands/          web-sized branch logos (generated from media/)
│  ├─ illustrations/   brand illustrations (flight path, systems, agency network, contact plane)
│  └─ icons.svg        icon sprite (Lucide, ISC license)
└─ media/              original uploads (JTG + branch logos)
```

## Contact form (Resend)

`POST /api/contact` emails each inquiry to the team (Reply-To set to the visitor) and sends the
visitor a short acknowledgment. Until the variables below are set, the form shows
"The contact form isn't connected yet" and the inquiry is written to the Vercel runtime logs
so nothing is lost.

Set these in Vercel → jtg-jtg-parent → Settings → Environment Variables (Production), then redeploy:

| Name | Example | Notes |
| --- | --- | --- |
| `RESEND_API_KEY` | `re_...` | Resend API key with send access |
| `FROM_EMAIL` | `Jump Tech Group <hello@j-tgroup.com>` | Domain must be verified in Resend (Resend → Domains → add j-tgroup.com and its DNS records) |
| `NOTIFY_TO` | `you@example.com` | Where inquiries go. Comma-separate for several |
| `SITE_URL` | `https://j-tgroup.com` | Optional. Used for the logo in emails |
| `ALLOWED_ORIGINS` | `https://www.j-tgroup.com` | Optional. Extra origins allowed to post (same-host posts always work) |

### Branch sites use this same setup

The branch sites (`acad.j-tgroup.com`, `barboost.j-tgroup.com`, `bloom.j-tgroup.com`,
`blanket-label.j-tgroup.com`, `seeder.j-tgroup.com`, `bc-agency.j-tgroup.com`, `media-bc.j-tgroup.com`,
`jumpwebs.j-tgroup.com`) post their contact forms here, and the Fortune 5 CEO coming-soon page on
`fortune5ceo.com` posts its "Get updates" sign-ups to `POST /api/subscribe`. So every site sends through
the one Resend account above, and the branch projects need no environment variables.

- Posts from `j-tgroup.com`, any `*.j-tgroup.com`, `fortune5ceo.com` and the branch projects'
  `jtg-<folder>.vercel.app` addresses are accepted (CORS); anything else gets a 403. The list lives in
  `lib/mail.js` (`SITES`), along with the shared email helpers.
- A branch-site message arrives with its subject starting `[Acad Branding]` (etc.), and the visitor's
  acknowledgment comes from the branch name at the `FROM_EMAIL` address, e.g. `Acad Branding <support@j-tgroup.com>`.
- `api/subscribe.js` emails each sign-up to `NOTIFY_TO` and sends the subscriber a confirmation. Every
  sign-up is also logged (Vercel → jtg-jtg-parent → Logs, search `subscribe:`), so the list can be exported
  into a mailing tool later.

## Editing content

- Agency rows live in `index.html` under `#agencies` (ids `branch-<key>`).
- The finder's short descriptions and which choice maps to which agency live at the top of `js/app.js`
  (`BRANCHES` and `MATCHES`). The team dropdown in the form and `BRANCHES` in `api/contact.js` use the same keys.
- Branch logos: the site uses the trimmed copies in `assets/brands/<key>.png` (Party Designers is `pd.jpg`).
  To swap one, replace that file (max ~480×200). ACAD and BC Agency sit on dark tiles because their logos are white;
  that's the `tile: 'dark'` flag in `js/app.js` and the `logo-tile--dark` class in `index.html`.
- Icons: `assets/icons.svg` holds the Lucide icons the page uses, referenced as
  `<svg class="icon"><use href="/assets/icons.svg#i-NAME"></use></svg>`. To add one, copy its paths from
  lucide.dev into a new `<symbol id="i-NAME" viewBox="0 0 24 24">` in the sprite.
- When a branch gets a website, add the link in its directory row, in `BRANCHES[key].site` in `js/app.js`,
  and in the footer if wanted.
