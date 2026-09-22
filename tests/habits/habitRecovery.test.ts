/**
 * Recovery: another date, within the week, within the ceiling (#520).
 *
 * The issue's worked example is the spine of this file — target three a week,
 * Monday skipped, `recover_within_period`, so the planner may offer a later
 * date in the same week up to `maximumOccurrences`. What the tests below add
 * to it are the three ways that goes wrong quietly: a recovery that leaves the
 * week, a recovery that ignores the ceiling and piles a week of skips onto a
 * Sunday, and a second recovery for a skip that already has a replacement.
 *
 * Nothing here counts skips across weeks, and there is no assertion in this
 * file that could pass only for somebody who has not skipped anything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { HabitOccurrence } from '../../src/contracts/v1/habitContracts.ts';
import { materializeHabitOccurrences } from '../../lib/habits/materialize.ts';
import { recoverSkippedOccurrence } from '../../lib/habits/recovery.ts';
import { MARCH_MONDAY, habit, withStatus } from './habitSupport.ts';

/** One week: Monday 2026-03-02 to Sunday 2026-03-08. Mon/Wed/Sat at 3/week. */
const ONE_WEEK = { fromLocalDate: MARCH_MONDAY, toLocalDate: '2026-03-08' };
const MONDAY = 'habit-1.2026-03-02.0';

function weekWithSkippedMonday(overrides = {}): readonly HabitOccurrence[] {
  const definition = habit(overrides);
  const { occurrences } = materializeHabitOccurrences(definition, ONE_WEEK);
  return occurrences.map((entry) =>
    entry.occurrenceId === MONDAY ? { ...entry, state: 'skipped' as const } : entry);
}

test('a skipped Monday recovers to a free date later in the same week', () => {
  const definition = habit();
  const outcome = recoverSkippedOccurrence({
    habit: definition,
    occurrences: weekWithSkippedMonday(),
    occurrenceId: MONDAY,
    notBeforeLocalDate: MARCH_MONDAY,
  });

  assert.equal(outcome.kind, 'recovered');
  if (outcome.kind !== 'recovered') return;
  // Tuesday: the earliest date after the skip that the cadence has not already
  // spent. Wednesday and Saturday are still pending, so they are not free.
  assert.equal(outcome.replacement.localDate, '2026-03-03');
  assert.equal(outcome.replacement.state, 'pending');
  assert.equal(outcome.replacement.recoveredFromOccurrenceId, MONDAY);
  assert.equal(outcome.replacement.durationMinutes, definition.durationMinutes);
  assert.equal(outcome.replacement.occurrenceId, 'habit-1.2026-03-03.0');
  // The skipped row stays, saying what happened, no longer outstanding demand.
  const monday = outcome.occurrences.find((entry) => entry.occurrenceId === MONDAY);
  assert.equal(monday?.state, 'recovered');
  assert.equal(outcome.occurrences.length, 4);
});

test('recovery is deterministic: the same list twice gives the same id', () => {
  const request = {
    habit: habit(),
    occurrences: weekWithSkippedMonday(),
    occurrenceId: MONDAY,
    notBeforeLocalDate: MARCH_MONDAY,
  };
  const first = recoverSkippedOccurrence(request);
  const second = recoverSkippedOccurrence(request);
  assert.equal(first.kind, 'recovered');
  if (first.kind !== 'recovered' || second.kind !== 'recovered') return;
  assert.equal(second.replacement.occurrenceId, first.replacement.occurrenceId);
});

test('a second recovery for the same skip is declined, not written twice', () => {
  const first = recoverSkippedOccurrence({
    habit: habit(),
    occurrences: weekWithSkippedMonday(),
    occurrenceId: MONDAY,
    notBeforeLocalDate: MARCH_MONDAY,
  });
  assert.equal(first.kind, 'recovered');
  if (first.kind !== 'recovered') return;

  const again = recoverSkippedOccurrence({
    habit: habit(),
    occurrences: first.occurrences,
    occurrenceId: MONDAY,
    notBeforeLocalDate: MARCH_MONDAY,
  });
  assert.equal(again.kind, 'none');
  if (again.kind !== 'none') return;
  assert.equal(again.reason, 'occurrence_not_skipped');
  assert.equal(again.occurrences.length, first.occurrences.length);
});

