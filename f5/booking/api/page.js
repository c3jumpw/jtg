import { rpc, json, clean, originAllowed } from '../lib/core.js';

/* Serves the booking page's configuration.
 *
 * With ?rep=<slug> this becomes a personal booking link: the page is scoped to
 * one rep, and the meeting types are narrowed to the ones that rep actually
 * takes on this page. A slug that doesn't resolve returns the page anyway with
 * a `repError` describing why, so the visitor lands on a working team page
 * instead of a dead end — a stale link in someone's email signature should
 * still get a meeting booked. */

async function handler(request) {
  if (!originAllowed(request)) return json(403, { error: 'Not allowed from this site.' });
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed.' });

  const url = new URL(request.url);
  const slug = clean(url.searchParams.get('slug'), 64) || 'fortune5';
  const repSlug = clean(url.searchParams.get('rep'), 80);

  try {
    const page = await rpc('booking', 'get_public_page', { p_slug: slug });
    if (!page || !page.page) return json(404, { error: 'This booking page isn’t available.' });

    if (!repSlug) return json(200, page);

    const resolved = await rpc('booking', 'resolve_rep_link', { p_page_slug: slug, p_rep_slug: repSlug });
    if (!resolved || resolved.ok !== true) {
      return json(200, {
        ...page,
        repError: {
          reason: (resolved && resolved.reason) || 'not_found',
          displayName: (resolved && resolved.display_name) || null
        }
      });
    }

    // Narrow to what this rep offers here, so a visitor can't pick a meeting
    // type they don't take and then find no times behind it.
    const allowed = new Set(resolved.meetingTypeIds || []);
    const meetingTypes = (page.meeting_types || []).filter((mt) => allowed.has(mt.id));

    return json(200, { ...page, meeting_types: meetingTypes, rep: resolved.rep });
  } catch (e) {
    console.error('page fetch failed', e.message);
    return json(500, { error: e.message.includes('is not fully configured') ? e.message : 'This page isn’t available right now.' });
  }
}

export default { fetch: handler };
