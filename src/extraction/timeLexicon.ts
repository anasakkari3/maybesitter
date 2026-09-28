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

/**
 * «בשתיים בלילה», «בחמש בבוקר», «בשש בערב» (FZ1 review, M5b): «ב» + a spoken
 * hour right before a part of the day is a clock time too, written «ב-2» so
 * the clock readers see it. Only there: «בשלוש דקות» is not three o'clock.
 */
const HE_HOUR_BEFORE_DAY_PART = new RegExp('(^|[\\s,.،])ב((?:[^\\s,.،]+)(?:\\s+[-־]?\\s*עשר(?:ה)?)?)(?=\\s+(?:בלילה|בבוקר|בערב|בצהריים|בצהרים|אחרי\\s+הצהריים|אחה["״]צ|לפנות\\s+בוקר)(?![\\p{L}]))', 'gu');

export function normalizeSpokenHebrewHours(value: string): string {
  // Only rewrite where a clock is actually being named, so «שלוש משימות»
  // (three tasks) keeps its word and only «בשעה שלוש» or «שעה שלוש» becomes a number.
  const beforeDayPart = value.replace(HE_HOUR_BEFORE_DAY_PART, (match, lead: string, word: string) => {
    for (const [pattern, digit] of HEBREW_SPOKEN_HOURS) {
      pattern.lastIndex = 0;
      if (new RegExp(`^(?:${pattern.source})$`).test(word)) return `${lead}ב-${digit}`;
    }
    return match;
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
  const D = '([0-9\\u0660-\\u0669\\u06F0-\\u06F9]{1,2})';
  // A fraction is a clock time only where a clock is being named: after a
  // clock word, or before a part of the day. «3 ونص كيلو رز» and
  // «150 ونص شيكل» are quantities and keep their words.
  const LEAD =
    '((?:الساعة|الساعه|عند|على)\\s*|\\b(?:at|by|around)\\s+|(?:בשעה|שעה|בסביבות|סביב|לקראת|עד)\\s*|(?<![\\p{L}\\p{M}])ב-?)';
  const PERIOD =
    '(?=\\s*(?:صباحا|صباحاً|الصبح|مساء|مساءً|المسا|المساء|بالليل|بعد\\s+الضهر|بعد\\s+الظهر|العصر|am|pm|בבוקר|בצהריים|אחרי\\s+הצהריים|בערב|בלילה)(?![\\p{L}\\p{M}]))';
  const hourOf = (digits: string) => Number(normalizeArabicDigits(digits));
  const before = (digits: string, minutes: string) => {
    const hour = hourOf(digits);
    return `${hour === 1 ? 12 : hour - 1}:${minutes}`;
  };
  const inClock = (text: string, fraction: string, toClock: (digits: string) => string) =>
    text
      .replace(new RegExp(`${LEAD}${D}${fraction}(?![\\p{L}\\p{M}])`, 'giu'), (_, lead: string, d: string) => `${lead}${toClock(d)}`)
      .replace(new RegExp(`(?<![\\d:\\p{L}\\p{M}])${D}${fraction}${PERIOD}`, 'giu'), (_, d: string) => toClock(d));
  let out = value;
  out = inClock(out, '\\s*(?:و\\s*)?(?:نص|نصف)', (d) => `${hourOf(d)}:30`);
  out = inClock(out, '\\s*(?:و\\s*)?ربع', (d) => `${hourOf(d)}:15`);
  out = inClock(out, '\\s*(?:و\\s*)?(?:ثلث|تلت)', (d) => `${hourOf(d)}:20`);
  out = inClock(out, '\\s*(?:إلا|الا|إلّا)\\s*ربع', (d) => before(d, '45'));
  out = inClock(out, '\\s*(?:إلا|الا|إلّا)\\s*(?:ثلث|تلت)', (d) => before(d, '40'));
  out = inClock(out, '\\s*וחצי', (d) => `${hourOf(d)}:30`);
  out = inClock(out, '\\s*ורבע', (d) => `${hourOf(d)}:15`);
  out = inClock(out, '\\s*פחות\\s*רבע', (d) => before(d, '45'));
  // "half past 5" and "quarter to 5" name a clock by themselves.
  return out
    .replace(new RegExp(`\\bhalf\\s+past\\s+${D}\\b`, 'giu'), (_, d: string) => `${hourOf(d)}:30`)
    .replace(new RegExp(`\\b(?:a\\s+)?quarter\\s+past\\s+${D}\\b`, 'giu'), (_, d: string) => `${hourOf(d)}:15`)
    .replace(new RegExp(`\\b(?:a\\s+)?quarter\\s+to\\s+${D}\\b`, 'giu'), (_, d: string) => before(d, '45'));
}

/** Every rewrite a clock reader needs, in order: digits, spoken hours, fractions. */
export function normalizeClockText(value: string): string {
  return normalizeClockFractions(normalizeSpokenHebrewHours(normalizeSpokenArabicHours(normalizeArabicDigits(value))));
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
  /(?:الساعة|الساعه|عند|على)?\s*[0-9٠-٩۰-۹]{1,2}(?::[0-9٠-٩۰-۹]{2})?\s*(?:صباحا|صباحاً|الصبح|ص|مساء|مساءً|المسا|المساء|بالليل|م)(?=$|[\s,.،])/.source,
  /(?:الساعة|الساعه|عند|على)\s*[0-9٠-٩۰-۹]{1,2}(?::[0-9٠-٩۰-۹]{2})?(?=$|[\s,.،])/.source,
  /(?:בשעה|שעה|בסביבות(?:\s+ה?שעה)?|סביב(?:\s+ה?שעה)?|לקראת(?:\s+ה?שעה)?|עד(?:\s+ה?שעה)?|[בס]-?)?\s*[0-9]{1,2}(?::[0-9]{2})?\s*(?:בבוקר|בוקר|בצהריים|צהריים|אחרי הצהריים|אחה"צ|בערב|ערב|בלילה|לילה)(?=$|[\s,.،])/.source,
  /(?:בשעה|שעה|בסביבות(?:\s+ה?שעה)?|סביב(?:\s+ה?שעה)?|לקראת(?:\s+ה?שעה)?|עד(?:\s+ה?שעה)?|[בס]-)\s*[0-9]{1,2}(?::[0-9]{2})?(?=$|[\s,.،])/.source,
  // Last, after the marked shapes: `stripTiming` runs these in order, and a
  // bare `4:30` taken out first left «الساعة» behind in the title (CL1
  // round 7). The counter anchors on digit positions, so its order is moot.
  /\b\d{1,2}:\d{2}(?=$|[\s,.،])/.source,
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

/**
 * Minutes on a bare early hour (CL1 round 7, I-3): `4:30`, `5:00` — one digit,
 * one to six, no leading zero. The colon does not say which half of the day;
 * "at 4:30" is as ambiguous as "at 4". `04:30` and `16:30` are not.
 */
const BARE_EARLY_HHMM = /(?<![\d:])[1-6]:\d{2}(?=$|[\s,.،])/;

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
    /(?:الساعة|الساعه|عند|على)\s*[0-9]{1,2}(?::[0-9]{2})?(?=$|[\s,.،])/.source,
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
 * had with someone («غدا مع …») *and* the sentence names its day some other
 * way — «بكرا», «اليوم», a weekday. Otherwise it is tomorrow, as it always
 * was: «اجتماع غدا مع العميل الساعة 11» is a meeting tomorrow with the client
 * (POLISH-CAPTURE review, I1).
 */
const AR_OTHER_DAY_WORD = `${NOT_LETTER_BEFORE}${AR_PROCLITIC}(?:بكرا|بكرة|بكره|باچر|باكر|اليوم|النهارده|النهاردة|الليلة|الليله|الأحد|الاحد|الاثنين|الإثنين|الأثنين|الثلاثاء|الثلثاء|الأربعاء|الاربعاء|الخميس|الجمعة|الجمعه|السبت)${NOT_LETTER_AFTER}`;
const AR_LUNCH_NOT_TOMORROW = `غد\\p{M}*ا(?!\\s+مع(?![\\p{L}\\p{M}])(?:(?=[\\s\\S]*${AR_OTHER_DAY_WORD})|(?<=${AR_OTHER_DAY_WORD}[\\s\\S]*)))`;
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
    `${NOT_LETTER_BEFORE}يوم\\s*[0-9٠-٩]{1,2}(?![0-9٠-٩:])`,
    `${NOT_LETTER_BEFORE}(?:ب|بـ)\\s*[0-9٠-٩]{1,2}\\s+(?:من\\s+)?(?:ال|هال|ل)?شهر`,
    `${NOT_LETTER_BEFORE}ב-?\\s*[0-9]{1,2}\\s+(?:ל|ב)?חודש`,
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
    // The night's end, and its midnight, run past today's date (N-M1): «آخر
    // الليل», «نص الليل», «الساعة 12 بالليل», "midnight", «חצות»
    `${NOT_LETTER_BEFORE}${AR_PROCLITIC}(?:آخر|اخر|نص|نصف|منتصف)\\s+(?:ال)?ليل${NOT_LETTER_AFTER}`,
    `(?:الساعة|الساعه|${NOT_LETTER_BEFORE})\\s*(?:12|١٢)\\s*(?:بالليل|الليل|بليل)${NOT_LETTER_AFTER}`,
    '\\bmidnight\\b|\\b12\\s*(?:at\\s+night|tonight|midnight)\\b',
    `${NOT_LETTER_BEFORE}[בל]?חצות${NOT_LETTER_AFTER}|(?:בשעה|ב-?)\\s*12\\s+בלילה${NOT_LETTER_AFTER}`,
  ].join('|'),
  'iu',
);

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
  return HHMM.test(text) || AMPM.test(text) || CLOCK_MARKER.test(text);
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
  const text = normalizeSpokenHebrewHours(normalizeSpokenArabicHours(normalizeArabicDigits(rawText)));
  if (RANGE_PATTERN_SOURCES.some((source) => new RegExp(source, 'i').test(text))) return 'event';
  if (DEADLINE_MARKER.test(text)) return 'deadline';
  return CLOCK_PATTERN_SOURCES.some((source) => new RegExp(source, 'i').test(text)) ? 'event' : null;
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
const CLOCK_NUMBER = /(?:\b(?:at|by|around)|الساعة|الساعه|عند|على|בשעה|שעה|[בס]-)\s*(\d{1,2})(?::\d{2})?(?=$|[\s,.،])|\b(\d{1,2})\s*o'?clock\b|(?<![\d:])([1-6]):\d{2}(?=$|[\s,.،])/gi;

/**
 * A typed bare hour from one to six with no part of the day — «الساعة 4»,
 * "at 4", «ב-4» (FY1 re-review). The rules would read it as the morning, the
 * unlikely half; as an answer it is not understood, and the question's
 * صبح/مسا buttons stay (CL1 round 6 applied to answers).
 */
export function isBareEarlyHourAnswer(rawText: string): boolean {
  if (typeof rawText !== 'string' || timeOfDayEvidence(rawText) !== 'clock_marker') return false;
  const hours = Array.from(normalizeClockText(rawText).matchAll(CLOCK_NUMBER), (match) => Number(match[1] ?? match[2] ?? match[3]));
  return hours.length > 0 && hours.every((hour) => hour >= 1 && hour <= 6);
}

const TIME_OF_DAY_STRIP = [
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
  let stripped = normalizeClockFractions(normalizeSpokenHebrewHours(normalizeSpokenArabicHours(rawText)));
  for (const pattern of TIME_OF_DAY_STRIP) stripped = stripped.replace(pattern, ' ');
  return stripped.replace(/[ \t]+/g, ' ').trim();
}

/** The last day of the month `now` falls in, on the user's own clock, `YYYY-MM-DD`. */
export function lastDayOfMonth(now: Date, timeZone: string): string {
  const today = localTimeSpecFor(now, timeZone)?.date ?? now.toISOString().slice(0, 10);
  const [year, month] = today.split('-').map(Number) as [number, number];
  // Day 0 of the next month is the last day of this one.
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}
