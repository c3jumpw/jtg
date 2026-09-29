// Availability engine.
//
// Given one meeting type, its active reps, their weekly hours, per-date overrides,
// and confirmed appointments in the range, compute the time slots a visitor can pick.
// A slot is bookable if AT LEAST ONE rep is free for the whole meeting (with the type's
// before/after buffers) at that moment. The picked rep is chosen at booking time.
//
// All math is done in ISO-8601 UTC strings; the DOM does the visitor's timezone.
// Working in UTC avoids DST bugs across the rep/visitor boundary.

// Reps live in a named IANA timezone; we need to translate 09:00 in America/New_York
// on a given date into a UTC millisecond, and vice versa. Node's built-in Intl DateTimeFormat
// gives us the parts we need without an extra dependency.

const CACHED_FMT = new Map();
function fmt(timezone) {
  let f = CACHED_FMT.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    CACHED_FMT.set(timezone, f);
  }
  return f;
}

// Return {y,m,d,h,mi,s} of a given UTC ms in the given IANA zone.
export function partsInZone(ms, timezone) {
  const parts = fmt(timezone).formatToParts(new Date(ms));
  const g = (t) => parts.find((p) => p.type === t)?.value || '';
  return {
    y: +g('year'), m: +g('month'), d: +g('day'),
    h: +g('hour') % 24, mi: +g('minute'), s: +g('second')
  };
}

// Find the UTC ms whose local wall clock in `timezone` equals the given y/m/d/h/mi.
// Two-step correction handles DST cleanly.
export function utcMsFromZoned(timezone, y, m, d, h, mi) {
  const guess = Date.UTC(y, m - 1, d, h, mi, 0);
  const seen = partsInZone(guess, timezone);
  const seenUtc = Date.UTC(seen.y, seen.m - 1, seen.d, seen.h, seen.mi, 0);
  return guess - (seenUtc - guess);
}

// 0 = Sunday, 6 = Saturday, matching our availability_rules.weekday column.
export function weekdayInZone(ms, timezone) {
  const p = partsInZone(ms, timezone);
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
}

