import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAvailability, partsInZone, utcMsFromZoned, weekdayInZone } from '../lib/availability.js';

// Helper to build a rep + rules quickly.
const rep = { person_id: 'r1', timezone: 'America/New_York', weight: 1 };
const mt = {
  id: 'mt1', mode: 'virtual', duration_min: 30,
  buffer_before_min: 0, buffer_after_min: 10,
  min_notice_hours: 0, max_days_ahead: 45, slot_step_min: 30
};
const weekdays = [1, 2, 3, 4, 5]; // Mon-Fri
const nineToFive = weekdays.map((wd) => ({ rep_id: 'r1', weekday: wd, start_time: '09:00', end_time: '17:00' }));

test('timezone helpers translate wall clock to UTC and back', () => {
  const ms = utcMsFromZoned('America/New_York', 2026, 3, 5, 9, 0); // 09:00 EST on a Thursday
  const p = partsInZone(ms, 'America/New_York');
  assert.deepEqual([p.y, p.m, p.d, p.h, p.mi], [2026, 3, 5, 9, 0]);
  assert.equal(weekdayInZone(ms, 'America/New_York'), 4);
});

test('DST spring-forward: 09:00 EST -> 09:00 EDT converts consistently', () => {
  // 2026-03-08 is DST start in the US (clocks jump 02:00 EST -> 03:00 EDT).
  const before = utcMsFromZoned('America/New_York', 2026, 3, 6, 9, 0); // EST
  const after  = utcMsFromZoned('America/New_York', 2026, 3, 9, 9, 0); // EDT (Monday after)
  const beforeParts = partsInZone(before, 'America/New_York');
  const afterParts  = partsInZone(after,  'America/New_York');
  assert.equal(beforeParts.h, 9); assert.equal(afterParts.h, 9);
  // Real UTC gap: 3 days minus 1 hour, because we spring forward.
  const gapHours = (after - before) / 3600000;
  assert.equal(gapHours, 3 * 24 - 1);
});

test('happy path: 9-5 Mon-Fri, 30-min slots, no notice, no busy -> 16 slots per weekday', () => {
  // Monday 2026-03-09 through Friday 2026-03-13 (5 working days).
  const from = utcMsFromZoned('America/New_York', 2026, 3, 9,  0, 0);
  const to   = utcMsFromZoned('America/New_York', 2026, 3, 14, 0, 0);
  const now  = utcMsFromZoned('America/New_York', 2026, 3, 1,  0, 0);
  const out = computeAvailability({ meeting_type: mt, reps: [rep], rules: nineToFive, overrides: [], busy: [] }, from, to, now);
  assert.equal(out.days.length, 5);
  for (const d of out.days) {
    // 09:00, 09:30, ... 16:30 = 16 slot starts.
    assert.equal(d.slots.length, 16, `${d.date} had ${d.slots.length} slots`);
    assert.equal(new Date(d.slots[0].start).getTime(), utcMsFromZoned('America/New_York', ...d.date.split('-').map(Number), 9, 0));
    assert.equal(d.slots[0].repIds[0], 'r1');
  }
});

test('weekend day yields no slots', () => {
  const from = utcMsFromZoned('America/New_York', 2026, 3, 14, 0, 0); // Sat
  const to   = utcMsFromZoned('America/New_York', 2026, 3, 15, 0, 0);
  const out = computeAvailability({ meeting_type: mt, reps: [rep], rules: nineToFive, overrides: [], busy: [] }, from, to, from - 86400000);
  assert.equal(out.days.length, 0);
});

test('busy appointment blocks its slot AND the buffer_after window that follows', () => {
  // 30-min meeting at 10:00 with 10-min after-buffer blocks 09:30 (ends 10:00 in the buffer), 10:00, 10:30 (starts within buffer? no, buffer ends 10:40).
  // The 10:30 slot starts 10:30 which is inside the buffer 10:30-10:40, so it should be blocked.
  const from = utcMsFromZoned('America/New_York', 2026, 3, 9, 0, 0);
  const to   = utcMsFromZoned('America/New_York', 2026, 3, 10, 0, 0);
  const busyStart = utcMsFromZoned('America/New_York', 2026, 3, 9, 10, 0);
  const busyEnd   = utcMsFromZoned('America/New_York', 2026, 3, 9, 10, 30);
  const out = computeAvailability({
    meeting_type: mt, reps: [rep], rules: nineToFive, overrides: [],
    busy: [{ rep_id: 'r1', starts_at: new Date(busyStart).toISOString(), ends_at: new Date(busyEnd).toISOString() }]
  }, from, to, from - 86400000);
  assert.equal(out.days.length, 1);
  const starts = out.days[0].slots.map((s) => new Date(s.start).toISOString());
  // 10:00 (busy itself) and 10:30 (inside buffer to 10:40) should be missing.
  assert.ok(!starts.some((s) => s.endsWith('T14:00:00.000Z')), '10:00 EST slot must be blocked');
  assert.ok(!starts.some((s) => s.endsWith('T14:30:00.000Z')), '10:30 EST slot must be blocked by buffer');
  // 09:30 has a 30-min meeting ending at 10:00, which is inside the buffer (guard runs to 10:40); blocked too.
  assert.ok(!starts.some((s) => s.endsWith('T13:30:00.000Z')), '09:30 EST slot ends at 10:00, inside the buffer, blocked');
  // 11:00 should be fine.
  assert.ok(starts.some((s) => s.endsWith('T15:00:00.000Z')), '11:00 EST slot should be available');
});

