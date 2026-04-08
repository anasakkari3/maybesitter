import { Item } from '@/types';
import { getLocalIsoDate } from '@/utils/agenda';

export interface RescheduleSuggestion {
  dueDate: string;
  reminderTime: string;
  roughTiming: string;
  label: string;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(date.getDate() + days);
  return next;
}

function roundToNextHour(date: Date): string {
  const next = new Date(date);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return `${String(next.getHours()).padStart(2, '0')}:00`;
}

export function getMissedRescheduleSuggestion(
  item: Item,
  defaultReminderTime = '09:00',
  now: Date = new Date()
): RescheduleSuggestion {
  const canStillUseToday = now.getHours() < 18;

  if (canStillUseToday) {
    const reminderTime = roundToNextHour(new Date(now.getTime() + 60 * 60 * 1000));
    return {
      dueDate: getLocalIsoDate(now),
      reminderTime,
      roughTiming: 'later today',
      label: `Reschedule to today at ${reminderTime}`,
    };
  }

  const tomorrow = addDays(now, 1);
  const reminderTime = item.reminderTime || defaultReminderTime;
  return {
    dueDate: getLocalIsoDate(tomorrow),
    reminderTime,
    roughTiming: 'tomorrow',
    label: `Reschedule to tomorrow at ${reminderTime}`,
  };
}
