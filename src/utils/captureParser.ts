import { CaptureSource, Item, ItemPriority } from '@/types';
import { getLocalIsoDate } from '@/utils/agenda';

export interface CaptureParseOptions {
  now?: Date;
  defaultReminderTime?: string;
  source?: CaptureSource;
}

export interface ParsedCapture {
  title: string;
  dueDate: string;
  reminderTime: string;
  roughTiming: string;
  priority: ItemPriority | null;
  source: CaptureSource;
  notes: string[];
  needsClarification: boolean;
}

const DEFAULT_LATER_TIME = '18:00';
const BUSINESS_WEEKDAY_FRIDAY = 5;

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(date.getDate() + days);
  return next;
}

function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function nextWeekday(from: Date, weekday: number, includeToday = true): Date {
  const day = from.getDay();
  let delta = (weekday - day + 7) % 7;
  if (delta === 0 && !includeToday) delta = 7;
  return addDays(from, delta);
}

function endOfThisWeek(from: Date): Date {
  const day = from.getDay();
  const delta = day <= BUSINESS_WEEKDAY_FRIDAY ? BUSINESS_WEEKDAY_FRIDAY - day : 7 - day + BUSINESS_WEEKDAY_FRIDAY;
  return addDays(from, delta);
}

function endOfNextWeek(from: Date): Date {
  return addDays(endOfThisWeek(from), 7);
}

function roundToNextHalfHour(date: Date): string {
  const next = new Date(date);
  next.setMinutes(next.getMinutes() <= 30 ? 30 : 60, 0, 0);
  const hour = String(next.getHours()).padStart(2, '0');
  const minute = String(next.getMinutes()).padStart(2, '0');
  return `${hour}:${minute}`;
}

function laterTodayTime(now: Date): string {
  const suggested = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  if (suggested.getDate() !== now.getDate() || suggested.getHours() >= 22) return DEFAULT_LATER_TIME;
  return roundToNextHalfHour(suggested);
}

