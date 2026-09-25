/**
 * Which day a weekday name means (L4, owner's first-run defect).
 *
 * «سجّل موعد دكتور يوم الأحد» used to resolve to the nearest Sunday *including
 * today*, silently. Read by both engines — the rule-based extractor parses with
 * it and the schema validator holds the model to it — so the same sentence
 * cannot mean two different Sundays depending on which engine answered.
 *
 * ══ THE RULE (a controller ruling; do not reinterpret the phrases) ══
 *
 *   1. A bare weekday, «الأحد الجاي/القادم», "next Sunday", «יום ראשון (הבא)»
 *      all mean the nearest upcoming Sunday that is NOT today. On a Sunday that
 *      is today + 7. In Levantine «الجاي» is "the coming one", not "the one
 *      after this week", so it gets no extra week.
 *   2. Only an explicit following-week phrase adds one more week:
 *      «مش هالأحد، اللي بعده», «الأحد اللي بعد الجاي», "the Sunday after next",
 *      «בעוד שבוע ביום ראשון».
 *   3. «اليوم»/«هلأ» (today / now) beside today's own weekday keeps today.
 *   4. Every date reached through rules 1–2 is a guess and is marked inferred,
 *      so the review card can say so and offer the Sunday after.
 *
 * Pure: the clock and the zone are arguments.
 */
import { localTimeSpecFor } from './timeLexicon';

export const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  'الأحد': 0,
  'الاحد': 0,
  'الاثنين': 1,
  'الإثنين': 1,
  'الأثنين': 1,
  'الثلاثاء': 2,
  'الثلثاء': 2,
  'الأربعاء': 3,
  'الاربعاء': 3,
  'الخميس': 4,
  'الجمعة': 5,
  'السبت': 6,
  'ראשון': 0,
  'שני': 1,
  'שלישי': 2,
  'רביעי': 3,
  'חמישי': 4,
  'שישי': 5,
  'שבת': 6,
};

const EN_DAY = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday)';
const AR_DAY = '(الأحد|الاحد|الاثنين|الإثنين|الأثنين|الثلاثاء|الثلثاء|الأربعاء|الاربعاء|الخميس|الجمعة|السبت)';
const HE_DAY = '(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)';

const EN_WEEKDAY_RE = new RegExp(`\\b${EN_DAY}\\b`);
export const AR_WEEKDAY_RE = new RegExp(AR_DAY);
export const HE_WEEKDAY_RE = new RegExp(`(?:(?:ביום|יום)\\s+|ב)?${HE_DAY}(?=$|[\\s,.،])`);

/** «الجاي»/«القادم» and their spellings — "the coming one". */
const AR_COMING = '(?:الجاي|الجاية|الجايه|الجّاي|القادم|القادمة)';
const AR_WHICH = '(?:اللي|الّي|الي|إللي|يلي)';

/**
 * Rule 2's phrases, per language. Each names a weekday and asks for the one
 * after the coming one. They are matched before the bare name, and
 * `FOLLOWING_WEEK_STRIP_SOURCES` removes exactly these from a title.
 */
const FOLLOWING_WEEK: readonly RegExp[] = [
  // «مش هالأحد، اللي بعده» / «مش هاد الأحد اللي بعده»
  new RegExp(`مش\\s+(?:ه|هذا\\s+|هاد\\s+|هادا\\s+)?${AR_DAY}\\s*[,،]?\\s*${AR_WHICH}\\s+بعده`),
  // «الأحد اللي بعد الجاي» / «الأحد بعد الجاي»
  new RegExp(`${AR_DAY}\\s+(?:${AR_WHICH}\\s+)?بعد\\s+${AR_COMING}`),
  // "the Sunday after next"
  new RegExp(`\\b${EN_DAY}\\s+after\\s+next\\b`),
  // «בעוד שבוע ביום ראשון» / «ביום ראשון בעוד שבוע»
  new RegExp(`בעוד\\s+שבוע\\s+(?:(?:ביום|יום)\\s+|ב)?${HE_DAY}(?=$|[\\s,.،])`),
  new RegExp(`(?:(?:ביום|יום)\\s+|ב)?${HE_DAY}\\s+בעוד\\s+שבוע`),
];

/** The same phrases as sources, for `stripTiming` to lift out of a title whole. */
export const FOLLOWING_WEEK_STRIP_SOURCES: readonly string[] = [
  `مش\\s+(?:ه|هذا\\s+|هاد\\s+|هادا\\s+)?${AR_DAY}\\s*[,،]?\\s*${AR_WHICH}\\s+بعده`,
  `(?:يوم\\s+)?${AR_DAY}\\s+(?:${AR_WHICH}\\s+)?بعد\\s+${AR_COMING}`,
  `\\b(?:the\\s+)?${EN_DAY}\\s+after\\s+next\\b`,
  `בעוד\\s+שבוע\\s+(?:(?:ביום|יום)\\s+|ב)?${HE_DAY}(?=$|[\\s,.،])`,
  `(?:(?:ביום|יום)\\s+|ב)?${HE_DAY}\\s+בעוד\\s+שבוע`,
];

