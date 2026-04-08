import type { Item, ItemPriority } from '@/types';
import { isActiveState } from '@/utils/itemState';

export type AgendaReason = 'overdue' | 'due_today' | 'reminder_today';
export type CalendarSortGroup = 'timed' | 'untimed';
export type AgendaVisualStatus =
  | 'pending'
  | 'acknowledged'
  | 'overdue'
  | 'escalation_pending'
  | 'escalated'
  | 'completed'
  | 'cancelled';

const PRIORITY_RANK: Record<ItemPriority, number> = {
  must: 0,
  should: 1,
  nice: 2,
};

const END_OF_DAY_MINUTES = 24 * 60;

export function getLocalIsoDate(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseTimeMinutes(time: string): number | null {
  if (!time) return null;
  const [hourText, minuteText] = time.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function priorityRank(priority: ItemPriority): number {
  return PRIORITY_RANK[priority];
}

export function isOverdueAgendaItem(item: Item, todayIsoDate: string): boolean {
  return isActiveState(item.state) && Boolean(item.dueDate) && item.dueDate < todayIsoDate;
}

export function isDueTodayAgendaItem(item: Item, todayIsoDate: string): boolean {
  return isActiveState(item.state) && item.dueDate === todayIsoDate;
}

export function hasReminderToday(item: Item, todayIsoDate: string): boolean {
  return isActiveState(item.state) && Boolean(item.reminderTime) && item.dueDate === todayIsoDate;
}

export function isDailyAgendaItem(item: Item, todayIsoDate: string): boolean {
  return (
    isOverdueAgendaItem(item, todayIsoDate) ||
    isDueTodayAgendaItem(item, todayIsoDate) ||
    hasReminderToday(item, todayIsoDate)
  );
}

export function getAgendaReason(item: Item, todayIsoDate: string): AgendaReason {
  if (isOverdueAgendaItem(item, todayIsoDate)) return 'overdue';
  if (hasReminderToday(item, todayIsoDate)) return 'reminder_today';
  return 'due_today';
}

function getAgendaSortMinutes(item: Item, todayIsoDate: string): number {
  const reminderMinutes = parseTimeMinutes(item.reminderTime);
  if (reminderMinutes !== null) return reminderMinutes;
  if (isOverdueAgendaItem(item, todayIsoDate)) return 0;
  return END_OF_DAY_MINUTES;
}

export function compareAgendaItems(todayIsoDate: string) {
  return (a: Item, b: Item): number => {
    const priorityDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (priorityDiff !== 0) return priorityDiff;

    const timeDiff = getAgendaSortMinutes(a, todayIsoDate) - getAgendaSortMinutes(b, todayIsoDate);
    if (timeDiff !== 0) return timeDiff;

    if (a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    return a.title.localeCompare(b.title);
  };
}

export function isDailyCalendarItem(item: Item, todayIsoDate: string = getLocalIsoDate()): boolean {
  if (!isActiveState(item.state)) return false;
  if (!item.dueDate) return true;
  return item.dueDate <= todayIsoDate;
}

export function getCalendarSortGroup(item: Item): CalendarSortGroup {
  return parseTimeMinutes(item.reminderTime) === null ? 'untimed' : 'timed';
}

function calendarDueRank(item: Item, todayIsoDate: string): number {
  if (item.dueDate && item.dueDate < todayIsoDate) return 0;
  if (item.dueDate === todayIsoDate) return 1;
  if (!item.dueDate) return 2;
  return 3;
}

export function compareDailyCalendarItems(todayIsoDate: string) {
  return (a: Item, b: Item): number => {
    const aTime = parseTimeMinutes(a.reminderTime);
    const bTime = parseTimeMinutes(b.reminderTime);
    const aTimed = aTime !== null;
    const bTimed = bTime !== null;

    if (aTimed && bTimed && aTime !== bTime) return aTime - bTime;
    if (aTimed !== bTimed) return aTimed ? -1 : 1;

    const priorityDiff = priorityRank(a.priority) - priorityRank(b.priority);
    if (priorityDiff !== 0) return priorityDiff;

    const dueDiff = calendarDueRank(a, todayIsoDate) - calendarDueRank(b, todayIsoDate);
    if (dueDiff !== 0) return dueDiff;

    if (a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    return a.title.localeCompare(b.title);
  };
}

export function getDailyCalendarItems(items: Item[], todayIsoDate: string = getLocalIsoDate()): Item[] {
  return items
    .filter((item) => isDailyCalendarItem(item, todayIsoDate))
    .sort(compareDailyCalendarItems(todayIsoDate));
}

export function getDailyAgendaItems(items: Item[], todayIsoDate: string = getLocalIsoDate()): Item[] {
  return items
    .filter((item) => isDailyAgendaItem(item, todayIsoDate))
    .sort(compareAgendaItems(todayIsoDate));
}

export function getNextExpectedAction(item: Item, todayIsoDate: string = getLocalIsoDate()): string {
  if (item.state === 'completed') return 'No action needed';
  if (item.state === 'cancelled') return 'No action needed';
  if (!item.dueDate && !item.reminderTime) return 'Schedule this item';
  if (item.state === 'escalated') return 'Confirm awareness now';
  if (item.state === 'missed' || item.state === 'escalation_pending') return 'Confirm awareness now';
  if (!item.acknowledgedAt) return isOverdueAgendaItem(item, todayIsoDate) ? 'Confirm awareness now' : 'Confirm awareness';
  return 'Mark as completed';
}

export function getAgendaVisualStatus(item: Item, todayIsoDate: string = getLocalIsoDate()): AgendaVisualStatus {
  if (item.state === 'completed') return 'completed';
  if (item.state === 'cancelled') return 'cancelled';
  if (item.state === 'escalated' || item.escalationLevel > 0) return 'escalated';
  if (item.state === 'missed' || item.state === 'escalation_pending') return 'escalation_pending';
  if (isOverdueAgendaItem(item, todayIsoDate)) return 'overdue';
  if (item.acknowledgedAt) return 'acknowledged';
  return 'pending';
}

export function isEscalationPendingForUser(item: Item): boolean {
  return item.state === 'missed' || item.state === 'escalation_pending';
}
