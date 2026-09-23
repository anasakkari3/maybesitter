/**
 * Deterministic memory growth: the rules themselves (UC-3.16, #202).
 *
 * Pure functions over what the user did, with no model, no titles and no
 * clock. Each case states its "now" and its zone, so nothing here depends on
 * the date the suite runs or the zone of the machine running it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  R1_FOCUS_WINDOW,
  R1_LOOKBACK_DAYS,
  R2_DEFER_DEFAULT,
  R2_LOOKBACK_DAYS,
  R3_LOOKBACK_DAYS,
  R3_PLAN_TIME,
  deferDefaultFingerprint,
  focusWindowFingerprint,
  parseDeferDefaultFingerprint,
  parseFocusWindowFingerprint,
  parsePlanTimeFingerprint,
  planTimeFingerprint,
  suggestDeferDefault,
  suggestFocusWindow,
  suggestPlanTime,
  type CompletionObservation,
  type DeferObservation,
  type PlanOpenObservation,
} from '../../lib/memoryGrowth/rules.ts';

const NOW = '2026-09-16T18:00:00.000Z';
const ZONE = 'Asia/Jerusalem'; // UTC+3 in September

/** A completion at a local wall-clock time, `daysAgo` days before NOW. */
function completionAt(id: string, daysAgo: number, localHHMM: string, zoneOffsetHours = 3): CompletionObservation {
  const [hour, minute] = localHHMM.split(':').map(Number);
  const day = new Date(Date.parse(NOW) - daysAgo * 86_400_000);
  const utc = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour! - zoneOffsetHours, minute!);
  return { id, at: new Date(utc).toISOString(), commitmentId: `c_${id}` };
}

/** Ten completions: seven between 09:00 and 12:00, three in the evening. */
function tenWithSevenInTheMorning(): CompletionObservation[] {
  return [
    completionAt('e01', 1, '09:15'),
    completionAt('e02', 2, '09:40'),
    completionAt('e03', 3, '10:00'),
    completionAt('e04', 5, '10:30'),
    completionAt('e05', 6, '11:00'),
    completionAt('e06', 8, '11:20'),
    completionAt('e07', 9, '11:45'),
    completionAt('e08', 4, '19:00'),
    completionAt('e09', 7, '20:30'),
    completionAt('e10', 10, '21:10'),
  ];
}

test('ten completions with seven between 09:00 and 12:00 yield the R1 suggestion', () => {
  const suggestion = suggestFocusWindow(tenWithSevenInTheMorning(), ZONE, NOW);
  assert.ok(suggestion, 'the issue’s own fixture must produce a suggestion');
  assert.equal(suggestion.ruleId, R1_FOCUS_WINDOW);
  assert.deepEqual(suggestion.window, { start: '09:00', end: '12:00' });
  assert.equal(suggestion.fingerprint, 'R1_focus_window:09:00-12:00');
  assert.equal(suggestion.matchingCount, 7);
  assert.equal(suggestion.totalCount, 10);
  assert.equal(suggestion.confidence, 0.7);
  assert.deepEqual([...suggestion.evidenceIds].sort(), ['e01', 'e02', 'e03', 'e04', 'e05', 'e06', 'e07']);
});

test('seven completions yield nothing, however concentrated they are', () => {
  const seven = tenWithSevenInTheMorning().slice(0, 7);
  assert.equal(suggestFocusWindow(seven, ZONE, NOW), null);
  // And the eighth, in the same window, is what crosses the threshold.
  const eight = [...seven, completionAt('e11', 11, '10:10')];
  assert.ok(suggestFocusWindow(eight, ZONE, NOW));
});

test('below sixty percent in any three-hour window yields nothing', () => {
  // Six of ten inside 09-12 is exactly 60% and counts; five of ten does not.
  const base = tenWithSevenInTheMorning();
  const sixOfTen = [...base.slice(0, 6), completionAt('x1', 12, '15:00'), ...base.slice(7)];
  assert.equal(suggestFocusWindow(sixOfTen, ZONE, NOW)?.confidence, 0.6);
  const fiveOfTen = [...base.slice(0, 5), completionAt('x1', 12, '15:00'), completionAt('x2', 13, '16:10'), ...base.slice(7)];
  assert.equal(suggestFocusWindow(fiveOfTen, ZONE, NOW), null);
});

