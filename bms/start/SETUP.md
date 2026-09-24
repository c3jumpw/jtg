# Build My Startup — Discovery form setup notes

A conversational, multi-page intake form for Build My Startup. No database: every submission
arrives as an email, and uploaded files sit in a private Vercel Blob store.

```
browser ── start.buildmystart-up.com (static files + /api on Vercel)
   ├─ POST /api/upload   hands the browser a short-lived token; the file goes straight to Blob storage
   ├─ POST /api/submit   validates, then emails you (answers + answers.json + file links) and emails the submitter
   └─ GET  /api/file     signed, expiring download link for one uploaded file (these are the links in your email)
```

## Where things are

| Path | What it is |
| --- | --- |
| `index.html`, `css/`, `js/`, `assets/` | The site. No build step. |
| `js/questions.js` | Every page and question. Edit copy and questions here. |
| `js/config.js` | Endpoints, booking link, upload limits. |
| `js/vendor/blob-client.js` | Vercel's official upload client (bundled, loaded only on the files page). |
| `api/*.js`, `lib/*.js` | The three routes and their shared code. |
| `vercel.json` | Security headers (including the content security policy). |

## Environment variables (Vercel → Project → Settings → Environment Variables)

| Name | Example | Notes |
| --- | --- | --- |
| `BLOB_READ_WRITE_TOKEN` | set automatically | Added when the Blob store was connected |
| `DOWNLOAD_SECRET` | set | Signs the file links in your email |
| `SITE_URL` | `https://start.buildmystart-up.com` | Logo and file links in emails |
| `RESEND_API_KEY` | `re_...` | **You add this.** Sends both emails |
| `FROM_EMAIL` | `Build My Startup <hello@buildmystart-up.com>` | **You add this.** Must be on a domain verified in Resend |
| `NOTIFY_TO` | `you@buildmystart-up.com` | **You add this.** Where new submissions land |
| `BOOKING_URL` | optional | Defaults to the main site's booking anchor |

Redeploy after changing variables. Until the three Resend values are set, the form refuses submissions
with a "try again" message instead of silently losing them.

## Reading submissions

Each email to you has the readable answers, a link per uploaded file (valid about 7 days), and an
`answers.json` attachment with every raw answer. Keep the emails: they are the record. Files stay in
the private Blob store until you delete them (Vercel → Storage).

## Previews

On `github.io` and `localhost` the whole flow runs but nothing is sent or stored. On the real domain
and on `*.vercel.app` it is live.
