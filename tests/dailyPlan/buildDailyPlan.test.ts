/**
 * Commitments, busy time and a routine, mapped into a planning request
 * (UC-3.10a, #194).
 *
 * Two of these are acceptance criteria rather than unit checks.
 *
 * **AC-1** — three confirmed items and two busy blocks produce a plan whose
 * `scheduled` never overlaps a busy block. It is asserted here, against
 * *injected* blocks, because the calendar source (UC-3.2, #186) does not exist
 * yet. What this proves is that the mapping turns a busy block into a blocking
 * `FixedEvent` and that the scheduler honours it. What it cannot prove is that
 * a real calendar reaches this function at all; `NO_BUSY_BLOCKS` is today's
 * production reader, and until #186 lands the end-to-end criterion is open.
 *
 * **The stable digest** — the same inputs twice give the same `inputDigest`.
 * That is only meaningful because this module reads no clock: a mapping that
 * called `Date.now()` anywhere would produce a different scope, horizon or
 * ordering on the second call and the assertion would be about luck.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EFFORT_MINUTES,
  FALLBACK_WINDOW,
  NO_BUSY_BLOCKS,
  buildDailyPlanInput,
  dayHorizon,
  workingWindowsFor,
  type BusyBlock,
} from '../../lib/services/dailyPlan/buildDailyPlan.ts';
import { schedulePlan } from '../../lib/planning/scheduler/index.ts';
import { intervalsOverlap, toEpochMs } from '../../lib/planning/shared/time.ts';
import type { Commitment } from '../../src/domain/stateMachine.ts';
import type { UserRoutineProfile } from '../../src/contracts/v1/routineContracts.ts';

const TZ = 'Asia/Jerusalem';
const DATE = '2026-09-15';
const UID = 'user_plan_1';

function commitment(overrides: Partial<Commitment> & { id: string; title: string }): Commitment {
  return {
    kind: 'task',
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt: null, remindAt: null, timezone: TZ },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2026-09-14T06:00:00.000Z',
    updatedAt: '2026-09-14T06:00:00.000Z',
    confirmedAt: '2026-09-14T06:00:00.000Z',
    completedAt: null,
    droppedAt: null,
    ...overrides,
  } as Commitment;
}

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

function args(overrides: Partial<Parameters<typeof buildDailyPlanInput>[0]> = {}) {
  return {
    uid: UID,
    date: DATE,
    timezone: TZ,
    commitments: [] as Commitment[],
    busyBlocks: [] as BusyBlock[],
    profile: PROFILE,
    ...overrides,
  };
}

/* ── The horizon is one local day, whatever the offset does ─────── */

test('the horizon is local midnight to local midnight', () => {
  const { horizon } = buildDailyPlanInput(args()).constraints;
  // 2026-09-15 in Jerusalem is UTC+3.
  assert.equal(horizon.startsAt, '2026-09-14T21:00:00.000Z');
  assert.equal(horizon.endsAt, '2026-09-15T21:00:00.000Z');
});

test('a spring-forward day is 23 hours long and a fall-back day is 25', () => {
  const spring = dayHorizon('2026-03-27', TZ);
  assert.equal(
    (toEpochMs(spring.endsAt) - toEpochMs(spring.startsAt)) / 3_600_000,
    23,
    'the day the clock jumps forward was planned as a full 24 hours',
  );
  const autumn = dayHorizon('2026-10-25', TZ);
  assert.equal(
    (toEpochMs(autumn.endsAt) - toEpochMs(autumn.startsAt)) / 3_600_000,
    25,
    'the day the clock falls back was planned as a full 24 hours',
  );
});

/* ── Working windows ─────────────────────────────────────────────── */

test('the profile\'s focus windows become the working windows', () => {
  const windows = buildDailyPlanInput(args()).constraints.workingWindows;
  assert.equal(windows.length, 1);
  assert.equal(windows[0]!.startMinute, 9 * 60);
  assert.equal(windows[0]!.endMinute, 17 * 60);
  assert.equal(windows[0]!.timezone, TZ);
  // 2026-09-15 is a Tuesday.
  assert.equal(windows[0]!.weekday, 2);
});

test('no focus windows falls back to 08:00-20:00 minus sleep', () => {
  const profile = { ...PROFILE, focusWindows: [], sleepWindow: { start: '23:00', end: '09:00' } } as UserRoutineProfile;
  const windows = workingWindowsFor(profile, TZ, 2);
  assert.deepEqual(
    windows.map((window) => [window.startMinute, window.endMinute]),
    [[9 * 60, FALLBACK_WINDOW.endMinute]],
    'the fallback window did not have the sleep window taken out of it',
  );
});

test('a wrapping sleep window is cut from both ends of the fallback', () => {
  const profile = { ...PROFILE, focusWindows: [], sleepWindow: { start: '19:00', end: '09:30' } } as UserRoutineProfile;
  assert.deepEqual(
    workingWindowsFor(profile, TZ, 2).map((window) => [window.startMinute, window.endMinute]),
    [[9 * 60 + 30, 19 * 60]],
  );
});

