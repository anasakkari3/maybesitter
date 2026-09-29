/**
 * How a weekly fixed block («ثابت أسبوعي») is said: «تدريب · كل سبت · 10:00–16:00».
 *
 * Pure: a block's days and hours and a language in, words out. The day names
 * are the app's own — `days` (with the article: «الأحد») and `wbDays` (the
 * bare noun that follows «كل»: «سبت») in the locale files — never `Intl`'s,
 * whose Arabic «السبت» cannot follow «كل».
 *
 * ── Three shapes ──────────────────────────────────────────────────
 *
 *   all seven            «كل يوم»
 *   three+ in a row      «من الأحد للخميس» — a working week read out as five
 *                        names is a sentence nobody says
 *   anything else        «كل سبت», «كل أحد وسبت», «كل أحد، ثلاثاء وخميس»
 *
 * "In a row" is Sunday-first and does not wrap round Saturday: 0 = Sunday …
 * 6 = Saturday, as the server stores them. A Friday–Saturday–Sunday block is
 * said as a list, which is longer and still true.
 *
 * ── Hours ─────────────────────────────────────────────────────────
 *
 * On screen the hours are one left-to-right unit (`formatClockRange`), so an
 * Arabic line cannot show «16:00–10:00». Read aloud they are «من 10:00 لـ
 * 16:00» (`wbA11yTime`): a screen reader pronounces a dash between two times
 * as a minus, or not at all.
 */
import { formatClockRange } from '../../i18n/format';
import { isolateAuto } from '../../i18n/bidi';
import { fill, strings, type Lang } from '../../i18n/strings';

export interface WeeklyShape {
  title: string;
  weekdays: readonly number[];
  /** `HH:MM` on the block's own clock. */
  start: string;
  end: string;
}

/** The distinct valid weekdays, Sunday first. */
function normalized(weekdays: readonly number[]): number[] {
  return [...new Set(weekdays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b);
}

function isRun(days: readonly number[]): boolean {
  return days.every((day, index) => index === 0 || day === days[index - 1]! + 1);
}

/** «كل سبت» / «من الأحد للخميس» / «كل يوم». Empty for no valid day. */
export function weekdaysPhrase(weekdays: readonly number[], lang: Lang): string {
  const t = strings[lang];
  const days = normalized(weekdays);
  if (days.length === 0) return '';
  if (days.length === 7) return t.wbEveryDay;
  if (days.length >= 3 && isRun(days)) {
    return fill(t.wbDayRange, { from: t.days[days[0]!]!, to: t.wbDays[days[days.length - 1]!]! });
  }
  const names = days.map((day) => t.wbDays[day]!);
  const listed = names.length === 1
    ? names[0]!
    : `${names.slice(0, -1).join(t.wbListSep)}${t.wbAnd}${names[names.length - 1]!}`;
  return fill(t.wbEvery, { days: listed });
}

/**
 * «تدريب · كل سبت · 10:00–16:00». The title is the person's own words and may
 * be in any script, so it is its own first-strong isolate.
 */
export function weeklyLine(block: WeeklyShape, lang: Lang, options: { withTitle?: boolean } = {}): string {
  const parts = [weekdaysPhrase(block.weekdays, lang), formatClockRange(block.start, block.end)];
  if (options.withTitle !== false) parts.unshift(isolateAuto(block.title));
  return parts.join(' · ');
}

/** «تدريب، كل سبت، من 10:00 لـ 16:00» — what VoiceOver and TalkBack read. */
export function weeklyA11yLabel(block: WeeklyShape, lang: Lang, options: { withTitle?: boolean } = {}): string {
  const t = strings[lang];
  const parts = [weekdaysPhrase(block.weekdays, lang), fill(t.wbA11yTime, { start: block.start, end: block.end })];
  if (options.withTitle !== false) parts.unshift(block.title);
  return parts.join(t.wbListSep);
}
