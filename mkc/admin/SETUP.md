# MKC Admin — mkc.jtgworkspace.com

Internal tool for managing the MKC booking system (and, later, other MKC tools).
Backed by the MKC-Admin Supabase project (`symbmscaajjmgywbifhv`).

## Auth model

Server-controlled magic links. No password. No JS auth library.

1. Admin enters email on the sign-in page.
2. Server verifies the email is on the allowlist (see below), generates a one-time link, emails it via Resend.
3. Admin clicks the link → server verifies the token, creates an HTTP-only session cookie (30 days).
4. Every `/api/*` call checks the cookie against `core.sessions` and re-verifies the allowlist.

The link is single-use and expires in 15 minutes.

**Allowlist:** an email is allowed if
- it's listed in the `MKC_ADMIN_EMAILS` env var (comma-separated), **or**
- it has an `admin` row in `core.tool_access` for tool `booking` (auto-granted on first successful sign-in of any bootstrap email — after that, other admins can be added from this tool).

## Environment variables (Vercel → mkc-admin → Settings → Environment Variables)

| Name | Example | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | `https://symbmscaajjmgywbifhv.supabase.co` | MKC-Admin project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJhbGciOi...` | Server-only, sensitive |
| `RESEND_API_KEY` | `re_...` | Sends the magic link emails |
| `FROM_EMAIL` | `MKC Admin <admin@jtgworkspace.com>` | Must be on a domain verified in Resend |
| `SITE_URL` | `https://mkc.jtgworkspace.com` | Used in the magic link URL |
| `MKC_ADMIN_EMAILS` | `you@company.com,other@company.com` | **You add this.** Bootstrap admins allowed to sign in. Comma-separated, lowercase. |

Redeploy after changing env vars.

## Modules in v1

- **Dashboard** — upcoming counts + next 5 bookings.
- **Bookings** — filter by upcoming / past / cancelled / all. Cancel from here.
- **Team** — add/edit reps. Link a rep to a Team Directory record (CRM Team Directory ID) so their bookings sync to the CRM.
- **Availability** — set weekly hours per rep, add per-date overrides.
- **Meeting types** — configure the visitor-facing options (duration, buffers, notice, horizon, active).
- **Settings** — view pages, add locations.

## What's coming in later phases

- Google Calendar OAuth per rep (busy-time subtraction + auto-create Meet events).
- Rep management from this tool that assigns/removes bookings-admin access.
- Multi-page management (BMS booking page, plus others).
- Reminder automation and Smart Triage-style batch actions.
