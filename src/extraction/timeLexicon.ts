/**
 * What a time looks like, in Arabic, Hebrew and English (UC-2.2, #162).
 *
 * One lexicon, read by both engines. The rule-based extractor uses it to parse;
 * the schema validator uses it to *police the model* — and those two have to
 * agree about what counts as a stated time, or the same sentence means two
 * things depending on which engine happened to answer.
 *
 * ── Why evidence, and not a boolean ──────────────────────────────
 *
 * "Did the user state a time" and "which of the two possible clocks did they
 * mean" are different questions, and collapsing them is what made #162's own
 * acceptance criteria contradict each other. So a time carries the *reason* it
 * was believed:
 *
 *   hhmm         `14:00` — a 24-hour clock. Unambiguous.
 *   ampm         `7 PM`, `٧ مساءً` — a 12-hour clock, disambiguated.
 *   daypart      "tomorrow morning", «بكرة الصبح», «מחר בערב» — a named part
 *                of the day. The hour is the product's, but the *period* is
 *                the user's, so it is not invented.
 *   clock_marker «الساعة 5», "at 9" — marked as a clock time, but with no
 *                AM/PM and an hour that could be either. Believed, and
 *                flagged: the number is the user's, the meridiem is a guess.
 *   day_only     "tomorrow" with no time of day at all. A time here would be
 *                entirely the product's invention.
 *   none         no temporal expression whatsoever.
 *
 * `day_only` and `none` are the two that must never carry a time. That is the
 * "no invented time" rule, and it is enforced in code rather than asked for in
 * a prompt.
 *
 * ── Hebrew is here on purpose ────────────────────────────────────
 *
 * The rule-based date parser reads no Hebrew — «מחר» matches nothing in it — so
 * Hebrew captures came back with a null time and looked correct. They were
 * correct by accident: nothing had read the sentence. The model *does* read
 * Hebrew, and this lexicon is what checks its answer, so «בשעה» and the Hebrew
 * dayparts belong here even though the rules engine cannot use them yet.
 * Without them the guard would strip a perfectly good time out of
 * «מחר בערב אני צריך להתקשר» and Hebrew users would lose every evening
 * reminder.
 */

/** Why a time was believed. Ordered weakest to strongest. */
export type TimeEvidence = 'none' | 'day_only' | 'clock_marker' | 'daypart' | 'ampm' | 'hhmm';

/** Digits as three scripts write them. */
export function normalizeArabicDigits(value: string): string {
  const arabic = '٠١٢٣٤٥٦٧٨٩';
  const persian = '۰۱۲۳۴۵۶۷۸۹';
  return value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const arabicIndex = arabic.indexOf(digit);
    if (arabicIndex !== -1) return String(arabicIndex);
    return String(persian.indexOf(digit));
  });
}

/**
 * Hours as people say them, not as they type them. Speech-to-text hands us
 * «الساعة تسعة»; only digits used to parse, so every spoken time was dropped.
 * Longest-first so «إحدى عشرة» is not eaten by «إحدى».
 */
export const ARABIC_SPOKEN_HOURS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:ال)?(?:حادية|إحدى|احدى)\s*عشرة?|احدعش/g, '11'],
  [/(?:ال)?(?:ثانية|اثنتا|اثنتي|تانية)\s*عشرة?|اتناش|اثناش/g, '12'],
  [/(?:ال)?(?:واحدة|وحدة)/g, '1'],
  [/(?:ال)?(?:ثانية|اثنين|إثنين|تنتين|ثنتين|تانية)/g, '2'],
  [/(?:ال)?(?:ثالثة|ثلاثة|تلاتة|تالتة)/g, '3'],
  [/(?:ال)?(?:رابعة|أربعة|اربعة)/g, '4'],
  [/(?:ال)?(?:خامسة|خمسة)/g, '5'],
  [/(?:ال)?(?:سادسة|ستة)/g, '6'],
  [/(?:ال)?(?:سابعة|سبعة)/g, '7'],
  [/(?:ال)?(?:ثامنة|ثمانية|تمانية|تامنة)/g, '8'],
  [/(?:ال)?(?:تاسعة|تسعة)/g, '9'],
  [/(?:ال)?(?:عاشرة|عشرة)/g, '10'],
];