test('only the last 28 days count', () => {
  const base = tenWithSevenInTheMorning();
  // Push three of the morning completions just past the lookback: 4 of 7 left.
  const aged = base.map((event, index) => (index < 3
    ? completionAt(event.id, R1_LOOKBACK_DAYS + 1, '10:00')
    : event));
  assert.equal(suggestFocusWindow(aged, ZONE, NOW), null);
  // A completion "in the future" relative to now is not an observation either.
  const future = [...base.slice(0, 7), completionAt('f1', -2, '10:00')];
  assert.equal(suggestFocusWindow(future, ZONE, NOW), null);
});

test('the window is read in the user’s own zone, not the server’s or UTC', () => {
  // The same instants, read in New York, fall at 02:15–04:45 — a different
  // window, and the fingerprint says so.
  const events = tenWithSevenInTheMorning();
  const jerusalem = suggestFocusWindow(events, 'Asia/Jerusalem', NOW);
  const newYork = suggestFocusWindow(events, 'America/New_York', NOW);
  assert.equal(jerusalem?.window.start, '09:00');
  assert.ok(newYork);
  assert.notEqual(newYork.fingerprint, jerusalem?.fingerprint);
  assert.deepEqual(newYork.window, { start: '02:00', end: '05:00' });
});

test('a daylight-saving change does not move a habit out of its window', () => {
  // New York leaves DST on 2026-11-01. 09:30 local is 13:30Z before and 14:30Z
  // after; reading every instant with one fixed offset would split the habit.
  const now = '2026-11-08T23:00:00.000Z';
  const before = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']
    .map((day, index) => ({ id: `b${index}`, at: `${day}T13:30:00.000Z`, commitmentId: `cb${index}` }));
  const after = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']
    .map((day, index) => ({ id: `a${index}`, at: `${day}T14:30:00.000Z`, commitmentId: `ca${index}` }));
  const suggestion = suggestFocusWindow([...before, ...after], 'America/New_York', now);
  assert.ok(suggestion);
  assert.equal(suggestion.matchingCount, 10);
  // All ten at 09:30: the window centred on them, not the earliest that holds them.
  assert.deepEqual(suggestion.window, { start: '08:00', end: '11:00' });
});

test('a commitment completed, reopened and completed again counts once', () => {
  const base = tenWithSevenInTheMorning().slice(0, 7);
  const repeats = [1, 2, 3].map((n) => ({ ...completionAt(`r${n}`, n, '10:05'), commitmentId: 'c_e01' }));
  // Seven distinct things finished, not ten.
  assert.equal(suggestFocusWindow([...base, ...repeats], ZONE, NOW), null);
});

test('the same input gives the same answer whatever order it arrives in', () => {
  const events = tenWithSevenInTheMorning();
  const forward = suggestFocusWindow(events, ZONE, NOW);
  const backward = suggestFocusWindow([...events].reverse(), ZONE, NOW);
  assert.deepEqual(backward, forward);
});

test('a window never wraps midnight, because a working window may not', () => {
  const late = Array.from({ length: 10 }, (_, index) => completionAt(`n${index}`, index + 1, index % 2 ? '23:30' : '00:30'));
  const suggestion = suggestFocusWindow(late, ZONE, NOW);
  // 23:30 and 00:30 are an hour apart on the clock and a day apart on the grid.
  assert.equal(suggestion, null);
});

test('a late habit is described as ending at the end of the day, not past it', () => {
  const late = Array.from({ length: 10 }, (_, index) => completionAt(`l${index}`, index + 1, '23:30'));
  const suggestion = suggestFocusWindow(late, ZONE, NOW);
  assert.ok(suggestion);
  assert.deepEqual(suggestion.window, { start: '21:00', end: '24:00' });
  assert.deepEqual(parseFocusWindowFingerprint(suggestion.fingerprint), suggestion.window);
});

