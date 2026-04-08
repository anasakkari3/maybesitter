import type { AppSnapshot } from '../../src/server/dataStore';
import type { Item, ItemPriority } from '../../src/types/index';
import { isActiveState } from '../../src/utils/itemState';

const CALENDAR_NAME = 'Maybesitter';
const DEFAULT_EVENT_MINUTES = 30;

const PRIORITY_LABELS: Record<ItemPriority, string> = {
  must: 'Must',
  should: 'Should',
  nice: 'Nice',
};

const ICS_PRIORITIES: Record<ItemPriority, number> = {
  must: 1,
  should: 5,
  nice: 9,
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatIcsDate(date: Date): string {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}

function formatIcsDateTime(date: Date): string {
  return `${formatIcsDate(date)}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function foldIcsLine(line: string): string[] {
  const chunks: string[] = [];
  let current = line;
  while (current.length > 74) {
    chunks.push(current.slice(0, 74));
    current = ` ${current.slice(74)}`;
  }
  chunks.push(current);
  return chunks;
}

function toIcs(lines: string[]): string {
  return `${lines.flatMap(foldIcsLine).join('\r\n')}\r\n`;
}

function validTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function eventStart(item: Item, todayIsoDate: string): { kind: 'timed' | 'all-day'; start: Date | string; end: Date | string } {
  const date = item.dueDate || todayIsoDate;
  if (item.reminderTime && validTime(item.reminderTime)) {
    const start = new Date(`${date}T${item.reminderTime}:00.000Z`);
    return {
      kind: 'timed',
      start,
      end: addMinutes(start, DEFAULT_EVENT_MINUTES),
    };
  }

  return {
    kind: 'all-day',
    start: date,
    end: addDays(date, 1),
  };
}

function buildDescription(item: Item): string {
  const parts = [
    item.description,
    `Priority: ${PRIORITY_LABELS[item.priority]}`,
    `State: ${item.state}`,
  ].filter(Boolean);

  if (!item.dueDate) {
    parts.push('No date was set in Maybesitter, so this appears on today in the calendar feed.');
  } else if (!item.reminderTime) {
    parts.push('No time was set in Maybesitter, so this appears as an all-day item.');
  }

  return parts.join('\n');
}

function itemToEventLines(item: Item, now: Date, todayIsoDate: string): string[] {
  const { kind, start, end } = eventStart(item, todayIsoDate);
  const priorityLabel = PRIORITY_LABELS[item.priority];
  const lines = [
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(`maybesitter-${item.id}@maybesitter.local`)}`,
    `DTSTAMP:${formatIcsDateTime(now)}`,
    `LAST-MODIFIED:${formatIcsDateTime(new Date(item.updatedAt || item.createdAt || now.toISOString()))}`,
    `SUMMARY:${escapeIcsText(`[${priorityLabel}] ${item.title}`)}`,
    `DESCRIPTION:${escapeIcsText(buildDescription(item))}`,
    `CATEGORIES:${escapeIcsText(`MAYBESITTER,${priorityLabel.toUpperCase()}`)}`,
    `PRIORITY:${ICS_PRIORITIES[item.priority]}`,
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
  ];

  if (kind === 'timed') {
    lines.push(`DTSTART:${formatIcsDateTime(start as Date)}`);
    lines.push(`DTEND:${formatIcsDateTime(end as Date)}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${String(start).replace(/-/g, '')}`);
    lines.push(`DTEND;VALUE=DATE:${String(end).replace(/-/g, '')}`);
  }

  lines.push('END:VEVENT');
  return lines;
}

export function buildCalendarFeed(snapshot: AppSnapshot, now: Date = new Date()): string {
  const todayIsoDate = now.toISOString().slice(0, 10);
  const activeItems = snapshot.items
    .filter((item) => isActiveState(item.state))
    .sort((a, b) => {
      const aDate = a.dueDate || todayIsoDate;
      const bDate = b.dueDate || todayIsoDate;
      if (aDate !== bDate) return aDate.localeCompare(bDate);
      if (a.reminderTime !== b.reminderTime) return a.reminderTime.localeCompare(b.reminderTime);
      return a.title.localeCompare(b.title);
    });

  return toIcs([
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Maybesitter//Calendar Feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${CALENDAR_NAME}`,
    'X-WR-TIMEZONE:UTC',
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
    'X-PUBLISHED-TTL:PT15M',
    ...activeItems.flatMap((item) => itemToEventLines(item, now, todayIsoDate)),
    'END:VCALENDAR',
  ]);
}
