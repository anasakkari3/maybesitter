import { getCommandServiceState } from './commandService';
import type { Commitment, DomainState, Reminder } from '../../src/domain/stateMachine';

type ReviewSectionKey = 'active' | 'pendingConfirmations' | 'overdue' | 'upcoming';

export interface CommitmentReviewItem {
  id: string;
  title: string;
  status: string;
  kind: string;
  person: string | null;
  priority: string;
  dueAt: string | null;
  remindAt: string | null;
  nextReminderAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommitmentReviewSnapshot {
  generatedAt: string;
  sections: Record<ReviewSectionKey, CommitmentReviewItem[]>;
}

const CLOSED_STATUSES = new Set(['completed', 'dropped', 'archived']);
const ACTIVE_STATUSES = new Set(['active', 'deferred', 'missed']);
const OPEN_REMINDER_STATUSES = new Set(['scheduled', 'delivered', 'snoozed']);

function reminderTimesFor(commitment: Commitment, reminders: Reminder[]): string[] {
  return reminders
    .filter((reminder) => reminder.commitmentId === commitment.id && OPEN_REMINDER_STATUSES.has(reminder.status))
    .map((reminder) => reminder.scheduledFor);
}

function relevantTimes(commitment: Commitment, reminders: Reminder[]): string[] {
  return [
    commitment.timeSpec.dueAt,
    commitment.timeSpec.remindAt,
    ...reminderTimesFor(commitment, reminders),
  ].filter((value): value is string => Boolean(value && !Number.isNaN(Date.parse(value))));
}

function nextReminderAt(commitment: Commitment, reminders: Reminder[]): string | null {
  return reminderTimesFor(commitment, reminders)
    .filter((value) => !Number.isNaN(Date.parse(value)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0] || null;
}

function toReviewItem(commitment: Commitment, reminders: Reminder[]): CommitmentReviewItem {
  return {
    id: commitment.id,
    title: commitment.title,
    status: commitment.status,
    kind: commitment.kind,
    person: commitment.person,
    priority: commitment.priority.level,
    dueAt: commitment.timeSpec.dueAt,
    remindAt: commitment.timeSpec.remindAt,
    nextReminderAt: nextReminderAt(commitment, reminders),
    createdAt: commitment.createdAt,
    updatedAt: commitment.updatedAt,
  };
}

function sortByTime(items: CommitmentReviewItem[]): CommitmentReviewItem[] {
  return [...items].sort((a, b) => {
    const aTime = Date.parse(a.nextReminderAt || a.remindAt || a.dueAt || a.updatedAt);
    const bTime = Date.parse(b.nextReminderAt || b.remindAt || b.dueAt || b.updatedAt);
    return aTime - bTime;
  });
}

function isOpen(commitment: Commitment): boolean {
  return !CLOSED_STATUSES.has(commitment.status);
}

function isOverdue(commitment: Commitment, reminders: Reminder[], nowMs: number): boolean {
  return isOpen(commitment) && relevantTimes(commitment, reminders).some((value) => Date.parse(value) < nowMs);
}

function isUpcoming(commitment: Commitment, reminders: Reminder[], nowMs: number): boolean {
  return isOpen(commitment) && relevantTimes(commitment, reminders).some((value) => Date.parse(value) >= nowMs);
}

export function getCommitmentReviewSnapshot(
  now: Date = new Date(),
  state: DomainState = getCommandServiceState()
): CommitmentReviewSnapshot {
  const commitments = Object.values(state.commitments);
  const reminders = Object.values(state.reminders);
  const nowMs = now.getTime();

  return {
    generatedAt: now.toISOString(),
    sections: {
      active: sortByTime(
        commitments
          .filter((commitment) => ACTIVE_STATUSES.has(commitment.status))
          .map((commitment) => toReviewItem(commitment, reminders))
      ),
      pendingConfirmations: sortByTime(
        commitments
          .filter((commitment) => commitment.status === 'pending_confirmation')
          .map((commitment) => toReviewItem(commitment, reminders))
      ),
      overdue: sortByTime(
        commitments
          .filter((commitment) => isOverdue(commitment, reminders, nowMs))
          .map((commitment) => toReviewItem(commitment, reminders))
      ),
      upcoming: sortByTime(
        commitments
          .filter((commitment) => isUpcoming(commitment, reminders, nowMs))
          .map((commitment) => toReviewItem(commitment, reminders))
      ),
    },
  };
}