function isoDateInZone(ms, timezone) {
  const p = partsInZone(ms, timezone);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

// "HH:MM" -> minutes since midnight (returns null on bad input).
function timeToMinutes(str) {
  if (!/^\d{1,2}:\d{2}$/.test(str || '')) return null;
  const [h, m] = str.split(':').map(Number);
  if (h < 0 || h > 24 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

// Round a Date UP to the next multiple of `stepMin` minutes (used for min-notice cutoff).
function ceilToStep(ms, stepMin) {
  const stepMs = stepMin * 60000;
  return Math.ceil(ms / stepMs) * stepMs;
}

/**
 * Compute the union of open slots across all reps.
 *
 * @param {Object} inputs From booking.get_availability_inputs():
 *   meeting_type: {id, duration_min, buffer_before_min, buffer_after_min, min_notice_hours, max_days_ahead, slot_step_min}
 *   reps:      [{person_id, timezone, weight}]
 *   rules:     [{rep_id, weekday, start_time, end_time}]        // HH:MM strings, in rep tz
 *   overrides: [{rep_id, on_date, start_time, end_time}]         // strings null=off day
 *   busy:      [{rep_id, starts_at, ends_at}]                    // ISO UTC strings (confirmed appts)
 * @param {number} fromMs, toMs  Range in UTC ms (visitor asks day-by-day; server clamps to policy).
 * @param {number} nowMs         Current time in UTC ms.
 * @returns {{days: Array<{date:string, slots:Array<{start:string, end:string, repIds:string[]}>}>}}
 */
export function computeAvailability(inputs, fromMs, toMs, nowMs = Date.now()) {
  const mt = inputs.meeting_type;
  if (!mt) return { days: [] };

  const duration = mt.duration_min * 60000;
  const bufBefore = mt.buffer_before_min * 60000;
  const bufAfter = mt.buffer_after_min * 60000;
  const step = mt.slot_step_min * 60000;
  const noticeCutoff = nowMs + mt.min_notice_hours * 3600000;
  const horizon = nowMs + mt.max_days_ahead * 86400000;

  // Clamp the request to policy.
  const rangeStart = Math.max(fromMs, noticeCutoff);
  const rangeEnd = Math.min(toMs, horizon);
  if (rangeStart >= rangeEnd) return { days: [] };

  // Group inputs by rep for cheap lookup during the sweep.
  const rulesByRep = new Map(); // rep_id -> Map(weekday -> [{start,end}])
  for (const r of inputs.rules || []) {
    const s = timeToMinutes(r.start_time), e = timeToMinutes(r.end_time);
    if (s == null || e == null || e <= s) continue;
    if (!rulesByRep.has(r.rep_id)) rulesByRep.set(r.rep_id, new Map());
    const wd = rulesByRep.get(r.rep_id);
    if (!wd.has(r.weekday)) wd.set(r.weekday, []);
    wd.get(r.weekday).push({ start: s, end: e });
  }

  const overridesByRepDate = new Map(); // rep_id -> Map(YYYY-MM-DD -> [{start,end}]) ; empty array = day off
  for (const o of inputs.overrides || []) {
    if (!overridesByRepDate.has(o.rep_id)) overridesByRepDate.set(o.rep_id, new Map());
    const d = overridesByRepDate.get(o.rep_id);
    const key = typeof o.on_date === 'string' ? o.on_date.slice(0, 10) : new Date(o.on_date).toISOString().slice(0, 10);
    if (!d.has(key)) d.set(key, []);
    if (o.start_time && o.end_time) {
      const s = timeToMinutes(o.start_time), e = timeToMinutes(o.end_time);
      if (s != null && e != null && e > s) d.get(key).push({ start: s, end: e });
    } // else: null/null means the whole day is off — leaves an empty windows array in place
  }

  const busyByRep = new Map(); // rep_id -> sorted [{start,end}] in UTC ms
  for (const b of inputs.busy || []) {
    const start = new Date(b.starts_at).getTime(), end = new Date(b.ends_at).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (!busyByRep.has(b.rep_id)) busyByRep.set(b.rep_id, []);
    busyByRep.get(b.rep_id).push({ start, end });
  }
  for (const arr of busyByRep.values()) arr.sort((a, b) => a.start - b.start);

  const reps = (inputs.reps || []).filter((r) => rulesByRep.has(r.person_id) || overridesByRepDate.has(r.person_id));
  if (reps.length === 0) return { days: [] };

  // Walk day by day IN EACH REP'S OWN TIMEZONE so weekly rules and overrides line up with real local days.
  // We then intersect the resulting UTC slots into a single "available if any rep is free" list per day.
  // For a single-rep team (the common case at launch) this is just that rep's list.

  // Build a set of visitor-facing dates to return, keyed by the visitor's local time zone if we want to
  // display them under the visitor's day. Simplest: bucket by rep's date, then merge across reps into a
  // single sorted stream and re-bucket by UTC date at the end. Tools usually pick the rep's day; we do
  // the same by keying the result on the rep's local date. If two reps in different zones produce
  // overlapping days, we merge under the earliest date they appear on.

  const slotIndex = new Map(); // ISO-date -> Map(startMs -> Set(repIds))

  for (const rep of reps) {
    const tz = rep.timezone;
    const rulesForRep = rulesByRep.get(rep.person_id) || new Map();
    const overridesForRep = overridesByRepDate.get(rep.person_id) || new Map();
    const busyForRep = busyByRep.get(rep.person_id) || [];

    // Iterate rep-local days from rangeStart to rangeEnd.
    let cursorMs = rangeStart;
    while (cursorMs < rangeEnd) {
      const date = isoDateInZone(cursorMs, tz);
      const p = partsInZone(cursorMs, tz);
      const weekday = weekdayInZone(cursorMs, tz);

      let windows;
      if (overridesForRep.has(date)) {
        windows = overridesForRep.get(date);
      } else {
        windows = rulesForRep.get(weekday) || [];
      }

      for (const w of windows) {
        // Convert window bounds (rep-local HH:MM on this rep-local date) to UTC ms.
        const winStart = utcMsFromZoned(tz, p.y, p.m, p.d, Math.floor(w.start / 60), w.start % 60);
        const winEnd = utcMsFromZoned(tz, p.y, p.m, p.d, Math.floor(w.end / 60), w.end % 60);

        // Slot start times sit on the step grid inside the window; the meeting + buffers must fit.
        const firstStart = Math.max(winStart, ceilToStep(rangeStart, mt.slot_step_min));
        const lastStart = Math.min(winEnd, rangeEnd) - duration;
        for (let s = firstStart; s <= lastStart; s += step) {
          const slotStart = s;
          const slotEnd = s + duration;
          const guardStart = slotStart - bufBefore;
          const guardEnd = slotEnd + bufAfter;

          if (slotStart < noticeCutoff) continue;

          // Existing bookings are treated as if they own the same before/after buffer
          // as the current meeting type. This keeps consecutive meetings from crowding
          // the rep even when the earlier meeting didn't store its own buffer config.
          let clash = false;
          for (const b of busyForRep) {
            if (b.end + bufAfter  <= guardStart) continue;   // existing ends fully before mine begins
            if (b.start - bufBefore >= guardEnd)   break;    // existing starts fully after mine ends (list is sorted)
            clash = true; break;
          }
          if (clash) continue;

          // We bucket the slot under the REP's local day, because that's how the rep sees it.
          const slotDate = isoDateInZone(slotStart, tz);
          if (!slotIndex.has(slotDate)) slotIndex.set(slotDate, new Map());
          const bucket = slotIndex.get(slotDate);
          if (!bucket.has(slotStart)) bucket.set(slotStart, new Set());
          bucket.get(slotStart).add(rep.person_id);
        }
      }

      // Advance to the next local day. We nudge by 24h + a small epsilon to survive DST gaps.
      cursorMs = utcMsFromZoned(tz, p.y, p.m, p.d + 1, 0, 1);
      if (cursorMs <= partsInZone(cursorMs, tz).y * 0 + rangeStart) cursorMs = rangeStart + 86400000; // paranoia
    }
  }

  const days = [];
  for (const [date, slots] of [...slotIndex.entries()].sort()) {
    const list = [...slots.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ms, repIds]) => ({
        start: new Date(ms).toISOString(),
        end: new Date(ms + duration).toISOString(),
        repIds: [...repIds]
      }));
    days.push({ date, slots: list });
  }
  return { days };
}

// Round-robin-lite: pick the rep with the smallest recent-booking count who's on the offered list.
// Falls back to the first rep so we never fail to assign.
export function pickRep(offeredRepIds, recentCountByRep) {
  let best = offeredRepIds[0];
  let bestScore = recentCountByRep.get(best) ?? 0;
  for (const id of offeredRepIds) {
    const c = recentCountByRep.get(id) ?? 0;
    if (c < bestScore) { best = id; bestScore = c; }
  }
  return best;
}
