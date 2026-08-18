/**
 * Shared builders for the #17 feature-extraction tests.
 *
 * Split out so the behavioural suite and the boundary suite construct their
 * domain records identically — a fixture that drifts between two suites makes
 * one of them pass for a reason the other cannot reproduce.
 */
import type { Commitment, Reminder } from '../../src/domain/stateMachine.ts';

export function commitmentOf(overrides: Partial<Commitment> = {}): Commitment {
  return {
    id: 'cmt_1',
    kind: 'task',
    title: 'Send the invoice',
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt: null, remindAt: null, timezone: 'UTC' },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    confirmedAt: null,
    completedAt: null,
    droppedAt: null,
    ...overrides,
  };
}

export function reminderOf(overrides: Partial<Reminder> & { id: string }): Reminder {
  return {
    commitmentId: 'cmt_1',
    reminderType: 'due_soon',
    scheduledFor: '2026-08-18T09:00:00.000Z',
    status: 'scheduled',
    requiresAction: false,
    deliveredAt: null,
    acknowledgedAt: null,
    snoozedUntil: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}
