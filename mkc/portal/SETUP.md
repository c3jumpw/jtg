# Client portal — portal.j-tgroup.com

Where clients sign in to see the updates, tasks and guides their team
publishes from the Portal Manager (`mkc/portal-manager`). Same Supabase
project (MKC-Admin, `symbmscaajjmgywbifhv`), `portal` schema.

This round ships the **sign-in page** (Jump Tech Group branding, all twelve
agency logos, a quiet link back to j-tgroup.com) and a **minimal signed-in
view**: the client's published updates, newest first, each opening in a
sandboxed viewer. The full client dashboard (tasks, files, requests,
notifications) is the next round.

## How sign-in works

1. The client enters their email. The answer is the same whether or not we
   know the address, so the form can't be used to discover clients.
2. If the email belongs to an active contact linked to at least one active
   company in this portal's divisions, we email a one-time link (15 minutes).
3. The link is `https://portal.j-tgroup.com/#signin=<token>`. The token sits
   in the URL **fragment**, which browsers never send to a server, so it stays
   out of access logs. The page wipes it from the address bar and shows
   **Open my portal**; only that tap posts it to `/api/auth-callback`. Company
   mail scanners that pre-open (or even run) links therefore can't use it up.
   The server re-checks access, spends the link (once — a second tab or
   double tap reads as "already used") and sets an HTTP-only cookie
   (`portal_sid`, 30 days).
4. The sign-in form answers in the same time whether or not the email is
   known, so response timing doesn't reveal who our clients are.

Clients are `portal.contacts`, never MKC staff accounts. A staff session can't
be used here and a client session can't be used in the Portal Manager.

## What a client can see

Only **published** updates of **active** companies they're linked to, in this
deployment's divisions. Drafts, archived updates and staff notes never leave
the server. Anything a client can't see — a draft, another company's update,
an invented id — returns the same "not available" page.

## One-time setup

The migration and the *Exposed schemas* step are shared with the Portal
Manager — see `mkc/portal-manager/SETUP.md`. Then:

1. **Vercel project** from this repo, Root Directory `mkc/portal`,
   framework *Other*, no build command.
2. **Environment variables** (you paste secret values yourself):

| Name | Example | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | `https://symbmscaajjmgywbifhv.supabase.co` | |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Server-only, mark Sensitive |
| `RESEND_API_KEY` | — | |
| `FROM_EMAIL` | `Jump Tech Group <portal@j-tgroup.com>` | Domain must be verified in Resend |
| `SITE_URL` | `https://portal.j-tgroup.com` | Used in sign-in links |
| `PORTAL_DIVISIONS` | `jtg` | Which divisions this deployment serves |

3. **Domain:** add `portal.j-tgroup.com` to the project and create the CNAME
   Vercel shows.

## UNY and MCO later

The server code is division-aware already: deploy this folder again with
`PORTAL_DIVISIONS=uny` (or `mco`) and that division's `SITE_URL`. The sign-in
page and email are JTG-branded today; a UNY or MCO portal needs its own logo,
colours and copy in `index.html`, `css/portal.css` and `lib/emails.js`.

## Tests

```
node --test test/*.test.js
```

Route tests cover the sign-in flow (unknown, switched-off and other-division
emails get the same answer; links work once; expired and spent links fail
clearly), division and company scoping, and the sandboxed viewer.
