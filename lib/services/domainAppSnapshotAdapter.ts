import { randomUUID } from 'crypto';
import type { AppSnapshot } from '../../src/server/dataStore';
import { getAppSnapshot, SINGLE_USER_ID } from '../../src/server/dataStore';
import type { Item, ItemPriority, ReminderAttempt } from '../../src/types/index';
import { applyCommand, configureCommandService, getCommandServiceState } from './commandService';
import { createEmptyDomainState } from '../../src/domain/stateMachine';
import type { Command, Commitment, DomainState, EscalationState, Priority, Reminder, TimeSpec } from '../../src/domain/stateMachine';

export type LegacyItemInput = Partial<Item>;

function domainPriorityToItem(priority: Priority): ItemPriority {
  if (priority.level === 'high') return 'must';
  if (priority.level === 'low') return 'nice';
  return 'should';
}

function itemPriorityToDomain(priority: ItemPriority | undefined): Priority {
  if (priority === 'must') {
    return { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' };
  }
  if (priority === 'nice') {
    return { level: 'low', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' };
  }
  return { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' };
}

function isoDate(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function isoTime(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(11, 16);
}

function dateTimeFromLegacy(dueDate: string | undefined, reminderTime: string | undefined): string | null {
  if (!dueDate) return null;
  const time = reminderTime || '23:59';
  const parsed = new Date(`${dueDate}T${time}:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function timeSpecFromItem(item: LegacyItemInput): TimeSpec {
  const dueAt = dateTimeFromLegacy(item.dueDate, item.reminderTime);
  const remindAt = item.reminderTime ? dueAt : null;
  return {
    kind: dueAt ? 'due_by' : 'unscheduled',
    dueAt,
    remindAt,
    timezone: 'UTC',
  };
}

function remindersForCommitment(state: DomainState, commitmentId: string): Reminder[] {
  return Object.values(state.reminders).filter((reminder) => reminder.commitmentId === commitmentId);
}

function nextReminder(reminders: Reminder[]): Reminder | null {
  return reminders
    .filter((reminder) => reminder.status === 'scheduled' || reminder.status === 'delivered' || reminder.status === 'snoozed')
    .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor))[0] || null;
}

function itemStateFromCommitment(commitment: Commitment, reminders: Reminder[], escalation: EscalationState | undefined): Item['state'] {
  if (commitment.status === 'completed') return 'completed';
  if (commitment.status === 'dropped' || commitment.status === 'archived') return 'cancelled';
  if (escalation?.status === 'active') return 'escalated';
  if (escalation?.status === 'eligible') return 'escalation_pending';
  if (commitment.status === 'missed') return 'missed';
  if (commitment.currentAckState === 'aware') return 'acknowledged';
  if (reminders.some((reminder) => reminder.status === 'delivered')) return 'reminder_sent';
  if (reminders.some((reminder) => reminder.status === 'scheduled' || reminder.status === 'snoozed')) return 'scheduled';
  if (commitment.status === 'active' || commitment.status === 'deferred') return 'scheduled';
  return 'captured';
}

function commitmentToItem(state: DomainState, commitment: Commitment): Item {
  const reminders = remindersForCommitment(state, commitment.id);
  const reminder = nextReminder(reminders);
  const escalation = state.escalationStates[commitment.id];
  return {
    id: commitment.id,
    userId: SINGLE_USER_ID,
    title: commitment.title,
    description: commitment.description || '',
    priority: domainPriorityToItem(commitment.priority),
    dueDate: isoDate(commitment.timeSpec.dueAt),
    reminderTime: isoTime(reminder?.scheduledFor || commitment.timeSpec.remindAt),
    roughTiming: '',
    state: itemStateFromCommitment(commitment, reminders, escalation),
    acknowledgedAt: commitment.currentAckState === 'aware' ? commitment.updatedAt : null,
    createdAt: commitment.createdAt,
    updatedAt: commitment.updatedAt,
    completedAt: commitment.completedAt,
    escalationLevel: escalation?.level || 0,
    escalatedAt: escalation?.lastEscalatedAt || null,
    source: 'manual',
  };
}

function reminderToAttempt(reminder: Reminder, escalation: EscalationState | undefined): ReminderAttempt | null {
  if (reminder.status !== 'delivered' && reminder.status !== 'ignored') return null;
  const isEscalation = reminder.reminderType === 'escalation';
  return {
    id: `attempt_${reminder.id}`,
    itemId: reminder.commitmentId,
    userId: SINGLE_USER_ID,
    type: isEscalation ? 'escalation' : 'reminder',
    channel: 'in_app',
    status: 'sent',
    idempotencyKey: `${reminder.status}:${reminder.id}:${reminder.updatedAt}`,
    scheduledFor: reminder.scheduledFor,
    sentAt: reminder.deliveredAt || reminder.updatedAt,
    attemptNumber: 1,
    nextRetryAt: null,
    escalationLevel: isEscalation ? escalation?.level || 1 : 0,
    error: null,
  };
}

export async function getUnifiedAppSnapshot(): Promise<AppSnapshot> {
  const legacySnapshot = await getAppSnapshot();
  const state = getCommandServiceState();
  const items = Object.values(state.commitments)
    .map((commitment) => commitmentToItem(state, commitment))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const reminderAttempts = Object.values(state.reminders)
    .map((reminder) => reminderToAttempt(reminder, state.escalationStates[reminder.commitmentId]))
    .filter((attempt): attempt is ReminderAttempt => attempt !== null);

  return {
    user: legacySnapshot.user,
    dailyDigests: legacySnapshot.dailyDigests,
    items,
    reminderAttempts,
  };
}

export function createCommitmentFromItem(raw: LegacyItemInput): void {
  const now = new Date().toISOString();
  const id = typeof raw.id === 'string' && raw.id ? raw.id : randomUUID();
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) throw new Error('Item title is required');
  const timeSpec = timeSpecFromItem(raw);

  const commands: Command[] = [
    {
      type: 'CreateDraft',
      now,
      commitment: {
        id,
        kind: 'task',
        title,
        description: typeof raw.description === 'string' ? raw.description : null,
        priority: itemPriorityToDomain(raw.priority),
        timeSpec,
      },
      draftStatus: 'pending_confirmation',
    },
    {
      type: 'ConfirmCommitment',
      commitmentId: id,
      now,
      reminders: timeSpec.remindAt
        ? [{ id: `rem_${id}_initial`, scheduledFor: timeSpec.remindAt }]
        : [],
    },
  ];

  for (const command of commands) {
    const result = applyCommand(command);
    if (result.result === 'rejected') throw new Error('Could not create commitment');
  }
}

export function updateCommitmentFromItem(itemId: string, updates: LegacyItemInput): void {
  const current = getCommandServiceState().commitments[itemId];
  if (!current) throw new Error('Item not found');

  if (updates.state === 'acknowledged') {
    applyLegacyItemAction(itemId, 'aware');
    return;
  }
  if (updates.state === 'completed') {
    applyLegacyItemAction(itemId, 'complete');
    return;
  }
  if (updates.state === 'cancelled') {
    applyLegacyItemAction(itemId, 'cancel');
    return;
  }

  const now = new Date().toISOString();
  const result = applyCommand({
    type: 'UpdateCommitment',
    commitmentId: itemId,
    now,
    updates: {
      title: typeof updates.title === 'string' ? updates.title : undefined,
      description: typeof updates.description === 'string' ? updates.description : undefined,
      priority: updates.priority ? itemPriorityToDomain(updates.priority) : undefined,
      timeSpec: timeSpecFromItem({
        dueDate: updates.dueDate ?? isoDate(current.timeSpec.dueAt),
        reminderTime: updates.reminderTime ?? isoTime(current.timeSpec.remindAt),
      }),
    },
  });
  if (result.result === 'rejected') throw new Error('Could not update commitment');
}

export function applyLegacyItemAction(itemId: string, action: 'aware' | 'complete' | 'cancel'): void {
  const now = new Date().toISOString();
  const command: Command = action === 'aware'
    ? { type: 'MarkAware', commitmentId: itemId, now }
    : action === 'complete'
      ? { type: 'Complete', commitmentId: itemId, now }
      : { type: 'Drop', commitmentId: itemId, now };
  const result = applyCommand(command);
  if (result.result === 'rejected') throw new Error('Could not update commitment');
}

export function clearCommitments(): void {
  configureCommandService({ initialState: createEmptyDomainState() });
}
