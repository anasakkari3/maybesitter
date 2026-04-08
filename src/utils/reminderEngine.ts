import { Item, ItemPriority, ReminderAttempt, ReminderAttemptType } from '@/types';

export const REMINDER_ENGINE_INTERVAL_MS = 30_000;
export const REMINDER_LOOKAHEAD_MS = 60_000;
export const MAX_DELIVERY_ATTEMPTS = 4;
export const REMINDER_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];

export interface EscalationPolicy {
  acknowledgementWindowMs: number;
  escalationDelayMs: number | null;
  maxEscalationLevel: number;
}

export const ESCALATION_POLICIES: Record<ItemPriority, EscalationPolicy> = {
  must: {
    acknowledgementWindowMs: 5 * 60_000,
    escalationDelayMs: 2 * 60_000,
    maxEscalationLevel: 1,
  },
  should: {
    acknowledgementWindowMs: 15 * 60_000,
    escalationDelayMs: 10 * 60_000,
    maxEscalationLevel: 1,
  },
  nice: {
    acknowledgementWindowMs: 30 * 60_000,
    escalationDelayMs: null,
    maxEscalationLevel: 0,
  },
};

export type ReminderEngineOperation =
  | {
      type: 'mark_reminder_pending';
      itemId: string;
    }
  | {
      type: 'send_reminder';
      itemId: string;
      scheduledFor: string;
      idempotencyKey: string;
      attemptNumber: number;
      title: string;
      body: string;
    }
  | {
      type: 'mark_missed';
      itemId: string;
    }
  | {
      type: 'mark_escalation_pending';
      itemId: string;
    }
  | {
      type: 'send_escalation';
      itemId: string;
      scheduledFor: string;
      idempotencyKey: string;
      attemptNumber: number;
      escalationLevel: number;
      title: string;
      body: string;
    };

