import { getCommandServiceState } from './commandService';
import type { Commitment, DomainState, Reminder } from '../../src/domain/stateMachine';
import { calculateAgendaUrgencyScore } from '../utils/agendaScoring';
import { getPressureCandidateForAgenda, type PressureCandidateMessage, type PressureDeliveryStore } from './pressureService';
import type { BehaviorFeedbackStore } from './behaviorFeedbackService';

export type AgendaReason = 'overdue' | 'due_soon' | 'pending' | 'active';
export type AgendaSuggestedAction = 'do' | 'review' | 'confirm';

export interface AgendaItem {
  id: string;
  title: string;
  reason: AgendaReason;
  urgencyScore: number;
  suggestedAction: AgendaSuggestedAction;
}

export interface Agenda {
  items: AgendaItem[];
  pressureCandidate?: PressureCandidateMessage;
}

export interface AgendaOptions {
  now?: Date;
  maxItems?: number;
  dueSoonWindowMs?: number;
  pressureDeliveryStore?: PressureDeliveryStore;
  behaviorFeedbackStore?: BehaviorFeedbackStore;
  sessionId?: string;
  userId?: string;
  conversationId?: string;
  pressureScopeId?: string;
}

const DEFAULT_MAX_ITEMS = 7;
const DEFAULT_DUE_SOON_WINDOW_MS = 24 * 60 * 60 * 1000;
const CLOSED_STATUSES = new Set(['completed', 'dropped', 'archived']);
const ACTIVE_STATUSES = new Set(['active', 'deferred', 'missed']);
const OPEN_REMINDER_STATUSES = new Set(['scheduled', 'delivered', 'snoozed']);

function boundedMaxItems(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return DEFAULT_MAX_ITEMS;
  return Math.max(1, Math.min(7, Math.floor(value)));
}

function isOpen(commitment: Commitment): boolean {
  return !CLOSED_STATUSES.has(commitment.status);
}

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

function hasOverdueTime(times: readonly string[], nowMs: number): boolean {
  return times.some((time) => Date.parse(time) < nowMs);
}

function hasDueSoonTime(times: readonly string[], nowMs: number, dueSoonWindowMs: number): boolean {
  return times.some((time) => {
    const timeMs = Date.parse(time);
    return timeMs >= nowMs && timeMs <= nowMs + dueSoonWindowMs;
  });
}

function classifyCommitment(
  commitment: Commitment,
  reminders: Reminder[],
  now: Date,
  dueSoonWindowMs: number
): AgendaItem | null {
  if (!isOpen(commitment)) return null;

  const nowMs = now.getTime();
  const times = relevantTimes(commitment, reminders);
  const overdue = hasOverdueTime(times, nowMs);
  const dueSoon = hasDueSoonTime(times, nowMs, dueSoonWindowMs);
  const relatedReminders = reminders.filter((reminder) => reminder.commitmentId === commitment.id);

  const score = (reason: AgendaReason) => calculateAgendaUrgencyScore({
    commitment,
    reminders: relatedReminders,
    reason,
    now,
    relevantTimes: times,
    dueSoonWindowMs,
  });

  if (overdue) {
    return {
      id: commitment.id,
      title: commitment.title,
      reason: 'overdue',
      urgencyScore: score('overdue'),
      suggestedAction: 'do',
    };
  }

  if (commitment.status === 'pending_confirmation') {
    return {
      id: commitment.id,
      title: commitment.title,
      reason: 'pending',
      urgencyScore: score('pending'),
      suggestedAction: 'confirm',
    };
  }

  if (dueSoon) {
    return {
      id: commitment.id,
      title: commitment.title,
      reason: 'due_soon',
      urgencyScore: score('due_soon'),
      suggestedAction: 'do',
    };
  }

  if (ACTIVE_STATUSES.has(commitment.status) && commitment.priority.level !== 'low') {
    return {
      id: commitment.id,
      title: commitment.title,
      reason: 'active',
      urgencyScore: score('active'),
      suggestedAction: 'review',
    };
  }

  return null;
}

export function getDailyAgenda(
  options: AgendaOptions = {},
  state: DomainState = getCommandServiceState()
): Agenda {
  const now = options.now || new Date();
  const maxItems = boundedMaxItems(options.maxItems);
  const dueSoonWindowMs = options.dueSoonWindowMs || DEFAULT_DUE_SOON_WINDOW_MS;
  const reminders = Object.values(state.reminders);

  const itemsById = new Map<string, AgendaItem>();
  for (const commitment of Object.values(state.commitments)) {
    const item = classifyCommitment(commitment, reminders, now, dueSoonWindowMs);
    if (!item) continue;

    const existing = itemsById.get(item.id);
    if (!existing || item.urgencyScore > existing.urgencyScore) {
      itemsById.set(item.id, item);
    }
  }

  const items = Array.from(itemsById.values())
    .sort((a, b) => b.urgencyScore - a.urgencyScore || a.title.localeCompare(b.title))
    .slice(0, maxItems);
  const pressureCandidate = getPressureCandidateForAgenda(items, {
    now,
    deliveryStore: options.pressureDeliveryStore,
    behaviorFeedbackStore: options.behaviorFeedbackStore,
    sessionId: options.sessionId,
    userId: options.userId,
    conversationId: options.conversationId,
    pressureScopeId: options.pressureScopeId,
  }, state);

  return pressureCandidate ? { items, pressureCandidate } : { items };
}