/** Rule 3: the text says today, or now. */
const TODAY_TOKEN =
  /\b(?:today|tonight)\b|اليوم|النهارده|الليلة|الليله|هلأ|هلا[ٔء]|هلّأ|هلق|هلّق|(?:^|[\s,.،])(?:היום|הערב|הלילה|עכשיו)(?=$|[\s,.،])/;

/** Another relative day beside the weekday: the weekday may not be the date. */
const OTHER_RELATIVE_DAY =
  /\b(?:tomorrow|tmrw|tmr|tomorow)\b|بكرا|بكرة|بكره|باچر|غدا|غداً|بعد غد|(?:^|[\s,.،])(?:מחר|מחרתיים)(?=$|[\s,.،])/;

const MONTHS_EN = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTHS_AR = '(?:يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر|كانون\\s+(?:الثاني|الأول|الاول)|شباط|آذار|اذار|نيسان|أيار|ايار|حزيران|تموز|آب|أيلول|ايلول|تشرين\\s+(?:الأول|الاول|الثاني))';
const MONTHS_HE = 'ב?(?:ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר)';

/** A calendar date the user typed: `4/10`, "Oct 4", «4 تشرين الأول», «4 באוקטובר». */
const CALENDAR_DATE = new RegExp(
  [
    '\\b\\d{1,2}[/.]\\d{1,2}(?:[/.]\\d{2,4})?\\b',
    `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTHS_EN}\\b`,
    `\\b${MONTHS_EN}\\s+\\d{1,2}\\b`,
    `[0-9٠-٩]{1,2}\\s*(?:من\\s+)?(?:شهر\\s+)?${MONTHS_AR}`,
    `[0-9]{1,2}\\s*${MONTHS_HE}`,
  ].join('|'),
  'i',
);

export interface WeekdayReference {
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** 1 only for an explicit following-week phrase (rule 2). */
  weeksLater: 0 | 1;
  /** The text also says today or now (rule 3). */
  today: boolean;
}

/** The weekday the text names, and how far past the coming one, or null. */
export function readWeekdayReference(rawText: string): WeekdayReference | null {
  if (typeof rawText !== 'string' || !rawText.trim()) return null;
  const lower = rawText.toLowerCase();
  const today = TODAY_TOKEN.test(lower);
  for (const pattern of FOLLOWING_WEEK) {
    const match = pattern.exec(lower);
    if (match) {
      const weekday = WEEKDAY_INDEX[match[1]!];
      if (weekday !== undefined) return { weekday, weeksLater: 1, today };
    }
  }
  const match = EN_WEEKDAY_RE.exec(lower) || AR_WEEKDAY_RE.exec(lower) || HE_WEEKDAY_RE.exec(lower);
  if (!match) return null;
  const weekday = WEEKDAY_INDEX[match[1]!];
  return weekday === undefined ? null : { weekday, weeksLater: 0, today };
}

/**
 * Days from `currentWeekday` to the day the reference means. Rules 1–3.
 *
 * Never 0 unless the text itself said today: `|| 7` is rule 1's "not today".
 */
export function daysUntilWeekday(currentWeekday: number, reference: WeekdayReference): number {
  if (reference.today && reference.weeksLater === 0 && reference.weekday === currentWeekday) return 0;
  const ahead = ((reference.weekday - currentWeekday + 7) % 7) || 7;
  return ahead + reference.weeksLater * 7;
}

/** True when the text types a calendar date, so a weekday beside it is decoration. */
export function namesCalendarDate(rawText: string): boolean {
  return typeof rawText === 'string' && CALENDAR_DATE.test(rawText);
}

/** True when the text names tomorrow or the day after as well as a weekday. */
export function namesOtherRelativeDay(rawText: string): boolean {
  return typeof rawText === 'string' && OTHER_RELATIVE_DAY.test(rawText.toLowerCase());
}

export interface WeekdayResolution {
  /** `YYYY-MM-DD`, on the user's clock. */
  date: string;
  /** Rule 4: false only when the text said today (rule 3) or typed the date. */
  inferred: boolean;
}

/** The local date a weekday-named sentence lands on, in `timeZone`, or null. */
export function resolveWeekdayDate(rawText: string, now: Date, timeZone: string): WeekdayResolution | null {
  const reference = readWeekdayReference(rawText);
  if (!reference) return null;
  const today = localTimeSpecFor(now, timeZone)?.date;
  if (!today) return null;
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  const currentWeekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const days = daysUntilWeekday(currentWeekday, reference);
  const date = new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
  return { date, inferred: days !== 0 && !namesCalendarDate(rawText) };
}