function parseReminderTime(reminderTime: string): { hour: number; minute: number } | null {
  const [hourText, minuteText] = reminderTime.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function getReminderDate(item: Item): Date | null {
  if (!item.reminderTime) return null;

  if (item.dueDate) {
    const date = new Date(`${item.dueDate}T${item.reminderTime}:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsed = parseReminderTime(item.reminderTime);
  if (!parsed) return null;

  const base = new Date(item.updatedAt || item.createdAt);
  if (Number.isNaN(base.getTime())) return null;

  const date = new Date(base);
  date.setHours(parsed.hour, parsed.minute, 0, 0);
  if (date.getTime() < base.getTime()) {
    date.setDate(date.getDate() + 1);
  }
  return Number.isNaN(date.getTime()) ? null : date;
}

export function getReminderIdempotencyKey(item: Item, scheduledFor: string): string {
  return `reminder:${item.id}:${scheduledFor}`;
}

export function getEscalationIdempotencyKey(item: Item, escalationLevel: number): string {
  return `escalation:${item.id}:${escalationLevel}`;
}

export function getRetryDelayMs(attemptNumber: number): number {
  const index = Math.max(0, Math.min(attemptNumber - 1, REMINDER_RETRY_DELAYS_MS.length - 1));
  return REMINDER_RETRY_DELAYS_MS[index];
}

export function getNextRetryAt(attemptNumber: number, at: Date = new Date()): string {
  return new Date(at.getTime() + getRetryDelayMs(attemptNumber)).toISOString();
}

function getSendPlan(
  attempts: ReminderAttempt[],
  idempotencyKey: string,
  nowMs: number
): { shouldSend: boolean; attemptNumber: number } {
  const matching = attempts
    .filter((attempt) => attempt.idempotencyKey === idempotencyKey)
    .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());

  if (matching.some((attempt) => attempt.status === 'sent')) {
    return { shouldSend: false, attemptNumber: matching.length + 1 };
  }

  const failures = matching.filter((attempt) => attempt.status === 'failed');
  if (failures.length >= MAX_DELIVERY_ATTEMPTS) {
    return { shouldSend: false, attemptNumber: failures.length + 1 };
  }

  const latestFailure = failures[0];
  if (!latestFailure) {
    return { shouldSend: true, attemptNumber: 1 };
  }

  const retryAtMs = latestFailure.nextRetryAt
    ? new Date(latestFailure.nextRetryAt).getTime()
    : new Date(latestFailure.sentAt).getTime() + getRetryDelayMs(latestFailure.attemptNumber || failures.length);

  return {
    shouldSend: Number.isNaN(retryAtMs) || retryAtMs <= nowMs,
    attemptNumber: failures.length + 1,
  };
}

function latestAttemptFor(item: Item, attempts: ReminderAttempt[], type: ReminderAttemptType): ReminderAttempt | null {
  const matching = attempts
    .filter((attempt) => attempt.itemId === item.id && attempt.type === type && attempt.status === 'sent')
    .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());
  return matching[0] || null;
}

function isResponseComplete(item: Item): boolean {
  return Boolean(item.acknowledgedAt || item.completedAt || item.state === 'cancelled');
}

function canSendReminder(item: Item): boolean {
  return item.state === 'scheduled' || item.state === 'reminder_pending';
}

export function getReminderEngineOperations(
  items: Item[],
  attempts: ReminderAttempt[],
  now: Date = new Date()
): ReminderEngineOperation[] {
  const operations: ReminderEngineOperation[] = [];
  const nowMs = now.getTime();

  for (const item of items) {
    if (isResponseComplete(item)) continue;

    const reminderDate = getReminderDate(item);
    const reminderMs = reminderDate?.getTime();

    if (
      item.state === 'scheduled' &&
      reminderDate &&
      reminderMs! > nowMs &&
      reminderMs! <= nowMs + REMINDER_LOOKAHEAD_MS
    ) {
      operations.push({ type: 'mark_reminder_pending', itemId: item.id });
      continue;
    }

    if (canSendReminder(item) && reminderDate && reminderMs! <= nowMs) {
      const scheduledFor = reminderDate.toISOString();
      const idempotencyKey = getReminderIdempotencyKey(item, scheduledFor);
      const plan = getSendPlan(attempts, idempotencyKey, nowMs);
      if (plan.shouldSend) {
        operations.push({
          type: 'send_reminder',
          itemId: item.id,
          scheduledFor,
          idempotencyKey,
          attemptNumber: plan.attemptNumber,
          title: `Maybesitter reminder: ${item.title}`,
          body: 'Please confirm you are aware of this. Completion can happen later.',
        });
      }
      continue;
    }

    if (item.state === 'reminder_sent') {
      const policy = ESCALATION_POLICIES[item.priority];
      const reminderAttempt = latestAttemptFor(item, attempts, 'reminder');
      if (reminderAttempt && new Date(reminderAttempt.sentAt).getTime() + policy.acknowledgementWindowMs <= nowMs) {
        operations.push({ type: 'mark_missed', itemId: item.id });
      }
      continue;
    }

    if (item.state === 'missed') {
      const policy = ESCALATION_POLICIES[item.priority];
      if (policy.escalationDelayMs === null || policy.maxEscalationLevel <= item.escalationLevel) continue;
      const missedAt = new Date(item.updatedAt).getTime();
      if (missedAt + policy.escalationDelayMs <= nowMs) {
        operations.push({ type: 'mark_escalation_pending', itemId: item.id });
      }
      continue;
    }

    if (item.state === 'escalation_pending') {
      const policy = ESCALATION_POLICIES[item.priority];
      const nextLevel = item.escalationLevel + 1;
      if (nextLevel > policy.maxEscalationLevel) continue;

      const scheduledFor = now.toISOString();
      const idempotencyKey = getEscalationIdempotencyKey(item, nextLevel);
      const plan = getSendPlan(attempts, idempotencyKey, nowMs);
      if (plan.shouldSend) {
        operations.push({
          type: 'send_escalation',
          itemId: item.id,
          scheduledFor,
          idempotencyKey,
          attemptNumber: plan.attemptNumber,
          escalationLevel: nextLevel,
          title: `Maybesitter escalation: ${item.title}`,
          body: 'No acknowledgement came in. Please confirm awareness now.',
        });
      }
    }
  }

  return operations;
}
