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
  // «إحدعش», «حدعش», «احداعش»; «اتناعش», «اطناعش», «تناعش» (closure UAT r6).
  [/(?:ال)?(?:حادية|إحدى|احدى)\s*عشرة?|[إا]?حدا?عش/g, '11'],
  [/(?:ال)?(?:ثانية|اثنتا|اثنتي|تانية)\s*عشرة?|اتناش|اثناش|[اإ][تثط]نا?عش|[تط]ناعش/g, '12'],
  [/(?:ال)?(?:واحدة|وحدة)/g, '1'],
  [/(?:ال)?(?:ثانية|اثنين|إثنين|اتنين|تنتين|ثنتين|تانية)/g, '2'],
  [/(?:ال)?(?:ثالثة|ثلاثة|تلاتة|تالتة)/g, '3'],
  [/(?:ال)?(?:رابعة|أربعة|اربعة)/g, '4'],
  [/(?:ال)?(?:خامسة|خمسة)/g, '5'],
  [/(?:ال)?(?:سادسة|ستة)/g, '6'],
  [/(?:ال)?(?:سابعة|سبعة)/g, '7'],
  [/(?:ال)?(?:ثامنة|ثمانية|تمانية|تامنة)/g, '8'],
  [/(?:ال)?(?:تاسعة|تسعة)/g, '9'],
  [/(?:ال)?(?:عاشرة|عشرة)/g, '10'],
];

/*
 * The words of a part of the day that can follow a clock hour in Arabic —
 * «5 المسا», «5 بالمسا», «5 عالمسا», «5 العصر», «5 بعد الضهر», «5 الصبح»,
 * «8 بالليل», «5 م» — as one source, read by the clock readers, the title
 * stripper and `hourWithDayPart` alike (closure UAT round 6). No `\p{…}`:
 * the clock patterns are compiled without the `u` flag.
 */
const AR_DAY_PART_AFTER_HOUR =
  '(?:(?:بال|عال|ال)(?:صبح|صباح)(?:\\s+(?:بكير|بدري))?|(?:بال|عال|ال)(?:مساء|مسا|عصر|ضهر|ظهر|ليل)|بعد\\s+(?:الضهر|الظهر)|مساءً|مساء|مسا|صباحاً|صباحا|م|ص)';

/*
 * A part of the day said right *before* its clock hour (FIX-R6-SPOKENHOUR):
 * «المسا ع سبعة», «بالليل ع 10», «בערב בשבע», "evening at seven", "tonight
 * at 7". The clock readers took the hour only after «الساعة»/«בשעה» or right
 * before the part, so the rules read these as the part alone — 18:00, marked
 * «حزرنا الساعة» — although the person said seven. Only with a clock word
 * between (`HOUR_LEAD_AFTER_DAY_PART`): «المسا سبعة» names no clock. Whole
 * words, as the parts of the day are (no `\p{…}`: the clock patterns are
 * compiled without the `u` flag).
 */
const AR_DAY_PART_BEFORE_HOUR =
  '(?:[وف]?(?:بال|عال|هال|ال)(?:صبح|صباح|مساء|مسا|عصر|ضهر|ظهر|ليل|ليلة|ليله)|بعد\\s+(?:الضهر|الظهر)|مساءً|مساء|مسا)';
const HE_DAY_PART_BEFORE_HOUR = '(?:ו?(?:בבוקר|בערב|בלילה|בצהריים|בצהרים|הבוקר|הערב|הלילה)|אחרי\\s+הצהריים|אחר\\s+הצהריים|אחה["״]צ)';
const EN_DAY_PART_BEFORE_HOUR = '(?:morning|afternoon|evening|tonight|night)';
const DAY_PART_BEFORE_HOUR_WORD = `(?:${AR_DAY_PART_BEFORE_HOUR}|${HE_DAY_PART_BEFORE_HOUR}|${EN_DAY_PART_BEFORE_HOUR})`;
// A few spaces at most: read inside lookbehinds, an open `\s+` rescans a
// long run of spaces at every position (quadratic on a pasted blank block).
const DAY_PART_BEFORE_HOUR = `(?<![^\\s,.،])${DAY_PART_BEFORE_HOUR_WORD}\\s{1,3}`;
/** The clock word between the part of the day and its hour: «ع», «على الساعة», «ב», "at". */
const HOUR_LEAD_AFTER_DAY_PART =
  '(?:(?:(?:على|عند|ع)\\s*)?(?:الساعة|الساعه)\\s*|(?:ع|على|عند|حوالي|حوالى)\\s*|(?:בשעה|בסביבות(?:\\s+ה?שעה)?|סביב(?:\\s+ה?שעה)?)\\s*|ב-?|(?:at|around|about)\\s+)';
/** A count after the number is no hour: «المسا ع 3 مرات», "tonight at 3 people". */
const NOT_A_COUNT = '(?!\\s+(?:مرات|مرة|مره|أيام|ايام|يوم|ساعات|دقايق|دقائق|دقيقة|أشخاص|اشخاص|ناس|times|days|hours|minutes|people|פעמים|ימים|שעות|דקות|אנשים))';

/*
 * Spelled hours as said right before a part of the day, with no «الساعة»
 * (closure UAT round 6): «خمسة المسا», «تلاتة بالليل», «إحدعش الصبح». Only the
 * cardinal words: an ordinal there is more often not a clock («المرة التانية
 * المسا»), and «الساعة الخامسة» is read above.
 */
const ARABIC_CARDINAL_HOURS: ReadonlyArray<readonly [string, string]> = [
  ['[إا]?حدا?عش|(?:إحدى|احدى)\\s+عشرة?', '11'],
  ['[اإ][تثط]نا?عش|[تط]ناعش|اتناش|اثناش|(?:اثنتا|اثنتي)\\s+عشرة?', '12'],
  ['واحدة|وحدة', '1'],
  ['اتنين|اثنين|إثنين|تنتين|ثنتين', '2'],
  ['ثلاثة|تلاتة', '3'],
  ['أربعة|اربعة', '4'],
  ['خمسة', '5'],
  ['ستة', '6'],
  ['سبعة', '7'],
  ['ثمانية|تمانية', '8'],
  ['تسعة', '9'],
  ['عشرة', '10'],
];
const AR_CARDINAL_WORDS = ARABIC_CARDINAL_HOURS.map(([words]) => words).join('|');
const AR_FRACTION_AFTER_HOUR = '(?:\\s*(?:و\\s*)?(?:نص|نصف|ربع|ثلث|تلت)|\\s*(?:إلا|الا|إلّا)\\s*(?:ربع|ثلث|تلت))';
const AR_CARDINAL_HOUR = new RegExp(
  // «ع سبعة المسا», and «عالسبعة المسا» / «ع السبعة المسا» with the article (FIX-R6-SPOKENHOUR)
  `(^|[\\s,.،])(عال|ع\\s*ال|ال)?(${AR_CARDINAL_WORDS})`
    // a spoken fraction may sit between: «خمسة ونص المسا», «سبعة إلا ربع الصبح»
    + `(?=${AR_FRACTION_AFTER_HOUR}?\\s+${AR_DAY_PART_AFTER_HOUR}(?=$|[\\s,.،])`
    // and «سبعة إلا ربع» is a clock by itself: a quarter to seven is no count
    + `|\\s*(?:إلا|الا|إلّا)\\s*(?:ربع|ثلث|تلت)(?=$|[\\s,.،]))`,
  'g',
);
/*
 * A spelled hour after the part of the day and its clock word
 * (FIX-R6-SPOKENHOUR): «المسا ع سبعة», «المسا عالسبعة», «بالليل ع عشرة»,
 * «المسا حوالي سبعة». «ع» is a clock word here only: «أوزع ع سبعة أشخاص» is a count.
 */
const AR_CARDINAL_AFTER_DAY_PART = new RegExp(
  `(?<=${DAY_PART_BEFORE_HOUR})(ع\\s*(?:ال)?|حوالي\\s+|حوالى\\s+)(${AR_CARDINAL_WORDS})(?=${AR_FRACTION_AFTER_HOUR}?(?:$|[\\s,.،]))${NOT_A_COUNT}`,
  'g',
);

function arabicCardinalHour(word: string): string | null {
  return ARABIC_CARDINAL_HOURS.find(([words]) => new RegExp(`^(?:${words})$`).test(word))?.[1] ?? null;
}

/*
 * Cheap gates (FIX-R6-PERF): each reader below needs a letter of its own
 * script, and the English ones "ish" or an hour word, so a text without one is
 * returned as it is instead of being scanned by patterns that cannot match.
 */
const ANY_ARABIC_LETTER = /[\u0600-\u06FF]/;
const ANY_HEBREW_LETTER = /[\u0590-\u05FF]/;

