import type { ExtractionContext, ExtractionResult, LocalTimeSpec } from './extractionTypes';
import { classifyMessageKind, createsNothing, stripLeadingGreetings } from './messageKind';
import {
  CLOCK_PATTERN_SOURCES,
  CLOCK_WITH_PERIOD_SOURCES,
  DAY_PART_MENTION_SOURCES,
  RELATIVE_DAY_MENTION_SOURCES,
  RANGE_PATTERN_SOURCES,
  dayPartHour,
  localTimeSpecFor,
  normalizeArabicDigits,
  normalizeSpokenHours,
  namesDay,
  instantFromLocal,
  forbidsResolvedTime,
  hourWithDayPart,
  lastDayOfMonth,
  namesTimeRange,
  monthEndDay,
  namesTwelveInTheEvening,
  MONTH_END_MENTION_SOURCES,
  MONTH_END_OFFSET_SOURCE,
  NIGHT_HOUR,
  nightClockHour,
  readPeriodEndDeadline,
  relativeDayIsUnsettled,
  relativeDayOffset,
  timeAnchorOf,
  timeOfDayEvidence,
  normalizeClockFractions,
  normalizeClockText,
  type TimeEvidence,
} from './timeLexicon';
import {
  FOLLOWING_WEEK_STRIP_SOURCES,
  WEEKDAY_MENTION_SOURCES,
  daysUntilWeekday,
  readWeekdayReference,
} from './weekdayLexicon';
import { isFixedAppointment, statedObligation } from './priorityLexicon';
import { stripCaptureCommand } from './captureCommand';

export { CLOCK_PATTERN_SOURCES, RANGE_PATTERN_SOURCES } from './timeLexicon';

const PARSER_VERSION = 'rule-v1-core';

/**
 * The rule-based path never guesses a category (#415).
 *
 * The tempting fix when the model is unavailable is a keyword table — "meeting"
 * is work, "doctor" is health. It is wrong in Arabic, wrong in Hebrew, wrong
 * for "meeting the school about Lina", and worst of all it is *confidently*
 * wrong: it produces a category the rest of the app cannot tell apart from one
 * the model actually reasoned about. The user would then find commitments
 * filed under a category nobody chose, in the one situation — the model being
 * down — where they have least reason to expect it.
 *
 * `null` costs the user nothing: an uncategorised commitment still appears
 * under "All", which is where everyone who has not turned the split on is
 * looking anyway.
 */
const NO_CATEGORY = { category: null, categoryConfidence: 0 } as const;
const INFORMATIONAL_RE =
  /\b(waiting on|for your information|fyi|just so you know|asked me about|told me about)\b|(سألتني|سألني|تسألني|مستني|مستنية|بانتظار|ينتظر|تنتظر|قالت لي|قال لي)|(מחכה|מחכים|שאל אותי|שאלה אותי|ביקש ממני)|(i|we) had a (nice|great|good|bad|tiring|long|busy|rough) (day|week|morning|afternoon|evening|night)\b/i;

function setTime(date: Date, hour: number, minute = 0): Date {
  const next = new Date(date);
  next.setHours(hour, minute, 0, 0);
  return next;
}

/* ── Timezone-aware date math ──────────────────────────────────────
 * The extractor receives a `timezone` in its context (e.g. 'UTC',
 * 'Asia/Jerusalem'). Relative phrases ("tomorrow at 10am") must resolve
 * to the same absolute instant regardless of the host machine's timezone.
 * These helpers do wall-clock math in the target timezone and convert back
 * to UTC. When no timezone is supplied we fall back to the host timezone to
 * preserve legacy behavior. DST transitions are handled with a two-pass
 * offset refinement. */

function tzOffsetMs(date: Date, timeZone: string): number {
  if (timeZone === 'UTC' || timeZone === 'Etc/UTC') return 0;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(date);
  const name = parts.find((part) => part.type === 'timeZoneName')?.value || 'GMT';
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 3_600 + Number(match[3]) * 60) * 1_000;
}

function wallClockParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const offset = tzOffsetMs(date, timeZone);
  const wall = new Date(date.getTime() + offset);
  return {
    year: wall.getUTCFullYear(),
    month: wall.getUTCMonth(),
    day: wall.getUTCDate(),
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
    second: wall.getUTCSeconds(),
  };
}

function fromWallClock(parts: { year: number; month: number; day: number; hour: number; minute: number; second: number }, timeZone: string): Date {
  const utcGuess = new Date(Date.UTC(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second));
  const offset = tzOffsetMs(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offset);
}

function addDaysTz(date: Date, days: number, timeZone: string): Date {
  const parts = wallClockParts(date, timeZone);
  return fromWallClock({ ...parts, day: parts.day + days }, timeZone);
}

function setTimeTz(date: Date, hour: number, minute: number, timeZone: string): Date {
  const parts = wallClockParts(date, timeZone);
  return fromWallClock({ ...parts, hour, minute, second: 0 }, timeZone);
}

/**
 * The date a weekday name means, by the rule in `weekdayLexicon.ts`: the
 * nearest one that is not today, a week later only when the text says "the one
 * after", and today only when the text says today.
 */
