/**
 * The single deterministic pass over DomainState that every Life-State view
 * reads from.
 *
 * Derived once rather than per view for two reasons. It fixes one iteration
 * order for all four views — `Object.values` over a record yields insertion
 * order, which differs between two structurally identical states — and it means
 * "open", "overdue" and "due soon" have exactly one definition, so
 * `commitments.overdueCount` and `load.overdueCount` can never disagree.
 */
import { calculateAgendaUrgencyScore, type AgendaScoringReason } from '../utils/agendaScoring';
import {
  OPEN_COMMITMENT_STATUSES,
  TERMINAL_COMMITMENT_STATUSES,
} from '../../src/contracts/v1/lifeStateContracts';
import type { Commitment, DomainState, Reminder } from '../../src/domain/stateMachine';
import { compareStrings, parseIsoMs } from './fields';

/**
 * Matches the agenda's default horizon, so "due soon" means the same thing in a
 * life-state read as it does in the daily agenda the user already sees.
 */
export const DUE_SOON_WINDOW_MS = 24 * 60 * 60 * 1_000;

const DRAFT_STATUSES: readonly string[] = ['draft', 'needs_clarification', 'pending_confirmation'];
const OPEN_REMINDER_STATUSES: readonly string[] = ['scheduled', 'delivered', 'snoozed'];

export interface CommitmentFact {
  readonly commitment: Commitment;
  readonly isOpen: boolean;
  readonly isTerminal: boolean;
  /**
   * The commitment's own deadline. Only `timeSpec.dueAt` qualifies: `remindAt`
   * and reminder rows are delivery machinery, not times the user owes anything.
   */
  readonly deadlineAt: string | null;
  readonly isOverdue: boolean;
  readonly isDueSoon: boolean;
  /** Agenda urgency for open work; zero for anything already closed. */
  readonly urgencyScore: number;
}

function remindersByCommitment(state: DomainState): Record<string, Reminder[]> {
  const grouped: Record<string, Reminder[]> = {};
  const reminders = Object.values(state.reminders).sort((left, right) => compareStrings(left.id, right.id));

  for (const reminder of reminders) {
    const bucket = grouped[reminder.commitmentId];
    if (bucket) bucket.push(reminder);
    else grouped[reminder.commitmentId] = [reminder];
  }
  return grouped;
}

/**
 * Times that shape *how* urgent an item is, as opposed to whether it is overdue.
 * The agenda scorer uses these for overdue duration and deadline closeness, so
 * reminder times belong here even though they never define the deadline itself.
 */
function relevantTimes(commitment: Commitment, reminders: readonly Reminder[]): string[] {
  const candidates = [
    commitment.timeSpec.dueAt,
    commitment.timeSpec.remindAt,
    ...reminders
      .filter((reminder) => OPEN_REMINDER_STATUSES.includes(reminder.status))
      .map((reminder) => reminder.scheduledFor),
  ];

  return candidates
    .filter((value): value is string => parseIsoMs(value) !== null)
    .sort((left, right) => (parseIsoMs(left) as number) - (parseIsoMs(right) as number) || compareStrings(left, right));
}

/**
 * Mirrors the agenda's reason precedence — time pressure first, lifecycle stage
 * second — but is total where the agenda's classifier is partial: load has to
 * score every open commitment, including the low-priority ones the agenda drops.
 */
function scoringReason(fact: { isOverdue: boolean; isDueSoon: boolean; commitment: Commitment }): AgendaScoringReason {
  if (fact.isOverdue) return 'overdue';
  if (fact.isDueSoon) return 'due_soon';
  if (DRAFT_STATUSES.includes(fact.commitment.status)) return 'pending';
  return 'active';
}

export function deriveCommitmentFacts(state: DomainState, nowMs: number): readonly CommitmentFact[] {
  const now = new Date(nowMs);
  const grouped = remindersByCommitment(state);
  const commitments = Object.values(state.commitments).sort((left, right) => compareStrings(left.id, right.id));

  return commitments.map((commitment) => {
    const isOpen = OPEN_COMMITMENT_STATUSES.includes(commitment.status);
    const deadlineMs = parseIsoMs(commitment.timeSpec.dueAt);
    const deadlineAt = deadlineMs === null ? null : commitment.timeSpec.dueAt;
    const isOverdue = isOpen && deadlineMs !== null && deadlineMs < nowMs;
    const isDueSoon = isOpen && deadlineMs !== null && deadlineMs >= nowMs && deadlineMs <= nowMs + DUE_SOON_WINDOW_MS;
    const reminders = grouped[commitment.id] || [];

    return {
      commitment,
      isOpen,
      isTerminal: TERMINAL_COMMITMENT_STATUSES.includes(commitment.status),
      deadlineAt,
      isOverdue,
      isDueSoon,
      urgencyScore: isOpen
        ? calculateAgendaUrgencyScore({
          commitment,
          reminders,
          reason: scoringReason({ isOverdue, isDueSoon, commitment }),
          now,
          relevantTimes: relevantTimes(commitment, reminders),
          dueSoonWindowMs: DUE_SOON_WINDOW_MS,
        })
        : 0,
    };
  });
}
