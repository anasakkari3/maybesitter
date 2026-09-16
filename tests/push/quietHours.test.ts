/**
 * Quiet hours mean the user's wall clock, on every day of the year (UC-3.0b, #184).
 *
 * ── Why this is a sweep and not a table of instants ──────────────
 *
 * A table of "22:30 Jerusalem is inside" cases passes against an
 * implementation that ignores the zone entirely, whenever the host happens to
 * *be* in that zone — which is how a timezone bug already shipped past a green
 * suite here (#382, audit 2026-09-14). So this file never writes an expected
 * answer down. It recomputes the wall clock independently, from
 * `wallClockAt`, and asserts the two agree at every quarter hour across three
 * days that contain a real clock change.
 *
 * `Pacific/Chatham` is in here for the same reason: its offset is +12:45, no
 * CI host runs in it, and its answers must differ from UTC's. If they did not,
 * the zone argument would be decorative and this file would prove nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isInQuietHours, NO_QUIET_HOURS, readQuietHours } from '../../lib/push/quietHours.ts';
import { wallClockAt, zoneOffsetMs } from '../../lib/planning/shared/time.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { saveRoutineProfile } from '../../lib/services/mobile/routineProfileService.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import type { RoutineTimeWindow } from '../../src/contracts/v1/routineContracts.ts';

const QUARTER_HOUR = 15 * 60 * 1000;

/** The window under test: it wraps midnight, which is the normal case. */
const NIGHT: RoutineTimeWindow = { start: '22:00', end: '07:00' };
/** One that does not wrap, so the other branch is exercised too. */
const AFTERNOON: RoutineTimeWindow = { start: '13:00', end: '15:30' };

function minutesOf(window: RoutineTimeWindow, part: 'start' | 'end'): number {
  const [hour, minute] = window[part].split(':').map(Number);
  return hour * 60 + minute;
}

/** The answer, derived from the clock face rather than from the module under test. */
function expected(window: RoutineTimeWindow, epochMs: number, zone: string): boolean {
  const clock = wallClockAt(epochMs, zone);
  const minutes = clock.hour * 60 + clock.minute;
  const start = minutesOf(window, 'start');
  const end = minutesOf(window, 'end');
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function sweep(fromIso: string, days: number): number[] {
  const start = Date.parse(fromIso);
  const stops: number[] = [];
  for (let at = start; at < start + days * 86_400_000; at += QUARTER_HOUR) stops.push(at);
  return stops;
}

/** Both Israeli transitions in 2026, so neither direction is assumed. */
const DST_SPANS = [
  { label: 'spring forward', from: '2026-03-26T00:00:00.000Z' },
  { label: 'autumn back', from: '2026-10-24T00:00:00.000Z' },
];

for (const span of DST_SPANS) {
  for (const window of [NIGHT, AFTERNOON]) {
    test(`Asia/Jerusalem ${span.label}: ${window.start}-${window.end} follows the wall clock`, () => {
      const stops = sweep(span.from, 3);
      const offsets = new Set(stops.map((at) => zoneOffsetMs(at, 'Asia/Jerusalem')));
      assert.equal(offsets.size, 2, 'this span does not contain a clock change, so it proves nothing about DST');

      let inside = 0;
      for (const at of stops) {
        const actual = isInQuietHours({ window, timezone: 'Asia/Jerusalem' }, new Date(at));
        assert.equal(
          actual,
          expected(window, at, 'Asia/Jerusalem'),
          `disagreed at ${new Date(at).toISOString()}`,
        );
        if (actual) inside += 1;
      }
      assert.ok(inside > 0 && inside < stops.length, 'the sweep was entirely inside or entirely outside');
    });
  }
}

test('a zone no host runs in is actually used, not ignored', () => {
  // +12:45. If the zone argument were dropped, every answer here would equal
  // the UTC answer and this assertion would fail.
  const stops = sweep('2026-09-14T00:00:00.000Z', 1);
  const chatham = stops.map((at) => isInQuietHours({ window: NIGHT, timezone: 'Pacific/Chatham' }, new Date(at)));
  const utc = stops.map((at) => isInQuietHours({ window: NIGHT, timezone: 'UTC' }, new Date(at)));
  assert.notDeepEqual(chatham, utc, 'the answer did not depend on the zone');

  stops.forEach((at, index) => {
    assert.equal(chatham[index], expected(NIGHT, at, 'Pacific/Chatham'), `disagreed at ${new Date(at).toISOString()}`);
  });
});

test('an account with no window is never quiet', () => {
  for (const at of sweep('2026-09-14T00:00:00.000Z', 1)) {
    assert.equal(isInQuietHours(NO_QUIET_HOURS, new Date(at)), false);
  }
});

test('the window is read from the routine profile, which is where the survey writes it', async () => {
  const storage = createMemoryStorage();
  const uid = 'quietHoursUser';
  await storage.set(userDoc(uid), { timezone: 'Europe/Berlin' });

  // Nothing stored yet: no window, and the account's own zone as the fallback.
  const before = await readQuietHours(uid, { storage });
  assert.equal(before.window, null);
  assert.equal(before.timezone, 'Europe/Berlin');

  await saveRoutineProfile(uid, {
    timezone: 'Pacific/Chatham',
    sleepWindow: null,
    focusWindows: [],
    fixedCommitmentWindows: [],
    preferredReminderIntensity: 'softAwareness',
    quietHours: NIGHT,
    surveySkipped: false,
  }, '2026-09-14T09:00:00.000Z', { storage });

  const after = await readQuietHours(uid, { storage });
  assert.deepEqual(after.window, NIGHT);
  // The profile's zone, not the account's: the window is wall-clock in the
  // zone it was answered in.
  assert.equal(after.timezone, 'Pacific/Chatham');
});