test('the latest completion of a reopened commitment is the one that counts, in either input order', () => {
  // Five of eight distinct things in the morning is 62.5%. One of those five
  // was reopened and finished again in the evening, which makes it four of
  // eight — and no suggestion — whichever order the two events arrive in.
  const morning = ['09:10', '09:50', '10:20', '10:40', '11:30'].map((time, index) => completionAt(`m${index}`, index + 5, time));
  const evening = ['19:00', '20:00', '21:00'].map((time, index) => completionAt(`v${index}`, index + 11, time));
  const again = { ...completionAt('m0_again', 1, '20:15'), commitmentId: morning[0]!.commitmentId };
  assert.ok(suggestFocusWindow([...morning, ...evening], ZONE, NOW), 'the baseline must suggest, or this proves nothing');
  assert.equal(suggestFocusWindow([...morning, ...evening, again], ZONE, NOW), null);
  assert.equal(suggestFocusWindow([again, ...morning, ...evening], ZONE, NOW), null);
});

test('the fingerprint round-trips and refuses anything it did not write', () => {
  assert.equal(focusWindowFingerprint({ start: '09:00', end: '12:00' }), 'R1_focus_window:09:00-12:00');
  assert.deepEqual(parseFocusWindowFingerprint('R1_focus_window:09:00-12:00'), { start: '09:00', end: '12:00' });
  for (const bad of [
    '', 'R1_focus_window:9:00-12:00', 'R1_focus_window:09:00-13:00', 'R1_focus_window:22:00-01:00',
    'R2_defer_default:09:00-12:00', 'R1_focus_window:09:30-12:30', 'R1_focus_window:٠٩:٠٠-١٢:٠٠', null, 42,
  ]) {
    assert.equal(parseFocusWindowFingerprint(bad), null, `accepted ${String(bad)}`);
  }
});

// ── R2: the usual defer duration (UC-3.14, #532) ────────────────

/** A defer `daysAgo` days back that pushed the thing `durationMinutes` later. */
function deferAt(id: string, daysAgo: number, durationMinutes: number): DeferObservation {
  const at = new Date(Date.parse(NOW) - daysAgo * 86_400_000);
  return {
    id,
    at: at.toISOString(),
    postponedUntil: new Date(at.getTime() + durationMinutes * 60_000).toISOString(),
  };
}

/** Six defers: four of an hour, two of three hours. */
function sixDefersFourAtOneHour(): DeferObservation[] {
  return [
    deferAt('d01', 1, 60),
    deferAt('d02', 2, 60),
    deferAt('d03', 3, 180),
    deferAt('d04', 4, 60),
    deferAt('d05', 5, 180),
    deferAt('d06', 6, 60),
  ];
}

test('four of the last six defers at one hour yield the R2 suggestion', () => {
  const suggestion = suggestDeferDefault(sixDefersFourAtOneHour(), NOW);
  assert.ok(suggestion, 'the fixture must produce a suggestion');
  assert.equal(suggestion.ruleId, R2_DEFER_DEFAULT);
  assert.equal(suggestion.fingerprint, 'R2_defer_default:60m');
  assert.equal(suggestion.deferMinutes, 60);
  assert.equal(suggestion.matchingCount, 4);
  assert.equal(suggestion.totalCount, 6);
  assert.equal(suggestion.confidence, 0.67);
  assert.equal(suggestion.lookbackDays, R2_LOOKBACK_DAYS);
  assert.deepEqual(suggestion.evidenceIds, ['d06', 'd04', 'd02', 'd01']);
});

test('three of the last six defers at one duration yield nothing', () => {
  // The threshold is four: three of six is exactly below it.
  const three = [
    deferAt('d01', 1, 60),
    deferAt('d02', 2, 60),
    deferAt('d03', 3, 180),
    deferAt('d04', 4, 60),
    deferAt('d05', 5, 240),
    deferAt('d06', 6, 300),
  ];
  assert.equal(suggestDeferDefault(three, NOW), null);
});

test('fewer than six defers yield nothing, however uniform they are', () => {
  const five = sixDefersFourAtOneHour().slice(0, 5);
  assert.equal(suggestDeferDefault(five, NOW), null);
  const fiveUniform = [1, 2, 3, 4, 5].map((day) => deferAt(`u${day}`, day, 60));
  assert.equal(suggestDeferDefault(fiveUniform, NOW), null);
});