function parseClockTime(input: string): { time: string; matched: boolean } {
  const lower = input.toLowerCase();

  if (/\bnoon\b/.test(lower)) return { time: '12:00', matched: true };
  if (/\bmidnight\b/.test(lower)) return { time: '00:00', matched: true };

  const match = lower.match(/\b(?:at\s+|around\s+|by\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (!match) return { time: '', matched: false };

  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const period = match[3];

  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return { time: '', matched: false };
  if (period === 'pm' && hour !== 12) hour += 12;
  if (period === 'am' && hour === 12) hour = 0;

  return {
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    matched: true,
  };
}

function inferPriority(lower: string): ItemPriority | null {
  if (/\b(urgent|asap|must|critical|important)\b/.test(lower)) return 'must';
  if (/\b(maybe|someday|optional|nice to)\b/.test(lower)) return 'nice';
  return null;
}

function cleanTitle(input: string): string {
  let title = input;
  const removalPatterns = [
    /\b(later today|later|tonight|today|tomorrow morning|tomorrow afternoon|tomorrow evening|tomorrow night|tomorrow|this week|next week|this morning|this afternoon|this evening)\b/gi,
    /\b(on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
    /\b(?:at\s+|around\s+|by\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi,
    /\b(noon|midnight|morning|afternoon|evening|night)\b/gi,
  ];

  for (const pattern of removalPatterns) {
    title = title.replace(pattern, ' ');
  }

  return title
    .replace(/\b(remind me to|remind me|remember to|please)\b/gi, ' ')
    .replace(/\s+\b(on|at|by|around|this|next)\b\s*$/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseNaturalLanguageCapture(
  input: string,
  options: CaptureParseOptions = {}
): ParsedCapture {
  const now = options.now || new Date();
  const source = options.source || 'text';
  const raw = input.trim();
  const lower = raw.toLowerCase();
  const notes: string[] = [];

  let dueDate = '';
  let reminderTime = '';
  let roughTiming = '';
  let needsClarification = false;

  const clock = parseClockTime(raw);
  if (clock.matched) reminderTime = clock.time;

  if (/\blater today\b/.test(lower) || /\blater\b/.test(lower)) {
    dueDate = getLocalIsoDate(now);
    reminderTime = reminderTime || laterTodayTime(now);
    roughTiming = 'later today';
  } else if (/\btonight\b/.test(lower)) {
    dueDate = getLocalIsoDate(now);
    reminderTime = reminderTime || '20:00';
    roughTiming = 'tonight';
  } else if (/\btoday\b/.test(lower)) {
    dueDate = getLocalIsoDate(now);
    roughTiming = 'today';
  }

  if (/\btomorrow\b/.test(lower)) {
    const tomorrow = addDays(now, 1);
    dueDate = getLocalIsoDate(tomorrow);
    roughTiming = 'tomorrow';
  }

  if (/\b(this week)\b/.test(lower)) {
    dueDate = getLocalIsoDate(endOfThisWeek(now));
    roughTiming = 'this week';
    needsClarification = true;
    notes.push('No exact day was given, so this is placed at the end of this week without a reminder time.');
  }

  if (/\b(next week)\b/.test(lower)) {
    dueDate = getLocalIsoDate(endOfNextWeek(now));
    roughTiming = 'next week';
    needsClarification = true;
    notes.push('No exact day was given, so this is placed at the end of next week without a reminder time.');
  }

  const weekdayMatch = lower.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (weekdayMatch) {
    const weekdayMap: Record<string, number> = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
    };
    dueDate = getLocalIsoDate(nextWeekday(startOfDay(now), weekdayMap[weekdayMatch[1]], true));
    roughTiming = weekdayMatch[1];
  }

  if (/\bmorning\b/.test(lower)) {
    reminderTime = reminderTime || '09:00';
    roughTiming = roughTiming ? `${roughTiming} morning` : 'morning';
  } else if (/\bafternoon\b/.test(lower)) {
    reminderTime = reminderTime || '14:00';
    roughTiming = roughTiming ? `${roughTiming} afternoon` : 'afternoon';
  } else if (/\bevening\b/.test(lower)) {
    reminderTime = reminderTime || '18:00';
    roughTiming = roughTiming ? `${roughTiming} evening` : 'evening';
  } else if (/\bnight\b/.test(lower) && !/\btonight\b/.test(lower)) {
    reminderTime = reminderTime || '20:00';
    roughTiming = roughTiming ? `${roughTiming} night` : 'night';
  }

  if (!dueDate && reminderTime) {
    dueDate = getLocalIsoDate(now);
    roughTiming = roughTiming || 'today';
  }

  if (/\b(remind me|reminder|remember)\b/.test(lower) && dueDate && !reminderTime) {
    reminderTime = options.defaultReminderTime || DEFAULT_LATER_TIME;
    notes.push(`No reminder time was given, so ${reminderTime} was used.`);
  }

  if (dueDate && !reminderTime && roughTiming) {
    notes.push('No exact reminder time was found. This will still appear in the daily agenda for that date.');
  }

  const cleanedTitle = cleanTitle(raw) || raw;

  return {
    title: cleanedTitle,
    dueDate,
    reminderTime,
    roughTiming,
    priority: inferPriority(lower),
    source,
    notes,
    needsClarification,
  };
}

function normalizeTitle(title: string): string[] {
  const stopwords = new Set(['the', 'a', 'an', 'to', 'for', 'with', 'and', 'or', 'my', 'me', 'this']);
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token && !stopwords.has(token));
}

function titleSimilarity(a: string, b: string): number {
  const aTokens = normalizeTitle(a);
  const bTokens = normalizeTitle(b);
  if (aTokens.length === 0 || bTokens.length === 0) return 0;

  const aKey = aTokens.join(' ');
  const bKey = bTokens.join(' ');
  if (aKey === bKey) return 1;
  if (aKey.includes(bKey) || bKey.includes(aKey)) return 0.86;

  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  let intersection = 0;
  aSet.forEach((token) => {
    if (bSet.has(token)) intersection += 1;
  });
  const union = new Set(aTokens.concat(bTokens)).size;
  return union === 0 ? 0 : intersection / union;
}

export interface DuplicateMatch {
  item: Item;
  score: number;
  reason: string;
}

export function findDuplicateItems(
  candidate: Pick<Item, 'title' | 'dueDate'>,
  existingItems: Item[],
  threshold = 0.72
): DuplicateMatch[] {
  return existingItems
    .filter((item) => item.state !== 'completed' && item.state !== 'cancelled')
    .map((item) => {
      let score = titleSimilarity(candidate.title, item.title);
      if (candidate.dueDate && item.dueDate && candidate.dueDate === item.dueDate) score += 0.1;
      if (candidate.dueDate && item.dueDate && candidate.dueDate !== item.dueDate) score -= 0.12;
      score = Math.max(0, Math.min(1, score));
      return {
        item,
        score,
        reason: candidate.dueDate && item.dueDate === candidate.dueDate
          ? 'Similar title and same date'
          : 'Similar title',
      };
    })
    .filter((match) => match.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}
