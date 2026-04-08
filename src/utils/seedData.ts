import { Item, ItemPriority, ItemState } from '@/types';
import { deriveScheduledState } from '@/utils/itemState';

function generateSeedId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

function formatIsoDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(date.getDate() + days);
  return next;
}

export function createDemoItems(userId: string, now: Date = new Date()): Item[] {
  const tomorrow = addDays(now, 1);
  const yesterday = addDays(now, -1);
  const nextWeek = addDays(now, 7);

  const makeItem = (
    title: string,
    description: string,
    priority: ItemPriority,
    dueDate: string,
    reminderTime: string,
    state: ItemState = deriveScheduledState(dueDate, reminderTime),
    completedAt: string | null = null
  ): Item => {
    const timestamp = now.toISOString();
    return {
      id: generateSeedId(),
      userId,
      title,
      description,
      priority,
      dueDate,
      reminderTime,
      roughTiming: '',
      state,
      acknowledgedAt: null,
      createdAt: timestamp,
      updatedAt: completedAt || timestamp,
      completedAt,
      escalationLevel: 0,
      escalatedAt: null,
      source: 'manual',
    };
  };

  return [
    makeItem('Pay electricity bill', 'Due by end of month or service gets cut', 'must', formatIsoDate(now), '09:00'),
    makeItem('Call doctor for prescription refill', 'Running low on medication', 'must', formatIsoDate(now), '10:00'),
    makeItem('Submit work report', 'Monthly performance report for manager', 'must', formatIsoDate(tomorrow), '08:00'),
    makeItem('Pick up kids from school', '3:30pm sharp', 'must', formatIsoDate(now), '15:00', 'completed', now.toISOString()),
    makeItem('Renew car registration', 'Expires this month', 'must', formatIsoDate(nextWeek), '09:00'),
    makeItem('Reply to email from landlord', 'About lease renewal questions', 'should', formatIsoDate(now), '11:00'),
    makeItem('Grocery shopping', 'Milk, eggs, vegetables, bread', 'should', formatIsoDate(tomorrow), '17:00'),
    makeItem('Exercise for 30 minutes', 'Even a walk counts', 'should', formatIsoDate(now), '18:00', 'completed', yesterday.toISOString()),
    makeItem('Review monthly budget', 'Check spending vs. planned budget', 'should', formatIsoDate(nextWeek), '19:00'),
    makeItem('Read that book chapter', 'Working through "Atomic Habits"', 'nice', formatIsoDate(tomorrow), '21:00'),
    makeItem('Reorganize home office desk', "It's getting messy again", 'nice', formatIsoDate(nextWeek), '14:00'),
    makeItem('Watch that documentary', 'Nature documentary saved in watchlist', 'nice', formatIsoDate(nextWeek), '20:00'),
    makeItem('Plan weekend trip', 'Look into nearby hiking trails', 'nice', formatIsoDate(nextWeek), '10:00', 'completed', yesterday.toISOString()),
    makeItem('Try new recipe', 'That pasta dish I bookmarked', 'nice', formatIsoDate(nextWeek), '18:00'),
    makeItem("Call a friend you've been meaning to catch up with", "It's been too long", 'nice', formatIsoDate(nextWeek), '19:00'),
  ];
}
