import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateAgendaUrgencyScore } from '../lib/utils/agendaScoring.ts';
import { applyCommand, createEmptyDomainState } from '../src/domain/stateMachine.ts';

const now = new Date('2026-04-08T08:00:00.000Z');

function makeCommitment() {
  const state = applyCommand(createEmptyDomainState(), {
    type: 'CreateDraft',
    now: '2026-04-08T07:00:00.000Z',
    commitment: {
      id: 'cmt',
      kind: 'task',
      title: 'Send invoice',
      priority: { level: 'high' },
      timeSpec: {
        kind: 'due_by',
        dueAt: '2026-04-08T07:00:00.000Z',
        remindAt: '2026-04-08T07:00:00.000Z',
        timezone: 'UTC',
      },
    },
    draftStatus: 'pending_confirmation',
  }).newState;

  return state.commitments.cmt;
}

test('agendaScoring: reason bands enforce required priority order', () => {
  const commitment = makeCommitment();
  const scores = {
    overdue: calculateAgendaUrgencyScore({
      commitment,
      reminders: [],
      reason: 'overdue',
      now,
      relevantTimes: ['2026-04-08T07:00:00.000Z'],
      dueSoonWindowMs: 24 * 60 * 60 * 1000,
    }),
    dueSoon: calculateAgendaUrgencyScore({
      commitment,
      reminders: [],
      reason: 'due_soon',
      now,
      relevantTimes: ['2026-04-08T08:10:00.000Z'],
      dueSoonWindowMs: 24 * 60 * 60 * 1000,
    }),
    active: calculateAgendaUrgencyScore({
      commitment,
      reminders: [],
      reason: 'active',
      now,
      relevantTimes: [],
      dueSoonWindowMs: 24 * 60 * 60 * 1000,
    }),
    pending: calculateAgendaUrgencyScore({
      commitment,
      reminders: [],
      reason: 'pending',
      now,
      relevantTimes: [],
      dueSoonWindowMs: 24 * 60 * 60 * 1000,
    }),
  };

  assert.ok(scores.overdue > scores.dueSoon);
  assert.ok(scores.dueSoon > scores.active);
  assert.ok(scores.active > scores.pending);
});

test('agendaScoring: caps extreme scores', () => {
  const commitment = {
    ...makeCommitment(),
    currentAckState: 'postponed' as const,
    postponedUntil: '2026-04-09T08:00:00.000Z',
  };
  const reminders = Array.from({ length: 20 }, (_, index) => ({
    id: `rem_${index}`,
    commitmentId: 'cmt',
    reminderType: 'check_in' as const,
    scheduledFor: '2026-04-09T08:00:00.000Z',
    status: 'snoozed' as const,
    requiresAction: true,
    deliveredAt: '2026-04-08T07:00:00.000Z',
    acknowledgedAt: null,
    snoozedUntil: '2026-04-09T08:00:00.000Z',
    createdAt: '2026-04-08T07:00:00.000Z',
    updatedAt: '2026-04-08T07:30:00.000Z',
  }));

  const score = calculateAgendaUrgencyScore({
    commitment,
    reminders,
    reason: 'overdue',
    now,
    relevantTimes: ['2020-01-01T00:00:00.000Z'],
    dueSoonWindowMs: 24 * 60 * 60 * 1000,
  });

  assert.ok(score <= 9999);
  assert.equal(score, 7999);
});