test('durations are bucketed to the half-hour: 45–74 minutes count as one hour', () => {
  const within = [45, 50, 65, 74].map((minutes, index) => deferAt(`b${index}`, index + 1, minutes));
  const others = [deferAt('x1', 8, 600), deferAt('x2', 9, 700)];
  const suggestion = suggestDeferDefault([...within, ...others], NOW);
  assert.ok(suggestion);
  assert.equal(suggestion.fingerprint, 'R2_defer_default:60m');
  assert.equal(suggestion.matchingCount, 4);
  // The boundaries themselves: 44 minutes is the half hour, 75 is ninety minutes.
  const fortyFour = [44, 20, 25, 30].map((minutes, index) => deferAt(`c${index}`, index + 1, minutes));
  assert.equal(suggestDeferDefault([...fortyFour, ...others], NOW)?.fingerprint, 'R2_defer_default:30m');
  const seventyFive = [75, 80, 89, 100].map((minutes, index) => deferAt(`e${index}`, index + 1, minutes));
  assert.equal(suggestDeferDefault([...seventyFive, ...others], NOW)?.fingerprint, 'R2_defer_default:90m');
  // And a defer of almost nothing rounds into the half hour rather than
  // claiming a duration of zero.
  const tenMinutes = [10, 5, 12, 1].map((minutes, index) => deferAt(`f${index}`, index + 1, minutes));
  assert.equal(suggestDeferDefault([...tenMinutes, ...others], NOW)?.fingerprint, 'R2_defer_default:30m');
});

test('only the newest six defers are counted', () => {
  const newest = sixDefersFourAtOneHour();
  // A seventh, oldest defer of a whole day changes nothing: it is out of the six.
  const withOddOldest = [deferAt('d00', 9, 1440), ...newest];
  assert.equal(suggestDeferDefault(withOddOldest, NOW)?.fingerprint, 'R2_defer_default:60m');
  // But when the newest six hold only three of a kind, an older run of the
  // same duration does not rescue the pattern.
  const patternInThePast = [
    deferAt('n1', 1, 180),
    deferAt('n2', 2, 240),
    deferAt('n3', 3, 300),
    deferAt('n4', 4, 60),
    deferAt('n5', 5, 60),
    deferAt('n6', 6, 60),
    deferAt('n7', 7, 60),
  ];
  assert.equal(suggestDeferDefault(patternInThePast, NOW), null);
});

test('only the lookback counts, and a defer in the future is not an observation', () => {
  const recent = sixDefersFourAtOneHour().slice(0, 5);
  const tooOld = deferAt('old', R2_LOOKBACK_DAYS + 1, 60);
  assert.equal(suggestDeferDefault([...recent, tooOld], NOW), null);
  const inFuture = {
    id: 'future',
    at: new Date(Date.parse(NOW) + 86_400_000).toISOString(),
    postponedUntil: new Date(Date.parse(NOW) + 2 * 86_400_000).toISOString(),
  };
  assert.equal(suggestDeferDefault([...recent, inFuture], NOW), null);
});

test('a defer with nothing to push to, or pushed backwards, is not counted', () => {
  const recent = sixDefersFourAtOneHour().slice(0, 5);
  const broken = { id: 'broken', at: new Date(Date.parse(NOW) - 86_400_000).toISOString(), postponedUntil: 'not-a-date' };
  const backwards = deferAt('backwards', 2, -60);
  assert.equal(suggestDeferDefault([...recent, broken], NOW), null);
  assert.equal(suggestDeferDefault([...recent, backwards], NOW), null);
});

test('the fingerprint is the duration, so the same habit re-keys and a changed one re-suggests', () => {
  const again = [deferAt('g1', 3, 62), deferAt('g2', 5, 58), deferAt('g3', 8, 60), deferAt('g4', 12, 47),
    deferAt('x1', 1, 400), deferAt('x2', 2, 500)];
  // Different days, different ids, the same hour: the claim is the same claim.
  assert.equal(suggestDeferDefault(again, NOW)?.fingerprint, suggestDeferDefault(sixDefersFourAtOneHour(), NOW)?.fingerprint);
  const threeHours = [1, 2, 3, 4].map((day) => deferAt(`t${day}`, day, 180));
  const moved = suggestDeferDefault([...threeHours, deferAt('y1', 5, 60), deferAt('y2', 6, 90)], NOW);
  assert.equal(moved?.fingerprint, 'R2_defer_default:180m');
  assert.notEqual(moved?.fingerprint, deferDefaultFingerprint(60));
});

