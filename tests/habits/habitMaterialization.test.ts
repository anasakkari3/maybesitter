/**
 * Materialization: bounded, deterministic, and unmoved by DST (#520).
 *
 * Four of the issue's acceptance criteria are checked here, and each of them
 * fails in production rather than in a suite if it is got wrong:
 *
 *  - "3/week creates no more than the bounded expected occurrences" and "a
 *    Habit never becomes an infinite set of Commitments" — a horizon is
 *    mandatory and a too-wide one is refused rather than clamped.
 *  - "re-running materialization produces identical IDs" — the failure mode is
 *    a second gym session beside every first one, on day two, which no
 *    single-run assertion would notice. Checked by re-running, by running over
 *    a *shifted* horizon, and by mutation (see the commit message).
 *  - "DST and timezone changes do not duplicate occurrences" — the horizon
 *    below deliberately contains both the North American and the European
 *    spring-forward dates, and one test runs the whole materialization in a
 *    separate process under three different `TZ` values.
 *  - "pausing the Habit removes future demand without deleting history".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HABIT_HORIZON_MAX_DAYS,
  type HabitOccurrence,
} from '../../src/contracts/v1/habitContracts.ts';
import {
  canonicalWeekOffsets,
  demandDates,
  materializeHabitOccurrences,
} from '../../lib/habits/materialize.ts';
import { addDays } from '../../lib/habits/civilDate.ts';
import {
  EU_SPRING_FORWARD,
  MARCH_MONDAY,
  MARCH_SUNDAY,
  US_FALL_BACK,
  US_SPRING_FORWARD,
  habit,
  withStatus,
} from './habitSupport.ts';

const FOUR_WEEKS = { fromLocalDate: MARCH_MONDAY, toLocalDate: MARCH_SUNDAY };

test('three times a week over four weeks is exactly twelve dates, and no more', () => {
  const result = materializeHabitOccurrences(habit(), FOUR_WEEKS);

  assert.equal(result.occurrences.length, 12);
  // Monday, Wednesday, Saturday — the even spread, stated once here so that a
  // change to the rule has to be made deliberately rather than absorbed.
  assert.deepEqual(canonicalWeekOffsets(habit()), [0, 2, 5]);
  assert.deepEqual(
    result.occurrences.slice(0, 3).map((entry) => entry.localDate),
    ['2026-03-02', '2026-03-04', '2026-03-07'],
  );
  assert.equal(new Set(result.occurrences.map((entry) => entry.localDate)).size, 12);
  for (const occurrence of result.occurrences) {
    assert.equal(occurrence.state, 'pending');
    assert.equal(occurrence.durationMinutes, 60);
    assert.equal(occurrence.recoveredFromOccurrenceId, null);
  }
});

test('a horizon wider than the maximum is refused, not silently truncated', () => {
  const tooWide = {
    fromLocalDate: MARCH_MONDAY,
    toLocalDate: addDays(MARCH_MONDAY, HABIT_HORIZON_MAX_DAYS),
  };
  assert.throws(
    () => materializeHabitOccurrences(habit(), tooWide),
    /horizon spans 57 days, above the maximum of 56/,
  );
  // The day before is fine, so the boundary is the boundary and not an
  // off-by-one that happens to make the assertion above pass.
  assert.ok(materializeHabitOccurrences(habit(), {
    fromLocalDate: MARCH_MONDAY,
    toLocalDate: addDays(MARCH_MONDAY, HABIT_HORIZON_MAX_DAYS - 1),
  }).occurrences.length > 0);
  assert.throws(
    () => materializeHabitOccurrences(habit(), { fromLocalDate: MARCH_SUNDAY, toLocalDate: MARCH_MONDAY }),
    /horizon ends before it starts/,
  );
});

test('re-running materialization produces identical ids and adds nothing', () => {
  const definition = habit();
  const first = materializeHabitOccurrences(definition, FOUR_WEEKS);
  const second = materializeHabitOccurrences(definition, FOUR_WEEKS, first.occurrences);

  assert.deepEqual(
    second.occurrences.map((entry) => entry.occurrenceId),
    first.occurrences.map((entry) => entry.occurrenceId),
  );
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.withdrawn, []);
  assert.equal(second.occurrences.length, 12);
  // And a third run from a *fresh* list: the ids are a function of the habit
  // and the date alone, so they match even with nothing carried over.
  assert.deepEqual(
    materializeHabitOccurrences(definition, FOUR_WEEKS).occurrences.map((entry) => entry.occurrenceId),
    first.occurrences.map((entry) => entry.occurrenceId),
  );
});

test('a horizon that starts mid-week reuses the ids of the week it joins', () => {
  const definition = habit();
  const wholeWeeks = materializeHabitOccurrences(definition, FOUR_WEEKS);
  // Starts on a Thursday, two weeks in. The overlapping dates must be the same
  // dates under the same ids: a nightly job whose window slides forward must
  // not re-choose which days of a week it already materialized.
  const shifted = materializeHabitOccurrences(definition, {
    fromLocalDate: '2026-03-12',
    toLocalDate: '2026-04-05',
  });
  const overlap = shifted.occurrences.filter((entry) => entry.localDate <= MARCH_SUNDAY);
  assert.ok(overlap.length >= 6, 'the two horizons must actually overlap for this to prove anything');
  const byId = new Map(wholeWeeks.occurrences.map((entry) => [entry.occurrenceId, entry]));
  for (const occurrence of overlap) {
    assert.ok(
      byId.has(occurrence.occurrenceId),
      `${occurrence.occurrenceId} (${occurrence.localDate}) was not produced by the aligned horizon`,
    );
  }
});

test('a horizon containing two spring-forward dates yields one row per date', () => {
  const result = materializeHabitOccurrences(habit(), FOUR_WEEKS);
  const dates = result.occurrences.map((entry) => entry.localDate);

  assert.ok(dates.includes(US_SPRING_FORWARD) === false, 'Sunday is not one of Mon/Wed/Sat');
  // The week *containing* the North American transition still gets its three.
  const transitionWeek = dates.filter((date) => date >= '2026-03-02' && date <= '2026-03-08');
  assert.deepEqual(transitionWeek, ['2026-03-02', '2026-03-04', '2026-03-07']);
  // The European transition is the horizon's last day, so the week it opens is
  // the one that must not lose or gain a date either.
  assert.equal(EU_SPRING_FORWARD, MARCH_SUNDAY);
  assert.equal(dates.length, new Set(dates).size, 'a date came out twice');
  assert.equal(dates.length, 12);
});

test('a fall-back week, where one local day is 25 hours long, yields the same three', () => {
  const horizon = { fromLocalDate: '2026-10-26', toLocalDate: '2026-11-08' };
  const dates = materializeHabitOccurrences(habit(), horizon).occurrences
    .map((entry) => entry.localDate);
  assert.equal(US_FALL_BACK, '2026-11-01');
  assert.deepEqual(dates, [
    '2026-10-26', '2026-10-28', '2026-10-31',
    '2026-11-02', '2026-11-04', '2026-11-07',
  ]);
});

/**
 * The behavioural half of the DST claim.
 *
 * The three assertions above are run in one process, whose local zone is
 * whatever the machine's is. `Date`'s local-time methods read that zone once at
 * start-up, so no in-process test can show that an implementation using
 * `getDate()` instead of `getUTCDate()` would break — which is precisely the
 * implementation somebody would reach for. This runs the whole materialization
 * three times in child processes, under UTC and under two zones whose
 * transitions fall inside the horizon, and compares the ids byte for byte.
 */