function weekdayTargetTz(from: Date, currentText: string, timeZone: string): { date: Date; daysAhead: number } | null {
  const reference = readWeekdayReference(currentText);
  if (!reference) return null;
  const parts = wallClockParts(from, timeZone);
  const currentWeekday = new Date(Date.UTC(parts.year, parts.month, parts.day)).getUTCDay();
  const daysAhead = daysUntilWeekday(currentWeekday, reference);
  return { date: addDaysTz(from, daysAhead, timeZone), daysAhead };
}

function resolveTimezone(context: ExtractionContext): string {
  return context.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function parseClock(raw: string): { hour: number; minute: number; night?: true; settled?: true } | null {
  const normalized = normalizeClockText(raw).toLowerCase();
  const explicit =
    normalized.match(/(?:\b(?:at|by|around)\b|الساعة|الساعه|عند|على|בשעה|שעה|בסביבות(?:\s+ה?שעה)?|סביב(?:\s+ה?שעה)?|לקראת(?:\s+ה?שעה)?|עד(?:\s+ה?שעה)?|[בס]-?)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|صباحا|صباحاً|الصبح|ص|مساء|مساءً|المسا|المساء|بالليل|م|בבוקר|בוקר|בצהריים|צהריים|אחרי הצהריים|אחה"צ|בערב|ערב|בלילה|לילה)?(?=$|[\s,.،])/) ||
    normalized.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|صباحا|صباحاً|الصبح|ص|مساء|مساءً|المسا|المساء|بالليل|م|בבוקר|בוקר|בצהריים|צהריים|אחרי הצהריים|אחה"צ|בערב|ערב|בלילה|לילה)(?=$|[\s,.،])/) ||
    // A bare hh:mm is read last, so a part of the day after it («5:30 المسا») is not lost.
    normalized.match(/\b(\d{1,2}):(\d{2})(?=$|[\s,.،])/);
  if (!explicit) return null;
  let hour = Number(explicit[1]);
  const minute = explicit[2] ? Number(explicit[2]) : 0;
  const period = explicit[3] || '';
  if (hour < 1 || hour > 23 || minute < 0 || minute > 59) return null;
  // At night, the small hours are the morning half (FZ1 N10): «2 بالليل» is 02:00.
  if (/(بالليل|בלילה|לילה)/.test(period)) return { hour: nightClockHour(hour), minute, night: true };
  if (/(pm|مساء|المسا|المساء|م|בערב|ערב|אחרי הצהריים|אחה"צ|בצהריים|צהריים)/.test(period) && hour < 12) hour += 12;
  if (/(am|صباح|الصبح|ص|בבוקר|בוקר)/.test(period) && hour === 12) hour = 0;
  return { hour, minute };
}

/** `HH:MM` as the parser's clock, already in its half of the day. */
function clockOf(time: string): { hour: number; minute: number; settled: true } {
  return { hour: Number(time.slice(0, 2)), minute: Number(time.slice(3, 5)), settled: true };
}

interface ParsedTime {
  dueAt: string | null;
  remindAt: string | null;
  confidence: number;
  /** Why the time was believed, or why there is none. */
  evidence: TimeEvidence;
  localTimeSpec: LocalTimeSpec | null;
  /** The day came from a weekday name alone, so it is the product's guess. */
  dateInferred: boolean;
  /** A day with no hour that is a deadline in itself (FX3): see `ExtractionResult.allDay`. */
  allDay?: boolean;
  /** The day came from the month's end (FX3), with or without an hour: its words are the time. */
  monthEnd?: boolean;
}

function parseDateTime(raw: string, context: ExtractionContext): ParsedTime {
  const now = context.now;
  const tz = resolveTimezone(context);
  // «الساعة 12 المسا» names no hour anybody can read (POLISH-CAPTURE review,
  // M7): no clock and no part of the day, so the day is kept and the hour asked.
  //
  // A number with its part of the day — «5 العصر», «خمسة المسا», "5 in the
  // evening", «5 אחר הצהריים» — is that hour in that half (closure UAT round
  // 6), read as the typed answers read it (`hourWithDayPart`). The part of the
  // day's own hour (14:00, 18:00) replaced the stated 5 before. A pair nobody
  // can read — «12 الصبح», «11 الضهر» — is asked, like «12 المسا». Not in a
  // range: «من الساعة 2 للساعة 4 المسا» starts at the range's start.
  const statedWithDayPart = namesTimeRange(raw) ? null : hourWithDayPart(raw);
  const twelveInTheEvening = namesTwelveInTheEvening(raw) || statedWithDayPart === 'ambiguous';
  const clock = twelveInTheEvening ? null : statedWithDayPart ? clockOf(statedWithDayPart) : parseClock(raw);
  let targetDate: Date | null = null;
  let timeConfidence = 0;
  let dateInferred = false;

  // Today, tomorrow or the day after, as whole words (`timeLexicon.ts`):
  // «الغداء» (lunch) is not «غدا», «اليومي» (daily) is not «اليوم».
  // A day ruled out or left open — «مش بكرا», «اليوم أو بكرا» — is no day
  // (FINAL-BACKEND review, M2): the item is asked, as on the model path.
  const relativeDay = relativeDayIsUnsettled(raw) ? null : relativeDayOffset(raw);
  if (relativeDay === 0) {
    targetDate = new Date(now);
    timeConfidence = 0.85;
  } else if (relativeDay !== null) {
    targetDate = addDaysTz(now, relativeDay, tz);
    timeConfidence = 0.9;
  }

  const weekday = weekdayTargetTz(now, raw, tz);
  if (weekday) {
    targetDate = weekday.date;
    timeConfidence = 0.88;
    // Every weekday day is a guess (rule 4) unless the text said today. That
    // includes a sentence that also typed a date this parser cannot read
    // ("the 4th"): the Sunday picked here may not be it, and saying so is the
    // honest answer.
    dateInferred = weekday.daysAhead !== 0;
  }

  // «قبل آخر الشهر», "by the end of the month", «עד סוף החודש» (FX3): the
  // month's last day, when nothing else in the sentence named a day. With a
  // counted offset before it — «قبل آخر الشهر بأسبوع», "two days before the
  // end of the month" — the day counted back on the person's clock (FZ1
  // round 2; FX3 settled all of these on the 30th). Another month named, or an
  // offset it cannot count, gets no day.
  const wordsDay = !targetDate ? monthEndDay(raw, now, tz) : null;
  const monthEnd = wordsDay && wordsDay.side !== 'after' && readPeriodEndDeadline(raw) === 'month' ? wordsDay.date : null;
  if (monthEnd) {
    targetDate = instantFromLocal(monthEnd, '12:00', tz);
    timeConfidence = 0.9;
  }

  // «أحضّر تقرير آخر الشهر» (FZ1 N6): this month's end named, not as a
  // deadline («تقرير آخر الشهر» is the month-end report), and nothing else
  // in the sentence says when. The words win for this month's end
  // (controller ruling): its last day, the hour asked, the day marked a
  // guess, and the words kept in the title. Not beside a time of day.
  // A counted offset after it — «بعد آخر الشهر بيومين» — is the day the
  // person counted to, said rather than guessed, with or without an hour
  // (FZ1 round 2).
  if (!targetDate && wordsDay && (wordsDay.side !== 'end' || forbidsResolvedTime(raw))) {
    targetDate = instantFromLocal(wordsDay.date, '12:00', tz);
    timeConfidence = wordsDay.side === 'end' ? 0.6 : 0.9;
    dateInferred = wordsDay.side === 'end';
  }

  if (!targetDate && clock) {
    targetDate = new Date(now);
    timeConfidence = 0.72;
  }

  const evidence = timeOfDayEvidence(raw);

  if (!targetDate) {
    return { dueAt: null, remindAt: null, confidence: 0.1, evidence, localTimeSpec: null, dateInferred: false };
  }

  // The hour has to come from the sentence. It used to come from `?? 18`, so
  // "remind me tomorrow" — a date and nothing else — resolved to six in the
  // evening at time-confidence 0.9 and overall 0.9, with no ambiguity flag.
  // That is high enough to auto-confirm, so the product silently scheduled an
  // hour the user never said and never asked about it. A caller that sets
  // `defaultReminderHour` has *chosen* a default and still gets one; its
  // absence now means "no time stated" rather than "six".
  const daypart = twelveInTheEvening ? null : dayPartHour(raw);
  let hour: number;
  let minute = 0;
  if (clock) {
    hour = clock.hour;
    minute = clock.minute;
    // «الساعة 3 العصر» is three in the *afternoon*. `parseClock` only reads
    // مساء/بالليل/am/pm as a meridiem, so العصر — and English "at 8 tonight" —
    // left the hour in the morning half and scheduled 03:00. The part-of-day
    // word is exactly the meridiem the sentence gave, so it is used as one.
    // Only when there was no explicit AM/PM to begin with: `ampm` and `hhmm`
    // have already said which half of the day they mean.
    // A night hour is read by the night's own rule (FZ1 N10): «الساعة 2
    // بالليل» is 02:00, "at 11 tonight" is 23:00.
    if (clock.settled) {
      // Already in the half its part of the day named.
    } else if (evidence === 'daypart' && daypart === NIGHT_HOUR) {
      if (!clock.night) hour = nightClockHour(hour);
    } else if (evidence === 'daypart' && daypart !== null && daypart >= 12 && hour >= 1 && hour <= 11) {
      hour += 12;
    }
    timeConfidence = Math.max(timeConfidence, 0.95);
  } else if (daypart !== null) {
    hour = daypart;
  } else if (context.defaultReminderHour !== undefined) {
    hour = context.defaultReminderHour;
  } else if (monthEnd && !(wordsDay?.side === 'before' && monthEnd === localTimeSpecFor(now, tz)?.date)) {
    // A deadline that is a day and not an hour: due by the month's last day,
    // all day. Nothing to ask — "what time is the end of the month?" has no
    // answer the person is holding.
    //
    // Except a counted day that is today (closure UAT round 4, N15): «قبل آخر
    // الشهر بيومين» said on the 28th is today, and the hour is asked on it —
    // it falls through to the day with no hour, below.
    const midnight = instantFromLocal(monthEnd, '00:00', tz);
    if (midnight) {
      return {
        dueAt: midnight.toISOString(),
        remindAt: null,
        confidence: timeConfidence,
        evidence: 'day_only',
        localTimeSpec: { date: monthEnd, time: null, timezone: tz },
        dateInferred: false,
        allDay: true,
        monthEnd: true,
      };
    }
    return { dueAt: null, remindAt: null, confidence: 0.1, evidence, localTimeSpec: null, dateInferred: false };
  } else {
    // The day parsed; the hour was never stated. Report exactly that, so the
    // review screen can show "Sunday" and the clarification step can ask for
    // the hour alone (#164, #165).
    const day = localTimeSpecFor(targetDate, tz);
    return {
      dueAt: null,
      remindAt: null,
      confidence: 0.1,
      evidence,
      localTimeSpec: day ? { ...day, time: null } : null,
      dateInferred,
      // A counted day today (N15): the month-end words are its time, not its title.
      ...(monthEnd ? { monthEnd: true } : {}),
    };
  }

  const withTime = setTimeTz(targetDate, hour, minute, tz);
  // A clock time with no meridiem is the user's number and the product's guess
  // at which half of the day it belongs to. It is kept, and it is named, so the
  // review screen and the clarification question can both see that it is soft.
  const confidence = evidence === 'clock_marker' ? Math.min(timeConfidence, 0.7) : timeConfidence;
  return {
    dueAt: withTime.toISOString(),
    remindAt: withTime.toISOString(),
    confidence,
    evidence,
    localTimeSpec: localTimeSpecFor(withTime, tz),
    dateInferred,
    ...(monthEnd ? { monthEnd: true } : {}),
  };
}

/** A text with every time, day and part-of-day expression taken out. */
export function stripTimeExpressions(text: string): string {
  return stripTiming(text);
}

// Compiled once (CL1 review m-4): `stripTiming` runs for every clause, and
// compiling ~40 `u`-flag sources per call was most of a cold capture's cost.
// A global regex is safe to share with `String.replace`, which resets it.
const FOLLOWING_WEEK_STRIP = FOLLOWING_WEEK_STRIP_SOURCES.map((source) => new RegExp(source, 'giu'));
const DAY_PART_STRIP = DAY_PART_MENTION_SOURCES.map((source) => new RegExp(source, 'giu'));
const RELATIVE_DAY_STRIP = RELATIVE_DAY_MENTION_SOURCES.map((source) => new RegExp(source, 'giu'));
const WEEKDAY_STRIP = WEEKDAY_MENTION_SOURCES.map((source) => new RegExp(source, 'gu'));
const CLOCK_STRIP = [...RANGE_PATTERN_SOURCES, ...CLOCK_PATTERN_SOURCES].map((source) => new RegExp(source, 'gi'));
// Ranges first, so «من الساعة 2 للساعة 4 المسا» is not cut inside its range.
const CLOCK_WITH_PERIOD_STRIP = [...RANGE_PATTERN_SOURCES, ...CLOCK_WITH_PERIOD_SOURCES].map((source) => new RegExp(source, 'gi'));
// The counted offset whole first («قبل آخر الشهر بأسبوع»), so «بأسبوع» is not
// left behind in the title (FZ1 round 2).
const MONTH_END_STRIP = [MONTH_END_OFFSET_SOURCE, ...MONTH_END_MENTION_SOURCES].map((source) => new RegExp(source, 'giu'));
/**
 * «הבוקר» is "this morning" and also "the morning" («ישיבת הבוקר»). It gives
 * an item no time unless the text names a day, and then it is kept in the
 * title as written (CL1 review m-2).
 */
const HE_THE_MORNING = new RegExp('^[\\s,.،]*ו?הבוקר[\\s,.،]*$', 'u');

/**
 * `monthEnd`: the reading used the month's end as its deadline, so the words
 * are the time and leave the title. Otherwise they stay: «أحضّر تقرير آخر
 * الشهر» is what the report is, and in «…بكرا الساعة 5 وأدفع الفاتورة قبل آخر
 * الشهر» the item took tomorrow, so the words are the only place the bill's
 * deadline is still visible (review I-1).
 */
function stripTiming(text: string, options: { monthEnd?: boolean } = {}): string {
  // Rewrite «الساعة تسعة» to «الساعة 9» and «בשעה תשע» to «בשעה 9» first, so
  // the clock patterns below strip a spoken hour out of the title exactly as
  // they strip a typed one.
  // Digits are left as typed (a title keeps its «٢٠٠ شيكل»); only the
  // spoken hours and fractions are rewritten so the clock patterns find them.
  let stripped = normalizeClockFractions(normalizeSpokenHours(text));
  // "The one after" phrases whole, before the bare day names below take their
  // weekday and leave «اللي بعد الجاي» behind in the title.
  for (const pattern of FOLLOWING_WEEK_STRIP) stripped = stripped.replace(pattern, ' ');
  // The month's end with its limit word (FX3), before «آخر» or «الشهر» can be
  // left behind by anything below — only when it is this item's deadline.
  if (options.monthEnd) for (const pattern of MONTH_END_STRIP) stripped = stripped.replace(pattern, ' ');
  // Parts of the day first, by the lexicon's own whole-word rule, while the
  // "tomorrow" that frames "tomorrow morning" is still there to be read. A
  // word that only contains one — «المساعدة», «המערב», "the morning report"
  // — stays in the title whole, and «عالمسا» leaves no «ع» behind.
  // A clock with its part of the day («5 المسا», «ב-5 בערב») goes whole first:
  // taking «المسا» alone would leave its «5» in the title (closure UAT r6).
  for (const pattern of CLOCK_WITH_PERIOD_STRIP) stripped = stripped.replace(pattern, ' ');
  const dayNamed = namesDay(text);
  for (const pattern of DAY_PART_STRIP) {
    stripped = stripped.replace(pattern, (match) => (!dayNamed && HE_THE_MORNING.test(match) ? match : ' '));
  }
  // The relative days the same way, the day after before tomorrow: a partial
  // match never takes letters out of a word («الغداء», «اليومي» stay whole).
  // Not a day the words rule out or leave open — «بس مش بكرا», «اليوم أو
  // بكرا», "today or tomorrow": the item took no day from it and is asked, so
  // the phrase stays as said, rather than «أتصل بسامي بس مش» or "call Sam or"
  // (FINAL-BACKEND review).
  if (!relativeDayIsUnsettled(text)) {
    for (const pattern of RELATIVE_DAY_STRIP) stripped = stripped.replace(pattern, ' ');
  }
  stripped = stripped
    .replace(/\b(?:on|this|next)\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi, ' ')
    .replace(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi, ' ');
  // Arabic and Hebrew day names, as whole words and with «يوم» and «الجاي»
  // around them — the same tokenizer that resolves them, so «الأحداث» and
  // «הראשון» stay in the title exactly as they are not read as days.
  for (const pattern of WEEKDAY_STRIP) stripped = stripped.replace(pattern, ' ');
  // Ranges before the clocks inside them: taking "2pm" first would leave
  // "meeting from to" as the title.
  for (const pattern of CLOCK_STRIP) stripped = stripped.replace(pattern, ' ');
  return stripped.replace(/\s+/g, ' ').trim();
}

/**
 * A limit word left at the end of a title once the time after it was taken
 * out (CL1, round 1): «أخلص تقرير الشغل قبل الخميس» became «أخلص تقرير الشغل
 * قبل», "finish the report by tomorrow" became "finish the report by".
 */
const DANGLING_LIMIT = new RegExp('(?:^|\\s)(قبل|لحد|لحدّ|لغاية|لغايه|حتى|حتّى|before|by|until|till|עד|לפני)$', 'iu');

/**
 * Only when the word was followed by something in what the user wrote — the
 * time that `stripTiming` took — so a title that genuinely ends on one is
 * kept. "Stop by" / "drop by" is a visit, not a deadline, and keeps its "by".
 */
function withoutDanglingLimit(title: string, raw: string): string {
  const match = DANGLING_LIMIT.exec(title);
  if (!match) return title;
  const word = match[1]!;
  const before = title.slice(0, match.index).trim();
  if (/^by$/i.test(word) && /\b(?:stop|stopped|drop|dropped|pass|passed|come|came|swing|pop|go|went)$/i.test(before)) return title;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const followed = new RegExp(`(?:^|[\\s,.،])${escaped}\\s+\\S`, 'iu').test(raw);
  return followed && before ? before : title;
}

/**
 * Sentence marks left in a title (CL1 review, I3). A clause keeps its own «.»
 * so a seed is stored as typed, and once `stripTiming` took the time before
 * it the title read «موعد دكتور .» — and « قبل .» hid the dangling «قبل» from
 * the strip below, which is anchored at the end.
 */
const STRAY_MARKS = /(^|\s)[.!?؟،,;:]+(?=\s|$)|[.!?؟]+$/g;

function cleanAction(raw: string, options: { monthEnd?: boolean } = {}): string {
  const title = cleanCommand(raw, options).replace(STRAY_MARKS, '$1').replace(/\s+/g, ' ').trim();
  return withoutDanglingLimit(title, raw);
}

function cleanCommand(raw: string, options: { monthEnd?: boolean } = {}): string {
  // «سجّل», «حط لي», "note:" — an instruction to the app, not the task (L4).
  // A greeting it opens with is not the task: «בוקר טוב, להתקשר לאמא» (CL1).
  return stripCaptureCommand(stripTiming(stripLeadingGreetings(raw), options))
    .replace(/^\s*(please\s+)?(remind me to|remind me|remember to|i need to|need to|i have to|have to|todo:?|task:?)\s+/i, '')
    .replace(/^\s*(urgent|asap|critical|important|must|maybe|optional)[:\s-]+/i, '')
    .replace(/\s+(urgent|asap|critical|important|must|maybe|optional)\s*$/i, '')
    // «ذكرني ليش» is a question to answer, not a reminder to strip (L4).
    .replace(/^\s*(ذكرني اني|ذكرني|ذكريني|بدي|لازم|محتاج|احتاج|علي|عليّ)\s+(?!(?:ليش|ليه|شو|مين|وين|كيف|قديش|امتى|إمتى|ايمتى|إيمتى|متى)(?:\s|$))/i, '')
    .replace(/^\s*(ضروري|مستعجل|مهم|لازم|يمكن|عادي|مش ضروري)[:\s-]+/i, '')
    .replace(/\s+(ضروري|مستعجل|مهم|لازم|يمكن|عادي|مش ضروري)\s*$/i, '')
    // Never onto the object marker: «תזכיר לי את הילד…» keeps its verb (L4).
    .replace(/^\s*(?:בבקשה\s+)?(תזכיר לי ש|תזכירי לי ש|להזכיר לי ש|תזכיר לי|תזכירי לי|להזכיר לי|אני צריך|אני צריכה|צריך|צריכה|אני חייב|אני חייבת|חייב|חייבת|אני רוצה|רוצה)\s+(?!את\s)/i, '')
    .replace(/^\s*(דחוף|חשוב|קריטי|חובה|אולי|לא דחוף|אפשר)[:\s-]+/i, '')
    .replace(/\s+(דחוף|חשוב|קריטי|חובה|אולי|לא דחוף|אפשר)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferPriority(raw: string, time: ParsedTime): ExtractionResult['priority'] {
  const lower = raw.toLowerCase();
  const pressureImplied = /\b(push me|bug me|don't let me|dont let me|do not let me)\b/.test(lower);
  // The person's own obligation word, read by the same whole-word lexicon the
  // model path uses (FX3). «مش لازم» is "not needed", which the substring
  // match below used to read as Must.
  const obligation = statedObligation(raw);
  if (obligation === 'not_needed' || /\b(maybe|probably|sometime|optional)\b/.test(lower) || /(مش ضروري|يمكن|عادي)/.test(lower) || /(?:^|[\s,.،])(אולי|לא דחוף)(?=$|[\s,.،])/.test(lower)) {
    return { level: 'low', source: 'inferred', pressureAllowed: false, pressureImplied: false };
  }
  if (obligation === 'must' || /\b(urgent|asap|critical|important)\b/.test(lower) || /(مستعجل|مهم)/.test(lower) || /(?:^|[\s,.،])(דחוף|חשוב|קריטי)(?=$|[\s,.،])/.test(lower) || pressureImplied) {
    return { level: 'high', source: pressureImplied ? 'inferred' : 'user_explicit', pressureAllowed: false, pressureImplied };
  }
  // A doctor, an exam, a flight on a fixed day is not a "should" (L4). It is
  // still our reading, not their words — `inferred`, so the review card marks
  // it as a guess they can change.
  if (isFixedAppointment(raw, { hasDay: Boolean(time.localTimeSpec?.date), hasClock: Boolean(time.localTimeSpec?.time) })) {
    return { level: 'high', source: 'inferred', pressureAllowed: false, pressureImplied: false };
  }
  return { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false };
}

function confidence(overall: number, action: number, time: number, priority = 0.8): ExtractionResult['confidence'] {
  return { overall, type: overall, action, time, priority };
}

/**
 * A result that produces no commitment, and says why.
 *
 * `informational_context` for everything the user was telling us, and `unknown`
 * for a negated request — which is not information, it is an instruction not to
 * act, and the disposition policy already refuses to auto-confirm it.
 *
 * The title is null on purpose. Echoing the sentence back as a title is how
 * «صباح الخير» became a commitment in the first place, and a no-commitment
 * outcome has nothing to name.
 */
function nothingResult(raw: string, kind: ReturnType<typeof classifyMessageKind>): ExtractionResult {
  const negated = kind === 'negated_request';
  return {
    type: negated ? 'unknown' : 'informational_context',
    action: null,
    title: null,
    person: null,
    dueAt: null,
    remindAt: null,
    localTimeSpec: null,
    timeEvidence: 'none',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'soft',
    ...NO_CATEGORY,
    // A negated request is capped below `MEDIUM_CONFIDENCE`, the same cap the
    // schema validator has always applied to one. Without it the disposition
    // policy reads `unknown` with high confidence as `needs_clarification`, and
    // the product would answer "don't remind me about the gym" with a question
    // about the gym.
    confidence: negated
      ? { overall: 0.55, type: 0.95, action: 0.1, time: 0.1, priority: 0.8 }
      : { overall: 0.95, type: 0.95, action: 0.1, time: 0.1, priority: 0.8 },
    missingFields: ['action'],
    ambiguityFlags: negated
      ? ['negated_request']
      : kind === 'informational' || kind === 'past_event'
        ? ['informational_without_action']
        : ['no_action_verb'],
    explicitReminderRequest: false,
    explicitPressureRequest: false,
    rawText: raw,
    parserVersion: PARSER_VERSION,
  };
}

export function extract(rawText: string, context: ExtractionContext): ExtractionResult {
  const raw = rawText.trim();

  // Before asking what commitment is in this, ask whether it is asking for one
  // (UC-2.6, #166). Without this the extractor answered "what task is this" for
  // every input, so «صباح الخير» became a task titled "الخير" and «מה השעה?»
  // became one titled "מה השעה?" — 27 of the 40 synthetic safety cases created
  // something. The classifier is deterministic rather than a prompt instruction
  // because this extractor is *the* engine whenever AI consent has not been
  // granted, which is every new account.
  const kind = classifyMessageKind(raw);
  if (createsNothing(kind)) return nothingResult(raw, kind);

  const lower = raw.toLowerCase();
  const negatedReminderRequest =
    /\b(don't|dont|do not|not)\s+(remind|remember|bug)\b/.test(lower) ||
    /\b(remind me|remember to|bug me)\s+not\b/.test(lower) ||
    /(?:^|[\s,.،])אל\s+(?:תזכיר|תזכירי|תזכירו)(?=$|[\s,.،])/.test(lower);
  const explicitReminderRequest =
    !negatedReminderRequest &&
    (/\b(remind me|remember to|bug me)\b/.test(lower) ||
      /(ذكرني|ذكريني)/.test(lower) ||
      /(?:^|[\s,.،])(?:בבקשה\s+)?(?:תזכיר לי|תזכירי לי|להזכיר לי)(?=$|[\s,.،])/.test(lower));
  const explicitPressureRequest = /\b(push me|bug me|don't let me|dont let me|do not let me)\b/.test(lower);
  const missingFields: ExtractionResult['missingFields'] = [];
  const ambiguityFlags: ExtractionResult['ambiguityFlags'] = [];
  const parsedTime = parseDateTime(raw, context);
  const priority = inferPriority(raw, parsedTime);

  if (/\band\b.+\b(remind me|i need to|follow up|call|email|text)\b/.test(lower)) {
    ambiguityFlags.push('multiple_commitments');
  }
  if (negatedReminderRequest) {
    ambiguityFlags.push('negated_request');
  }

  const followUp = raw.match(/\bfollow up with\s+([A-Z][a-z]+|[a-z]+)(?:\s+about\s+(.+?))?(?:\s+(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|at|by)\b.*)?$/i);
  if (followUp) {
    const person = followUp[1].trim();
    const topic = followUp[2] ? stripTiming(followUp[2], { monthEnd: parsedTime.monthEnd }).trim() : '';
    const title = topic ? `Follow up with ${person} about ${topic}` : `Follow up with ${person}`;
    if (!parsedTime.remindAt && !parsedTime.allDay) missingFields.push('time');
    return {
      type: 'follow_up',
      action: title,
      title,
      person,
      dueAt: parsedTime.dueAt,
      remindAt: parsedTime.remindAt,
      localTimeSpec: parsedTime.localTimeSpec,
      timeEvidence: parsedTime.evidence,
      dateInferred: parsedTime.dateInferred,
      priority,
      flexibility: 'movable',
      ...NO_CATEGORY,
      confidence: confidence(parsedTime.remindAt ? 0.86 : 0.68, 0.9, parsedTime.confidence),
      missingFields,
      ambiguityFlags,
      explicitReminderRequest,
      explicitPressureRequest,
      rawText: raw,
      timeAnchor: parsedTime.allDay ? 'deadline' : timeAnchorOf(raw),
      ...(parsedTime.allDay ? { allDay: true } : {}),
      parserVersion: PARSER_VERSION,
    };
  }

  if (INFORMATIONAL_RE.test(lower) && !explicitReminderRequest) {
    return {
      type: 'informational_context',
      action: null,
      title: raw,
      person: null,
      dueAt: null,
      remindAt: null,
      localTimeSpec: null,
      timeEvidence: 'none',
      priority,
      flexibility: 'soft',
      ...NO_CATEGORY,
      confidence: confidence(0.55, 0.1, 0.1),
      missingFields: ['action', 'time'],
      ambiguityFlags: ['informational_without_action'],
      explicitReminderRequest,
      explicitPressureRequest,
      rawText: raw,
      parserVersion: PARSER_VERSION,
    };
  }

  const action = cleanAction(raw, { monthEnd: parsedTime.monthEnd });
  const weak =
    /\b(maybe|probably|sometime|should probably)\b/.test(lower) ||
    /(يمكن|عادي|مش ضروري)/.test(lower) ||
    /(?:^|[\s,.،])(אולי|לא דחוף)(?=$|[\s,.،])/.test(lower);
  if (!action || action.length < 3) {
    missingFields.push('action');
    ambiguityFlags.push('vague_action');
  }
  // An all-day deadline is a complete answer to "when" (FX3): not vague, and
  // not missing — but it has no hour to remind at, so it never auto-confirms.
  const allDay = parsedTime.allDay === true;
  if (!parsedTime.remindAt && !allDay) {
    missingFields.push('time');
    ambiguityFlags.push('vague_time');
  }
  if (weak) ambiguityFlags.push('weak_commitment_language');

  const actionConfidence = action && action.length >= 3 ? 0.82 : 0.2;
  const hasTime = Boolean(parsedTime.remindAt) || allDay;
  let overall = 0.72;
  if (explicitReminderRequest && parsedTime.remindAt && actionConfidence >= 0.8 && !weak) overall = 0.9;
  if (!hasTime) overall = weak ? 0.5 : 0.62;
  if (weak && !explicitReminderRequest) overall = Math.min(overall, 0.58);
  if (negatedReminderRequest) overall = Math.min(overall, 0.55);
  if (ambiguityFlags.includes('multiple_commitments')) overall = Math.min(overall, 0.55);

  return {
    type: 'task',
    action: action || null,
    title: action || raw,
    person: null,
    dueAt: parsedTime.dueAt,
    remindAt: parsedTime.remindAt,
    localTimeSpec: parsedTime.localTimeSpec,
    timeEvidence: parsedTime.evidence,
    dateInferred: parsedTime.dateInferred,
    priority,
    flexibility: weak ? 'soft' : 'movable',
    ...NO_CATEGORY,
    confidence: confidence(overall, actionConfidence, parsedTime.confidence),
    missingFields,
    ambiguityFlags,
    explicitReminderRequest,
    explicitPressureRequest,
    rawText: raw,
    // «الساعة 5» is a time to do it at, «قبل الخميس» a limit (CL1, D2).
    // The month's end is always a limit (FX3).
    timeAnchor: allDay ? 'deadline' : timeAnchorOf(raw),
    ...(allDay ? { allDay: true } : {}),
    parserVersion: PARSER_VERSION,
  };
}

/**
 * How many distinct clock times the raw text names.
 *
 * The extractor reads a time with `String.match` against a non-global regex,
 * which returns the first match and silently discards the rest. A sentence
 * carrying three times can therefore produce one commitment that looks
 * complete, and the confidence policy — which only ever sees that one
 * result — reports no clarification needed.
 *
 * It reads `RANGE_PATTERN_SOURCES` and `CLOCK_PATTERN_SOURCES`, the same lists
 * `stripTiming` removes from a title, so the counter and the parser cannot
 * disagree about what a time looks like.
 */
export function countTimeExpressions(raw: string): number {
  if (typeof raw !== 'string' || !raw.trim()) return 0;
  // Count what the parser reads: «الساعة تسعة» and «בשעה תשע» both become 9,
  // «5 ونص» becomes 5:30.
  const text = normalizeClockText(raw);

  // Count positions, not matches: two patterns can describe the same mention
  // ("at 9am" matches both the am-suffixed and the bare-hour shape), and
  // counting each would invent a time the sentence never had.
  const covered = new Set<number>();

  // Pass 1: a range counts once, at its first digit, and claims its span.
  const spans: Array<readonly [number, number]> = [];
  forEachTimeMention(RANGE_PATTERN_SOURCES, text, (start, end, digitAt) => {
    spans.push([start, end]);
    covered.add(digitAt);
  });

  // Pass 2: clock times, except the start and end already inside a range.
  forEachTimeMention(CLOCK_PATTERN_SOURCES, text, (_start, _end, digitAt) => {
    if (!spans.some(([start, end]) => digitAt >= start && digitAt < end)) covered.add(digitAt);
  });
  return covered.size;
}

/**
 * The clock times the raw text names, as the numbers written — `{ hour: 4 }`
 * for «الساعة ٤ العصر», before any meridiem is applied.
 *
 * Found exactly where `countTimeExpressions` finds them (the same normalising
 * and the same two pattern lists), so a caller asking "is this hour written
 * here?" (the meeting prep's follow-ups, CL5a M-3) and the counter cannot
 * disagree about what a time looks like. A range gives its first time.
 */
export function clockTimesIn(raw: string): Array<{ hour: number; minute: number }> {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const text = normalizeSpokenHours(normalizeArabicDigits(raw));
  const at = new Set<number>();
  forEachTimeMention(RANGE_PATTERN_SOURCES, text, (_start, _end, digitAt) => at.add(digitAt));
  forEachTimeMention(CLOCK_PATTERN_SOURCES, text, (_start, _end, digitAt) => at.add(digitAt));
  return Array.from(at).sort((left, right) => left - right).flatMap((digitAt) => {
    const clock = /^(\d{1,2})(?::(\d{2}))?/.exec(text.slice(digitAt));
    return clock ? [{ hour: Number(clock[1]), minute: clock[2] ? Number(clock[2]) : 0 }] : [];
  });
}

function forEachTimeMention(
  sources: readonly string[],
  text: string,
  visit: (start: number, end: number, digitAt: number) => void,
): void {
  for (const source of sources) {
    const pattern = new RegExp(source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      // A zero-width match would spin forever; step past it.
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      // Anchor on where the digits sit, so overlapping shapes of one mention
      // collapse onto a single position.
      const digitOffset = match[0].search(/[0-9٠-٩۰-۹]/);
      if (digitOffset < 0) continue;
      visit(match.index, match.index + match[0].length, match.index + digitOffset);
    }
  }
}