test('the same defers give the same answer whatever order they arrive in', () => {
  const events = sixDefersFourAtOneHour();
  const forward = suggestDeferDefault(events, NOW);
  const backward = suggestDeferDefault([...events].reverse(), NOW);
  assert.deepEqual(backward, forward);
});

test('the R2 fingerprint round-trips and refuses anything it did not write', () => {
  assert.equal(deferDefaultFingerprint(60), 'R2_defer_default:60m');
  assert.equal(parseDeferDefaultFingerprint('R2_defer_default:60m'), 60);
  assert.equal(parseDeferDefaultFingerprint('R2_defer_default:90m'), 90);
  for (const bad of [
    '', 'R2_defer_default:60', 'R2_defer_default:60M', 'R2_defer_default:0m', 'R2_defer_default:-60m',
    'R2_defer_default:45m', 'R2_defer_default:06m', 'R1_focus_window:09:00-12:00', 'R2_defer_default:6٠m',
    null, 42, 60,
  ]) {
    assert.equal(parseDeferDefaultFingerprint(bad), null, `accepted ${String(bad)}`);
  }
});

// ── R3: the usual plan-open time (#533) ──────────────────────────

const DELIVERY = '07:30';

/** A plan opened at a local wall-clock time, `daysAgo` days before NOW. */
function openAt(id: string, daysAgo: number, localHHMM: string, zoneOffsetHours = 3): PlanOpenObservation {
  const [hour, minute] = localHHMM.split(':').map(Number);
  const day = new Date(Date.parse(NOW) - daysAgo * 86_400_000);
  const utc = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour! - zoneOffsetHours, minute!);
  const at = new Date(utc);
  const planDate = new Date(utc + zoneOffsetHours * 3_600_000).toISOString().slice(0, 10);
  return { id, at: at.toISOString(), planDate };
}

/** Seven plan days: five first opened in the 08:00 half-hour, two at 21:00. */
function sevenDaysFiveAtEight(): PlanOpenObservation[] {
  return [
    openAt('o01', 1, '08:12'),
    openAt('o02', 2, '08:26'),
    openAt('o03', 3, '21:05'),
    openAt('o04', 4, '08:04'),
    openAt('o05', 5, '21:40'),
    openAt('o06', 6, '08:29'),
    openAt('o07', 7, '08:00'),
  ];
}

test('five of the last seven plan days opened around one time yield the R3 suggestion', () => {
  const suggestion = suggestPlanTime(sevenDaysFiveAtEight(), DELIVERY, ZONE, NOW);
  assert.ok(suggestion, 'the fixture must produce a suggestion');
  assert.equal(suggestion.ruleId, R3_PLAN_TIME);
  assert.equal(suggestion.fingerprint, 'R3_plan_time:08:00');
  assert.equal(suggestion.planTime, '08:00');
  assert.equal(suggestion.matchingCount, 5);
  assert.equal(suggestion.totalCount, 7);
  assert.equal(suggestion.confidence, 0.71);
  assert.equal(suggestion.lookbackDays, R3_LOOKBACK_DAYS);
  assert.deepEqual(suggestion.evidenceIds, ['o07', 'o06', 'o04', 'o02', 'o01']);
});

test('four of the last seven plan days at one time yield nothing', () => {
  // The threshold is five: four of seven is exactly below it.
  const four = [
    openAt('o01', 1, '08:12'),
    openAt('o02', 2, '08:26'),
    openAt('o03', 3, '21:05'),
    openAt('o04', 4, '08:04'),
    openAt('o05', 5, '21:40'),
    openAt('o06', 6, '08:29'),
    openAt('o07', 7, '22:10'),
  ];
  assert.equal(suggestPlanTime(four, DELIVERY, ZONE, NOW), null);
});

test('fewer than seven opened plan days yield nothing, however uniform they are', () => {
  const six = sevenDaysFiveAtEight().slice(0, 6);
  assert.equal(suggestPlanTime(six, DELIVERY, ZONE, NOW), null);
  const sixUniform = [1, 2, 3, 4, 5, 6].map((day) => openAt(`u${day}`, day, '08:15'));
  assert.equal(suggestPlanTime(sixUniform, DELIVERY, ZONE, NOW), null);
});