test('override for a date replaces the weekly rule for that date only', () => {
  const from = utcMsFromZoned('America/New_York', 2026, 3, 10, 0, 0); // Tuesday
  const to   = utcMsFromZoned('America/New_York', 2026, 3, 11, 0, 0);
  const out = computeAvailability({
    meeting_type: mt, reps: [rep], rules: nineToFive,
    overrides: [{ rep_id: 'r1', on_date: '2026-03-10', start_time: '13:00', end_time: '15:00' }],
    busy: []
  }, from, to, from - 86400000);
  const starts = out.days[0].slots.map((s) => partsInZone(new Date(s.start).getTime(), 'America/New_York'));
  assert.deepEqual(starts.map((p) => `${p.h}:${p.mi}`), ['13:0', '13:30', '14:0', '14:30']);
});

test('null-time override marks the whole day off', () => {
  const from = utcMsFromZoned('America/New_York', 2026, 3, 10, 0, 0);
  const to   = utcMsFromZoned('America/New_York', 2026, 3, 11, 0, 0);
  const out = computeAvailability({
    meeting_type: mt, reps: [rep], rules: nineToFive,
    overrides: [{ rep_id: 'r1', on_date: '2026-03-10', start_time: null, end_time: null }],
    busy: []
  }, from, to, from - 86400000);
  assert.equal(out.days.length, 0);
});

test('min_notice_hours pushes the first bookable slot forward', () => {
  const from = utcMsFromZoned('America/New_York', 2026, 3, 9, 0, 0);
  const to   = utcMsFromZoned('America/New_York', 2026, 3, 10, 0, 0);
  const now  = utcMsFromZoned('America/New_York', 2026, 3, 9, 8, 0); // 08:00 EST same day
  const noticed = { ...mt, min_notice_hours: 4 }; // must be booked >= 4h out
  const out = computeAvailability({ meeting_type: noticed, reps: [rep], rules: nineToFive, overrides: [], busy: [] }, from, to, now);
  const starts = out.days[0].slots.map((s) => partsInZone(new Date(s.start).getTime(), 'America/New_York'));
  assert.equal(starts[0].h, 12, 'first slot must be at 12:00 or later');
});

test('two reps in different timezones: slots are the UNION', () => {
  const repEast = { person_id: 'east', timezone: 'America/New_York', weight: 1 };
  const repWest = { person_id: 'west', timezone: 'America/Los_Angeles', weight: 1 };
  const rules = [
    ...nineToFive.map((r) => ({ ...r, rep_id: 'east' })),
    ...weekdays.map((wd) => ({ rep_id: 'west', weekday: wd, start_time: '09:00', end_time: '17:00' }))
  ];
  const from = utcMsFromZoned('America/New_York', 2026, 3, 9, 0, 0);
  const to   = utcMsFromZoned('America/New_York', 2026, 3, 10, 0, 0);
  const out = computeAvailability({ meeting_type: mt, reps: [repEast, repWest], rules, overrides: [], busy: [] }, from, to, from - 86400000);
  const day = out.days.find((d) => d.date === '2026-03-09');
  assert.ok(day, 'a Monday must be present');
  // First slot should be 09:00 EST (repEast). Last should be 17:00 PST = 20:00 EST (repWest ends 17:00 local, last start = 16:30 PST = 19:30 EST).
  const firstEast = utcMsFromZoned('America/New_York', 2026, 3, 9, 9, 0);
  const lastWest  = utcMsFromZoned('America/Los_Angeles', 2026, 3, 9, 16, 30);
  const startTimes = day.slots.map((s) => new Date(s.start).getTime());
  assert.equal(startTimes[0], firstEast);
  assert.ok(startTimes[startTimes.length - 1] >= lastWest, 'west-coast slot should extend the range');
  // At exactly noon EST both reps should be free.
  const noonEast = utcMsFromZoned('America/New_York', 2026, 3, 9, 12, 0);
  const noonSlot = day.slots.find((s) => new Date(s.start).getTime() === noonEast);
  assert.ok(noonSlot); assert.deepEqual(new Set(noonSlot.repIds), new Set(['east', 'west']));
});

test('max_days_ahead clamps the horizon', () => {
  const now  = utcMsFromZoned('America/New_York', 2026, 3, 1, 0, 0);
  const far  = now + 90 * 86400000;
  const capped = { ...mt, max_days_ahead: 3 };
  const out = computeAvailability({ meeting_type: capped, reps: [rep], rules: nineToFive, overrides: [], busy: [] }, now, far, now);
  // Only 3 days from now => March 2 (Mon), 3 (Tue), 4 (Wed). Sunday Mar 1 is a weekend, skipped anyway.
  assert.ok(out.days.length <= 3);
});
