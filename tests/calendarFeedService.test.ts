import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCalendarFeed } from '../lib/services/calendarFeedService.ts';
import type { AppSnapshot } from '../src/server/dataStore.ts';
import type { Item, ItemPriority, ItemState } from '../src/types/index.ts';

function makeItem(
  id: string,
  options: {
    title?: string;
    priority?: ItemPriority;
    dueDate?: string;
    reminderTime?: string;
    state?: ItemState;
  } = {}
): Item {
  return {
    id,
    userId: 'single-user',
    title: options.title || id,
    description: '',
    priority: options.priority || 'should',
    dueDate: options.dueDate || '',
    reminderTime: options.reminderTime || '',
    roughTiming: '',
    state: options.state || 'scheduled',
    acknowledgedAt: null,
    createdAt: '2026-04-08T08:00:00.000Z',
    updatedAt: '2026-04-08T08:00:00.000Z',
    completedAt: null,
    escalationLevel: 0,
    escalatedAt: null,
    source: 'text',
  };
}

function makeSnapshot(items: Item[]): AppSnapshot {
  return {
    user: {
      id: 'single-user',
      email: 'single-user@maybesitter.local',
      name: 'Maybesitter User',
      createdAt: '2026-04-08T08:00:00.000Z',
      preferences: {
        reminderTime: '08:00',
        timezone: 'UTC',
        notificationsEnabled: true,
        dailyDigestEnabled: true,
        theme: 'light',
      },
    },
    items,
    dailyDigests: [],
    reminderAttempts: [],
  };
}

test('calendarFeedService: exports active timed and all-day items as iCalendar events', () => {
  const feed = buildCalendarFeed(
    makeSnapshot([
      makeItem('timed', { title: 'Go to work', priority: 'must', dueDate: '2026-04-08', reminderTime: '17:00' }),
      makeItem('dated', { title: 'Pay bill', priority: 'should', dueDate: '2026-04-09' }),
      makeItem('unscheduled', { title: 'Read chapter', priority: 'nice' }),
      makeItem('done', { title: 'Already done', state: 'completed', dueDate: '2026-04-08', reminderTime: '09:00' }),
    ]),
    new Date('2026-04-08T08:00:00.000Z')
  );
  const unfoldedFeed = feed.replace(/\r\n /g, '');

  assert.match(unfoldedFeed, /BEGIN:VCALENDAR/);
  assert.match(unfoldedFeed, /SUMMARY:\[Must\] Go to work/);
  assert.match(unfoldedFeed, /DTSTART:20260408T170000Z/);
  assert.match(unfoldedFeed, /DTEND:20260408T173000Z/);
  assert.match(unfoldedFeed, /SUMMARY:\[Should\] Pay bill/);
  assert.match(unfoldedFeed, /DTSTART;VALUE=DATE:20260409/);
  assert.match(unfoldedFeed, /SUMMARY:\[Nice\] Read chapter/);
  assert.match(unfoldedFeed, /No date was set in Maybesitter/);
  assert.doesNotMatch(unfoldedFeed, /Already done/);
});
