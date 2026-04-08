export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  preferences: {
    reminderTime: string;
    timezone: string;
    notificationsEnabled: boolean;
    dailyDigestEnabled: boolean;
    theme: 'light' | 'dark';
  };
}

export type ItemPriority = 'must' | 'should' | 'nice';
export type CaptureSource = 'voice' | 'text' | 'manual';
export type ReminderAttemptType = 'reminder' | 'escalation';
export type ReminderChannel = 'browser' | 'in_app';
export type ReminderAttemptStatus = 'sent' | 'failed' | 'skipped';

export type ItemState =
  | 'captured'
  | 'scheduled'
  | 'reminder_pending'
  | 'reminder_sent'
  | 'acknowledged'
  | 'missed'
  | 'escalation_pending'
  | 'escalated'
  | 'completed'
  | 'cancelled';

export interface Item {
  id: string;
  userId: string;
  title: string;
  description: string;
  priority: ItemPriority;
  dueDate: string;
  reminderTime: string;
  roughTiming: string;
  state: ItemState;
  acknowledgedAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  escalationLevel: number;
  escalatedAt: string | null;
  source: CaptureSource;
}

export type Task = Item;
export type TaskCategory = ItemPriority;
export type TaskStatus = ItemState;

export interface DailyDigest {
  id: string;
  userId: string;
  date: string;
  confirmed: boolean;
  confirmedAt: string | null;
}

export interface ReminderAttempt {
  id: string;
  itemId: string;
  userId: string;
  type: ReminderAttemptType;
  channel: ReminderChannel;
  status: ReminderAttemptStatus;
  idempotencyKey: string;
  scheduledFor: string;
  sentAt: string;
  attemptNumber: number;
  nextRetryAt: string | null;
  escalationLevel: number;
  error: string | null;
}
