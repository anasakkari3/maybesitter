/**
 * What day "by Monday" means when the email was sent on Thursday
 * (UC-3.8, #192 step 4).
 *
 * ── The anchor is the email, not the phone ───────────────────────
 *
 * A capture resolves "tomorrow" against the device's clock, because the person
 * typed it just now. A *shared* email was written at some other moment, and its
 * relative words mean what they meant then. An email sent on Thursday saying
 * "by Monday" means the Monday after that Thursday; read against a phone
 * reference time the following Wednesday it would mean a Monday five days
 * further on, and the product would quietly move a school deadline.
 *
 * So the day is resolved here, against `Date:`, and the item is dropped when
 * the day it resolves to is already behind the device's reference time.
 *
 * ── Why resolving here and not in the model ──────────────────────
 *
 * The channel could hand the model the sent date and ask for an absolute one
 * back. That makes calendar arithmetic a thing a language model is trusted with
 * and a thing no test can pin, and it puts a content-derived date in the
 * instructions. Instead the model quotes the *words* — "by Monday", «قبل
 * الاثنين» — and the arithmetic is this file, which is pure, deterministic and
 * has no opinion about anything it was not given.
 *
 * ── The tie with the extractor downstream ────────────────────────
 *
 * `nextWeekdayTz` in `src/extraction/ruleBasedExtractor.ts` resolves a bare
 * weekday as `(target - current + 7) % 7` days ahead of *its* now — same-day
 * counts as today. This mirrors that formula on purpose. The two therefore
 * agree on every day that is still ahead of the device, and disagree only about
 * days already behind it — which are exactly the ones this drops. The
 * disagreement is unreachable rather than tolerated.
 */
import { localDayKey, normalizeTimezone } from '../mobile/time';

/** Sunday is 0, the way `Date#getDay` and the extractor both count. */
const WEEKDAYS: Readonly<Record<string, number>> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  'الأحد': 0, 'الاحد': 0, 'الإثنين': 1, 'الاثنين': 1, 'الأثنين': 1, 'الثلاثاء': 2, 'الثلثاء': 2,
  'الأربعاء': 3, 'الاربعاء': 3, 'الخميس': 4, 'الجمعة': 5, 'الجمعه': 5, 'السبت': 6,
  'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3, 'חמישי': 4, 'שישי': 5, 'שבת': 6,
};

/**
 * A weekday name with a separator on each side.
 *
 * Spelled out as a character class rather than as `\p{L}`: the Unicode property
 * escape needs the `u` flag, which this repository's compile target does not
 * offer, and a word boundary (`\b`) does not work at all against Arabic or
 * Hebrew — `\bالاثنين\b` matches nothing, which would have made the Arabic and
 * Hebrew halves of this silently dead.
 */
const EDGE = '[\\s.,:;،؛"\'()\\[\\]!?\\-]';
const WEEKDAY_PATTERN = new RegExp(
  `(?:^|${EDGE})(${Object.keys(WEEKDAYS).map(escapeForPattern).join('|')})(?:$|${EDGE})`,
  'i',
);

function escapeForPattern(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TODAY = /\b(?:today|tonight)\b|اليوم|النهاردة|النهارده|الليلة|היום|הערב/i;
const TOMORROW = /\b(?:tomorrow|tmrw|tmr)\b|بكرا|بكرة|بكره|غدا|غداً|מחר/i;
const DAY_AFTER = /\b(?:day after tomorrow|after tomorrow)\b|بعد بكرا|بعد بكرة|بعد بكره|بعد غد|מחרתיים/i;

/** A calendar day, as `YYYY-MM-DD` in the reader's zone. Comparable as a string. */
export type DayKey = string;

/**
 * The day a phrase names, resolved against `anchor`, or null.
 *
 * Null is the ordinary answer for "as soon as you can", "before the end of the
 * month" and everything else this deliberately does not guess at. An item with
 * no resolved day is kept — it is a real request without a date — and the
 * capture pipeline reads its words the way it reads a typed sentence.
 */
export function resolveDayPhrase(
  phrase: string | null,
  anchor: Date,
  timezone: string,
): DayKey | null {
  if (typeof phrase !== 'string' || phrase.trim() === '') return null;
  const zone = normalizeTimezone(timezone);
  // Order matters: "day after tomorrow" contains "tomorrow".
  if (DAY_AFTER.test(phrase)) return addDays(anchor, 2, zone);
  if (TOMORROW.test(phrase)) return addDays(anchor, 1, zone);
  if (TODAY.test(phrase)) return addDays(anchor, 0, zone);

  const weekday = WEEKDAY_PATTERN.exec(phrase);
  if (!weekday) return null;
  const target = WEEKDAYS[weekday[1]!.toLowerCase()] ?? WEEKDAYS[weekday[1]!];
  if (target === undefined) return null;
  const current = weekdayIn(anchor, zone);
  return addDays(anchor, (target - current + 7) % 7, zone);
}

/** The anchor's own weekday in the reader's zone, 0 = Sunday. */
function weekdayIn(instant: Date, timezone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' })
    .format(instant)
    .toLowerCase();
  return WEEKDAYS[name] ?? instant.getUTCDay();
}

/**
 * `days` after the anchor's local day, as a day key.
 *
 * The arithmetic is done on the *day key* rather than on the instant, so a
 * daylight-saving shift between the anchor and the target cannot move the
 * answer by a day: 2026-10-29 plus one day is 2026-10-30 in every zone,
 * whatever happens to the clocks that night.
 */
function addDays(anchor: Date, days: number, timezone: string): DayKey {
  const key = localDayKey(anchor, timezone);
  const [year, month, day] = key.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

/** The reader's own day, as the same comparable key. */
export function dayKeyOf(instant: Date, timezone: string): DayKey {
  return localDayKey(instant, normalizeTimezone(timezone));
}
