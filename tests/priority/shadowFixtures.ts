/**
 * Shared subjects for the shadow-comparison tests (Sprint 05, #23).
 *
 * Every fixture here is built so that a rank change is *arithmetically
 * forced* rather than hoped for. The comparison under test can produce a
 * zero-disagreement report — and must, when the two policies are equal — so a
 * fixture that merely "probably" moves would let a broken comparison pass by
 * reporting the same zero it reports for the control.
 *
 * All subjects sit in the `overdue` band at `NOW`, so `reason_base` is the same
 * 7000 for each and every difference between them is a band component. The
 * totals in the comments below are therefore checkable by hand, and the tests
 * pin them.
 */
import type { Commitment, Reminder } from '../../src/domain/stateMachine.ts';
import type { ShadowSubject } from '../../lib/priority/shadow/shadowComparison.ts';

export const NOW = '2026-08-18T12:00:00.000Z';
export const GENERATED_AT = '2026-08-18T12:30:00.000Z';

const HOUR_MS = 60 * 60 * 1_000;

/** Hours before `NOW`, as an ISO instant. Never derived from the host clock. */
export function hoursBefore(hours: number): string {
  return new Date(Date.parse(NOW) - hours * HOUR_MS).toISOString();
}

export function commitmentOf(overrides: Partial<Commitment> & { id: string }): Commitment {
  return {
    kind: 'task',
    title: 'Send the invoice',
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'normal', source: 'inferred', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt: null, remindAt: null, timezone: 'UTC' },
    currentAckState: 'seen',
    postponedUntil: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
    confirmedAt: null,
    completedAt: null,
    droppedAt: null,
    ...overrides,
  };
}

export function reminderOf(overrides: Partial<Reminder> & { id: string; commitmentId: string }): Reminder {
  return {
    reminderType: 'due_soon',
    scheduledFor: hoursBefore(1),
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

function overdueSubject(commitment: Commitment, reminders: readonly Reminder[] = []): ShadowSubject {
  return { commitment, reminders, reason: 'overdue' };
}

/**
 * `A` — every feature known, one ignore inside the recency window.
 *
 * 7000 + urgency(round(6 x 1) = 6) + importance(normal = 80) + lateness(0)
 * + userPressure(recent = 240) = **7326**.
 */
export const SUBJECT_A: ShadowSubject = overdueSubject(
  commitmentOf({
    id: 'cmt_a',
    timeSpec: { kind: 'due_by', dueAt: hoursBefore(1), remindAt: null, timezone: 'UTC' },
  }),
  [reminderOf({ id: 'rem_a1', commitmentId: 'cmt_a', status: 'ignored', updatedAt: hoursBefore(1) })],
);

/**
 * `R` — an ignore that carries no usable instant, so `userPressure` is
 * **unknown**. This is the realistic shape of the missing-context case: the ack
 * state says the user ignored the item, and nothing in the record says when, so
 * the feature is absent rather than counted as stale.
 *
 * 7000 + urgency(round(6 x 42) = 252) + importance(80) + lateness(0) = **7332**.
 */
export const SUBJECT_R: ShadowSubject = overdueSubject(
  commitmentOf({
    id: 'cmt_r',
    currentAckState: 'ignored',
    updatedAt: 'unknown',
    timeSpec: { kind: 'due_by', dueAt: hoursBefore(42), remindAt: null, timezone: 'UTC' },
  }),
);

/**
 * `M` — high importance (inferred, so no hard constraint) *and* an undatable
 * ignore. Both a re-weighted known feature and a re-weighted unknown one.
 *
 * 7000 + urgency(round(6 x 20) = 120) + importance(high = 180) + lateness(0) = **7300**.
 */
export const SUBJECT_M: ShadowSubject = overdueSubject(
  commitmentOf({
    id: 'cmt_m',
    currentAckState: 'ignored',
    updatedAt: 'unknown',
    priority: { level: 'high', source: 'inferred', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt: hoursBefore(20), remindAt: null, timezone: 'UTC' },
  }),
);

/**
 * `P` — high importance, every feature known.
 *
 * 7000 + urgency(6) + importance(180) + lateness(0) + userPressure(known 0) = **7186**.
 */
export const SUBJECT_P: ShadowSubject = overdueSubject(
  commitmentOf({
    id: 'cmt_p',
    priority: { level: 'high', source: 'inferred', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt: hoursBefore(1), remindAt: null, timezone: 'UTC' },
  }),
);

/**
 * `Q` — normal importance, further overdue, every feature known.
 *
 * 7000 + urgency(round(6 x 20) = 120) + importance(80) + lateness(0)
 * + userPressure(known 0) = **7200**.
 */
export const SUBJECT_Q: ShadowSubject = overdueSubject(
  commitmentOf({
    id: 'cmt_q',
    timeSpec: { kind: 'due_by', dueAt: hoursBefore(20), remindAt: null, timezone: 'UTC' },
  }),
);

/** Ids only, for the sampling tests, where the commitment bodies are irrelevant. */
export function syntheticIds(count: number): readonly string[] {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) ids.push(`cmt_${index}`);
  return ids;
}
