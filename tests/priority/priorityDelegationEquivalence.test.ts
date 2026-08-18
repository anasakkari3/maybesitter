/**
 * End-to-end equivalence: real features scored by the real scorer must
 * reproduce the live agenda score exactly.
 *
 * #17 and #18 each verified equivalence with `calculateAgendaUrgencyScore`
 * independently — #17 by hand-reproducing the band arithmetic from its feature
 * vector, #18 by scoring feature vectors it constructed itself. Neither ran the
 * real extractor into the real scorer, so a mismatch between them would have
 * been invisible to both. Sprints 02 and 03 both shipped exactly that kind of
 * gap.
 *
 * This matters more than a usual integration test: at merge
 * `calculateAgendaUrgencyScore` delegates to this pipeline, so any divergence
 * here is a silent change to the ordering users already see.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateAgendaUrgencyScore, type AgendaScoringReason } from '../../lib/utils/agendaScoring.ts';
import { extractPriorityFeatures, deriveRelevantTimes, DEFAULT_DUE_SOON_WINDOW_MS } from '../../lib/priority/priorityFeatures.ts';
import { scorePriority } from '../../lib/priority/priorityScorer.ts';
import { DEFAULT_PRIORITY_POLICY } from '../../lib/priority/priorityPolicy.ts';
import type { Commitment, Reminder } from '../../src/domain/stateMachine.ts';
import type { PriorityReason } from '../../src/contracts/v1/priorityContracts.ts';

const NOW_ISO = '2026-08-19T12:00:00.000Z';
const NOW = new Date(NOW_ISO);

function commitment(overrides: Partial<Commitment> = {}): Commitment {
  return {
    id: 'c_1',
    kind: 'task',
    title: 'Call the clinic',
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: true, pressureLevel: 'gentle' },
    timeSpec: { kind: 'unscheduled', dueAt: null, remindAt: null, timezone: 'UTC' },
    currentAckState: 'seen',
    postponedUntil: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    confirmedAt: null,
    completedAt: null,
    droppedAt: null,
    ...overrides,
  };
}

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 'rem_1',
    commitmentId: 'c_1',
    reminderType: 'due_soon',
    scheduledFor: '2026-08-18T09:00:00.000Z',
    status: 'scheduled',
    requiresAction: true,
    deliveredAt: null,
    acknowledgedAt: null,
    snoozedUntil: null,
    createdAt: '2026-08-18T08:00:00.000Z',
    updatedAt: '2026-08-18T08:00:00.000Z',
    ...overrides,
  };
}

/** Runs both paths over the same inputs and asserts they agree. */
function assertEquivalent(
  label: string,
  subject: Commitment,
  reminders: readonly Reminder[],
  reason: AgendaScoringReason,
): void {
  const relevantTimes = deriveRelevantTimes(subject, reminders);

  const legacy = calculateAgendaUrgencyScore({
    commitment: subject,
    reminders,
    reason,
    now: NOW,
    relevantTimes,
    dueSoonWindowMs: DEFAULT_DUE_SOON_WINDOW_MS,
  });

  const features = extractPriorityFeatures({
    commitment: subject,
    reminders,
    now: NOW_ISO,
    relevantTimes,
    dueSoonWindowMs: DEFAULT_DUE_SOON_WINDOW_MS,
  });
  const scored = scorePriority({
    features,
    reason: reason as PriorityReason,
    policy: DEFAULT_PRIORITY_POLICY,
  });

  assert.equal(scored.total, legacy, `${label}: scored total must equal the live agenda score`);

  // The reconciliation invariant must survive the real pipeline, not only the
  // hand-built vectors each track tested against.
  const summed = scored.components.reduce((runningTotal, component) => runningTotal + component.points, 0);
  assert.equal(summed, scored.total, `${label}: components must sum to the total`);
}