export function normalizeSpokenArabicHours(value: string): string {
  if (!ANY_ARABIC_LETTER.test(value)) return value;
  const beforeDayPart = value
    // «عالسبعة المسا» is «7 المسا»: the clock word goes with the article.
    .replace(AR_CARDINAL_HOUR, (match, lead: string, _article: string | undefined, word: string) => {
      const hour = arabicCardinalHour(word);
      return hour ? `${lead}${hour}` : match;
    })
    .replace(AR_CARDINAL_AFTER_DAY_PART, (match, lead: string, word: string) => {
      const hour = arabicCardinalHour(word);
      return hour ? `${lead.startsWith('ع') ? 'ع ' : lead}${hour}` : match;
    });
  // Only rewrite where a clock is actually being named, so «الفصل الثالث»
  // (a chapter) keeps its word and only «الساعة الثالثة» becomes a number.
  // «على الساعة سبعة» / «ع الساعة سبعة» whole: taking «على» as the clock word
  // read «الساعة» as its hour, and the seven was never seen (FIX-R6-SPOKENHOUR).
  return beforeDayPart.replace(
    /((?:(?:على|عند|ع)\s*)?(?:الساعة|الساعه)\s*|(?:عند|على)\s*)([^\s,.،]+(?:\s+عشرة?)?)/g,
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

/**
 * «בשתיים בלילה», «בחמש בבוקר», «בשש בערב» (FZ1 review, M5b): «ב» + a spoken
 * hour right before a part of the day is a clock time too, written «ב-2» so
 * the clock readers see it. Only there: «בשלוש דקות» is not three o'clock.
 */
const HE_HOUR_BEFORE_DAY_PART = new RegExp('(^|[\\s,.،])ב((?:[^\\s,.،]+)(?:\\s+[-־]?\\s*עשר(?:ה)?)?)(?=\\s+(?:בלילה|בבוקר|בערב|בצהריים|בצהרים|אחרי\\s+הצהריים|אחה["״]צ|לפנות\\s+בוקר)(?![\\p{L}]))', 'gu');

/** «בערב בשבע», «הערב בשבע» (FIX-R6-SPOKENHOUR): the same «ב» + hour right *after* the part of the day. */
const HE_HOUR_AFTER_DAY_PART = new RegExp(`(?<=${DAY_PART_BEFORE_HOUR})ב([^\\s,.،]+(?:\\s+[-־]?\\s*עשר(?:ה)?)?)(?=$|[\\s,.،])${NOT_A_COUNT}`, 'gu');

function hebrewSpokenHour(word: string): string | null {
  for (const [pattern, digit] of HEBREW_SPOKEN_HOURS) {
    pattern.lastIndex = 0;
    if (new RegExp(`^(?:${pattern.source})$`).test(word)) return digit;
  }
  return null;
}

export function normalizeSpokenHebrewHours(value: string): string {
  if (!ANY_HEBREW_LETTER.test(value)) return value;
  // Only rewrite where a clock is actually being named, so «שלוש משימות»
  // (three tasks) keeps its word and only «בשעה שלוש» or «שעה שלוש» becomes a number.
  const beforeDayPart = value
    .replace(HE_HOUR_BEFORE_DAY_PART, (match, lead: string, word: string) => {
      const digit = hebrewSpokenHour(word);
      return digit ? `${lead}ב-${digit}` : match;
    })
    .replace(HE_HOUR_AFTER_DAY_PART, (match, word: string) => {
      const digit = hebrewSpokenHour(word);
      return digit ? `ב-${digit}` : match;
    });
  return beforeDayPart.replace(
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

const EN_HOUR_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const EN_HOUR_WORD = `(?:${EN_HOUR_WORDS.join('|')})`;
const EN_DAY_PART_AFTER_HOUR = '(?:in\\s+the\\s+(?:morning|afternoon|evening)|at\\s+night|tonight)';
const enHour = (word: string) => (/^\d+$/.test(word) ? String(Number(word)) : String(EN_HOUR_WORDS.indexOf(word.toLowerCase()) + 1));
/**
 * "at 7ish", "evening 7ish", "7ish in the evening": about seven, said as
 * "around 7". With a clock word or beside its part of the day only: "7ish
 * people" is a count.
 */
// One separator at most («7ish», «7 ish», «7-ish»): two `\s*` around a dash backtrack quadratically on a run of spaces.
const EN_ISH_SOURCE = `(\\d{1,2}|${EN_HOUR_WORD})[\\s-]?ish\\b`;
const EN_ISH = new RegExp(
  `\\b(at|by|around|about)\\s+${EN_ISH_SOURCE}|(?<=\\b${EN_DAY_PART_BEFORE_HOUR}\\s{1,3})()${EN_ISH_SOURCE}|\\b()${EN_ISH_SOURCE}(?=\\s+${EN_DAY_PART_AFTER_HOUR}\\b)`,
  'gi',
);
/** The gates: every "7ish" says "ish", and every spelled hour is one of the hour words. */
const EN_ISH_WORD = /ish/i;
const EN_ANY_HOUR_WORD = new RegExp(EN_HOUR_WORD, 'i');
/** "at seven in the evening", "at seven tonight": a spoken hour right before its part of the day. */
const EN_WORD_BEFORE_DAY_PART = new RegExp(`\\b(at|around|about)\\s+(${EN_HOUR_WORD})(?=\\s+${EN_DAY_PART_AFTER_HOUR}\\b)`, 'gi');
/** "evening at seven", "tonight at seven": a spoken hour right after its part of the day. */
const EN_WORD_AFTER_DAY_PART = new RegExp(`(?<=\\b${EN_DAY_PART_BEFORE_HOUR}\\s{1,3})(at|around|about)\\s+(${EN_HOUR_WORD})\\b(?=$|[\\s,.!?])${NOT_A_COUNT}`, 'gi');

/**
 * English hours as said (FIX-R6-SPOKENHOUR). "7ish" is "around 7" — the hour
 * itself, as «حوالي 5 المسا» and "about 5 in the evening" are (FZ1 round 4),
 * not a guess to mark. A spelled hour is a number only beside its part of the
 * day — "evening at seven", "at seven tonight" — so "about seven people"
 * stays a count.
 */
export function normalizeSpokenEnglishHours(value: string): string {
  const aboutHour = EN_ISH_WORD.test(value)
    ? value.replace(EN_ISH, (...groups: Array<string | undefined>) => {
      const lead = groups[1] ?? groups[3] ?? groups[5];
      const hour = (groups[2] ?? groups[4] ?? groups[6])!;
      return `${lead && lead.toLowerCase() !== 'at' ? lead : 'around'} ${enHour(hour)}`;
    })
    : value;
  if (!EN_ANY_HOUR_WORD.test(aboutHour)) return aboutHour;
  return aboutHour
    .replace(EN_WORD_BEFORE_DAY_PART, (_, lead: string, hour: string) => `${lead} ${enHour(hour)}`)
    .replace(EN_WORD_AFTER_DAY_PART, (_, lead: string, hour: string) => `${lead} ${enHour(hour)}`);
}

/** The hours as spoken in the three languages, written as numbers where a clock is named. */
export function normalizeSpokenHours(value: string): string {
  return normalizeSpokenEnglishHours(normalizeSpokenHebrewHours(normalizeSpokenArabicHours(value)));
}

/*
 * The fraction patterns, built once (FIX-R6-PERF): every clock reader runs
 * this on every capture, several times over, and building and compiling
 * two dozen `u`-flag patterns per call was most of a cold capture's cost.
 * `String.prototype.replace` starts a global pattern from 0 every time, so a
 * shared one carries nothing from one call to the next.
 */
const FRACTION_DIGIT = '([0-9\\u0660-\\u0669\\u06F0-\\u06F9]{1,2})';
/** Any digit a clock or fraction pattern can read, ASCII or Arabic-Indic. */
const ANY_CLOCK_DIGIT = /[0-9\u0660-\u0669\u06F0-\u06F9]/;

/**
 * The text has a digit a clock pattern could read (FIX-R6-PERF). Every range
 * and clock pattern here — `RANGE_PATTERN_SOURCES`, `CLOCK_PATTERN_SOURCES`,
 * `CLOCK_WITH_PERIOD_SOURCES` — reads at least one, so a text without one is
 * no clock to any of them, and a reader can skip them all.
 */
export function hasClockDigit(value: string): boolean {
  return ANY_CLOCK_DIGIT.test(value);
}
// A fraction is a clock time only where a clock is being named: after a
// clock word, or before a part of the day. «3 ونص كيلو رز» and
// «150 ونص شيكل» are quantities and keep their words.
const FRACTION_LEAD =
  `((?:الساعة|الساعه|عند|على)\\s*|(?<=${DAY_PART_BEFORE_HOUR})(?:ع|حوالي|حوالى)\\s*|\\b(?:at|by|around)\\s+|(?:בשעה|שעה|בסביבות|סביב|לקראת|עד)\\s*|(?<![\\p{L}\\p{M}])ב-?)`;
const FRACTION_PERIOD =
  '(?=\\s*(?:صباحا|صباحاً|الصبح|مساء|مساءً|المسا|المساء|بالليل|بعد\\s+الضهر|بعد\\s+الظهر|العصر|am|pm|בבוקר|בצהריים|אחרי\\s+הצהריים|בערב|בלילה)(?![\\p{L}\\p{M}]))';
const fractionHourOf = (digits: string) => Number(normalizeArabicDigits(digits));
const fractionBefore = (digits: string, minutes: string) => {
  const hour = fractionHourOf(digits);
  return `${hour === 1 ? 12 : hour - 1}:${minutes}`;
};
type FractionRewrite = readonly [RegExp, (digits: string) => string, boolean];
/** A fraction in a clock: after its clock word (the lead is kept), and before a part of the day. */
const inClockFraction = (fraction: string, toClock: (digits: string) => string): FractionRewrite[] => [
  [new RegExp(`${FRACTION_LEAD}${FRACTION_DIGIT}${fraction}(?![\\p{L}\\p{M}])`, 'giu'), toClock, true],
  [new RegExp(`(?<![\\d:\\p{L}\\p{M}])${FRACTION_DIGIT}${fraction}${FRACTION_PERIOD}`, 'giu'), toClock, false],
];
/** In order: each rewrite reads the text the one before it left. */
const FRACTION_REWRITES: readonly FractionRewrite[] = [
  ...inClockFraction('\\s*(?:و\\s*)?(?:نص|نصف)', (d) => `${fractionHourOf(d)}:30`),
  ...inClockFraction('\\s*(?:و\\s*)?ربع', (d) => `${fractionHourOf(d)}:15`),
  ...inClockFraction('\\s*(?:و\\s*)?(?:ثلث|تلت)', (d) => `${fractionHourOf(d)}:20`),
  ...inClockFraction('\\s*(?:إلا|الا|إلّا)\\s*ربع', (d) => fractionBefore(d, '45')),
  ...inClockFraction('\\s*(?:إلا|الا|إلّا)\\s*(?:ثلث|تلت)', (d) => fractionBefore(d, '40')),
  // «7 إلا ربع» names a clock by itself: a quarter to seven is no count (FIX-R6-SPOKENHOUR).
  [new RegExp(`(?<![\\d:\\p{L}\\p{M}])${FRACTION_DIGIT}\\s*(?:إلا|الا|إلّا)\\s*ربع(?![\\p{L}\\p{M}])`, 'giu'), (d) => fractionBefore(d, '45'), false],
  [new RegExp(`(?<![\\d:\\p{L}\\p{M}])${FRACTION_DIGIT}\\s*(?:إلا|الا|إلّا)\\s*(?:ثلث|تلت)(?![\\p{L}\\p{M}])`, 'giu'), (d) => fractionBefore(d, '40'), false],
  ...inClockFraction('\\s*וחצי', (d) => `${fractionHourOf(d)}:30`),
  ...inClockFraction('\\s*ורבע', (d) => `${fractionHourOf(d)}:15`),
  ...inClockFraction('\\s*פחות\\s*רבע', (d) => fractionBefore(d, '45')),
  // "half past 5" and "quarter to 5" name a clock by themselves.
  [new RegExp(`\\bhalf\\s+past\\s+${FRACTION_DIGIT}\\b`, 'giu'), (d) => `${fractionHourOf(d)}:30`, false],
  [new RegExp(`\\b(?:a\\s+)?quarter\\s+past\\s+${FRACTION_DIGIT}\\b`, 'giu'), (d) => `${fractionHourOf(d)}:15`, false],
  [new RegExp(`\\b(?:a\\s+)?quarter\\s+to\\s+${FRACTION_DIGIT}\\b`, 'giu'), (d) => fractionBefore(d, '45'), false],
];

/**
 * A spoken fraction of the hour, written as minutes (CL1 round 7, I-3):
 * «5 ونص» → 5:30, «5 وربع» → 5:15, «5 إلا ربع» → 4:45; «5 וחצי» → 5:30,
 * «5 פחות רבע» → 4:45; "half past 5" → 5:30, "quarter to 5" → 4:45. Every
 * clock reader — the parser, the evidence, the stated hours, the counter and
 * the title stripper — runs this after the spoken hours, so «الساعة خمسة ونص»
 * is one time of 5:30 to all of them, and the half hour is not lost on the
 * way to the am/pm question.
 */
export function normalizeClockFractions(value: string): string {
  // Every pattern reads a digit: with none there is nothing to rewrite.
  if (!ANY_CLOCK_DIGIT.test(value)) return value;
  let out = value;
  for (const [pattern, toClock, keepsLead] of FRACTION_REWRITES) {
    out = keepsLead
      ? out.replace(pattern, (_, lead: string, d: string) => `${lead}${toClock(d)}`)
      : out.replace(pattern, (_, d: string) => toClock(d));
  }
  return out;
}

/** Every rewrite a clock reader needs, in order: digits, spoken hours, fractions. */
export function normalizeClockText(value: string): string {
  return normalizeClockFractions(normalizeSpokenHours(normalizeSpokenArabicRange(normalizeArabicDigits(value))));
}

/**
 * A spelled Arabic number is clock evidence inside a range only when the
 * range itself ends in an explicit part of day. That narrow context keeps
 * «من أربعة لثمانية أشخاص/مرات/أيام/ساعات/دقايق» as counts, never clocks.
 */
function normalizeSpokenArabicRange(value: string): string {
  if (!ANY_ARABIC_LETTER.test(value)) return value;
  const word = `(?:${AR_CARDINAL_WORDS})`;
  const pattern = new RegExp(
    `(من\\s+)(${word})(\\s*(?:إلى|الى|حتى|لحد|لحدّ|لغاية|لغايه|للغاية|ل)ـ*\\s*)(?:ال)?(${word})(?=\\s+(?:المسا|المساء|مساء|مساءً|الصبح|الصباح|صباحا|صباحاً|العصر|الليل|بالليل|بالمسا|بالصبح))`,
    'gu',
  );
  return value.replace(pattern, (match, lead: string, startWord: string, separator: string, endWord: string) => {
    const start = arabicCardinalHour(startWord);
    const end = arabicCardinalHour(endWord);
    return start && end ? `${lead}${start}${separator}${end}` : match;
  });
}

/**
 * A clock whose hour is marked by the part of the day right after it: «5
 * المسا», «5 العصر», «8 بالليل», «ב-5 בערב», "5 in the evening". The hour is
 * read from the pair (`hourWithDayPart`), so the pair leaves a title
 * together: `stripTiming` takes these before the parts of the day, or «5
 * المسا» would lose «المسا» first and leave «5 لازم أتصل بأمي» (closure UAT
 * round 6).
 */
const AR_CLOCK_WORD = '(?<![\\u0600-\\u06FF])(?:(?:(?:على|عند|ع)\\s*)?(?:الساعة|الساعه)|عند|على|عال)';
const AR_CLOCK_WITH_PERIOD = `(?:${AR_CLOCK_WORD}|(?<![\\u0600-\\u06FF])(?:ع|حوالي|حوالى))?\\s*[0-9٠-٩۰-۹]{1,2}(?::[0-9٠-٩۰-۹]{2})?\\s*${AR_DAY_PART_AFTER_HOUR}(?=$|[\\s,.،])`;
const HE_CLOCK_WITH_PERIOD = /(?:בשעה|שעה|בסביבות(?:\s+ה?שעה)?|סביב(?:\s+ה?שעה)?|לקראת(?:\s+ה?שעה)?|עד(?:\s+ה?שעה)?|[בס]-?)?\s*[0-9]{1,2}(?::[0-9]{2})?\s*(?:בבוקר|בוקר|בצהריים|בצהרים|צהריים|אחרי הצהריים|אחר הצהריים|אחרי הצהרים|אחר הצהרים|אחה["״]צ|בערב|ערב|בלילה|לילה)(?=$|[\s,.،])/.source;
const EN_CLOCK_WITH_PERIOD = /\b(?:(?:at|by|around|about)\s+)?\d{1,2}(?::\d{2})?\s+(?:in\s+the\s+(?:morning|afternoon|evening)|at\s+night|tonight)\b/.source;
/**
 * The part of the day, its clock word and the hour after it: «المسا ع 7»,
 * «בערב ב-7», "evening at 7" (FIX-R6-SPOKENHOUR). One time, taken from a
 * title whole — taking «المسا» first left «ع 7» behind.
 */
const DAY_PART_THEN_CLOCK = `${DAY_PART_BEFORE_HOUR}${HOUR_LEAD_AFTER_DAY_PART}[0-9٠-٩۰-۹]{1,2}(?::[0-9٠-٩۰-۹]{2})?(?=$|[\\s,.،!?؟])${NOT_A_COUNT}`;
export const CLOCK_WITH_PERIOD_SOURCES: readonly string[] = [AR_CLOCK_WITH_PERIOD, HE_CLOCK_WITH_PERIOD, EN_CLOCK_WITH_PERIOD, DAY_PART_THEN_CLOCK];

/**
 * What a single clock time looks like. `stripTiming` removes these from a
 * title and `countTimeExpressions` counts them; both read this one list, so
 * the two cannot drift apart. Stored as sources: every caller builds a fresh
 * RegExp, because a shared global regex carries `lastIndex` between calls.
 */
export const CLOCK_PATTERN_SOURCES: readonly string[] = [
  /\b(?:at|by|around)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/.source,
  /\b(?:at|by|around)\s*\d{1,2}(?::\d{2})?(?=$|[\s,.،])/.source,
  EN_CLOCK_WITH_PERIOD,
  AR_CLOCK_WITH_PERIOD,
  DAY_PART_THEN_CLOCK,
  `${AR_CLOCK_WORD}\\s*[0-9٠-٩۰-۹]{1,2}(?::[0-9٠-٩۰-۹]{2})?(?=$|[\\s,.،])`,
  HE_CLOCK_WITH_PERIOD,
  /(?:בשעה|שעה|בסביבות(?:\s+ה?שעה)?|סביב(?:\s+ה?שעה)?|לקראת(?:\s+ה?שעה)?|עד(?:\s+ה?שעה)?|[בס]-)\s*[0-9]{1,2}(?::[0-9]{2})?(?=$|[\s,.،])/.source,
  // Last, after the marked shapes: `stripTiming` runs these in order, and a
  // bare `4:30` taken out first left «الساعة» behind in the title (CL1
  // round 7). The counter anchors on digit positions, so its order is moot.
  /\b\d{1,2}:\d{2}(?=$|[\s,.،])/.source,
];
/** Built once, for `timeAnchorOf` (FIX-R6-PERF). Not global: `test` keeps no position. */
const CLOCK_PATTERNS_ANY_CASE = CLOCK_PATTERN_SOURCES.map((source) => new RegExp(source, 'i'));

/**
 * A start-to-end range is one appointment, not two times. English
 * "from 14:00 to 15:00" / "from 2pm to 3pm", and Arabic «من الساعة 2 للساعة 4»,
 * where «ل» fuses with «الساعة» into «للساعة».
 *
 * FIX-R8-CAPTURE (owner's phone, 2026-09-29) widened the three spellings the
 * owner actually typed, each of which fell apart into a start that was lost
 * and an end read as the time:
 *
 *   «من 10 للـ 4»      the tatweel after «لل»: «ل» + «ل» + «ـ».
 *   «מ-10 עד 4»        the hyphen after «מ»: «עד 4» alone was read, a
 *                      Saturday 04:00 *deadline* («עד» is "until").
 *   "10 to 4"          English with no "from" — only right before the end
 *                      of the clause, a day word or a time word, so "buy 2
 *                      to 4 apples" and "5 to 10 minutes" are not a range.
 *
 * Each source reads its start as the first number in the match and its end as
 * the last (`readClockRange`).
 */
const AR_RANGE_TO = '(?:إلى|الى|حتى|لحد|لحدّ|لغاية|لغايه|للغاية|ل)ـ*';
const EN_RANGE_END_CONTEXT = '(?=\\s*(?:$|[,.;!?،]|(?:on|every|each|at|in|this|next|today|tomorrow|tonight|weekly|daily|sunday|monday|tuesday|wednesday|thursday|friday|saturday|sundays|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays)\\b))';
const RANGE_HALF_OF_DAY_WORD = `(?:${AR_DAY_PART_AFTER_HOUR}|am|pm|a\\.m\\.?|p\\.m\\.?|(?:in\\s+the\\s+)?(?:morning|afternoon|evening)|at\\s+night|tonight)`;
export const RANGE_PATTERN_SOURCES: readonly string[] = [
  /\bfrom\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:(?:to|until|till)\s+|[-–—]\s*)\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/.source,
  /\bbetween\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s+(?:and|to)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/.source,
  /(?<![\d:])(?:[01]?\d|2[0-3]):[0-5]\d\s*[-–—]\s*(?:[01]?\d|2[0-3]):[0-5]\d(?![\d:])/.source,
  /(?<![\d:])\d{1,2}(?::\d{2})?\s*(?:am|pm)\s*[-–—]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/.source,
  `(?<![\\d:/.\\-])[0-9٠-٩۰-۹]{1,2}(?::[0-9٠-٩۰-۹]{2})?\\s*[-–—]\\s*[0-9٠-٩۰-۹]{1,2}(?::[0-9٠-٩۰-۹]{2})?\\s*${RANGE_HALF_OF_DAY_WORD}(?![\\p{L}\\p{M}])`,
  `(?<![؀-ۿ])من\\s*(?:(?:ال|ل)?(?:ساعة|ساعه)\\s*)?[0-9٠-٩۰-۹]{1,2}(?::[0-9٠-٩۰-۹]{2})?\\s*(?:${RANGE_HALF_OF_DAY_WORD})?\\s*(?:${AR_RANGE_TO}|-)\\s*(?:(?:ال|ل)ـ*)?(?:ساعة|ساعه)?\\s*[0-9٠-٩۰-۹]{1,2}(?::[0-9٠-٩۰-۹]{2})?\\s*(?:${RANGE_HALF_OF_DAY_WORD})?`,
  `(?<![؀-ۿ])بين\\s*[0-9٠-٩۰-۹]{1,2}(?::[0-9٠-٩۰-۹]{2})?\\s*(?:و|إلى|الى|حتى)\\s*[0-9٠-٩۰-۹]{1,2}(?::[0-9٠-٩۰-۹]{2})?\\s*${RANGE_HALF_OF_DAY_WORD}(?![\\p{L}\\p{M}])`,
  /(?:מ[-־]?|משעה|מהשעה|בין)\s*[0-9]{1,2}(?::[0-9]{2})?\s*(?:עד\s+ל[-־]?|עד|ל[-־]?|ו[-־]?)\s*(?:ה?שעה\s*)?[0-9]{1,2}(?::[0-9]{2})?/.source,
  `(?<![\\d:/.\\-])\\b\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?\\s+(?:to|until|till)\\s+\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?\\b(?![:/.\\-]\\d)${EN_RANGE_END_CONTEXT}`,
];

const RANGE_PATTERNS = RANGE_PATTERN_SOURCES.map((source) => new RegExp(source, 'i'));

/** The words name a start-to-end range: «من الساعة 2 للساعة 4 المسا», "from 2pm to 3pm". */
export function namesTimeRange(rawText: string): boolean {
  if (typeof rawText !== 'string' || !rawText.trim()) return false;
  const text = normalizeClockText(rawText);
  return RANGE_PATTERNS.some((pattern) => pattern.test(text));
}

/** One end of a range as written: the number, and the half of the day said right after it. */
export interface RangeEnd {
  hour: number;
  minute: number;
  /** The absolute hour its own half-of-day word gives it, or null when it has none (or an unreadable one). */
  statedHour: number | null;
}

export interface ClockRange {
  start: RangeEnd;
  end: RangeEnd;
}

const RANGE_CLOCK = /(\d{1,2})(?::(\d{2}))?/g;

function rangeEndAt(text: string, digits: RegExpExecArray): RangeEnd {
  const hour = Number(digits[1]);
  const minute = digits[2] ? Number(digits[2]) : 0;
  const after = text.slice(digits.index + digits[0].length);
  const half = new RegExp(`^\\s*(${HALF_OF_DAY_WORD})(?![\\p{L}\\p{M}])`, 'iu').exec(after);
  const inHalf = half ? hourInHalf(hour, half[1]!) : null;
  return { hour, minute, statedHour: typeof inHalf === 'number' ? inHalf : null };
}

/**
 * The first range the words name, its start and end as written (FIX-R8-
 * CAPTURE), or null. Read on the same normalised text as the patterns above.
 */
export function readClockRange(rawText: string): ClockRange | null {
  if (typeof rawText !== 'string' || !rawText.trim()) return null;
  const text = normalizeClockText(rawText);
  if (!ANY_CLOCK_DIGIT.test(text)) return null;
  let best: RegExpExecArray | null = null;
  for (const pattern of RANGE_PATTERNS) {
    const match = pattern.exec(text);
    if (match && (best === null || match.index < best.index)) best = match;
  }
  if (!best) return null;
  const clocks = Array.from(best[0].matchAll(RANGE_CLOCK));
  if (clocks.length < 2) return null;
  const at = (clock: RegExpMatchArray): RegExpExecArray => Object.assign(clock, { index: best!.index + clock.index! }) as unknown as RegExpExecArray;
  let start = rangeEndAt(text, at(clocks[0]!));
  const endClock = at(clocks[clocks.length - 1]!);
  const end = rangeEndAt(text, endClock);
  // English dash shorthand shares its trailing am/pm with the start when the
  // written endpoints are equal: "4-4pm" starts at 16:00 but still names no
  // duration. Arabic day-part shorthand keeps the established 08:00–20:00
  // reading of «8-8 المسا».
  if (start.statedHour === null && end.statedHour !== null
    && start.hour === end.hour && start.minute === end.minute
    && /[-–—]/.test(best[0])
    && /^\s*(?:am|pm)\b/i.test(text.slice(endClock.index + endClock[0].length))) {
    start = { ...start, statedHour: end.statedHour };
  }
  if (start.hour > 23 || end.hour > 23 || start.minute > 59 || end.minute > 59) return null;
  return { start, end };
}

/**
 * The start a range means when the start has no half of the day of its own
 * but the end does (FIX-R8-CAPTURE): «من 10 لـ 4 المسا» starts at 10:00, not
 * 22:00, and «من 2 لـ 4 المسا» at 14:00 — the latest reading of the start's
 * number that is still before the end. `HH:MM`, or null when the words give
 * no such start (then the start is read as any clock is).
 */
export function rangeStartTime(range: ClockRange): string | null {
  const pad = (hour: number, minute: number) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (range.start.statedHour !== null) return pad(range.start.statedHour, range.start.minute);
  if (range.end.statedHour === null || range.start.hour > 12) return null;
  const end = range.end.statedHour * 60 + range.end.minute;
  const candidates = [range.start.hour % 12, (range.start.hour % 12) + 12]
    .map((hour) => hour * 60 + range.start.minute)
    .filter((minutes) => minutes < end);
  const latest = candidates.length > 0 ? Math.max(...candidates) : null;
  return latest === null ? null : pad(Math.floor(latest / 60), latest % 60);
}

/** No range is read as lasting longer than this: past it, the end is left unsaid. */
const LONGEST_RANGE_MINUTES = 16 * 60;

/**
 * How long a range lasts from the start actually read, in minutes, or null
 * (FIX-R8-CAPTURE). The end is never an hour of its own to ask about: it
 * follows the start. A range cannot end before it starts, so an end with no
 * half of the day is the first reading of its number after the start — «10
 * لـ 4» from 10:00 is 16:00 (04:00 would end six hours before it began), «2
 * لـ 4» is two hours whichever half the start is asked into, and "9 to 5" is
 * 09:00–17:00. The start keeps every existing ruling: a bare 1–6 is asked
 * صبح or مسا (CL1 round 6) and a bare 7–11 is the morning, as «الساعة 10» has
 * always been. An end with its own half («لـ 4 المسا», "to 4pm") is that
 * hour; past midnight only when it said so. Counted from `startTime`, so an
 * answered صبح/مسا moves the end with it.
 *
 * Null when the words name no range, when the start read is not the range's
 * own start (a model that answered another hour), or when the reading would
 * last more than 16 hours — then the item simply names no end.
 */
export function rangeMinutesFrom(rawText: string, startTime: string | null | undefined): number | null {
  if (!startTime || !/^\d{2}:\d{2}$/.test(startTime)) return null;
  const range = readClockRange(rawText);
  if (!range) return null;
  // Equal endpoints name no duration only when both are absolute-equal or both
  // are unstated-equal. A mixed Arabic «8-8 المسا» is 08:00–20:00; English
  // "4-4pm" was normalised to two stated 16:00 endpoints above.
  if (range.start.minute === range.end.minute && (
    (range.start.statedHour !== null && range.end.statedHour !== null && range.start.statedHour === range.end.statedHour)
    || (range.start.statedHour === null && range.end.statedHour === null && range.start.hour === range.end.hour)
  )) return null;
  const startHour = Number(startTime.slice(0, 2));
  const start = startHour * 60 + Number(startTime.slice(3, 5));
  if (startHour % 12 !== range.start.hour % 12 || Number(startTime.slice(3, 5)) !== range.start.minute) return null;
  let minutes: number;
  if (range.end.statedHour !== null) {
    minutes = range.end.statedHour * 60 + range.end.minute - start;
    if (minutes === 0) return null;
    if (minutes <= 0) minutes += 24 * 60;
  } else {
    minutes = range.end.hour * 60 + range.end.minute - start;
    if (minutes === 0) return null;
    while (minutes <= 0) minutes += 12 * 60;
  }
  return minutes > 0 && minutes <= LONGEST_RANGE_MINUTES ? minutes : null;
}

/** A 24-hour clock: `14:00`. Unambiguous by construction. */
const HHMM = /\b\d{1,2}:\d{2}(?=$|[\s,.،])/;

/**
 * Minutes on a bare early hour (CL1 round 7, I-3): `4:30`, `5:00` — one digit,
 * one to eleven, no leading zero. The colon does not say which half of the day;
 * "at 4:30" is as ambiguous as "at 4". `04:30` and `16:30` are not.
 */
const BARE_EARLY_HHMM = /(?<![\d:])(?:[1-9]|1[01]):\d{2}(?=$|[\s,.،])/;

/** An explicit meridiem, in any of the three languages. */
const AMPM = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|[0-9]{1,2}(?::[0-9]{2})?\s*(?:صباحا|صباحاً|ص|مساءً|مساء|م)(?=$|[\s,.،])/i;

/**
 * A named part of the day. The hour the product picks for it is the product's,
 * but the *period* is the user's — "tomorrow evening" is not an invented time,
 * it is a coarse one.
 *
 * ── A part of the day is a whole word ───────────────────────────────
 *
 * The first version matched substrings, so the words that contain one became
 * a time nobody said (CL1, found by the CL5a review): «طلب المساعدة يوم الأحد»
 * read «المسا» inside «المساعدة» (help) and proposed 18:00, «المسافة»
 * (distance) the same, «המערב» (the west) and «ערבית» (Arabic) read «ערב»,
 * and "send the morning report" became 09:00. So each language says what may
 * stand around the word, the way `weekdayLexicon` does for day names:
 *
 *   Arabic   the proclitics the product already reads before it — و/ف, then
 *            ب/ل/ك or the spoken ع («وبالمسا», «عالمسا», «بالعصرية») — and
 *            nothing after it but diacritics and the accusative alif of
 *            «صباحاً» / «مساءً». A nisba adjective («الصباحي», «المسائي»)
 *            names a kind of meeting, not a time. «العصرية» / «الصبحية» are
 *            the spoken afternoon and morning only after ب or ع: bare
 *            «العصرية» is also "modern".
 *   Hebrew   ו/ש, then ב/ל/כ (with or without ה), ה, or מה — «ובערב»,
 *            «הערב», «מהבוקר». Never a bare מ: «מערב» is "west" and «מבוקר»
 *            is "audited". Nothing after it («ערבית», «ערבים»).
 *   English  whole words, framed as a time: after a day or a time
 *            preposition ("tomorrow morning", "Sunday evening", "in the
 *            morning", "at night"), or closing its phrase ("call mom,
 *            evening"), or before a function word ("evening to call mom").
 *            Directly before any other word it modifies it — "the morning
 *            report", "night shift", "evening class" — and names a kind of
 *            thing. Arabic and Hebrew put that modifier *after* the noun
 *            («تقرير الصبح», «ישיבת בוקר»), where it cannot be told from
 *            «اتصل بأمي الصبح» without a parser, so the rule is English only.
 *
 * A greeting — «صباح الخير», «ערב טוב», "good morning" — is not a time.
 *
 * When a word is ambiguous the answer is "no part of the day": a miss costs
 * the item one question (the day is kept and the hour asked); a false hit
 * schedules an hour nobody said, and a model's invented hour gets past the
 * day-only guard on it.
 */
const NOT_LETTER_BEFORE = '(?<![\\p{L}\\p{M}])';
const NOT_LETTER_AFTER = '(?![\\p{L}\\p{M}])';
// «ه» is the spoken "this" before an article: «هالمسا», «هاليوم».
const AR_PROCLITIC = '[وف]?(?:[بلكع]|ه(?=ال))?';
const AR_NOT_GREETING = `(?!\\s+(?:الخير|النور|الورد|الفل|الفلّ)${NOT_LETTER_AFTER})`;
const HE_PREFIX = '[וש]?(?:מה|[בלכ]ה?|ה)?';
const HE_NOT_GREETING = `(?!\\s+טוב(?:ה|ים|ות)?${NOT_LETTER_AFTER})`;
/**
 * «לערב את…» is the verb "to involve", not "for the evening". «ארוחת ערב»
 * (dinner) is left a part of the day on purpose: "dinner at 8" is eight in
 * the evening, and without «ערב» the 8 would read as the morning.
 */
const HE_NOT_VERB = `(?!ו?לערב\\s+את${NOT_LETTER_AFTER})`;
const EN_NOT_GREETING = '(?<!\\bgood\\s+)';
/** "Morning, call mom tomorrow": the first word of the message, then a comma, is a greeting. */
const EN_NOT_OPENING_GREETING = '(?!(?<=^\\s*[a-z]+)\\s*[,!])';
/** Before a part of the day, these make it a time: "tomorrow morning", "in the evening". */
const EN_ANCHOR =
  '(?:today|tonight|tomorrow|tmrw|tmr|tomorow|yesterday|sunday|monday|tuesday|wednesday|thursday|friday|saturday|'
  + 'this|next|every|each|early|late|all|at|by|in|on|before|after|until|till|around|from|through|throughout|during|since|'
  + '(?:in|during|by|before|after|until|till|around|from|through|throughout|for|on)\\s+the)';
/** After a part of the day, these leave it a time: "evening to call mom", "morning at the bank". */
const EN_FOLLOW =
  "(?:at|on|in|by|around|about|before|after|until|till|from|to|and|or|but|then|so|with|for|please|pls|if|when|once|while|"
  + "i|we|you|he|she|they|today|tonight|tomorrow|tmrw|sunday|monday|tuesday|wednesday|thursday|friday|saturday|this|next|"
  + "am|pm|o'?clock)";

interface DayPartWords {
  hour: number;
  /** English words, read by the framing rule above. */
  en: string;
  /** English words that are a time wherever they stand ("tonight"). */
  enAlways?: string;
  ar: string;
  /**
   * Arabic words with a second meaning in the adjective position, right
   * after a noun with «ال»: «العصرية» is the spoken afternoon, and in
   * «المدرسة العصرية» it is "modern". A one-word answer to "when?" has no
   * noun before it, so it is always the afternoon there.
   */
  arUnlessAdjective?: string;
  he: string;
  /**
   * The English word stays in a title, as it always has: "keep B plan at
   * noon". Only the words the stripper always took are taken.
   */
  enStaysInTitle?: true;
}

/**
 * Checked in this order, because a longer phrase must beat a shorter one:
 * «بعد الظهر» contains «الظهر», and «אחרי הצהריים» contains «הצהריים».
 */
const DAY_PARTS: readonly DayPartWords[] = [
  { hour: 0, en: 'midnight', enStaysInTitle: true, ar: 'منتصف\\s+الليل', he: 'חצות' },
  {
    hour: 14,
    en: 'afternoon',
    ar: 'بعد\\s+(?:الظهر|الضهر)|العصر',
    arUnlessAdjective: 'العصري[ةه]',
    he: 'אחרי\\s+הצהריים|אחר\\s+הצהריים|אחרי\\s+הצהרים|אחר\\s+הצהרים|אחה["״]צ',
  },
  {
    hour: 9,
    en: 'morning',
    ar: 'الصبح|الصباح|صباح\\p{M}*ا?|الصبحي[ةه]|الفترة\\s+الصباحي[ةه]',
    he: 'בוקר',
  },
  {
    hour: 12,
    en: 'noon|midday',
    enStaysInTitle: true,
    ar: 'الظهر|الضهر|الضهري[ةه]|الظهري[ةه]|الظهيرة|الظهيره',
    he: 'צהריים|צהרים',
  },
  { hour: 20, en: 'night', enAlways: 'tonight', ar: 'الليل|الليلة|الليله', he: 'לילה' },
  // «مسا» without the article is spoken too: «الساعة 7 مسا», «ذكرني … مسا».
  { hour: 18, en: 'evening', ar: 'المساء?|مسا(?:ء\\p{M}*ا?)?|الفترة\\s+المسائي[ةه]', he: 'ערב' },
];

/** The hour `dayPartHour` gives the night («بالليل», "tonight", «בלילה»). */
export const NIGHT_HOUR = 20;

/*
 * A clock hour said "at night" (closure UAT round 3, FZ1 N10). «الساعة 2
 * بالليل», «ב-2 בלילה» and "2 at night" are two in the morning — the small
 * hours are night too — so only 6 to 11 move to the evening half; 12 at night
 * is midnight. The rules read every night hour as pm, so «اليوم الساعة 2
 * بالليل» typed at 03:22 was proposed, settled, for 14:00.
 */
export function nightClockHour(hour: number): number {
  if (hour === 12) return 0;
  if (hour >= 1 && hour <= 5) return hour;
  return hour < 12 ? hour + 12 : hour;
}

/*
 * Which half of the day a typed answer names, for the am/pm question about an
 * hour already said (closure UAT round 3, FZ1 round 2). «المسا», "pm", «م»,
 * «בערב» are the evening half of *that* hour — «5» answered «المسا» is 17:00 —
 * not the time question's 19:00 button. The night is its own rule
 * (`nightClockHour`). "am"/"pm" count only as the whole answer ("I am
 * busy" is not the morning). Null when the answer names no half.
 */
const AM_WORD = new RegExp(`^\\s*(?:am|a\\.m\\.?)\\s*$|${'(?<![\\p{L}\\p{M}])'}(?:ص|صباحا|صباحًا|صباحاً)\\p{M}*(?![\\p{L}\\p{M}])|לפנה["״]צ`, 'iu');
const PM_WORD = new RegExp(`^\\s*(?:pm|p\\.m\\.?)\\s*$|${'(?<![\\p{L}\\p{M}])'}(?:م|مساء|مساءً|مساءا)\\p{M}*(?![\\p{L}\\p{M}])`, 'iu');
export function typedHalfOfDay(rawText: string): 'am' | 'pm' | 'night' | null {
  if (typeof rawText !== 'string' || !rawText.trim()) return null;
  if (AM_WORD.test(rawText)) return 'am';
  if (PM_WORD.test(rawText)) return 'pm';
  const hour = dayPartHour(rawText, { answer: true });
  if (hour === null || hour === 0) return null;
  if (hour === NIGHT_HOUR) return 'night';
  return hour < 12 ? 'am' : 'pm';
}

/*
 * A clock hour said with its part of the day (closure UAT round 6; the rule
 * the typed answers follow since FZ1 M5a): «5 المسا», «5 العصر», «خمسة
 * المسا», «5 بعد الضهر», "5 in the evening", «5 אחר הצהריים», «ב-8 בבוקר».
 * The number is the person's hour and the part of the day picks its half.
 *
 * Only the number right before the part of the day: «ع/على/حوالي/الساعة»,
 * "at/about/around", «בשעה» or an attached «ב» may come before it, and "in
 * the" between. A count or a date is not an hour — «بعد 2 يوم الصبح», «3
 * مرات المسا», "in 3 days in the evening", «يوم 5 المسا», "the 5th in the
 * evening" — so a unit after the number, «يوم»/"the" before it, or an
 * ordinal ending refuses it.
 */
const HOUR_DIGIT = '[0-9٠-٩۰-۹]';
const HALF_OF_DAY_WORD = [
  AR_DAY_PART_AFTER_HOUR,
  '(?:in\\s+the\\s+)?(?:morning|afternoon|evening)', 'at\\s+night', 'tonight', 'am', 'pm', 'a\\.m\\.?', 'p\\.m\\.?',
  'בבוקר', 'בערב', 'בלילה', 'בצהריים', 'בצהרים', 'אחרי\\s+הצהריים', 'אחר\\s+הצהריים', 'אחרי\\s+הצהרים', 'אחר\\s+הצהרים', 'אחה["״]צ',
].join('|');
const HOUR_BEFORE_HALF = new RegExp(
  `(?:^|[\\s,،])(?:(?:ع|على|حوالي|حوالى|الساعة|الساعه|at|about|around|בשעה|בסביבות)\\s+|عال\\s*|ב-?)?(${HOUR_DIGIT}{1,2})(?::(${HOUR_DIGIT}{2}))?\\s*(${HALF_OF_DAY_WORD})(?![\\p{L}\\p{M}])`,
  'giu',
);
/**
 * The part of the day before the hour, with a clock word between (FIX-R6-
 * SPOKENHOUR): «المسا ع 7», «بالليل ع 10», «בערב ב-7», "evening at 7" —
 * after the spoken hours are written as numbers.
 */
const HALF_BEFORE_HOUR = new RegExp(
  `(?<![^\\s,.،])(${DAY_PART_BEFORE_HOUR_WORD})\\s+${HOUR_LEAD_AFTER_DAY_PART}(${HOUR_DIGIT}{1,2})(?::(${HOUR_DIGIT}{2}))?(?=$|[\\s,.،!?؟])${NOT_A_COUNT}`,
  'giu',
);
/** «يوم 5», "the 5", "day 5": the number names a day. */
const DAY_BEFORE_NUMBER = new RegExp(`(?:يوم|نهار|day|the)\\s*${HOUR_DIGIT}{1,2}\\s*(?:${HALF_OF_DAY_WORD})(?![\\p{L}\\p{M}])`, 'iu');
const EXPLICIT_AM = /^(?:am|a\.m\.?|ص|صباحا|صباحاً)$/i;
const EXPLICIT_PM = /^(?:pm|p\.m\.?|م|مساء|مساءً)$/i;

/**
 * The hour one number means in the half one word names, `HH` — or
 * `ambiguous` when the pair names no hour anybody can read without asking:
 * «12 الصبح» (midnight to some, noon to others; FZ1 round 4), «12 المسا»
 * (POLISH-CAPTURE M2), and a number outside its part of the day — «11
 * الضهر», «9 العصر» — which read by the half alone came out 23:00 and 21:00.
 * A night hour follows the night's rule (`nightClockHour`).
 */
function hourInHalf(hour: number, word: string): number | 'ambiguous' | null {
  if (!Number.isInteger(hour) || hour < 1 || hour > 12) return null;
  const said = word.trim();
  if (EXPLICIT_AM.test(said)) return hour % 12;
  if (EXPLICIT_PM.test(said)) return (hour % 12) + 12;
  switch (dayPartHour(said, { answer: true })) {
    case 9: return hour === 12 ? 'ambiguous' : hour;
    case 12: return hour === 12 ? 12 : hour <= 5 ? hour + 12 : 'ambiguous';
    case 14: return hour === 12 ? 12 : hour <= 7 ? hour + 12 : 'ambiguous';
    case 18: return hour === 12 ? 'ambiguous' : hour + 12;
    case NIGHT_HOUR: return nightClockHour(hour);
    default: return null;
  }
}

/**
 * The clock time the words state as a number with its part of the day —
 * `HH:MM` — or `ambiguous` when that pair is one to ask about, or null when
 * the words state none, or two that disagree. Read the same way for a
 * capture (both engines) and for a typed answer to the time question.
 */
export function hourWithDayPart(rawText: string): string | 'ambiguous' | null {
  if (typeof rawText !== 'string' || !rawText.trim()) return null;
  const text = normalizeClockText(rawText);
  // Every pattern below reads an hour's digit (FIX-R6-PERF).
  if (!ANY_CLOCK_DIGIT.test(text)) return null;
  if (DAY_BEFORE_NUMBER.test(text)) return null;
  const readings = new Set<string>();
  for (const match of Array.from(text.matchAll(HOUR_BEFORE_HALF))) {
    const hour = hourInHalf(Number(match[1]), match[3]!);
    if (hour === null) continue;
    readings.add(hour === 'ambiguous' ? hour : `${String(hour).padStart(2, '0')}:${match[2] ?? '00'}`);
  }
  for (const match of Array.from(text.matchAll(HALF_BEFORE_HOUR))) {
    const hour = hourInHalf(Number(match[2]), match[1]!);
    if (hour === null) continue;
    readings.add(hour === 'ambiguous' ? hour : `${String(hour).padStart(2, '0')}:${match[3] ?? '00'}`);
  }
  if (readings.has('ambiguous')) return 'ambiguous';
  return readings.size === 1 ? Array.from(readings)[0]! : null;
}

/**
 * A title loses the preposition with the part of the day — "call mom at
 * noon" is "call mom", not "call mom at".
 */
const EN_STRIP_LEAD = '(?:\\b(?:in|during|at|by|around|before|after|until|till|from|through|on|for|this)\\s+(?:the\\s+)?)?';

/**
 * The adjective position: right after a word with «ال» that is not a day —
 * «المدرسة العصرية», not «يوم الأحد العصرية» or «اليوم العصرية».
 */
const AR_AFTER_DEFINITE_NOUN =
  `(?<!${NOT_LETTER_BEFORE}ال(?!(?:أحد|احد|اثنين|إثنين|أثنين|ثلاثاء|ثلثاء|أربعاء|اربعاء|خميس|جمعة|جمعه|سبت|يوم|يومه)${NOT_LETTER_AFTER})[\\p{L}\\p{M}]+\\s+)`;

function dayPartSources(words: DayPartWords, mode: 'text' | 'answer' | 'strip'): string[] {
  const ar = words.arUnlessAdjective
    ? `${words.ar}|${AR_AFTER_DEFINITE_NOUN}(?:${words.arUnlessAdjective})`
    : words.ar;
  const en = mode === 'answer'
    // A typed answer to "when?" is a time by being the answer: "morning is fine".
    ? `${EN_NOT_GREETING}\\b(?:${words.en})\\b`
    : `${mode === 'strip' ? EN_STRIP_LEAD : ''}${EN_NOT_GREETING}(?:(?<=\\b${EN_ANCHOR}\\s+)\\b(?:${words.en})\\b|\\b(?:${words.en})\\b(?!\\s+(?!${EN_FOLLOW}\\b)[a-z]))${EN_NOT_OPENING_GREETING}`;
  return [
    ...(words.enAlways ? [`\\b(?:${words.enAlways})\\b`] : []),
    ...(mode === 'strip' && words.enStaysInTitle ? [] : [en]),
    `${NOT_LETTER_BEFORE}${AR_PROCLITIC}(?:${ar})\\p{M}*${NOT_LETTER_AFTER}${AR_NOT_GREETING}`,
    `${NOT_LETTER_BEFORE}${HE_NOT_VERB}${HE_PREFIX}(?:${words.he})${NOT_LETTER_AFTER}${HE_NOT_GREETING}`,
  ];
}

const DAY_PART_PATTERNS = DAY_PARTS.map((words) => ({
  hour: words.hour,
  inText: new RegExp(dayPartSources(words, 'text').join('|'), 'iu'),
  inAnswer: new RegExp(dayPartSources(words, 'answer').join('|'), 'iu'),
}));

/**
 * Every part-of-day mention in a capture, as sources, for `stripTiming` to
 * lift out of a title — the proclitic with it («عالمسا» leaves no «ع»), and
 * nothing it did not read («the morning report» keeps its word).
 */
export const DAY_PART_MENTION_SOURCES: readonly string[] = DAY_PARTS.flatMap((words) => dayPartSources(words, 'strip'));

/** The text names a part of the day, by the rules above. */
function namesDayPart(text: string): boolean {
  return DAY_PART_PATTERNS.some((pattern) => pattern.inText.test(text));
}

/**
 * The number is being named as a clock time — but with no meridiem.
 * «الساعة 5», "at 9", «בשעה 8». Believed, and flagged.
 */
const CLOCK_MARKER = new RegExp(
  [
    /\b(?:at|by|around)\s*\d{1,2}(?::\d{2})?(?=$|[\s,.،])/.source,
    /\b\d{1,2}\s*o'?clock\b/.source,
    /(?:الساعة|الساعه|عند|على|(?<![\u0600-\u06FF])عال)\s*[0-9]{1,2}(?::[0-9]{2})?(?=$|[\s,.،])/.source,
    /(?:בשעה|שעה|בסביבות(?:\s+ה?שעה)?|סביב(?:\s+ה?שעה)?|לקראת(?:\s+ה?שעה)?|עד(?:\s+ה?שעה)?|[בס]-)\s*[0-9]{1,2}(?::[0-9]{2})?(?=$|[\s,.،])/.source,
  ].join('|'),
  'i',
);

/**
 * The relative days — today, tomorrow, the day after — by the same whole-word
 * rule as the parts of the day (CL1, after the part-of-day fix). As
 * substrings, «غدا» inside «الغداء» (lunch) moved «أحضّر الغداء اليوم» to
 * tomorrow, «اليوم» inside «اليومي» (daily) and «اليومين» (two days) made
 * them today, and the title stripper cut «الغداء» down to «ال ء».
 *
 *   Arabic   the same proclitics as the parts of the day («واليوم», «لبكرا»,
 *            «هالمسا»), nothing after but diacritics («غداً», «غدًا»).
 *            «الغدا» with the article is lunch, never tomorrow.
 *   Hebrew   ו/ש, then one of ב/ל/כ/מ — «ומחר», «למחר», «ממחר», «מהיום».
 *            A bare מ is safe here: no Hebrew word is מ + «מחר» or מ +
 *            «היום» but "from tomorrow" / "from today". Nothing after:
 *            «למחרת» (the day after), «מחרוזת», «היומי» are not days.
 *   English  whole words, and not a possessive: "today's report" names the
 *            report, as "the morning report" does. "This morning / afternoon
 *            / evening" and «هالمسا» are today.
 *
 * Checked in this order, because «بعد بكرا» contains «بكرا».
 */
const HE_DAY_PREFIX = '[וש]?[בלכמ]?';
const EN_NOT_POSSESSIVE = "(?!['’]s\\b)";
/*
 * «غدا» is tomorrow in the standard language and lunch in the spoken one
 * (closure UAT round 4, N16 probes). «عندي غدا مع أمي بكرا» was titled «عندي
 * مع أمي»: the lunch taken out as a day word. It is the meal only when it is
 * had — right after «عندي/عندنا/عنا» — with someone («غدا مع …»), *and* the
 * sentence names its day some other way («بكرا», «اليوم», a weekday).
 * Otherwise it is tomorrow, as it always was: «اجتماع غدا مع العميل الساعة
 * 11» is a meeting tomorrow (POLISH-CAPTURE review, I1), and so is «اجتماع
 * غدا مع المدير بخصوص تقرير اليوم», whose «اليوم» is the report's (N-I1).
 */
const AR_OTHER_DAY_WORD = `${NOT_LETTER_BEFORE}${AR_PROCLITIC}(?:بكرا|بكرة|بكره|باچر|باكر|اليوم|النهارده|النهاردة|الليلة|الليله|الأحد|الاحد|الاثنين|الإثنين|الأثنين|الثلاثاء|الثلثاء|الأربعاء|الاربعاء|الخميس|الجمعة|الجمعه|السبت)${NOT_LETTER_AFTER}`;
const AR_HAD = `${NOT_LETTER_BEFORE}[وف]?(?:عندي|عندنا|عنا|عنّا)\\s+`;
const AR_LUNCH_NOT_TOMORROW = `غد\\p{M}*ا(?!(?<=${AR_HAD}غد\\p{M}*ا)\\s+مع(?![\\p{L}\\p{M}])(?:(?=[\\s\\S]*${AR_OTHER_DAY_WORD})|(?<=${AR_OTHER_DAY_WORD}[\\s\\S]*)))`;
const RELATIVE_DAYS: ReadonlyArray<{ offset: number; en: string; ar: string; he: string }> = [
  { offset: 2, en: 'day\\s+after\\s+tomorrow|after\\s+tomorrow|after\\s+tmrw', ar: 'بعد\\s+(?:بكرا|بكرة|بكره|غد\\p{M}*ا?)', he: 'מחרתיים' },
  { offset: 1, en: 'tomorrow|tmrw|tmr|tomorow', ar: `بكرا|بكرة|بكره|باچر|باكر|${AR_LUNCH_NOT_TOMORROW}`, he: 'מחר' },
  {
    offset: 0,
    en: 'today|tonight|this\\s+(?:morning|afternoon|evening)',
    ar: 'اليوم|النهارده|النهاردة|اليومه|الليلة|الليله|ه(?:المسا|المساء|الصبح|العصر|الضهر|الظهر)',
    he: 'היום|הערב|הלילה',
  },
];

function relativeDaySources(day: (typeof RELATIVE_DAYS)[number]): string[] {
  return [
    `\\b(?:${day.en})\\b${EN_NOT_POSSESSIVE}`,
    `${NOT_LETTER_BEFORE}${AR_PROCLITIC}(?:${day.ar})\\p{M}*${NOT_LETTER_AFTER}`,
    `${NOT_LETTER_BEFORE}${HE_DAY_PREFIX}(?:${day.he})${NOT_LETTER_AFTER}`,
  ];
}

const RELATIVE_DAY_PATTERNS = RELATIVE_DAYS.map((day) => ({
  offset: day.offset,
  pattern: new RegExp(relativeDaySources(day).join('|'), 'iu'),
}));

/**
 * How many days ahead the text's relative day is — 0 today, 1 tomorrow, 2 the
 * day after — or null when it names none. The furthest one wins, as it
 * always has: «بعد بكرا» is the day after, not tomorrow.
 */
export function relativeDayOffset(rawText: string): number | null {
  if (typeof rawText !== 'string') return null;
  for (const { offset, pattern } of RELATIVE_DAY_PATTERNS) {
    if (pattern.test(rawText)) return offset;
  }
  return null;
}

/**
 * One relative day as a single source — 0 today, 1 tomorrow, 2 the day after
 * — for the other readers of day words (the email-share anchor, memory
 * candidates, the weekday rule), so all of them read the same whole words.
 * Compile with the `u` flag.
 */
export function relativeDaySource(offset: 0 | 1 | 2): string {
  const day = RELATIVE_DAYS.find((candidate) => candidate.offset === offset)!;
  return relativeDaySources(day).join('|');
}

/**
 * Every relative-day mention, as sources, for `stripTiming` to lift out of a
 * title with its proclitic («واليوم» leaves no «و») and nothing else.
 */
export const RELATIVE_DAY_MENTION_SOURCES: readonly string[] = RELATIVE_DAYS.flatMap(relativeDaySources);

/*
 * "Tonight" runs past midnight: "tonight at 1", «الليلة الساعة 1» and
 * «הלילה ב-1» are read as the coming small hours, tomorrow's date, rightly.
 */
const TONIGHT = new RegExp(
  [
    '\\btonight\\b',
    `${NOT_LETTER_BEFORE}${AR_PROCLITIC}(?:الليلة|الليله)\\p{M}*${NOT_LETTER_AFTER}`,
    `${NOT_LETTER_BEFORE}${HE_DAY_PREFIX}הלילה${NOT_LETTER_AFTER}`,
  ].join('|'),
  'iu',
);

/**
 * The words' only relative day is today — «اليوم», "today", «היום» — and not
 * "tonight" (closure UAT round 3, FZ1 N10). A weekday or a date named beside
 * it is the caller's to check.
 */
export function namesTodayOnly(rawText: string): boolean {
  return relativeDayOffset(rawText) === 0 && !TONIGHT.test(rawText);
}

/*
 * A relative day the words rule out or leave open (FINAL-BACKEND review, M2):
 * «مش بكرا», "not tomorrow", «לא מחר», and two day words offered as
 * alternatives — «اليوم أو بكرا», «اليوم ولا بكرا», "today or tomorrow",
 * «היום או מחר». Neither is a day anybody said, so nothing may be filled from
 * it. Each part is linear: a fixed word, whitespace, a fixed word.
 */
// Plain day words only (review P-I2): built from the full relative-day
// sources, with the «غدا مع» lunch lookarounds, this ran at every offset of a
// 2000-character capture several times per request and pushed the #508
// bound from under 60 ms to 88. Which «غدا» is lunch does not matter here:
// «مش غدا» and «اليوم أو غدا» are days ruled out or left open either way.
const UNSETTLED_DAY = [
  `${NOT_LETTER_BEFORE}${AR_PROCLITIC}(?:بعد\\s+)?(?:بكرا|بكرة|بكره|باچر|باكر|غدا|غدًا|اليوم|النهارده|النهاردة|الليلة|الليله)${NOT_LETTER_AFTER}`,
  '\\b(?:today|tonight|tomorrow|tmrw|tmr)\\b',
  `${NOT_LETTER_BEFORE}${HE_DAY_PREFIX}(?:היום|מחרתיים|מחר|הערב|הלילה)${NOT_LETTER_AFTER}`,
].join('|');
const UNSETTLED_RELATIVE_DAY = new RegExp(
  [
    `${NOT_LETTER_BEFORE}[وف]?(?:مش|مو|مب|بلاش)\\s+(?:${UNSETTLED_DAY})`,
    `\\bnot\\s+(?:${UNSETTLED_DAY})`,
    `${NOT_LETTER_BEFORE}ו?לא\\s+(?:${UNSETTLED_DAY})`,
    `(?:${UNSETTLED_DAY})(?:\\s*[،,])?\\s*(?:أو|او|ولا|or|או)\\s+(?:${UNSETTLED_DAY})`,
  ].join('|'),
  'iu',
);
/** A cheap gate: no negation or «أو»/"or" word at all means nothing to look for. */
const UNSETTLED_GATE = new RegExp('مش|مو|مب|بلاش|أو|او|ولا|not|or|לא|או', 'iu');

/** The words' relative day is ruled out or one of two alternatives: not a day to fill. */
export function relativeDayIsUnsettled(rawText: string): boolean {
  return typeof rawText === 'string' && UNSETTLED_GATE.test(rawText) && UNSETTLED_RELATIVE_DAY.test(rawText);
}

/** Where the words rule out or leave open a relative day, as said: «مش بكرا», "today or tomorrow". */
export function unsettledRelativeDayPhrase(rawText: string): { index: number; text: string } | null {
  if (typeof rawText !== 'string' || !UNSETTLED_GATE.test(rawText)) return null;
  const match = UNSETTLED_RELATIVE_DAY.exec(rawText);
  return match ? { index: match.index, text: match[0] } : null;
}

// A day of the month by its number: «يوم 5», «بـ 5 الشهر», «ב-5 לחודש».
const DAY_OF_MONTH_SOURCES = [
  `${NOT_LETTER_BEFORE}يوم\\s*[0-9٠-٩]{1,2}(?![0-9٠-٩:])`,
  `${NOT_LETTER_BEFORE}(?:ب|بـ)\\s*[0-9٠-٩]{1,2}\\s+(?:من\\s+)?(?:ال|هال|ل)?شهر`,
  `${NOT_LETTER_BEFORE}ב-?\\s*[0-9]{1,2}\\s+(?:ל|ב)?חודש`,
];
const DAY_OF_MONTH = new RegExp(DAY_OF_MONTH_SOURCES.join('|'), 'iu');

/** The words name a day of the month by its number — «يوم 29», «بـ 29 الشهر» (R6). */
export function namesDayOfMonth(rawText: string): boolean {
  return typeof rawText === 'string' && DAY_OF_MONTH.test(rawText);
}

/*
 * The night's end, and its midnight: «آخر الليل», «نص الليل», «الساعة 12
 * بالليل», "midnight", «חצות». They run past today's date (N-M1), and they are
 * no evening: «نص الليل» holds «الليل», which `dayPartHour` reads as 20:00.
 */
const NIGHT_END_SOURCES: readonly string[] = [
  `${NOT_LETTER_BEFORE}${AR_PROCLITIC}(?:آخر|اخر|نص|نصف|منتصف)\\s+(?:ال)?ليل${NOT_LETTER_AFTER}`,
  `(?:الساعة|الساعه|${NOT_LETTER_BEFORE})\\s*(?:12|١٢)\\s*(?:بالليل|الليل|بليل)${NOT_LETTER_AFTER}`,
  '\\bmidnight\\b|\\b12\\s*(?:at\\s+night|tonight|midnight)\\b',
  `${NOT_LETTER_BEFORE}[בל]?חצות${NOT_LETTER_AFTER}|(?:בשעה|ב-?)\\s*12\\s+בלילה${NOT_LETTER_AFTER}`,
];
const NIGHT_END = new RegExp(NIGHT_END_SOURCES.join('|'), 'iu');

/*
 * Words that put the commitment on some day other than today even when
 * «اليوم»/"today"/«היום» is the only relative day in them (FZ1 review, I1):
 * «اليوم الدكتور قلي ارجعله يوم 5», «اليوم عرفت إنه الاجتماع أول الشهر»,
 * "not today", the weekend, after the feast. A model day for those is the
 * model's reading of those words, not a "today" it moved.
 */
const OTHER_DAY_THAN_TODAY = new RegExp(
  [
    // «مش اليوم», "not today", «לא היום»
    `${NOT_LETTER_BEFORE}(?:مش|مو|ما|لا|مب)\\s+${AR_PROCLITIC}(?:اليوم|النهارده|النهاردة)${NOT_LETTER_AFTER}`,
    '\\bnot\\s+today\\b',
    `${NOT_LETTER_BEFORE}לא\\s+היום${NOT_LETTER_AFTER}`,
    // «يوم 5», «بـ 5 الشهر», «ב-5 לחודש», "on the 5th"
    ...DAY_OF_MONTH_SOURCES,
    // The month's start: «أول الشهر», "the beginning of the month", «תחילת החודש»
    `${NOT_LETTER_BEFORE}${AR_PROCLITIC}(?:أول|اول|بداية|بدايه|مطلع)\\s+(?:هال|ال)?شهر`,
    '\\b(?:beginning|start)\\s+of\\s+(?:the\\s+|next\\s+)?month\\b',
    `${NOT_LETTER_BEFORE}[בל]?(?:תחילת|ראשית)\\s+ה?חודש`,
    // The weekend: «الويكند», «آخر الأسبوع», "the weekend", «סוף השבוע», «סופ"ש»
    `${NOT_LETTER_BEFORE}${AR_PROCLITIC}(?:الويكند|الويك\\s+اند|ويكند)`,
    `${NOT_LETTER_BEFORE}${AR_PROCLITIC}(?:آخر|اخر|نهاية|نهايه)\\s+(?:هال|ال)?(?:أسبوع|اسبوع|جمعة)`,
    '\\bweek\\s*-?\\s*end\\b',
    `${NOT_LETTER_BEFORE}[בל]?(?:סוף\\s+ה?שבוע|סופ["״]?ש)`,
    // A feast or a holiday: «بعد العيد», "after the holidays", «אחרי החג»
    `${NOT_LETTER_BEFORE}${AR_PROCLITIC}(?:العيد|عيد|الأعياد|الاعياد)${NOT_LETTER_AFTER}`,
    '\\bholidays?\\b',
    `${NOT_LETTER_BEFORE}[בל]?(?:אחרי\\s+)?ה?(?:חג|חגים)${NOT_LETTER_AFTER}`,
    // The day after (FZ1 review, N-M1): "the next day", «تاني يوم», «למחרת»
    '\\b(?:the\\s+)?(?:next|following)\\s+day\\b|\\bthe\\s+day\\s+after\\b',
    `${NOT_LETTER_BEFORE}(?:تاني|ثاني|تانى|ثانى)\\s+(?:يوم|نهار)${NOT_LETTER_AFTER}|${NOT_LETTER_BEFORE}${AR_PROCLITIC}(?:اليوم|النهار)\\s+(?:التاني|الثاني|التالي|اللي\\s+بعده)${NOT_LETTER_AFTER}`,
    `${NOT_LETTER_BEFORE}למחרת${NOT_LETTER_AFTER}`,
    // The night's end, and its midnight, run past today's date (N-M1).
    ...NIGHT_END_SOURCES,
  ].join('|'),
  'iu',
);

/** The words name the night's end or its midnight (`NIGHT_END_SOURCES`). */
export function namesNightEnd(rawText: string): boolean {
  return typeof rawText === 'string' && NIGHT_END.test(rawText);
}

/**
 * The words name a day that is not today although «اليوم»/"today" is their
 * only relative day: a negated today, a day of the month, the month's start
 * or end, the weekend, a feast (FZ1 review, I1).
 */
export function namesOtherDayThanToday(rawText: string): boolean {
  if (typeof rawText !== 'string' || !rawText.trim()) return false;
  return OTHER_DAY_THAN_TODAY.test(rawText) || thisMonthEndWords(rawText) !== null || readPeriodEndDeadline(rawText) !== null;
}

/**
 * A day, without any time of day. English, Arabic and Hebrew.
 *
 * Only used to tell `day_only` from `none`; both refuse a time, so a miss here
 * is not a safety hole — it changes which reason is reported, not whether the
 * time survives. Whole words, like the relative days: «الأحداث» is not «الأحد».
 */
const DAY_TOKEN = new RegExp(
  [
    ...RELATIVE_DAY_MENTION_SOURCES,
    /\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|next week|this week)\b/.source,
    `${NOT_LETTER_BEFORE}${AR_PROCLITIC}(?:الأحد|الاحد|الاثنين|الإثنين|الأثنين|الثلاثاء|الثلثاء|الأربعاء|الاربعاء|الخميس|الجمعة|السبت)${NOT_LETTER_AFTER}`,
    // Without the article in its frames (FIX-R8-CAPTURE; `weekdayLexicon`'s
    // `AR_BARE_DAY`): «يوم سبت», «كل سبت».
    `${NOT_LETTER_BEFORE}و?يوم\\s+(?:أحد|احد|اثنين|إثنين|ثلاثاء|ثلثاء|أربعاء|اربعاء|خميس|جمعة|جمعه|سبت)${NOT_LETTER_AFTER}`,
    `${NOT_LETTER_BEFORE}كل\\s+(?:ثلاثاء|ثلثاء|أربعاء|اربعاء|خميس|سبت)${NOT_LETTER_AFTER}`,
    `${NOT_LETTER_BEFORE}${HE_DAY_PREFIX}(?:יום ראשון|יום שני|יום שלישי|יום רביעי|יום חמישי|יום שישי|שבת)${NOT_LETTER_AFTER}`,
  ].join('|'),
  'iu',
);

/**
 * The strongest time-of-day evidence the text carries.
 *
 * Deliberately about the *time of day*, not the date. "Tomorrow" is a date, and
 * a date with no hour is exactly the case that used to silently become 18:00.
 */
export function timeOfDayEvidence(rawText: string): TimeEvidence {
  if (typeof rawText !== 'string' || !rawText.trim()) return 'none';
  const text = normalizeClockText(rawText);
  if (HHMM.test(text)) {
    // Minutes on a bare early hour with no period word are a guess at the
    // half of the day, like the bare hour itself (round 7, I-3).
    return BARE_EARLY_HHMM.test(text) && !AMPM.test(text) && !namesDayPart(text) ? 'clock_marker' : 'hhmm';
  }
  if (AMPM.test(text)) return 'ampm';
  if (namesDayPart(text)) return 'daypart';
  if (CLOCK_MARKER.test(text)) return 'clock_marker';
  // A range with no half of the day on it — "10 to 4", «מ-10 עד 4» — is a
  // clock number like «الساعة 10» (FIX-R8-CAPTURE).
  if (RANGE_PATTERNS.some((pattern) => pattern.test(text))) return 'clock_marker';
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
 * The text names a day — "tomorrow", «الأحد», «מחר» — whatever else it says.
 * Unlike `timeOfDayEvidence`, which reports the strongest evidence only, this
 * answers the day question on its own: «بكرا الساعة 5» names a day *and* a
 * clock (CL1 round 6, NEW-2).
 */
export function namesDay(rawText: string): boolean {
  return typeof rawText === 'string' && DAY_TOKEN.test(rawText);
}

/**
 * The text states a clock time — a number read as an hour: «الساعة 5», "at
 * 4:30pm", «ב-10». A part of the day alone («المسا») is not one.
 */
export function statesClock(rawText: string): boolean {
  if (typeof rawText !== 'string' || !rawText.trim()) return false;
  // Not `timeOfDayEvidence`: that reports the strongest evidence, and a part
  // of the day outranks the clock beside it — «الساعة 5 المسا» is `daypart`.
  const text = normalizeClockText(rawText);
  return HHMM.test(text) || AMPM.test(text) || CLOCK_MARKER.test(text) || RANGE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * The hours the text states as clock times, modulo twelve (CL1 round 6, M-a):
 * "at 6pm" and «الساعة 18:00» both give 6. Used to check a model's answer
 * against the clause it says it read — the hour is the one thing the two must
 * share when the clause names one.
 */
export function statedClockHours(rawText: string): Set<number> {
  const hours = new Set<number>();
  if (typeof rawText !== 'string' || !rawText.trim()) return hours;
  const text = normalizeClockText(rawText);
  for (const source of CLOCK_PATTERN_SOURCES) {
    const pattern = new RegExp(source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      const digits = /[0-9]{1,2}/.exec(match[0]);
      if (digits) hours.add(Number(digits[0]) % 12);
    }
  }
  // A range states its start too: «מ-10 עד 4» names 10, not only the «עד 4»
  // the clock patterns see (FIX-R8-CAPTURE).
  const range = readClockRange(rawText);
  if (range) hours.add(range.start.hour % 12);
  return hours;
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
  const text = normalizeSpokenHours(normalizeArabicDigits(rawText));
  if (RANGE_PATTERNS.some((pattern) => pattern.test(text))) return 'event';
  if (DEADLINE_MARKER.test(text)) return 'deadline';
  return CLOCK_PATTERNS_ANY_CASE.some((pattern) => pattern.test(text)) ? 'event' : null;
}

/**
 * The hour a named part of the day means, or null when the text names none.
 *
 * `answer` is for a typed answer to "when?": there the word is the answer, so
 * "morning is fine" is 09:00 even though "morning" is followed by a word. The
 * word boundaries hold either way.
 */
export function dayPartHour(rawText: string, options: { answer?: boolean } = {}): number | null {
  if (typeof rawText !== 'string') return null;
  for (const pattern of DAY_PART_PATTERNS) {
    if ((options.answer ? pattern.inAnswer : pattern.inText).test(rawText)) return pattern.hour;
  }
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

/**
 * Resolve the local end clock of a range. Exact ambiguous wall times choose
 * the earlier instant; a wall time inside a DST gap advances to the first
 * valid minute. This deliberately differs from adding elapsed milliseconds:
 * a two-hour local range across a transition still ends at the clock the
 * person said.
 */
export function rangeEndInstant(
  date: string,
  startTime: string,
  timeZone: string,
  rangeMinutes: number,
): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime)) return null;
  if (!Number.isFinite(rangeMinutes) || rangeMinutes < 0 || rangeMinutes > 24 * 60) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
  } catch {
    return null;
  }
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = startTime.split(':').map(Number) as [number, number];
  const targetWall = Date.UTC(year, month - 1, day, hour, minute) + rangeMinutes * 60_000;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  let exact: Date | null = null;
  let firstAfterGap: { instant: Date; wall: number } | null = null;
  for (let instantMs = targetWall - 18 * 3_600_000; instantMs <= targetWall + 18 * 3_600_000; instantMs += 60_000) {
    const instant = new Date(instantMs);
    const parts = formatter.formatToParts(instant);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') === 24 ? 0 : get('hour'), get('minute'));
    if (wall === targetWall && (!exact || instant < exact)) exact = instant;
    if (wall > targetWall && wall <= targetWall + 3 * 3_600_000 && (!firstAfterGap || wall < firstAfterGap.wall || (wall === firstAfterGap.wall && instant < firstAfterGap.instant))) {
      firstAfterGap = { instant, wall };
    }
  }
  return exact ?? firstAfterGap?.instant ?? null;
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

/* ── The end of the month (closure UAT 2026-09-27, FX3) ─────────────
 *
 * «بدي أدفع فاتورة الكهربا قبل آخر الشهر» came back «بدون وقت»: nothing in
 * the lexicon knew the month has an end, so the deadline the person said was
 * dropped. It is a deadline on the current month's last day, with no hour —
 * an all-day `due_by`, the way a day with no chosen hour is stored everywhere
 * (`TimeSpec.allDay`).
 *
 * Only *this* month. «آخر الشهر الجاي», "end of next month", «סוף החודש
 * הבא» and the past ones are not read, so they keep what they did before
 * rather than landing on the wrong month. There is no end-of-week reading:
 * which day ends a week (Thursday, Friday, Saturday) differs by person and
 * country, and a wrong deadline is worse than none.
 */
const AR_MONTH_WORD = '(?:هال|ال)شهر';
const AR_NOT_ANOTHER_MONTH = `(?!\\s+(?:الجاي|الجاية|القادم|الماضي|الفائت|الفات|التاني|اللي\\s+(?:جاي|بعده|بعدو|فات|قبله|قبلو)))`;
const EN_NOT_ANOTHER_MONTH = '(?!\\s+after\\b)';
const HE_NOT_ANOTHER_MONTH = `(?!\\s+(?:הבא|הקרוב|שעבר|הקודם))`;

/*
 * When the words are a deadline and when they only name a thing (review I-1).
 *
 * «أحضّر تقرير آخر الشهر» is "prepare the month-end report": «آخر الشهر»
 * modifies the indefinite noun before it (idafa), exactly like "the end of the
 * month report", "the month-end close" and «דוח סוף החודש» (smichut). Read
 * as a deadline, the title lost what the report was and got a 30th nobody said.
 * So the phrase is a deadline only when something marks it as *when*:
 *
 *   - a limit word or a preposition before it — «قبل/لحد/لغاية/حتى/في/ع/على»,
 *     «ب/ل/ع» attached («بآخر الشهر»), "by/before/until/till/at/on/in/for",
 *     «עד/לפני», «ב/ל» attached («בסוף החודש»);
 *   - in Arabic, after a *definite* word — «أدفع الفاتورة آخر الشهر»,
 *     «فاتورة الكهربا آخر الشهر»: a definite noun cannot open an idafa, so the
 *     phrase after it is adverbial; an indefinite one («تقرير», «رواتب»,
 *     «إيجار», «فاتورة») can, and is left alone;
 *   - at the start of a clause («آخر الشهر بدي أدفع…», «סוף החודש לשלם…»).
 *
 * In English, a noun right after it ("…end of the month report", "month-end
 * close") is a modifier even with a preposition before it. Anything else keeps
 * its pre-FX3 reading: the words stay in the title and the hour is asked.
 */
const AR_MONTH_END = `(?:آخر|اخر|أخر|إخر|نهاية|نهايه|نهايت)\\s+${AR_MONTH_WORD}${NOT_LETTER_AFTER}${AR_NOT_ANOTHER_MONTH}`;
const CLAUSE_START = '(?<=(?:^|[\\n.,،;:!?؟])\\s*)';
const EN_NO_NOUN_AFTER = "(?!['’]s\\b)(?![\\s-]+(?!(?:and|or|but|then|so|at|on|by|to|for|tomorrow|today|tonight|please)\\b)[a-z])";

/** What names the month's end as a deadline, with the word that marks it as one. */
const MONTH_END_CORE: readonly string[] = [
  // «قبل آخر الشهر», «في آخر الشهر», «ع آخر الشهر»
  `${NOT_LETTER_BEFORE}[وف]?(?:قبل|لحد|لحدّ|لغاية|لغايه|حتى|في|ع|على)\\s+${AR_MONTH_END}`,
  // «بآخر الشهر», «لآخر الشهر», «عآخر الشهر»
  `${NOT_LETTER_BEFORE}[وف]?[بلع]${AR_MONTH_END}`,
  // after a definite word, or opening the clause
  `(?:${CLAUSE_START}|(?<=${NOT_LETTER_BEFORE}(?:[وفبلك]?ال|هال)[\\p{L}\\p{M}]+\\s+))[وف]?${AR_MONTH_END}`,
  `${NOT_LETTER_BEFORE}(?:قبل|لحد|لحدّ|لغاية|لغايه|حتى)\\s+ما\\s+(?:يخلص|يخلّص|ينتهي|يوفى|يوفّى)\\s+${AR_MONTH_WORD}${NOT_LETTER_AFTER}${AR_NOT_ANOTHER_MONTH}`,
  `\\b(?:by|before|until|till|til|at|on|in|for|around)\\s+(?:the\\s+)?end\\s+of\\s+(?:the\\s+|this\\s+)?month\\b${EN_NOT_ANOTHER_MONTH}${EN_NO_NOUN_AFTER}`,
  `\\b(?:by|before|until|till|til|at|on|for|around)\\s+(?:(?:the|this)\\s+)?month[\\s-]end\\b${EN_NO_NOUN_AFTER}`,
  `${NOT_LETTER_BEFORE}[וש]?(?:עד|לפני)\\s+ה?סוף\\s+ה?חודש${NOT_LETTER_AFTER}${HE_NOT_ANOTHER_MONTH}`,
  `${NOT_LETTER_BEFORE}[וש]?[בל]סוף\\s+ה?חודש${NOT_LETTER_AFTER}${HE_NOT_ANOTHER_MONTH}`,
  `${CLAUSE_START}[וש]?סוף\\s+ה?חודש${NOT_LETTER_AFTER}${HE_NOT_ANOTHER_MONTH}`,
];

const MONTH_END = new RegExp(MONTH_END_CORE.join('|'), 'iu');

/**
 * The same patterns, for `stripTiming` to lift out of a title whole — limit
 * word included: «أدفع فاتورة الكهربا قبل آخر الشهر» is titled «أدفع فاتورة
 * الكهربا». Only when the reading used them (`stripTiming`'s `monthEnd`).
 */
export const MONTH_END_MENTION_SOURCES: readonly string[] = MONTH_END_CORE;

/** `month` when the text sets a deadline at the end of the current month. */
export function readPeriodEndDeadline(rawText: string): 'month' | null {
  if (typeof rawText !== 'string' || !rawText.trim()) return null;
  return MONTH_END.test(rawText) ? 'month' : null;
}

/*
 * This month's end in the person's words, whatever it does in the sentence
 * (closure UAT round 2, FY1 N6): a deadline («قبل آخر الشهر») or only a name
 * for a thing («تقرير آخر الشهر», "the month-end report", «דוח סוף החודש»).
 * Another month («آخر الشهر الجاي», "end of next month", «סוף החודש הבא») is
 * not this one. The words are one group, so a match is the phrase itself.
 */
const THIS_MONTH_END_WORDS = new RegExp(
  [
    `${NOT_LETTER_BEFORE}(?:[وف]?[بلع]?)((?:آخر|اخر|أخر|إخر|نهاية|نهايه|نهايت)\\s+${AR_MONTH_WORD})${NOT_LETTER_AFTER}${AR_NOT_ANOTHER_MONTH}`,
    `\\b((?:the\\s+)?end\\s+of\\s+(?:the\\s+|this\\s+)?month|(?:the\\s+)?month[\\s-]end)\\b${EN_NOT_ANOTHER_MONTH}`,
    `${NOT_LETTER_BEFORE}(?:[וש]?[בל]?)(סוף\\s+ה?חודש)${NOT_LETTER_AFTER}${HE_NOT_ANOTHER_MONTH}`,
  ].join('|'),
  'iu',
);

/**
 * The words naming this month's end, as the person wrote them («آخر الشهر»,
 * "end of the month", «סוף החודש»), or null when the text names none.
 */
export function thisMonthEndWords(rawText: string): string | null {
  if (typeof rawText !== 'string' || !rawText.trim()) return null;
  const match = THIS_MONTH_END_WORDS.exec(rawText);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/*
 * The month's end, but not as the day itself (FY1 review, I2): an offset on
 * it — «قبل آخر الشهر بأسبوع», "two days before the end of the month",
 * «שבוע לפני סוף החודש», «بعد آخر الشهر بيومين», "after the end of the month"
 * — or another month named after it, «סוף חודש אוקטובר». The model reads
 * these to another day, rightly, and that day is not the month's last.
 */
const AR_END = '(?:آخر|اخر|أخر|إخر|نهاية|نهايه|نهايت)';
const AR_DURATION = '(?:أسبوع|اسبوع|أسبوعين|اسبوعين|يوم|يومين|أيام|ايام|جمعة|جمعتين)';
const EN_DURATION = '(?:days?|weeks?|a\\s+day|a\\s+week|a\\s+couple\\s+of\\s+days)';
const HE_DURATION = '(?:יום|יומיים|ימים|שבוע|שבועיים|שבועות)';
const AR_MONTHS = '(?:\\d{1,2}|كانون|شباط|آذار|اذار|نيسان|أيار|ايار|حزيران|تموز|آب|اب|أيلول|ايلول|تشرين|يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر)';
const HE_MONTHS = '(?:ינואר|פברואר|מרץ|מרס|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר)';
const EN_MONTHS = '(?:january|february|march|april|may|june|july|august|september|october|november|december)';
const MONTH_END_NOT_THE_DAY = new RegExp(
  [
    `${NOT_LETTER_BEFORE}[وف]?(?:قبل|بعد)\\s+${AR_END}\\s+${AR_MONTH_WORD}\\s+(?:ب|بـ\\s*)(?:\\d+\\s*)?${AR_DURATION}${NOT_LETTER_AFTER}`,
    `${NOT_LETTER_BEFORE}(?:ب)?(?:\\d+\\s*)?${AR_DURATION}\\s+(?:قبل|بعد)\\s+${AR_END}\\s+${AR_MONTH_WORD}`,
    `${NOT_LETTER_BEFORE}[وف]?بعد\\s+${AR_END}\\s+${AR_MONTH_WORD}${NOT_LETTER_AFTER}`,
    `${NOT_LETTER_BEFORE}${AR_END}\\s+(?:هال|ال)?شهر\\s+${AR_MONTHS}${NOT_LETTER_AFTER}`,
    `\\b${EN_DURATION}\\s+(?:before|after)\\s+(?:the\\s+)?(?:end\\s+of|month[\\s-]end)\\b`,
    '\\bafter\\s+(?:the\\s+)?(?:end\\s+of\\s+(?:the\\s+|this\\s+)?month|month[\\s-]end)\\b',
    `\\bend\\s+of\\s+(?:the\\s+month\\s+of\\s+)?${EN_MONTHS}\\b`,
    `${NOT_LETTER_BEFORE}${HE_DURATION}\\s+(?:לפני|אחרי)\\s+ה?סוף\\s+ה?חודש`,
    `${NOT_LETTER_BEFORE}[ו]?אחרי\\s+ה?סוף\\s+ה?חודש`,
    `${NOT_LETTER_BEFORE}[ובל]?סוף\\s+ה?חודש\\s+ה?${HE_MONTHS}${NOT_LETTER_AFTER}`,
  ].join('|'),
  'iu',
);

/**
 * True when the text's month's end carries an offset or names another month,
 * so the day it means is not this month's last (FY1 review, I2).
 */
export function monthEndIsNotTheDay(rawText: string): boolean {
  return typeof rawText === 'string' && MONTH_END_NOT_THE_DAY.test(rawText);
}

/*
 * A counted offset on this month's end (closure UAT round 3, FZ1 round 2):
 * «قبل آخر الشهر بأسبوع», «أسبوع قبل آخر الشهر», «بعد آخر الشهر بيومين»,
 * "two days before the end of the month", «שבוע לפני סוף החודש». FX3 read
 * the limit word and settled all of these on the month's last day — a later
 * deadline than the person said. The count is read here, on the person's
 * clock; an offset with no count («بعد آخر الشهر», "after the end of the
 * month") is left uncounted, and gets no day.
 */
const AR_COUNT: ReadonlyArray<[string, number]> = [
  ['تلاتة|ثلاثة|تلات|ثلاث|تلت', 3], ['أربعة|اربعة|أربع|اربع', 4], ['خمسة|خمس', 5], ['ستة|ست', 6],
  ['سبعة|سبع', 7], ['تمانية|ثمانية|تمن|ثمان', 8], ['تسعة|تسع', 9], ['عشرة|عشر', 10],
];
const EN_COUNT: ReadonlyArray<[string, number]> = [
  ['a\\s+couple\\s+of|couple\\s+of', 2], ['an|a|one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5],
  ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10],
];
const HE_COUNT: ReadonlyArray<[string, number]> = [
  ['שלושה|שלוש', 3], ['ארבעה|ארבע', 4], ['חמישה|חמש', 5], ['שישה|שש', 6], ['שבעה|שבע', 7], ['עשרה|עשר', 10],
];
// Latin and Arabic-Indic digits («ب٣ أيام»: the Arabic keyboard's) (FZ1 review, I2).
const countSource = (counts: ReadonlyArray<[string, number]>) => `[0-9٠-٩۰-۹]{1,2}|${counts.map(([words]) => words).join('|')}`;
/** Days per unit, and whether the unit needs a count («أيام», "days", «ימים»). */
const OFFSET_UNITS: ReadonlyArray<{ words: string; days: number; counted: boolean }> = [
  { words: 'أسبوعين|اسبوعين|جمعتين|שבועיים', days: 14, counted: false },
  { words: 'أسابيع|اسابيع|weeks|שבועות', days: 7, counted: true },
  { words: 'أسبوع|اسبوع|جمعة|week|שבוע', days: 7, counted: false },
  { words: 'يومين|יומיים', days: 2, counted: false },
  // «تيام» is how «أيام» is said after a count: «خمس تيام».
  { words: 'أيام|ايام|تيام|days|ימים', days: 1, counted: true },
  { words: 'يوم|day|יום', days: 1, counted: false },
];
const UNIT_SOURCE = OFFSET_UNITS.map((unit) => unit.words).join('|');
/** The month's end in Arabic, as words or as «ما يخلص الشهر» (FX3). */
const AR_MONTH_END_PHRASE = `(?:${AR_END}\\s+${AR_MONTH_WORD}|ما\\s+(?:يخلص|يخلّص|ينتهي|يوفى|يوفّى)\\s+${AR_MONTH_WORD})`;
const MONTH_END_OFFSET = new RegExp(
  [
    // «قبل آخر الشهر بأسبوع», «بعد آخر الشهر بتلات أيام», «ب 3 أيام»,
    // «قبل ما يخلص الشهر بأسبوع»
    `${NOT_LETTER_BEFORE}[وف]?(قبل|بعد)\\s+${AR_MONTH_END_PHRASE}\\s+(?:بـ|ب)\\s*(?:(${countSource(AR_COUNT)})\\s*)?(${UNIT_SOURCE})${NOT_LETTER_AFTER}`,
    // «أسبوع قبل آخر الشهر», «بيومين بعد آخر الشهر»
    `${NOT_LETTER_BEFORE}[وف]?(?:بـ|ب)?\\s*(?:(${countSource(AR_COUNT)})\\s*)?(${UNIT_SOURCE})\\s+(قبل|بعد)\\s+${AR_MONTH_END_PHRASE}${NOT_LETTER_AFTER}${AR_NOT_ANOTHER_MONTH}`,
    // "two days before the end of the month", "a week after month end"
    `\\b(${countSource(EN_COUNT)})\\s+(${UNIT_SOURCE})\\s+(before|after)\\s+(?:the\\s+)?(?:end\\s+of\\s+(?:the\\s+|this\\s+)?month|month[\\s-]end)\\b${EN_NOT_ANOTHER_MONTH}`,
    // «שבוע לפני סוף החודש», «שלושה ימים אחרי סוף החודש»
    `${NOT_LETTER_BEFORE}(?:(${countSource(HE_COUNT)})\\s+)?(${UNIT_SOURCE})\\s+(לפני|אחרי)\\s+ה?סוף\\s+ה?חודש${NOT_LETTER_AFTER}${HE_NOT_ANOTHER_MONTH}`,
  ].join('|'),
  'iu',
);

/*
 * An offset on the month's end that gives no count (FZ1 review, I2):
 * «بأسابيع», «بكم يوم», «بشي أسبوع», «بشوي», "a few days before the end of
 * the month", «כמה ימים לפני סוף החודש». No day is ours to pick: the hour is
 * asked, and the words stay in the title.
 */
const AR_VAGUE = '(?:كم|كام|شي|عدة|عدّة|كذا)';
const AR_VAGUE_UNIT = `(?:${UNIT_SOURCE}|شوي|شوية|شويه|فترة|فتره|مدة|مده)`;
const MONTH_END_VAGUE_OFFSET = new RegExp(
  [
    `${NOT_LETTER_BEFORE}[وف]?(?:قبل|بعد)\\s+${AR_MONTH_END_PHRASE}\\s+(?:بـ|ب)\\s*(?:${AR_VAGUE}\\s*)?${AR_VAGUE_UNIT}${NOT_LETTER_AFTER}`,
    `${NOT_LETTER_BEFORE}[وف]?(?:بـ|ب)?\\s*(?:${AR_VAGUE}\\s*)?(?:${UNIT_SOURCE})\\s+(?:قبل|بعد)\\s+${AR_MONTH_END_PHRASE}`,
    '\\b(?:(?:a\\s+)?few|some|several|many|a\\s+couple|couple)?\\s*(?:days?|weeks?)\\s+(?:before|after)\\s+(?:the\\s+)?(?:end\\s+of|month[\\s-]end)\\b',
    `${NOT_LETTER_BEFORE}(?:כמה\\s+|מספר\\s+)?(?:ימים|יום|שבועות|שבוע)\\s+(?:לפני|אחרי)\\s+ה?סוף\\s+ה?חודש`,
  ].join('|'),
  'iu',
);

/*
 * Another month's end named: «סוף חודש אוקטובר», "the end of October",
 * «آخر شهر 10» (FZ1 review, I3). An offset on it is not counted on this month.
 */
const ANOTHER_MONTH_END = new RegExp(
  [
    `${NOT_LETTER_BEFORE}${AR_END}\\s+(?:هال|ال)?شهر\\s+${AR_MONTHS}${NOT_LETTER_AFTER}`,
    `\\bend\\s+of\\s+(?:the\\s+month\\s+of\\s+)?${EN_MONTHS}\\b`,
    `${NOT_LETTER_BEFORE}[ובל]?סוף\\s+ה?חודש\\s+ה?${HE_MONTHS}${NOT_LETTER_AFTER}`,
  ].join('|'),
  'iu',
);

/** The whole offset phrases, for a title that used them as its deadline to lose them. */
export const MONTH_END_OFFSET_SOURCE: string = MONTH_END_OFFSET.source;

function countOf(word: string | undefined): number | null {
  if (word === undefined) return null;
  const digits = word.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  if (/^\d+$/.test(digits)) return Number(digits);
  for (const [words, value] of [...AR_COUNT, ...EN_COUNT, ...HE_COUNT]) {
    if (new RegExp(`^(?:${words})$`, 'iu').test(word.trim())) return value;
  }
  return null;
}

/** Signed days from the month's end, or null when the text counts none. */
function monthEndOffsetDays(rawText: string): number | null {
  const match = MONTH_END_OFFSET.exec(rawText);
  if (!match) return null;
  // Each alternative captures (direction, count, unit) in its own order.
  const groups: Array<[string | undefined, string | undefined, string | undefined]> = [
    [match[1], match[2], match[3]],
    [match[6], match[4], match[5]],
    [match[9], match[7], match[8]],
    [match[12], match[10], match[11]],
  ];
  const found = groups.find(([direction, , unitWord]) => direction && unitWord);
  if (!found) return null;
  const [direction, countWord, unitWord] = found;
  const unit = OFFSET_UNITS.find((candidate) => new RegExp(`^(?:${candidate.words})$`, 'iu').test(unitWord!.trim()));
  if (!unit) return null;
  const count = countOf(countWord);
  if (unit.counted && count === null) return null;
  const days = (count ?? 1) * unit.days;
  if (!Number.isFinite(days) || days < 1 || days > 60) return null;
  return /^(?:قبل|before|לפני)$/i.test(direction!) ? -days : days;
}

/**
 * The day this month's end in the person's words means, on their clock:
 * the month's last day (`end`), or that day counted back or on (`before`,
 * `after`). Null when the text names no end of this month, or puts on it an
 * offset it does not count or another month («סוף חודש אוקטובר») — no day
 * of ours, the hour asked (FY1 review, I2).
 */
export function monthEndDay(rawText: string, now: Date, timeZone: string): { date: string; side: 'end' | 'before' | 'after' } | null {
  // «قبل ما يخلص الشهر» names the month's end without the words (FX3).
  if (!thisMonthEndWords(rawText) && readPeriodEndDeadline(rawText) !== 'month') return null;
  // Another month's end: nothing here is counted on this one (I3).
  if (ANOTHER_MONTH_END.test(rawText)) return null;
  const last = lastDayOfMonth(now, timeZone);
  const offset = monthEndOffsetDays(rawText);
  if (offset === null) {
    // An offset it cannot count, or one FY1 already knew: no day (I2).
    return monthEndIsNotTheDay(rawText) || MONTH_END_VAGUE_OFFSET.test(rawText) ? null : { date: last, side: 'end' };
  }
  const [year, month, day] = last.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + offset));
  return { date: shifted.toISOString().slice(0, 10), side: offset < 0 ? 'before' : 'after' };
}

/** The number a clock word names, or an early h:mm with no marker. */
const CLOCK_NUMBER = /(?:\b(?:at|by|around)|الساعة|الساعه|عند|على|(?<![\u0600-\u06FF])عال|בשעה|שעה|[בס]-)\s*(\d{1,2})(?::\d{2})?(?=$|[\s,.،])|\b(\d{1,2})\s*o'?clock\b|(?<![\d:])([1-6]):\d{2}(?=$|[\s,.،])/gi;

/**
 * A typed bare hour from one to six with no part of the day — «الساعة 4»,
 * "at 4", «ב-4» (FY1 re-review). The rules would read it as the morning, the
 * unlikely half; as an answer it is not understood, and the question's
 * صبح/مسا buttons stay (CL1 round 6 applied to answers).
 */
export function isBareEarlyHourAnswer(rawText: string): boolean {
  if (typeof rawText !== 'string' || timeOfDayEvidence(rawText) !== 'clock_marker') return false;
  const hours = Array.from(normalizeClockText(rawText).matchAll(CLOCK_NUMBER), (match) => Number(match[1] ?? match[2] ?? match[3]));
  // A range's start is its clock (FIX-R8-CAPTURE): «من 2 لـ 4» is a bare 2.
  const range = readClockRange(rawText);
  if (range && range.start.statedHour === null && range.end.statedHour === null) hours.push(range.start.hour);
  return hours.length > 0 && hours.every((hour) => hour >= 1 && hour <= 6);
}

const TIME_OF_DAY_STRIP = [
  // A clock with its part of the day whole first, as `stripTiming` takes it:
  // taking «المسا» alone left «ع 7» of «المسا ع 7» behind (FIX-R6-SPOKENHOUR).
  ...CLOCK_WITH_PERIOD_SOURCES.map((source) => new RegExp(source, 'gi')),
  ...DAY_PART_MENTION_SOURCES.map((source) => new RegExp(source, 'giu')),
  ...[...RANGE_PATTERN_SOURCES, ...CLOCK_PATTERN_SOURCES].map((source) => new RegExp(source, 'gi')),
];

/**
 * The text with its times of day taken out — clock times, ranges and parts
 * of the day — and its days left in (FY1 review, I3). For re-reading a
 * sentence whose hour a typed answer is replacing: «اليوم الساعة 3 العصر لازم
 * أبعت الإيميل» answered «الساعة 7 المسا» is read as «اليوم لازم أبعت
 * الإيميل» + «الساعة 7 المسا», so the passed 15:00 is not read first.
 */
export function withoutTimeOfDay(rawText: string): string {
  if (typeof rawText !== 'string') return '';
  let stripped = normalizeClockFractions(normalizeSpokenHours(rawText));
  for (const pattern of TIME_OF_DAY_STRIP) stripped = stripped.replace(pattern, ' ');
  return stripped.replace(/[ \t]+/g, ' ').trim();
}

/*
 * «12 المسا», "12 in the evening", «12 בערב» (FZ1 round 4 note; POLISH-CAPTURE
 * review M2, M7): noon to some and midnight to others. Asked, not guessed —
 * typed as an answer, or said in the capture itself. "12 pm", «12 م» and «12
 * الضهر» are the clock's noon, and «12 بالليل» the night's midnight (FZ1 N10).
 */
const TWELVE_IN_THE_EVENING = new RegExp(
  '(?:^|[\\s,،])(?:(?:ع|على|حوالي|حوالى|الساعة|الساعه|at|about|around|בשעה)\\s+|ב-?)?(?:12|١٢|۱۲)(?::[0-9٠-٩]{2})?\\s*'
    + '(?:بالمسا|المساء|المسا|مساءً|مساءا|مساء|مسا|(?:in\\s+the\\s+)?evening|בערב)(?![\\p{L}\\p{M}])',
  'iu',
);

/** The text says twelve with an evening word — an hour nobody can read without asking. */
export function namesTwelveInTheEvening(rawText: string): boolean {
  return typeof rawText === 'string' && TWELVE_IN_THE_EVENING.test(rawText);
}

/**
 * The product's hour for a part of the day the words give with no number, or
 * null (UAT round 6, D2 and batch 4). «بكرا المسا», "this evening", «מחר
 * בערב» are `dayPartHour`'s hour — the same one on both engines — and ours,
 * not the person's. Null when the words state a clock number anywhere — «5
 * المسا», «الساعة 7», "7pm", «ב-19:00», «الساعة سبعة المسا» are the person's
 * hour — and for «12 المسا», which is asked, never settled.
 */
export function partOfDayOnlyHour(rawText: string): number | null {
  if (typeof rawText !== 'string' || !rawText.trim()) return null;
  const hour = dayPartHour(rawText);
  if (hour === null || namesTwelveInTheEvening(rawText)) return null;
  return !statesClock(rawText) && statedClockHours(rawText).size === 0 ? hour : null;
}

/*
 * Any number in the words — a digit, or an hour said as a word: «ع سبعة»,
 * «عالسبعة», «בערב בשבע», "evening at seven". The clock readers read those
 * beside a part of the day (FIX-R6-SPOKENHOUR); a number they still cannot
 * place is the model's to read, and its hour is not replaced by the part of
 * the day's while such a number is there (UAT round 6, batch 4).
 */
const ANY_NUMBER = new RegExp(
  [
    '[0-9\u0660-\u0669\u06F0-\u06F9]',
    `${NOT_LETTER_BEFORE}${AR_PROCLITIC}(?:ال)?(?:${ARABIC_CARDINAL_HOURS.map(([words]) => words).join('|')})${NOT_LETTER_AFTER}`,
    `${NOT_LETTER_BEFORE}${HE_PREFIX}-?(?:אחת|אחד|שתיים|שתים|שניים|שנים|שלוש|שלושה|שלש|ארבע|ארבעה|חמש|חמישה|שש|שישה|שבע|שבעה|שמונה|תשע|תשעה|עשר|עשרה)${NOT_LETTER_AFTER}`,
    '\\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\\b',
  ].join('|'),
  'iu',
);

/** The words carry a number of any kind, digits or a spoken hour. */
export function namesAnyNumber(rawText: string): boolean {
  return typeof rawText === 'string' && ANY_NUMBER.test(rawText);
}

/** The last day of the month `now` falls in, on the user's own clock, `YYYY-MM-DD`. */
export function lastDayOfMonth(now: Date, timeZone: string): string {
  const today = localTimeSpecFor(now, timeZone)?.date ?? now.toISOString().slice(0, 10);
  const [year, month] = today.split('-').map(Number) as [number, number];
  // Day 0 of the next month is the last day of this one.
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}
