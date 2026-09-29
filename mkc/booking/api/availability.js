import { rpc, json, clean, originAllowed, readJson, UUID_RE, rateLimited, clientIp } from '../lib/core.js';
import { computeAvailability } from '../lib/availability.js';

const MAX_RANGE_DAYS = 60;

async function handler(request) {
  if (!originAllowed(request)) return json(403, { error: 'Not allowed from this site.' });
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' });
  if (rateLimited(`av:${clientIp(request)}`, 240, 60_000)) return json(429, { error: 'Too many requests. Please wait a moment.' });

  const { body, error } = await readJson(request);
  if (error) return error;
  const meetingTypeId = clean(body.meetingTypeId, 64);
  const fromStr = clean(body.from, 40);
  const toStr = clean(body.to, 40);
  // Optional: a personal booking link narrows the result to one rep. This can
  // only ever remove slots from what an unfiltered call would return, so an
  // arbitrary id discloses nothing — the real check is at booking time, where
  // the rep must genuinely be free before an appointment is written.
  const repId = clean(body.repId, 64);
  if (!UUID_RE.test(meetingTypeId)) return json(400, { error: 'Bad meeting type.' });
  if (repId && !UUID_RE.test(repId)) return json(400, { error: 'Bad rep.' });
  const from = new Date(fromStr).getTime();
  const to = new Date(toStr).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return json(400, { error: 'Bad date range.' });
  if (to - from > MAX_RANGE_DAYS * 86400_000) return json(400, { error: 'That range is too wide.' });

  try {
    let inputs = await rpc('booking', 'get_availability_inputs', {
      p_meeting_type_id: meetingTypeId,
      p_from: new Date(from).toISOString(),
      p_to: new Date(to).toISOString()
    });
    if (!inputs || !inputs.meeting_type) return json(404, { error: 'That meeting type isn’t available.' });

    if (repId) {
      const scoped = (inputs.reps || []).filter((r) => r.person_id === repId);
      if (scoped.length === 0) return json(200, { days: [], repUnavailable: true });
      inputs = { ...inputs, reps: scoped };
    }

    const result = computeAvailability(inputs, from, to);
    return json(200, result);
  } catch (e) {
    console.error('availability failed', e.message);
    return json(500, { error: e.message.includes('is not fully configured') ? e.message : 'Couldn’t load times. Please try again.' });
  }
}

export default { fetch: handler };