const CASES: ReadonlyArray<{
  readonly label: string;
  readonly commitment: Commitment;
  readonly reminders: readonly Reminder[];
  readonly reason: AgendaScoringReason;
}> = [
  {
    label: 'pending, nothing set',
    commitment: commitment({ status: 'pending_confirmation' }),
    reminders: [],
    reason: 'pending',
  },
  {
    label: 'active, no times',
    commitment: commitment(),
    reminders: [],
    reason: 'active',
  },
  {
    label: 'overdue by one hour',
    commitment: commitment({
      timeSpec: { kind: 'due_by', dueAt: '2026-08-19T11:00:00.000Z', remindAt: null, timezone: 'UTC' },
    }),
    reminders: [],
    reason: 'overdue',
  },
  {
    label: 'overdue far past the saturation point',
    commitment: commitment({
      timeSpec: { kind: 'due_by', dueAt: '2026-07-01T00:00:00.000Z', remindAt: null, timezone: 'UTC' },
    }),
    reminders: [],
    reason: 'overdue',
  },
  {
    label: 'due soon, mid-window',
    commitment: commitment({
      timeSpec: { kind: 'due_by', dueAt: '2026-08-20T00:00:00.000Z', remindAt: null, timezone: 'UTC' },
    }),
    reminders: [],
    reason: 'due_soon',
  },
  {
    label: 'due soon, exactly now',
    commitment: commitment({
      timeSpec: { kind: 'due_by', dueAt: NOW_ISO, remindAt: null, timezone: 'UTC' },
    }),
    reminders: [],
    reason: 'due_soon',
  },
  {
    label: 'high importance, user set',
    commitment: commitment({
      priority: { level: 'high', source: 'user_explicit', pressureAllowed: true, pressureLevel: 'firm' },
    }),
    reminders: [],
    reason: 'active',
  },
  {
    label: 'snoozed past the lateness cap',
    commitment: commitment(),
    reminders: [
      reminder({ id: 'r1', status: 'snoozed' }),
      reminder({ id: 'r2', status: 'snoozed' }),
      reminder({ id: 'r3', status: 'snoozed' }),
      reminder({ id: 'r4', status: 'snoozed' }),
    ],
    reason: 'active',
  },
  {
    label: 'postponed and deferred together',
    commitment: commitment({
      status: 'deferred',
      currentAckState: 'postponed',
      postponedUntil: '2026-08-20T09:00:00.000Z',
    }),
    reminders: [],
    reason: 'active',
  },
  {
    label: 'ignored recently',
    commitment: commitment({ currentAckState: 'ignored', updatedAt: '2026-08-19T06:00:00.000Z' }),
    reminders: [reminder({ status: 'ignored', updatedAt: '2026-08-19T06:00:00.000Z' })],
    reason: 'active',
  },
  {
    label: 'ignored long ago',
    commitment: commitment({ currentAckState: 'ignored', updatedAt: '2026-08-01T06:00:00.000Z' }),
    reminders: [reminder({ status: 'ignored', updatedAt: '2026-08-01T06:00:00.000Z' })],
    reason: 'active',
  },
  {
    label: 'maximal: the band cap binds',
    commitment: commitment({
      status: 'deferred',
      currentAckState: 'ignored',
      postponedUntil: '2026-08-20T09:00:00.000Z',
      updatedAt: '2026-08-19T06:00:00.000Z',
      priority: { level: 'high', source: 'user_explicit', pressureAllowed: true, pressureLevel: 'firm' },
      timeSpec: { kind: 'due_by', dueAt: '2026-07-01T00:00:00.000Z', remindAt: null, timezone: 'UTC' },
    }),
    reminders: [
      reminder({ id: 'r1', status: 'snoozed' }),
      reminder({ id: 'r2', status: 'snoozed' }),
      reminder({ id: 'r3', status: 'snoozed' }),
      reminder({ id: 'r4', status: 'ignored', updatedAt: '2026-08-19T06:00:00.000Z' }),
    ],
    reason: 'overdue',
  },
  {
    label: 'non-UTC offset on the due time',
    commitment: commitment({
      timeSpec: { kind: 'due_by', dueAt: '2026-08-19T14:00:00.000+03:00', remindAt: null, timezone: 'Asia/Jerusalem' },
    }),
    reminders: [],
    reason: 'due_soon',
  },
];

for (const testCase of CASES) {
  test(`delegation equivalence: ${testCase.label}`, () => {
    assertEquivalent(testCase.label, testCase.commitment, testCase.reminders, testCase.reason);
  });
}

test('delegation equivalence holds across every reason band for one commitment', () => {
  const subject = commitment({
    timeSpec: { kind: 'due_by', dueAt: '2026-08-19T11:00:00.000Z', remindAt: null, timezone: 'UTC' },
  });
  for (const reason of ['overdue', 'due_soon', 'active', 'pending'] as const) {
    assertEquivalent(`band ${reason}`, subject, [], reason);
  }
});

test('the band cap is actually exercised, so the clamp component is not untested here', () => {
  const maximal = CASES.find((entry) => entry.label === 'maximal: the band cap binds');
  assert.ok(maximal);

  const features = extractPriorityFeatures({
    commitment: maximal.commitment,
    reminders: maximal.reminders,
    now: NOW_ISO,
    relevantTimes: deriveRelevantTimes(maximal.commitment, maximal.reminders),
    dueSoonWindowMs: DEFAULT_DUE_SOON_WINDOW_MS,
  });
  const scored = scorePriority({
    features,
    reason: 'overdue',
    policy: DEFAULT_PRIORITY_POLICY,
  });

  const clamp = scored.components.find((component) => component.code === 'band_clamp');
  assert.ok(clamp, 'a band_clamp component must be emitted');
  assert.ok(clamp.points < 0, 'the clamp must bind on the maximal vector, or this case proves nothing');
  assert.ok(scored.reasonCodes.includes('BAND_CAPPED'));
});

test('an unparseable clock now throws instead of scoring from nonsense', () => {
  // The one intentional behaviour change in the delegation. Previously an
  // invalid Date flowed through as NaN and produced a confident, wrong score:
  // 7300 for a commitment a valid clock scored 7720, with every time feature
  // silently dropped and every ignore treated as stale. A ranking computed
  // from a clock we do not have is worse than a refusal.
  const subject = commitment({
    currentAckState: 'ignored',
    timeSpec: { kind: 'due_by', dueAt: '2026-07-01T00:00:00.000Z', remindAt: null, timezone: 'UTC' },
  });

  assert.throws(
    () => calculateAgendaUrgencyScore({
      commitment: subject,
      reminders: [],
      reason: 'overdue',
      now: new Date('not a date'),
      relevantTimes: ['2026-07-01T00:00:00.000Z'],
      dueSoonWindowMs: DEFAULT_DUE_SOON_WINDOW_MS,
    }),
    /must be a valid Date/,
  );
});