export function normalizeSpokenArabicHours(value: string): string {
  // Only rewrite where a clock is actually being named, so «الفصل الثالث»
  // (a chapter) keeps its word and only «الساعة الثالثة» becomes a number.
  return value.replace(
    /((?:الساعة|الساعه|عند|على)\s*)([^\s,.،]+(?:\s+عشرة?)?)/g,
    (match, lead: string, word: string) => {
      for (const [pattern, digit] of ARABIC_SPOKEN_HOURS) {
        pattern.lastIndex = 0;
        if (new RegExp(`^(?:${pattern.source})$`).test(word)) return `${lead}${digit}`;
      }
      return match;
    }
  );
}

/**
 * Spoken Hebrew hours (#512). Speech-to-text hands us «בשעה תשע», never «בשעה 9».
 * Longest-first so «אחת עשרה» is not eaten by «אחת».
 */
export const HEBREW_SPOKEN_HOURS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:ה)?(?:אחת|אחד)\s*[-־]?\s*עשר(?:ה)?/g, '11'],
  [/(?:ה)?(?:שתים|שתיים|שנים|שניים)\s*[-־]?\s*עשר(?:ה)?/g, '12'],
  [/(?:ה)?(?:אחת|אחד|ראשונה)/g, '1'],
  [/(?:ה)?(?:שתים|שתיים|שנים|שניים|שנייה|שניה)/g, '2'],
  [/(?:ה)?(?:שלוש|שלש|שלושה|שלשה|שלישית)/g, '3'],
  [/(?:ה)?(?:ארבע|ארבעה|רביעית)/g, '4'],
  [/(?:ה)?(?:חמש|חמישה|חמישית)/g, '5'],
  [/(?:ה)?(?:שש|שישה|ששה|שישית)/g, '6'],
  [/(?:ה)?(?:שבע|שבעה|שביעית)/g, '7'],
  [/(?:ה)?(?:שמונה|שמינית)/g, '8'],
  [/(?:ה)?(?:תשע|תשעה|תשיעית)/g, '9'],
  [/(?:ה)?(?:עשר|עשרה|עשירית)/g, '10'],
];

export function normalizeSpokenHebrewHours(value: string): string {
  // Only rewrite where a clock is actually being named, so «שלוש משימות»
  // (three tasks) keeps its word and only «בשעה שלוש» or «שעה שלוש» becomes a number.
  return value.replace(
    /((?:בשעה|שעה|בסביבות(?:\s+ה?שעה)?|סביב(?:\s+ה?שעה)?|לקראת(?:\s+ה?שעה)?|עד(?:\s+ה?שעה)?)\s*)([^\s,.،]+(?:\s+[-־]?\s*עשר(?:ה)?)?)/g,
    (match, lead: string, word: string) => {
      for (const [pattern, digit] of HEBREW_SPOKEN_HOURS) {
        pattern.lastIndex = 0;
        if (new RegExp(`^(?:${pattern.source})$`).test(word)) {
          return `${lead}${digit}`;
        }
      }
      return match;
    }
  );
}

/**
 * What a single clock time looks like. `stripTiming` removes these from a
 * title and `countTimeExpressions` counts them; both read this one list, so
 * the two cannot drift apart. Stored as sources: every caller builds a fresh
 * RegExp, because a shared global regex carries `lastIndex` between calls.
 */