test('a recovery never leaves the week it belongs to', () => {
  // Every other date in the week is taken, so the only dates left are in the
  // next week — and the answer must be "no", not "next Monday".
  const week = weekWithSkippedMonday().map((entry) =>
    entry.occurrenceId === MONDAY ? entry : { ...entry, state: 'scheduled' as const });
  const filled: HabitOccurrence[] = [...week];
  for (const localDate of ['2026-03-03', '2026-03-05', '2026-03-06', '2026-03-08']) {
    filled.push({
      occurrenceId: `other.${localDate}.0`,
      habitId: 'habit-1',
      localDate,
      ordinal: 0,
      state: 'scheduled',
      durationMinutes: 60,
      recoveredFromOccurrenceId: null,
    });
  }
  const outcome = recoverSkippedOccurrence({
    habit: habit({ minimumOccurrences: 0, maximumOccurrences: 7 }),
    occurrences: filled,
    occurrenceId: MONDAY,
    notBeforeLocalDate: MARCH_MONDAY,
  });
  assert.equal(outcome.kind, 'none');
  if (outcome.kind !== 'none') return;
  assert.equal(outcome.reason, 'no_date_left_in_period');
});

test('the ceiling stops a week of skips piling onto the last free day', () => {
  // All three of the week's dates skipped, ceiling of three. Each recovery
  // gives its slot back, so the first two succeed; what must not happen is a
  // fourth, fifth or sixth session appearing in a week configured for three.
  let occurrences: readonly HabitOccurrence[] = materializeHabitOccurrences(habit(), ONE_WEEK)
    .occurrences.map((entry) => ({ ...entry, state: 'skipped' as const }));
  const recovered: string[] = [];
  for (const occurrenceId of [MONDAY, 'habit-1.2026-03-04.0', 'habit-1.2026-03-07.0']) {
    const outcome = recoverSkippedOccurrence({
      habit: habit(),
      occurrences,
      occurrenceId,
      notBeforeLocalDate: MARCH_MONDAY,
    });
    if (outcome.kind === 'recovered') {
      recovered.push(outcome.replacement.localDate);
      occurrences = outcome.occurrences;
    }
  }
  const live = occurrences.filter((entry) => entry.state === 'pending');
  assert.equal(live.length, recovered.length);
  assert.ok(live.length <= 3, `the week ended with ${live.length} live sessions, ceiling is 3`);
  assert.deepEqual(recovered, ['2026-03-03', '2026-03-05', '2026-03-08']);
});

test('period_capacity_reached is the answer when the ceiling is already spent', () => {
  // The state an earlier recovery leaves behind: Monday was skipped and
  // recovered onto Tuesday, and Tuesday was then done. The week now holds
  // three live sessions — Tuesday, Wednesday, Saturday — which is the ceiling.
  // Skipping Wednesday must not buy a fourth date, because the slot Wednesday
  // gives back is the one Tuesday is already using.
  const week: readonly HabitOccurrence[] = [
    { occurrenceId: MONDAY, habitId: 'habit-1', localDate: '2026-03-02', ordinal: 0, state: 'recovered', durationMinutes: 60, recoveredFromOccurrenceId: null },
    { occurrenceId: 'habit-1.2026-03-03.0', habitId: 'habit-1', localDate: '2026-03-03', ordinal: 0, state: 'completed', durationMinutes: 60, recoveredFromOccurrenceId: MONDAY },
    { occurrenceId: 'habit-1.2026-03-04.0', habitId: 'habit-1', localDate: '2026-03-04', ordinal: 0, state: 'skipped', durationMinutes: 60, recoveredFromOccurrenceId: null },
    { occurrenceId: 'habit-1.2026-03-07.0', habitId: 'habit-1', localDate: '2026-03-07', ordinal: 0, state: 'pending', durationMinutes: 60, recoveredFromOccurrenceId: null },
  ];
  const outcome = recoverSkippedOccurrence({
    habit: habit({ minimumOccurrences: 0, maximumOccurrences: 2 }),
    occurrences: week,
    occurrenceId: 'habit-1.2026-03-04.0',
    notBeforeLocalDate: MARCH_MONDAY,
  });
  assert.equal(outcome.kind, 'none');
  if (outcome.kind !== 'none') return;
  assert.equal(outcome.reason, 'period_capacity_reached');
});

