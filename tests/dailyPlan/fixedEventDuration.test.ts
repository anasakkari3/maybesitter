/**
 * A pinned commitment blocks the time it actually takes (#185's `endAt`).
 *
 * The planner used to block `DEFAULT_FIXED_EVENT_MINUTES` for every pinned
 * commitment regardless of its end, which put the second half of any two-hour
 * event back on the market while the device calendar showed it as busy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FIXED_EVENT_MINUTES,
  buildDailyPlanInput,
} from '../../lib/services/dailyPlan/buildDailyPlan.ts';
import { normalizeStoredTimeSpec, type Commitment } from '../../src/domain/stateMachine.ts';
import type { UserRoutineProfile } from '../../src/contracts/v1/routineContracts.ts';

const TZ = 'Asia/Jerusalem';
const DATE = '2026-09-19';
const UID = 'u1';

// Same helper `tests/dailyPlan/buildDailyPlan.test.ts` uses, copied rather
// than reinvented: a fixed profile so `workingWindowsFor` has something real
// to chew on, not `undefined as never` standing in for a type this module
// actually requires.
const PROFILE: UserRoutineProfile = {
  schemaVersion: 1,
  updatedAt: '2026-09-01T00:00:00.000Z',
  timezone: TZ,
  sleepWindow: { start: '23:00', end: '07:00' },
  focusWindows: [{ start: '09:00', end: '17:00', label: 'work_study' }],
  fixedCommitmentWindows: [],
  preferredReminderIntensity: 'followUp',
  quietHours: null,
  surveySkipped: false,
} as UserRoutineProfile;

function commitmentAt(id: string, dueAt: string, endAt: string | null): Commitment {
  return {
    id,
    kind: 'task',
    title: id,
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    category: null,
    categorySource: 'inferred',
    timeSpec: normalizeStoredTimeSpec({ kind: 'scheduled_event', dueAt, endAt, timezone: TZ }),
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: dueAt,
    updatedAt: dueAt,
    confirmedAt: dueAt,
    completedAt: null,
    droppedAt: null,
  };
}

const ARGS = {
  uid: UID,
  date: DATE,
  timezone: TZ,
  profile: PROFILE,
  busyBlocks: [],
  // Local midnight of the day being planned: a clock that bounds nothing, so
  // these tests stay about event duration and not about #500's lower bound.
  builtAt: '2026-09-18T21:00:00.000Z',
};

test('an end time is the length of the blocking event', () => {
  const input = buildDailyPlanInput({
    ...ARGS,
    commitments: [commitmentAt('match', '2026-09-19T19:00:00.000Z', '2026-09-19T21:00:00.000Z')],
  });
  const event = input.constraints.fixedEvents.find((e) => e.sourceCommitmentId === 'match');
  assert.ok(event, 'the pinned commitment should produce a fixed event');
  assert.equal(event.interval.endsAt, '2026-09-19T21:00:00.000Z');
});

test('no end time still blocks the default', () => {
  const input = buildDailyPlanInput({
    ...ARGS,
    commitments: [commitmentAt('call', '2026-09-19T19:00:00.000Z', null)],
  });
  const event = input.constraints.fixedEvents.find((e) => e.sourceCommitmentId === 'call');
  assert.ok(event);
  const minutes = (Date.parse(event.interval.endsAt) - Date.parse(event.interval.startsAt)) / 60_000;
  assert.equal(minutes, DEFAULT_FIXED_EVENT_MINUTES);
});

test('an end that is not after its start falls back to the default', () => {
  // The domain refuses this, so it can only arrive from a hand-edited document.
  // The planner must not emit a zero-length or inverted blocking interval:
  // `intervalsOverlap` treats a zero-length interval as intersecting nothing,
  // so such an event would block nothing while looking like it blocks.
  const input = buildDailyPlanInput({
    ...ARGS,
    commitments: [commitmentAt('bad', '2026-09-19T19:00:00.000Z', '2026-09-19T19:00:00.000Z')],
  });
  const event = input.constraints.fixedEvents.find((e) => e.sourceCommitmentId === 'bad');
  assert.ok(event);
  const minutes = (Date.parse(event.interval.endsAt) - Date.parse(event.interval.startsAt)) / 60_000;
  assert.equal(minutes, DEFAULT_FIXED_EVENT_MINUTES);
});