export const CLOCK_PATTERN_SOURCES: readonly string[] = [
  /\b(?:at|by|around)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/.source,
  /\b(?:at|by|around)\s*\d{1,2}(?::\d{2})?(?=$|[\s,.،])/.source,
  /\b\d{1,2}:\d{2}(?=$|[\s,.،])/.source,
  /(?:الساعة|الساعه|عند|على)?\s*[0-9٠-٩۰-۹]{1,2}(?::[0-9٠-٩۰-۹]{2})?\s*(?:صباحا|صباحاً|الصبح|ص|مساء|مساءً|المسا|المساء|بالليل|م)(?=$|[\s,.،])/.source,
  /(?:الساعة|الساعه|عند|على)\s*[0-9٠-٩۰-۹]{1,2}(?::[0-9٠-٩۰-۹]{2})?(?=$|[\s,.،])/.source,
  /(?:בשעה|שעה|בסביבות(?:\s+ה?שעה)?|סביב(?:\s+ה?שעה)?|לקראת(?:\s+ה?שעה)?|עד(?:\s+ה?שעה)?|[בס]-?)?\s*[0-9]{1,2}(?::[0-9]{2})?\s*(?:בבוקר|בוקר|בצהריים|צהריים|אחרי הצהריים|אחה"צ|בערב|ערב|בלילה|לילה)(?=$|[\s,.،])/.source,
  /(?:בשעה|שעה|בסביבות(?:\s+ה?שעה)?|סביב(?:\s+ה?שעה)?|לקראת(?:\s+ה?שעה)?|עד(?:\s+ה?שעה)?|[בס]-)\s*[0-9]{1,2}(?::[0-9]{2})?(?=$|[\s,.،])/.source,
];

/**
 * A start-to-end range is one appointment, not two times. English
 * "from 14:00 to 15:00" / "from 2pm to 3pm", and Arabic «من الساعة 2 للساعة 4»,
 * where «ل» fuses with «الساعة» into «للساعة».
 */
export const RANGE_PATTERN_SOURCES: readonly string[] = [
  /\bfrom\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s+(?:to|until|till|-)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/.source,
  /(?<![؀-ۿ])من\s*(?:الساعة|الساعه)?\s*[0-9٠-٩۰-۹]{1,2}(?::[0-9٠-٩۰-۹]{2})?\s*(?:إلى|الى|حتى|لـ?)\s*(?:ال|ل)?(?:ساعة|ساعه)?\s*[0-9٠-٩۰-۹]{1,2}(?::[0-9٠-٩۰-۹]{2})?/.source,
  /(?:מ|משעה|בין)\s*[0-9]{1,2}(?::[0-9]{2})?\s*(?:עד|עד שעה|ל|ל-|עד ל-)\s*(?:שעה\s*)?[0-9]{1,2}(?::[0-9]{2})?/.source,
];

/** A 24-hour clock: `14:00`. Unambiguous by construction. */
const HHMM = /\b\d{1,2}:\d{2}(?=$|[\s,.،])/;

/** An explicit meridiem, in any of the three languages. */
const AMPM = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|[0-9]{1,2}(?::[0-9]{2})?\s*(?:صباحا|صباحاً|ص|مساءً|مساء|م)(?=$|[\s,.،])/i;

/**
 * A named part of the day. The hour the product picks for it is the product's,
 * but the *period* is the user's — "tomorrow evening" is not an invented time,
 * it is a coarse one.
 */
const DAYPART = new RegExp(
  [
    /\b(?:morning|noon|midday|afternoon|evening|tonight|night|midnight)\b/.source,
    /الصبح|صباحا|صباحاً|صباح|الضهر|الظهر|بعد الظهر|بعد الضهر|العصر|المسا|المساء|مساءً|مساء|بالليل|الليل|منتصف الليل/.source,
    /בבוקר|בוקר|בצהריים|צהריים|אחרי הצהריים|אחה"צ|בערב|ערב|בלילה|לילה|חצות/.source,
  ].join('|'),
  'i',
);

/**
 * The number is being named as a clock time — but with no meridiem.
 * «الساعة 5», "at 9", «בשעה 8». Believed, and flagged.
 */
const CLOCK_MARKER = new RegExp(
  [
    /\b(?:at|by|around)\s*\d{1,2}(?::\d{2})?(?=$|[\s,.،])/.source,
    /\b\d{1,2}\s*o'?clock\b/.source,
    /(?:الساعة|الساعه|عند|على)\s*[0-9]{1,2}(?::[0-9]{2})?(?=$|[\s,.،])/.source,
    /(?:בשעה|שעה|בסביבות(?:\s+ה?שעה)?|סביב(?:\s+ה?שעה)?|לקראת(?:\s+ה?שעה)?|עד(?:\s+ה?שעה)?|[בס]-)\s*[0-9]{1,2}(?::[0-9]{2})?(?=$|[\s,.،])/.source,
  ].join('|'),
  'i',
);

/**
 * A day, without any time of day. English, Arabic and Hebrew.
 *
 * Only used to tell `day_only` from `none`; both refuse a time, so a miss here
 * is not a safety hole — it changes which reason is reported, not whether the
 * time survives.
 */
const DAY_TOKEN = new RegExp(
  [
    /\b(?:today|tomorrow|tonight|day after tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday|next week|this week)\b/.source,
    /اليوم|النهارده|اليومه|بكرا|بكرة|غدا|غداً|بعد بكرا|بعد بكرة|بعد غد|الأحد|الاحد|الاثنين|الإثنين|الأثنين|الثلاثاء|الثلثاء|الأربعاء|الاربعاء|الخميس|الجمعة|السبت/.source,
    /מחר|מחרתיים|היום|הערב|יום ראשון|יום שני|יום שלישי|יום רביעי|יום חמישי|יום שישי|שבת/.source,
  ].join('|'),
  'i',
);

/**
 * The strongest time-of-day evidence the text carries.
 *
 * Deliberately about the *time of day*, not the date. "Tomorrow" is a date, and
 * a date with no hour is exactly the case that used to silently become 18:00.
 */
export function timeOfDayEvidence(rawText: string): TimeEvidence {
  if (typeof rawText !== 'string' || !rawText.trim()) return 'none';
  const text = normalizeSpokenHebrewHours(normalizeSpokenArabicHours(normalizeArabicDigits(rawText)));
  if (HHMM.test(text)) return 'hhmm';
  if (AMPM.test(text)) return 'ampm';
  if (DAYPART.test(text)) return 'daypart';
  if (CLOCK_MARKER.test(text)) return 'clock_marker';
  if (DAY_TOKEN.test(text)) return 'day_only';
  return 'none';
}

/**
 * True when a time must not survive: the text names no time of day at all.
 *
 * `day_only` is included on purpose. It is the case the product got wrong for
 * the longest — "remind me tomorrow" resolved to 18:00 at confidence 0.9, with
 * no ambiguity flag, which is high enough to auto-confirm. The user never said
 * six in the evening.
 */
export function forbidsResolvedTime(rawText: string): boolean {
  const evidence = timeOfDayEvidence(rawText);
  return evidence === 'none' || evidence === 'day_only';
}

/**
 * A word that makes a stated time a limit rather than an appointment (CL1, D2):
 * "by 5", "before Thursday", «قبل الخميس», «لحد الساعة 5», «עד 17:00».
 * Whole words only, so «قبلها» and "abyss" are not read as one.
 */
const DEADLINE_MARKER = new RegExp(
  [
    /\b(?:by|before|until|till|til|due|deadline|no\s+later\s+than)\b/.source,
    '(?<![\\p{L}\\p{M}])(?:قبل|لحد|لحدّ|لغاية|لغايه|حتى|حتّى|أقصاه|اقصاه)(?![\\p{L}\\p{M}])',
    '(?<![\\p{L}\\p{M}])(?:עד|לפני|לא\\s+יאוחר)(?![\\p{L}\\p{M}])',
  ].join('|'),
  'iu',
);

/**
 * What a stated time is to the person: the time to do it at, or a limit.
 *
 * `event` — a clock time with nothing making it a limit: «أشتري دوا … الساعة
 * 5», "buy medicine at 5pm", «לקנות תרופה ב-17:00». The user means to do it
 * then, so the planner must keep it there. Capture wrote every one of these as
 * a `due_by`, which the planner reads as a deadline and floats ahead of — the
 * medicine landed at 15:30.
 *
 * `deadline` — a limit word anywhere in the text: "by 5pm", «قبل الخميس الساعة
 * 5», «עד 17:00». Anywhere rather than next to the time on purpose: a deadline
 * is what capture always wrote, so a stray «قبل» costs nothing but the old
 * behaviour.
 *
 * `null` — no clock time at all: a day, or a part of the day ("tomorrow
 * evening"), which is a window, not a time to be at. Also the old behaviour.
 *
 * A range ("from 2 to 4", «من الساعة 2 للساعة 4») is an event even though
 * "to"/«حتى»/«עד» appear in it: it has a start.
 */
export function timeAnchorOf(rawText: string): 'event' | 'deadline' | null {
  if (typeof rawText !== 'string' || !rawText.trim()) return null;
  const text = normalizeSpokenHebrewHours(normalizeSpokenArabicHours(normalizeArabicDigits(rawText)));
  if (RANGE_PATTERN_SOURCES.some((source) => new RegExp(source, 'i').test(text))) return 'event';
  if (DEADLINE_MARKER.test(text)) return 'deadline';
  return CLOCK_PATTERN_SOURCES.some((source) => new RegExp(source, 'i').test(text)) ? 'event' : null;
}

/**
 * The hour a named daypart means, or null when the text names none.
 *
 * Checked in the order a longer phrase must beat a shorter one: "bعد الظهر"
 * contains «الظهر», and "אחרי הצהריים" contains «צהריים».
 */
export function dayPartHour(rawText: string): number | null {
  const text = rawText.toLowerCase();
  if (/\bmidnight\b|منتصف الليل|חצות/.test(text)) return 0;
  if (/\bafternoon\b|بعد الظهر|بعد الضهر|العصر|אחרי הצהריים|אחה"צ/.test(text)) return 14;
  if (/\bmorning\b|الصبح|صباحا|صباحاً|صباح|בבוקר|בוקר/.test(text)) return 9;
  if (/\b(?:noon|midday)\b|الضهر|الظهر|בצהריים|צהריים/.test(text)) return 12;
  if (/\btonight\b|\bnight\b|بالليل|الليل|בלילה|לילה/.test(text)) return 20;
  if (/\bevening\b|المسا|المساء|مساءً|مساء|בערב|ערב/.test(text)) return 18;
  return null;
}

/** The wall-clock offset of a zone at an instant, in milliseconds. */
function tzOffsetMs(date: Date, timeZone: string): number {
  if (timeZone === 'UTC' || timeZone === 'Etc/UTC') return 0;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(date);
  const name = parts.find((part) => part.type === 'timeZoneName')?.value || 'GMT';
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 3_600 + Number(match[3]) * 60) * 1_000;
}

/**
 * The instant a local `YYYY-MM-DD` + `HH:MM` names in a zone.
 *
 * Two passes: the first guess is read as if the wall clock were UTC, then the
 * zone's offset *at that guess* is removed. A single pass picks the wrong side
 * of a DST boundary, which is a one-hour error twice a year.
 */
export function instantFromLocal(date: string, time: string, timeZone: string): Date | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const clock = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!day || !clock) return null;
  const hour = Number(clock[1]);
  const minute = Number(clock[2]);
  if (hour > 23 || minute > 59) return null;
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date());
  } catch {
    // An unusable zone is not a reason to invent an instant from it.
    return null;
  }
  const guess = new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), hour, minute));
  const resolved = new Date(guess.getTime() - tzOffsetMs(guess, zone));
  return Number.isFinite(resolved.getTime()) ? resolved : null;
}

/** How a resolved instant reads on the user's own clock. */
export function localTimeSpecFor(instant: Date, timeZone: string): { date: string; time: string; timezone: string } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(instant);
    const get = (type: string) => parts.find((part) => part.type === type)?.value;
    const [year, month, day, hour, minute] = [get('year'), get('month'), get('day'), get('hour'), get('minute')];
    if (!year || !month || !day || hour === undefined || minute === undefined) return null;
    return { date: `${year}-${month}-${day}`, time: `${hour === '24' ? '00' : hour}:${minute}`, timezone: timeZone };
  } catch {
    return null;
  }
}
