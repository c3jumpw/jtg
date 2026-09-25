import { rpc, json, clean, originAllowed } from '../lib/core.js';

async function handler(request) {
  if (!originAllowed(request)) return json(403, { error: 'Not allowed from this site.' });
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed.' });

  const url = new URL(request.url);
  const slug = clean(url.searchParams.get('slug'), 64) || 'fortune5';
  try {
    const page = await rpc('booking', 'get_public_page', { p_slug: slug });
    if (!page || !page.page) return json(404, { error: 'This booking page isn’t available.' });
    return json(200, page);
  } catch (e) {
    console.error('page fetch failed', e.message);
    return json(500, { error: e.message.includes('is not fully configured') ? e.message : 'This page isn’t available right now.' });
  }
}

export default { fetch: handler };
