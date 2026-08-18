/**
 * Numeric equivalence between the explainable scorer (#18) and the live
 * `calculateAgendaUrgencyScore` it will replace at merge time.
 *
 * This is the test that makes the delegation safe. `agendaScoring` is what
 * users see today, so any difference between the two is a defect in the new
 * scorer rather than an improvement to accept — the legacy function is
 * imported read-only and never modified here.
 *
 * The feature vectors are derived in this file rather than by #17's extractor:
 * the two tracks are built in parallel, and hard-coding the mapping here states
 * the arithmetic contract the extractor must satisfy without depending on it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { scorePriority } from '../../lib/priority/priorityScorer.ts';
import { DEFAULT_PRIORITY_POLICY } from '../../lib/priority/priorityPolicy.ts';
import { calculateAgendaUrgencyScore, type AgendaScoringInput } from '../../lib/utils/agendaScoring.ts';
import type { Commitment, Reminder } from '../../src/domain/stateMachine.ts';
import type { PriorityReason } from '../../src/contracts/v1/priorityContracts.ts';
import { makeFeatures, type FeatureOverrides } from './priorityScorerFixtures.ts';

const NOW = new Date('2026-08-18T12:00:00.000Z');
const NOW_MS = NOW.getTime();
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

function at(offsetMs: number): string {
  return new Date(NOW_MS + offsetMs).toISOString();
}

function makeCommitment(overrides: Partial<Commitment> = {}): Commitment {
  return {
    id: 'cmt_1',
    kind: 'task',
    title: 'Send the invoice',
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: true, pressureLevel: 'gentle' },
    timeSpec: { kind: 'due_by', dueAt: at(-HOUR_MS), remindAt: null, timezone: 'UTC' },
    currentAckState: 'seen',
    postponedUntil: null,
    createdAt: at(-5 * DAY_MS),
    updatedAt: at(-HOUR_MS),
    confirmedAt: null,
    completedAt: null,
    droppedAt: null,
    ...overrides,
  };
}

function makeReminder(id: string, status: Reminder['status'], updatedAt: string): Reminder {
  return {
    id,
    commitmentId: 'cmt_1',
    reminderType: 'due_now',
    scheduledFor: updatedAt,
    status,
    requiresAction: true,
    deliveredAt: updatedAt,
    acknowledgedAt: null,
    snoozedUntil: null,
    createdAt: updatedAt,
    updatedAt,
  };
}

/**
 * The mapping stated in the design's "Mapping to the existing scorer" table,
 * written out as arithmetic over the same inputs `agendaScoring` receives.
 */
function deriveFeatures(input: AgendaScoringInput): FeatureOverrides {
  const nowMs = input.now.getTime();
  const times = input.relevantTimes.map((value) => Date.parse(value)).filter((ms) => !Number.isNaN(ms));

  const overdueTimes = times.filter((ms) => ms < nowMs).sort((left, right) => left - right);
  const hoursOverdue = overdueTimes.length === 0 ? 0 : (nowMs - overdueTimes[0]) / HOUR_MS;

  const upcomingTimes = times.filter((ms) => ms >= nowMs).sort((left, right) => left - right);
  const window = input.dueSoonWindowMs;
  const dueSoonCloseness =
    upcomingTimes.length === 0 || window <= 0
      ? 0
      : 1 - Math.max(0, Math.min(window, upcomingTimes[0] - nowMs)) / window;

  const ignoredReminderTimes = input.reminders
    .filter((reminder) => reminder.status === 'ignored')
    .map((reminder) => Date.parse(reminder.updatedAt))
    .filter((ms) => !Number.isNaN(ms))
    .sort((left, right) => right - left);
  const ackIgnoredAt =
    input.commitment.currentAckState === 'ignored' ? Date.parse(input.commitment.updatedAt) : Number.NaN;
  const latestIgnoredAt = ignoredReminderTimes.length > 0 ? ignoredReminderTimes[0] : ackIgnoredAt;
  const ignoredCount = Number.isNaN(latestIgnoredAt)
    ? 0
    : Math.max(ignoredReminderTimes.length, 1);

  return {
    commitmentId: input.commitment.id,
    urgency: { hoursOverdue, dueSoonCloseness },
    importance: {
      level: input.commitment.priority.level,
      userSet: input.commitment.priority.source === 'user_explicit',
    },
    lateness: {
      snoozedCount: input.reminders.filter((reminder) => reminder.status === 'snoozed').length,
      postponed: input.commitment.currentAckState === 'postponed' || input.commitment.postponedUntil !== null,
      deferred: input.commitment.status === 'deferred',
    },
    userPressure: {
      ignoredCount,
      ignoredRecently: ignoredCount > 0 && nowMs - latestIgnoredAt <= DAY_MS,
    },
  };
}