test('materialization is byte-identical under three different process timezones', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, '..', '..');
  const script = join(here, 'materializeUnderTz.ts');
  const run = (timeZone: string): string => execFileSync(
    process.execPath,
    ['--no-warnings', '--loader', './scripts/ts-resolver.mjs', script],
    { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, TZ: timeZone } },
  ).trim();

  const utc = run('UTC');
  assert.ok(utc.includes('2026-03-07'), 'the child produced nothing recognisable');
  assert.equal(run('America/New_York'), utc);
  assert.equal(run('Pacific/Chatham'), utc, 'a 45-minute-offset zone with its own transition');
});

test('pausing stops future demand and keeps everything the person touched', () => {
  const active = habit();
  const first = materializeHabitOccurrences(active, FOUR_WEEKS);
  // Two dates in the first week have already happened: one done, one not.
  const history: HabitOccurrence[] = first.occurrences.map((entry, index) => {
    if (index === 0) return { ...entry, state: 'completed' as const };
    if (index === 1) return { ...entry, state: 'skipped' as const };
    return entry;
  });

  const after = materializeHabitOccurrences(withStatus(active, 'paused'), FOUR_WEEKS, history);

  assert.deepEqual(after.created, []);
  assert.deepEqual(
    after.occurrences.map((entry) => [entry.localDate, entry.state]),
    [['2026-03-02', 'completed'], ['2026-03-04', 'skipped']],
    'history survived and every untouched future date was withdrawn',
  );
  assert.equal(after.withdrawn.length, 10);
  // And the demand itself is gone, not merely unwritten.
  assert.deepEqual(demandDates(withStatus(active, 'paused'), FOUR_WEEKS), []);
  assert.deepEqual(demandDates(withStatus(active, 'archived'), FOUR_WEEKS), []);
});