test('retry_same_day offers the same date again, at the next ordinal', () => {
  const definition = habit({ recoveryPolicy: 'retry_same_day' });
  const outcome = recoverSkippedOccurrence({
    habit: definition,
    occurrences: weekWithSkippedMonday({ recoveryPolicy: 'retry_same_day' }),
    occurrenceId: MONDAY,
    notBeforeLocalDate: MARCH_MONDAY,
  });
  assert.equal(outcome.kind, 'recovered');
  if (outcome.kind !== 'recovered') return;
  assert.equal(outcome.replacement.localDate, '2026-03-02');
  assert.equal(outcome.replacement.ordinal, 1);
  assert.equal(outcome.replacement.occurrenceId, 'habit-1.2026-03-02.1');
});

test('retry_same_day will not offer a date that is already behind the caller', () => {
  const outcome = recoverSkippedOccurrence({
    habit: habit({ recoveryPolicy: 'retry_same_day' }),
    occurrences: weekWithSkippedMonday({ recoveryPolicy: 'retry_same_day' }),
    occurrenceId: MONDAY,
    notBeforeLocalDate: '2026-03-05',
  });
  assert.equal(outcome.kind, 'none');
  if (outcome.kind !== 'none') return;
  assert.equal(outcome.reason, 'no_date_left_in_period');
});

test('recover_within_period respects the caller’s today', () => {
  const outcome = recoverSkippedOccurrence({
    habit: habit(),
    occurrences: weekWithSkippedMonday(),
    occurrenceId: MONDAY,
    notBeforeLocalDate: '2026-03-05',
  });
  assert.equal(outcome.kind, 'recovered');
  if (outcome.kind !== 'recovered') return;
  // Not Tuesday, which is in the past for this caller; Thursday, the first free
  // date from today. Wednesday and Saturday are still the cadence's own.
  assert.equal(outcome.replacement.localDate, '2026-03-05');
});

test('the skip policy, a paused habit and an unknown id each decline with a reason', () => {
  const cases: readonly [Record<string, unknown>, string, string][] = [
    [{ recoveryPolicy: 'skip' }, MONDAY, 'policy_is_skip'],
    [{}, 'habit-1.2026-03-04.0', 'occurrence_not_skipped'],
    [{}, 'habit-1.2026-04-01.0', 'occurrence_not_found'],
  ];
  for (const [overrides, occurrenceId, reason] of cases) {
    const outcome = recoverSkippedOccurrence({
      habit: habit(overrides),
      occurrences: weekWithSkippedMonday(overrides),
      occurrenceId,
      notBeforeLocalDate: MARCH_MONDAY,
    });
    assert.equal(outcome.kind, 'none');
    if (outcome.kind !== 'none') continue;
    assert.equal(outcome.reason, reason);
  }

  const paused = recoverSkippedOccurrence({
    habit: withStatus(habit(), 'paused'),
    occurrences: weekWithSkippedMonday(),
    occurrenceId: MONDAY,
    notBeforeLocalDate: MARCH_MONDAY,
  });
  assert.equal(paused.kind, 'none');
  if (paused.kind !== 'none') return;
  assert.equal(paused.reason, 'habit_not_active');
});

test('materialization leaves a recovery’s extra date alone', () => {
  const definition = habit();
  const recovery = recoverSkippedOccurrence({
    habit: definition,
    occurrences: weekWithSkippedMonday(),
    occurrenceId: MONDAY,
    notBeforeLocalDate: MARCH_MONDAY,
  });
  assert.equal(recovery.kind, 'recovered');
  if (recovery.kind !== 'recovered') return;

  const after = materializeHabitOccurrences(definition, ONE_WEEK, recovery.occurrences);
  assert.deepEqual(after.withdrawn, [], 'the cadence withdrew a date it did not create');
  assert.deepEqual(after.created, []);
  assert.ok(after.occurrences.some((entry) =>
    entry.occurrenceId === recovery.replacement.occurrenceId));
});