test('an open within twenty minutes of the delivery is the delivery, not a habit', () => {
  // Every day opened only at 07:35, five minutes after the 07:30 delivery.
  const deliveryReads = [1, 2, 3, 4, 5, 6, 7].map((day) => openAt(`r${day}`, day, '07:35'));
  assert.equal(suggestPlanTime(deliveryReads, DELIVERY, ZONE, NOW), null);
  // The boundary itself: twenty minutes away is still the delivery.
  const atBoundary = [1, 2, 3, 4, 5, 6, 7].map((day) => openAt(`b${day}`, day, '07:50'));
  assert.equal(suggestPlanTime(atBoundary, DELIVERY, ZONE, NOW), null);
  // One minute past it counts.
  const pastBoundary = [1, 2, 3, 4, 5, 6, 7].map((day) => openAt(`p${day}`, day, '07:51'));
  assert.equal(suggestPlanTime(pastBoundary, DELIVERY, ZONE, NOW)?.fingerprint, 'R3_plan_time:07:30');
  // And the window wraps midnight: a 00:10 delivery makes 23:55 a delivery read.
  const acrossMidnight = [1, 2, 3, 4, 5, 6, 7].map((day) => openAt(`m${day}`, day, '23:55'));
  assert.equal(suggestPlanTime(acrossMidnight, '00:10', ZONE, NOW), null);
});

test('a day opened at the delivery and again later counts at the later time', () => {
  const days = [1, 2, 3, 4, 5, 6, 7].flatMap((day) => [
    openAt(`d${day}_delivery`, day, '07:32'),
    openAt(`d${day}_later`, day, '12:10'),
  ]);
  const suggestion = suggestPlanTime(days, DELIVERY, ZONE, NOW);
  assert.equal(suggestion?.fingerprint, 'R3_plan_time:12:00');
  assert.equal(suggestion?.matchingCount, 7);
});

test('the first open of the day counts, and reopening all evening cannot move it', () => {
  const days = [1, 2, 3, 4, 5, 6, 7].flatMap((day) => [
    openAt(`f${day}`, day, '08:10'),
    openAt(`s${day}_1`, day, '19:00'),
    openAt(`s${day}_2`, day, '20:00'),
    openAt(`s${day}_3`, day, '21:00'),
  ]);
  const suggestion = suggestPlanTime(days, DELIVERY, ZONE, NOW);
  assert.equal(suggestion?.fingerprint, 'R3_plan_time:08:00');
  assert.equal(suggestion?.matchingCount, 7);
  assert.equal(suggestion?.totalCount, 7);
});

test('only the newest seven plan days are counted', () => {
  const newest = sevenDaysFiveAtEight();
  // An eighth, oldest day at a different time is out of the seven.
  const withOddOldest = [...newest, openAt('o00', 9, '15:00')];
  assert.equal(suggestPlanTime(withOddOldest, DELIVERY, ZONE, NOW)?.fingerprint, 'R3_plan_time:08:00');
  // But when the newest seven hold only four of a kind, an older run of the
  // same time does not rescue the pattern.
  const patternInThePast = [
    openAt('n1', 1, '21:00'),
    openAt('n2', 2, '21:20'),
    openAt('n3', 3, '19:40'),
    openAt('n4', 4, '08:10'),
    openAt('n5', 5, '08:20'),
    openAt('n6', 6, '08:05'),
    openAt('n7', 7, '08:15'),
    openAt('n8', 8, '08:25'),
    openAt('n9', 9, '08:10'),
  ];
  assert.equal(suggestPlanTime(patternInThePast, DELIVERY, ZONE, NOW), null);
});

test('only the lookback counts, and an open in the future is not an observation', () => {
  const recent = [1, 2, 3, 4, 5, 6].map((day) => openAt(`r${day}`, day, '08:15'));
  const tooOld = openAt('old', R3_LOOKBACK_DAYS + 1, '08:15');
  assert.equal(suggestPlanTime([...recent, tooOld], DELIVERY, ZONE, NOW), null);
  const day = new Date(Date.parse(NOW) + 86_400_000);
  const inFuture: PlanOpenObservation = {
    id: 'future',
    at: new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 5, 15)).toISOString(),
    planDate: '2099-01-01',
  };
  assert.equal(suggestPlanTime([...recent, inFuture], DELIVERY, ZONE, NOW), null);
});

