# MKC Booking — start.befortune5.com

The customer-facing booking page. Backed by the MKC-Admin Supabase project.

```
browser ── start.befortune5.com (static + /api on Vercel)
   ├─ GET  /api/page?slug=fortune5           → page + active meeting types
   ├─ POST /api/availability                 → open slots for a meeting type across a date range
   ├─ POST /api/appointments                 → create booking (rate-limited, honeypot, GIST-guarded)
   ├─ GET  /api/appointments?t=<token>       → look up a booking (from the emailed manage link)
   └─ POST /api/appointments?action=cancel   → cancel a booking
        ↓
   MKC-Admin Supabase project (service-role only)
        ↓
   Resend (confirmation + notification emails, each with an .ics attachment)
```

## Environment variables (Vercel → Project → Settings → Environment Variables)

| Name | Example | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | `https://symbmscaajjmgywbifhv.supabase.co` | The MKC-Admin project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJhbGciOi...` | **You add this** — grab from Supabase → Project Settings → API |
| `RESEND_API_KEY` | `re_...` | Same key you use for the F5 form is fine |
| `FROM_EMAIL` | `The Fortune 5 Agency <bookings@befortune5.com>` | Must be on a domain verified in Resend |
| `SITE_URL` | `https://start.befortune5.com` | Used for the manage links and the logo in email |
| `NOTIFY_TO` | `you@befortune5.com` | Fallback address if the rep has no email on file (rare) |
| `ALLOWED_ORIGINS` | *(optional)* | Comma-separated extra origins allowed to call the API |

Redeploy after changing variables.

## Testing

The scheduling engine is pure and unit-tested:

```
npm test
```

Ten tests cover timezone math, DST, day-off overrides, buffer blocking, notice-time cutoff,
horizon clamping, and multi-rep zone unions.

## What's not built yet (phase 2)

- Google Calendar sync (per-rep OAuth, busy-time subtraction, event creation with Meet link).
- Admin tool for adding reps, hours and locations. For now, edit rows directly in Supabase Studio.
- Reminder emails (24h and 1h before). Rows exist in the schema; a scheduled function will send them.