test('un-pausing restores the same ids the pause withdrew', () => {
  const active = habit();
  const first = materializeHabitOccurrences(active, FOUR_WEEKS);
  const paused = materializeHabitOccurrences(withStatus(active, 'paused'), FOUR_WEEKS, first.occurrences);
  const resumed = materializeHabitOccurrences(active, FOUR_WEEKS, paused.occurrences);

  assert.deepEqual(
    resumed.occurrences.map((entry) => entry.occurrenceId),
    first.occurrences.map((entry) => entry.occurrenceId),
  );
});

test('an edited cadence withdraws untouched dates and keeps answered ones', () => {
  const threeTimes = habit();
  const first = materializeHabitOccurrences(threeTimes, FOUR_WEEKS);
  const completedWednesday = first.occurrences.map((entry) =>
    entry.localDate === '2026-03-04' ? { ...entry, state: 'completed' as const } : entry);

  const twiceOnMonAndThu = habit({
    cadence: { kind: 'weekdays', weekdays: [1, 4] },
    minimumOccurrences: 2,
    maximumOccurrences: 2,
  });
  const after = materializeHabitOccurrences(twiceOnMonAndThu, FOUR_WEEKS, completedWednesday);
  const dates = after.occurrences.map((entry) => entry.localDate);

  assert.ok(dates.includes('2026-03-04'), 'the completed Wednesday must survive a cadence change');
  assert.ok(!dates.includes('2026-03-07'), 'an untouched Saturday the cadence dropped must go');
  assert.deepEqual(
    after.occurrences.filter((entry) => entry.state === 'pending')
      .map((entry) => entry.localDate).slice(0, 4),
    ['2026-03-02', '2026-03-05', '2026-03-09', '2026-03-12'],
  );
});

test('every cadence count from one to seven picks that many distinct days', () => {
  for (let count = 1; count <= 7; count += 1) {
    const offsets = canonicalWeekOffsets(habit({
      cadence: { kind: 'weekly_count', count },
      minimumOccurrences: count,
      maximumOccurrences: count,
    }));
    assert.equal(offsets.length, count, `count ${count}`);
    assert.equal(new Set(offsets).size, count, `count ${count} collapsed two sessions onto one day`);
    assert.ok(offsets.every((offset) => offset >= 0 && offset <= 6), `count ${count} left the week`);
  }
});

test('maximumOccurrences caps a weekdays cadence as well as a count', () => {
  const capped = habit({
    cadence: { kind: 'weekdays', weekdays: [1, 3, 5] },
    minimumOccurrences: 0,
    maximumOccurrences: 2,
  });
  assert.deepEqual(canonicalWeekOffsets(capped), [0, 2]);
  assert.equal(materializeHabitOccurrences(capped, FOUR_WEEKS).occurrences.length, 8);
});