interface EquivalenceCase {
  readonly name: string;
  readonly input: AgendaScoringInput;
  /** Stated independently so the case documents the number, not just the match. */
  readonly expected: number;
}

const cases: readonly EquivalenceCase[] = [
  {
    name: 'overdue by an hour, normal importance',
    input: {
      commitment: makeCommitment(),
      reminders: [],
      reason: 'overdue',
      now: NOW,
      relevantTimes: [at(-HOUR_MS)],
      dueSoonWindowMs: DAY_MS,
    },
    expected: 7_000 + 6 + 80,
  },
  {
    name: 'every band component at its maximum, so the band cap binds',
    input: {
      commitment: makeCommitment({
        status: 'deferred',
        priority: { level: 'high', source: 'inferred', pressureAllowed: true, pressureLevel: 'firm' },
        currentAckState: 'postponed',
        postponedUntil: at(6 * HOUR_MS),
      }),
      reminders: [
        makeReminder('rem_1', 'snoozed', at(-3 * HOUR_MS)),
        makeReminder('rem_2', 'snoozed', at(-2 * HOUR_MS)),
        makeReminder('rem_3', 'snoozed', at(-1 * HOUR_MS)),
        makeReminder('rem_4', 'ignored', at(-1 * HOUR_MS)),
      ],
      reason: 'overdue',
      now: NOW,
      relevantTimes: [at(-100 * HOUR_MS)],
      dueSoonWindowMs: DAY_MS,
    },
    expected: 7_000 + 999,
  },
  {
    name: 'due soon at the middle of the window, low importance',
    input: {
      commitment: makeCommitment({
        priority: { level: 'low', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
      }),
      reminders: [],
      reason: 'due_soon',
      now: NOW,
      relevantTimes: [at(12 * HOUR_MS)],
      dueSoonWindowMs: DAY_MS,
    },
    expected: 5_000 + 210,
  },
  {
    name: 'due soon with nothing left of the window',
    input: {
      commitment: makeCommitment({
        priority: { level: 'low', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
      }),
      reminders: [],
      reason: 'due_soon',
      now: NOW,
      relevantTimes: [at(0)],
      dueSoonWindowMs: DAY_MS,
    },
    expected: 5_000 + 420,
  },
  {
    name: 'due soon with no upcoming time to measure',
    input: {
      commitment: makeCommitment({
        priority: { level: 'low', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
      }),
      reminders: [],
      reason: 'due_soon',
      now: NOW,
      relevantTimes: [],
      dueSoonWindowMs: DAY_MS,
    },
    expected: 5_000,
  },
  {
    name: 'due soon with a zero-length window',
    input: {
      commitment: makeCommitment({
        priority: { level: 'low', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
      }),
      reminders: [],
      reason: 'due_soon',
      now: NOW,
      relevantTimes: [at(HOUR_MS)],
      dueSoonWindowMs: 0,
    },
    expected: 5_000,
  },
  {
    name: 'active with one snooze and high importance',
    input: {
      commitment: makeCommitment({
        priority: { level: 'high', source: 'user_explicit', pressureAllowed: true, pressureLevel: 'firm' },
      }),
      reminders: [makeReminder('rem_1', 'snoozed', at(-2 * HOUR_MS))],
      reason: 'active',
      now: NOW,
      relevantTimes: [],
      dueSoonWindowMs: DAY_MS,
    },
    expected: 3_000 + 180 + 90,
  },
  {
    name: 'active ignores the time features its band does not use',
    input: {
      commitment: makeCommitment(),
      reminders: [],
      reason: 'active',
      now: NOW,
      relevantTimes: [at(-5 * HOUR_MS), at(HOUR_MS)],
      dueSoonWindowMs: DAY_MS,
    },
    expected: 3_000 + 80,
  },
  {
    name: 'pending with a stale ignore',
    input: {
      commitment: makeCommitment({
        priority: { level: 'low', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
      }),
      reminders: [makeReminder('rem_1', 'ignored', at(-48 * HOUR_MS))],
      reason: 'pending',
      now: NOW,
      relevantTimes: [],
      dueSoonWindowMs: DAY_MS,
    },
    expected: 1_000 + 120,
  },
  {
    name: 'overdue with the ignore carried by ack state rather than a reminder',
    input: {
      commitment: makeCommitment({
        priority: { level: 'high', source: 'user_explicit', pressureAllowed: true, pressureLevel: 'firm' },
        currentAckState: 'ignored',
        updatedAt: at(-2 * HOUR_MS),
      }),
      reminders: [],
      reason: 'overdue',
      now: NOW,
      relevantTimes: [at(-3 * HOUR_MS)],
      dueSoonWindowMs: DAY_MS,
    },
    expected: 7_000 + 18 + 180 + 240,
  },
  {
    name: 'pending with nothing to report',
    input: {
      commitment: makeCommitment({
        priority: { level: 'low', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
      }),
      reminders: [],
      reason: 'pending',
      now: NOW,
      relevantTimes: [],
      dueSoonWindowMs: DAY_MS,
    },
    expected: 1_000,
  },
  {
    name: 'snoozes past the snooze cap',
    input: {
      commitment: makeCommitment(),
      reminders: [
        makeReminder('rem_1', 'snoozed', at(-5 * HOUR_MS)),
        makeReminder('rem_2', 'snoozed', at(-4 * HOUR_MS)),
        makeReminder('rem_3', 'snoozed', at(-3 * HOUR_MS)),
        makeReminder('rem_4', 'snoozed', at(-2 * HOUR_MS)),
      ],
      reason: 'active',
      now: NOW,
      relevantTimes: [],
      dueSoonWindowMs: DAY_MS,
    },
    expected: 3_000 + 80 + 270,
  },
];

for (const equivalenceCase of cases) {
  test(`priorityScorer equivalence: ${equivalenceCase.name}`, () => {
    const legacy = calculateAgendaUrgencyScore(equivalenceCase.input);
    const scored = scorePriority({
      features: makeFeatures(deriveFeatures(equivalenceCase.input)),
      reason: equivalenceCase.input.reason as PriorityReason,
      policy: DEFAULT_PRIORITY_POLICY,
    });

    assert.equal(legacy, equivalenceCase.expected, 'the legacy scorer must still produce the stated number');
    assert.equal(scored.total, legacy, 'the explainable scorer must reproduce the legacy total exactly');
    assert.equal(
      scored.components.reduce((sum, component) => sum + component.points, 0),
      scored.total,
    );
  });
}

test('priorityScorer equivalence: the cases cover every reason band', () => {
  const covered = cases
    .map((equivalenceCase) => equivalenceCase.input.reason)
    .filter((reason, index, all) => all.indexOf(reason) === index)
    .slice()
    .sort();
  assert.deepEqual(covered, ['active', 'due_soon', 'overdue', 'pending']);
});