test('the open time is read in the user’s own zone, not the server’s or UTC', () => {
  // The same instants are 08:0x in Jerusalem and 05:0x in UTC: the habit is
  // the user's wall clock, so the claim must move with the zone it is read in.
  const opens = [1, 2, 3, 4, 5, 6, 7].map((day) => openAt(`z${day}`, day, '08:10'));
  assert.equal(suggestPlanTime(opens, DELIVERY, ZONE, NOW)?.fingerprint, 'R3_plan_time:08:00');
  assert.equal(suggestPlanTime(opens, DELIVERY, 'UTC', NOW)?.fingerprint, 'R3_plan_time:05:00');
});

test('the fingerprint is the time, so the same habit re-keys and a changed one re-suggests', () => {
  const again = [3, 5, 8, 12, 13].map((day) => openAt(`g${day}`, day, '08:20'));
  const others = [openAt('x1', 1, '19:00'), openAt('x2', 2, '20:00')];
  // Different days, different ids, the same half-hour: the claim is the same claim.
  assert.equal(
    suggestPlanTime([...again, ...others], DELIVERY, ZONE, NOW)?.fingerprint,
    suggestPlanTime(sevenDaysFiveAtEight(), DELIVERY, ZONE, NOW)?.fingerprint,
  );
  const evenings = [1, 2, 3, 4, 5].map((day) => openAt(`t${day}`, day, '21:10'));
  const moved = suggestPlanTime([...evenings, openAt('y1', 6, '08:00'), openAt('y2', 7, '08:20')], DELIVERY, ZONE, NOW);
  assert.equal(moved?.fingerprint, 'R3_plan_time:21:00');
  assert.notEqual(moved?.fingerprint, planTimeFingerprint('08:00'));
});

test('the same opens give the same answer whatever order they arrive in', () => {
  const events = sevenDaysFiveAtEight();
  const forward = suggestPlanTime(events, DELIVERY, ZONE, NOW);
  const backward = suggestPlanTime([...events].reverse(), DELIVERY, ZONE, NOW);
  assert.deepEqual(backward, forward);
});

test('the R3 fingerprint round-trips and refuses anything it did not write', () => {
  assert.equal(planTimeFingerprint('08:00'), 'R3_plan_time:08:00');
  assert.equal(parsePlanTimeFingerprint('R3_plan_time:08:00'), '08:00');
  assert.equal(parsePlanTimeFingerprint('R3_plan_time:23:30'), '23:30');
  for (const bad of [
    '', 'R3_plan_time', 'R3_plan_time:8:00', 'R3_plan_time:08:15', 'R3_plan_time:08:60',
    'R3_plan_time:24:00', 'R3_plan_time:29:30', 'R3_plan_time:08:00 ',
    'R1_focus_window:09:00-12:00', 'R2_defer_default:60m', 'R3_plan_time:٠٨:٠٠', null, 42, 800,
  ]) {
    assert.equal(parsePlanTimeFingerprint(bad), null, `accepted ${String(bad)}`);
  }
});

// ── Boundaries ───────────────────────────────────────────────────

function sourcesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? sourcesUnder(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const GROWTH_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'memoryGrowth');

test('no rule reads a commitment title', () => {
  const files = sourcesUnder(GROWTH_DIR);
  assert.ok(files.length > 0, 'found no sources, so this check would be vacuous');
  for (const file of files) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /title/i, `${file} mentions a title`);
  }
});

