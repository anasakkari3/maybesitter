import { isolate } from './bidi';
import { tFor } from './index';
import { intlLocale, type Locale } from './locale';

/**
 * Every formatter takes an explicit timeZone. Never let `Intl` fall back to the
 * host zone: the app reads the device zone once (timezone.ts), sends it to the
 * backend, and must render every time in that same zone or the day the user
 * sees stops matching the day the server reasoned about.
 */
export type FormatOptions = { locale: Locale; timeZone: string };

export type DateStyle = 'short' | 'weekday' | 'weekdayShort' | 'dayNumber' | 'full';

const DATE_STYLES: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  short: { month: 'short', day: 'numeric' }, // MMM d
  weekday: { weekday: 'long', month: 'short', day: 'numeric' }, // EEEE, MMM d
  weekdayShort: { weekday: 'short' }, // EEE, for the week strip
  dayNumber: { day: 'numeric' }, // d, for the day circle
  full: { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }, // EEEE, MMMM d, yyyy
};

/**
 * A day key as an instant that formats back to that same civil date anywhere.
 *
 * The week strip works in day keys, not instants — it asks "what are the seven
 * days from today", which is calendar arithmetic and has no time in it. To
 * *print* one it needs a Date, and the only safe pairing is a midday-UTC
 * instant formatted in UTC: any real zone would shift it, and past +12 a
 * midday-UTC instant is already the next day.
 */
export function civilDate(key: string): Date {
  return new Date(`${key}T12:00:00.000Z`);
}

/** The formatter options for a `civilDate`: it is a civil date, so print it in UTC. */
export const CIVIL_ZONE = 'UTC';

/** `key` shifted by whole calendar days. Pure day arithmetic, so DST cannot reach it. */
export function shiftDayKey(key: string, days: number): string {
  return new Date(Date.parse(`${key}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// The design shows plain 24-hour times ("18:00") in both languages, and so does
// the rest of the app (`fmt` in state/derive.ts). h23 keeps them identical.
const TIME_STYLE: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };

export function formatDate(date: Date, style: DateStyle, { locale, timeZone }: FormatOptions): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { ...DATE_STYLES[style], timeZone }).format(date);
}

export function formatTime(date: Date, { locale, timeZone }: FormatOptions): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { ...TIME_STYLE, timeZone }).format(date);
}

export function formatTimeRange(start: Date, end: Date, { locale, timeZone }: FormatOptions): string {
  const fmt = new Intl.DateTimeFormat(intlLocale(locale), { ...TIME_STYLE, timeZone });
  // Hermes' Intl is backed by the platform and does not implement formatRange
  // everywhere, so fall back to two isolated times. The isolates stop "18:00"
  // and "19:30" swapping places inside an Arabic line.
  if (typeof fmt.formatRange === 'function') {
    try {
      return fmt.formatRange(start, end);
    } catch {
      // fall through
    }
  }
  return `${isolate(fmt.format(start))}–${isolate(fmt.format(end))}`;
}

export function formatNumber(
  value: number,
  { locale }: { locale: Locale },
  options: Intl.NumberFormatOptions = {},
): string {
  return new Intl.NumberFormat(intlLocale(locale), options).format(value);
}

// "2026-09-10" for the given instant as seen in that timezone. en-CA is the
// shortest way to an ISO-ordered date out of Intl, and it is only ever compared
// with another one produced the same way.
export function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function calendarDayDiff(from: Date, to: Date, timeZone: string): number {
  const a = Date.parse(`${dayKey(from, timeZone)}T00:00:00Z`);
  const b = Date.parse(`${dayKey(to, timeZone)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * "Today" / "Tomorrow" from the copy, falling back to a weekday date. The
 * comparison is by calendar day in `timeZone`, not by elapsed hours, so 23:30
 * and 00:30 are correctly different days.
 */
export function formatRelativeDay(date: Date, options: FormatOptions & { now?: Date }): string {
  const { locale, timeZone } = options;
  const diff = calendarDayDiff(options.now ?? new Date(), date, timeZone);
  const t = tFor(locale);
  if (diff === 0) return t('today');
  if (diff === 1) return t('tomorrow');
  if (diff === -1) return t('yesterday');
  return formatDate(date, 'weekday', { locale, timeZone });
}
