# MKC Portal Manager

Staff tool for writing and publishing client portal updates for every MKC
division (JTG, UNY, MCO). Separate from MKC Admin, same look, same sign-in
model, same Supabase project (MKC-Admin, `symbmscaajjmgywbifhv`).

Suggested host: `portal-manager.jtgworkspace.com`.

## What it does

- **Clients** — every client portal you can see (managers and super admins see
  all; account managers and supervisors see the clients assigned to them).
  Each client has Updates, Contacts (who can sign in to the portal), Staff
  (who works the account) and Settings.
- **Composer** — write an update: type, title, summary, your notes, then turn
  the notes into a page:
  - **Copy prompt** fills one of three prompts (update page, client task,
    how-to guide) with the notes, client name, division colours and your name.
    Paste it into Gemini, Claude or ChatGPT and paste the HTML back in.
  - **Draft with Gemini** does the same from the server in one click. While
    the Gemini subscription is paused the button is disabled with a note, and
    Copy prompt keeps working — nothing else changes.
  - **Preview** shows the saved page exactly as clients will see it.
  - **Publish** asks for confirmation and says how many contacts will see it.
- **Prompt library** — the three prompts on their own page, each with Copy
  prompt, Copy link (deep link to that prompt) and "Paste into" links.
- **Team** — who has access and with which role (super admins only can change).

## Roles

| Role | Clients | Write | Publish | Clients & assignments | Team |
| --- | --- | --- | --- | --- | --- |
| Super admin | all | ✓ | ✓ | ✓ | ✓ |
| Manager | all | ✓ | ✓ | ✓ | — |
| Account manager | assigned | ✓ | ✓ | — | — |
| Supervisor | assigned | read-only | — | — | — |

The table lives in `lib/access.js` and is enforced on the server on every
request. The browser only hides buttons.

## Security model (short)

- Sign-in links look like `https://…/#signin=<token>`. The token is in the
  URL fragment, which never reaches a server, and it is only spent when the
  person taps **Continue** — so company mail scanners that pre-open links
  can't use them up or get a session. A link is claimed atomically: two taps
  at once give one session, not two.

- The `portal` schema grants nothing to `anon` or `authenticated`; RLS is on
  for every table with no policies. Only this server (service role) reads or
  writes it, and every route checks the session, the role and the client
  before touching data.
- Update pages are stored sanitised and are **only** served from `/api/view`
  with `Content-Security-Policy: sandbox allow-popups allow-popups-to-escape-sandbox …`
  — no scripts, forms or same-origin access; links open the real site in a
  new tab. `vercel.json` keeps the site-wide headers off that path.
- Saves and publish/unpublish are atomic: if two people save the same
  update at once, the second is told to reload instead of silently
  overwriting the first.
- Every change is written to `core.audit_log` (tool `portal`), which the
  migration makes append-only.
- Email lookups escape LIKE wildcards (`_`, `%`) and re-check the exact
  address, so `j_hn@x.com` can never match `john@x.com`.

## One-time setup

1. **Apply the migration** `mkc/sql/001_portal_foundation.sql` to the MKC-Admin
   project (creates the `portal` schema; also makes `core.audit_log`
   append-only).
2. **Expose the schema to the API:** Supabase Dashboard → Project Settings →
   Data API → *Exposed schemas* → add `portal` → Save. (The service role still
   needs this to reach the schema over REST; anon/authenticated have no grants.)
3. **Create the Vercel project** from this repo with Root Directory
   `mkc/portal-manager`, framework *Other*, no build command.
4. **Environment variables** (Vercel → Settings → Environment Variables).
   You paste the secret values yourself:

| Name | Example | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | `https://symbmscaajjmgywbifhv.supabase.co` | Same as MKC Admin |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Server-only, mark Sensitive |
| `RESEND_API_KEY` | — | Sends sign-in links |
| `FROM_EMAIL` | `MKC Portal Manager <admin@jtgworkspace.com>` | Verified Resend domain |
| `SITE_URL` | `https://portal-manager.jtgworkspace.com` | Used in sign-in links |
| `PORTAL_ADMIN_EMAILS` | `you@company.com` | Bootstrap super admins. Falls back to `MKC_ADMIN_EMAILS` |
| `GEMINI_API_KEY` | — | Leave **unset** while the subscription is paused |
| `GEMINI_MODEL` | `gemini-3.6-flash` | Optional; this is the default |
| `GEMINI_PAUSED` | `1` | Optional switch to turn drafting off without removing the key |

5. Add the domain, deploy, sign in with a bootstrap email, then add the team
   on the Team page and assign them to clients.

### When the Gemini subscription is renewed

Add `GEMINI_API_KEY` (and remove `GEMINI_PAUSED` if you set it), redeploy.
The composer's button turns on by itself. Drafts are rate-limited to 20 per
person per hour, are sanitised, and are never saved until the person saves —
and a live (published) update is never overwritten by an unreviewed draft.

## Known limits

- Rate limits are counted in memory per serverless instance — a speed bump,
  not a guarantee. Moving them to the database is a later step.
- Tested in Chromium (desktop and iPhone-sized). Check on a real iPhone in
  Safari before inviting clients.

## Shared code

`lib/core.js` and `lib/sanitize.js` are also used by the client portal
(`mkc/portal`). Each Vercel project deploys from its own folder, so the files
are copied; `mkc/portal/test/sanitize-parity.test.js` fails if they drift.

## Tests

```
node --test test/*.test.js
```

Unit tests cover roles, sanitiser (including linear time on hostile input),
prompts and Gemini handling. Route tests run every API route against
`test/fake-postgrest.js`, an in-memory PostgREST that reads the real column
names from the migration — a typo'd column fails here, not in production.
