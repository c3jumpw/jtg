# Jump Tech Group — j-tgroup.com

The parent-group site for JTG. Static HTML/CSS/JS plus one Vercel function for the contact form.

```
jtg-parent/            ← Vercel project "jtg-jtg-parent", Root Directory = jtg-parent
├─ index.html          the page (hero + team finder, services, agency directory, process, contact)
├─ 404.html
├─ css/style.css
├─ js/app.js           finder data/matching + contact form submit
├─ api/contact.js      POST /api/contact → Resend
├─ assets/             logo, light logo, icons, share image, self-hosted fonts
│  └─ brands/          web-sized branch logos (generated from media/)
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

## Editing content

- Agency rows live in `index.html` under `#agencies` (ids `branch-<key>`).
- The finder's short descriptions and which choice maps to which agency live at the top of `js/app.js`
  (`BRANCHES` and `MATCHES`). The team dropdown in the form and `BRANCHES` in `api/contact.js` use the same keys.
- Branch logos: the site uses the trimmed copies in `assets/brands/<key>.png` (Party Designers is `pd.jpg`).
  To swap one, replace that file (max ~480×200). ACAD and BC Agency sit on dark tiles because their logos are white;
  that's the `tile: 'dark'` flag in `js/app.js` and the `logo-tile--dark` class in `index.html`.
- When a branch gets a website, add the link in its directory row, in `BRANCHES[key].site` in `js/app.js`,
  and in the footer if wanted.