test('no profile at all still yields a usable day', () => {
  const windows = workingWindowsFor(null, TZ, 2);
  assert.deepEqual(windows.map((window) => [window.startMinute, window.endMinute]), [[8 * 60, 20 * 60]]);
});

/* ── Items and fixed events ──────────────────────────────────────── */

test('a commitment with a fixed start becomes a blocking fixed event, not an item', () => {
  const input = buildDailyPlanInput(args({
    commitments: [commitment({
      id: 'c_fixed',
      title: 'Dentist',
      timeSpec: { kind: 'scheduled_event', dueAt: '2026-09-15T11:00:00.000Z', remindAt: '2026-09-15T11:00:00.000Z', timezone: TZ },
    })],
  }));
  assert.deepEqual(input.constraints.items.map((item) => item.itemId), []);
  assert.equal(input.constraints.fixedEvents.length, 1);
  assert.equal(input.constraints.fixedEvents[0]!.sourceCommitmentId, 'c_fixed');
  assert.equal(input.constraints.fixedEvents[0]!.blocking, true);
});

test('completed, dropped and unconfirmed commitments are not planned', () => {
  const input = buildDailyPlanInput(args({
    commitments: [
      commitment({ id: 'c_done', title: 'Done', status: 'completed' }),
      commitment({ id: 'c_dropped', title: 'Dropped', status: 'dropped' }),
      commitment({ id: 'c_draft', title: 'Draft', status: 'pending_confirmation' }),
      commitment({ id: 'c_open', title: 'Open' }),
    ],
  }));
  assert.deepEqual(input.constraints.items.map((item) => item.itemId), ['c_open']);
});

test('an undated low-priority commitment stays out of today', () => {
  const input = buildDailyPlanInput(args({
    commitments: [
      commitment({ id: 'c_low', title: 'Someday', priority: { level: 'low', source: 'default', pressureAllowed: false, pressureLevel: 'none' } }),
      commitment({ id: 'c_high', title: 'Matters', priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' } }),
    ],
  }));
  assert.deepEqual(input.constraints.items.map((item) => item.itemId), ['c_high']);
});

test('every item carries a known effort, so nothing is reported merely for having no estimate', () => {
  const input = buildDailyPlanInput(args({ commitments: [commitment({ id: 'c1', title: 'One' })] }));
  assert.deepEqual(input.constraints.items[0]!.effort, { kind: 'known', minutes: DEFAULT_EFFORT_MINUTES });
});

/* ── AC-1: nothing is placed inside a busy block ─────────────────── */

const BUSY: BusyBlock[] = [
  { blockId: 'b1', startsAt: '2026-09-15T06:00:00.000Z', endsAt: '2026-09-15T08:00:00.000Z' },
  { blockId: 'b2', startsAt: '2026-09-15T10:00:00.000Z', endsAt: '2026-09-15T12:30:00.000Z' },
];

test('with three confirmed items and two busy blocks, no placement overlaps a busy block', () => {
  const commitments = [
    commitment({ id: 'c1', title: 'Write the summary' }),
    commitment({ id: 'c2', title: 'Call the bank' }),
    commitment({ id: 'c3', title: 'Book the train' }),
  ];
  const { constraints, config } = buildDailyPlanInput(args({ commitments, busyBlocks: BUSY }));
  const plan = schedulePlan(constraints, config);

  assert.equal(plan.scheduled.length, 3, 'the three items did not all fit in the free part of the day');
  for (const placed of plan.scheduled) {
    for (const block of BUSY) {
      assert.equal(
        intervalsOverlap(placed.reservedInterval, { startsAt: block.startsAt, endsAt: block.endsAt }),
        false,
        `${placed.itemId} was placed inside busy block ${block.blockId}`,
      );
    }
  }
});

test('the same inputs give the same inputDigest on two runs, and different inputs do not', () => {
  const commitments = [
    commitment({ id: 'c1', title: 'Write the summary' }),
    commitment({ id: 'c2', title: 'Call the bank' }),
    commitment({ id: 'c3', title: 'Book the train' }),
  ];
  const first = buildDailyPlanInput(args({ commitments, busyBlocks: BUSY }));
  const second = buildDailyPlanInput(args({ commitments, busyBlocks: BUSY }));
  const planA = schedulePlan(first.constraints, first.config);
  const planB = schedulePlan(second.constraints, second.config);

  assert.equal(planA.inputDigest, planB.inputDigest);
  assert.deepEqual(planA.scheduled, planB.scheduled);

  const withoutBusy = buildDailyPlanInput(args({ commitments, busyBlocks: [] }));
  assert.notEqual(
    schedulePlan(withoutBusy.constraints, withoutBusy.config).inputDigest,
    planA.inputDigest,
    'removing the busy blocks did not change the digest, so the digest does not cover them',
  );
});

test('the default busy-block reader answers empty rather than throwing', async () => {
  assert.deepEqual(await NO_BUSY_BLOCKS(UID, dayHorizon(DATE, TZ)), []);
});