test('the rules read no ambient clock and no random source', () => {
  const source = readFileSync(join(GROWTH_DIR, 'rules.ts'), 'utf8');
  assert.doesNotMatch(source, /Date\.now\s*\(/);
  assert.doesNotMatch(source, /new\s+Date\s*\(\s*\)/);
  assert.doesNotMatch(source, /Math\.random|randomUUID/);
  assert.doesNotMatch(source, /from '\.\.\/storage|getStorage/);
});

// ── The stored sentence ──────────────────────────────────────────

test('the kept sentence passes the same §13, shame and coercion lexicons as the plan, in every language', async () => {
  const { EXPLANATION_LEXICONS } = await import('../../lib/services/dailyPlan/explanationValidator.ts');
  const {
    KEPT_DEFER_CONTENT,
    KEPT_PLAN_TIME_CONTENT,
    KEPT_SUGGESTION_CONTENT,
    KEPT_SUGGESTION_LANGUAGES,
    keptDeferDefaultContent,
    keptFocusWindowContent,
    keptPlanTimeContent,
  } = await import('../../lib/memoryGrowth/templates.ts');
  assert.deepEqual([...KEPT_SUGGESTION_LANGUAGES].sort(), ['ar', 'en', 'he']);
  for (const language of KEPT_SUGGESTION_LANGUAGES) {
    const sentences = [
      keptFocusWindowContent({ start: '09:00', end: '12:00' }, language),
      // The buckets a rule can produce, at every age the wording changes.
      ...[30, 60, 90, 120, 150, 180, 210, 1440].map((minutes) => keptDeferDefaultContent(minutes, language)),
      keptPlanTimeContent('08:30', language),
    ];
    for (const sentence of sentences) {
      assert.doesNotMatch(sentence, /\{|\}/, `${language}: a placeholder survived in ${sentence}`);
      const lexicon = EXPLANATION_LEXICONS[language];
      for (const [name, patterns] of Object.entries(lexicon)) {
        for (const pattern of patterns as readonly RegExp[]) {
          assert.doesNotMatch(sentence, pattern, `${language}: ${name} lexicon matched ${sentence}`);
        }
      }
    }
    assert.ok(
      keptFocusWindowContent({ start: '09:00', end: '12:00' }, language).includes('09:00'),
      `${language}: the window is not in the sentence`,
    );
    assert.ok(
      keptDeferDefaultContent(60, language).trim() !== KEPT_DEFER_CONTENT[language],
      `${language}: the duration is not in the sentence`,
    );
    assert.ok(
      keptPlanTimeContent('08:30', language).includes('08:30'),
      `${language}: the time is not in the sentence`,
    );
    assert.notEqual(KEPT_DEFER_CONTENT[language], KEPT_SUGGESTION_CONTENT[language]);
    assert.notEqual(KEPT_PLAN_TIME_CONTENT[language], KEPT_SUGGESTION_CONTENT[language]);
    assert.notEqual(KEPT_PLAN_TIME_CONTENT[language], KEPT_DEFER_CONTENT[language]);
  }
});

test('a duration reads as a person would say it, in every language', async () => {
  const { deferDurationText } = await import('../../lib/memoryGrowth/templates.ts');
  assert.equal(deferDurationText(30, 'en'), '30 minutes');
  assert.equal(deferDurationText(60, 'en'), '1 hour');
  assert.equal(deferDurationText(90, 'en'), '1.5 hours');
  assert.equal(deferDurationText(120, 'en'), '2 hours');
  assert.equal(deferDurationText(150, 'en'), '2.5 hours');
  assert.equal(deferDurationText(180, 'en'), '3 hours');
  assert.equal(deferDurationText(210, 'en'), '3.5 hours');
  assert.equal(deferDurationText(60, 'ar'), 'ساعة');
  assert.equal(deferDurationText(90, 'ar'), 'ساعة ونص');
  assert.equal(deferDurationText(120, 'ar'), 'ساعتين');
  assert.equal(deferDurationText(150, 'ar'), 'ساعتين ونص');
  assert.equal(deferDurationText(180, 'ar'), '3 ساعات');
  assert.equal(deferDurationText(30, 'ar'), 'نص ساعة');
  assert.equal(deferDurationText(60, 'he'), 'שעה');
  assert.equal(deferDurationText(90, 'he'), 'שעה וחצי');
  assert.equal(deferDurationText(120, 'he'), 'שעתיים');
  assert.equal(deferDurationText(180, 'he'), '3 שעות');
  assert.equal(deferDurationText(30, 'he'), 'חצי שעה');
  // A duration no bucket ever produced falls back to bare minutes.
  assert.equal(deferDurationText(45, 'en'), '45 minutes');
  assert.equal(deferDurationText(45, 'ar'), '45 دقيقة');
  assert.equal(deferDurationText(45, 'he'), '45 דקות');
});
