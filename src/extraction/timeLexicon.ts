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
    ar: 'بعد\\s+(?:الظهر|الضهر)|العصر|[بع]العصرية|[بع]العصريه',
    he: 'אחרי\\s+הצהריים|אחר\\s+הצהריים|אחרי\\s+הצהרים|אחר\\s+הצהרים|אחה["״]צ',
  },
  { hour: 9, en: 'morning', ar: 'الصبح|الصباح|صباح\\p{M}*ا?|[بع]الصبحية|[بع]الصبحيه', he: 'בוקר' },
  { hour: 12, en: 'noon|midday', enStaysInTitle: true, ar: 'الظهر|الضهر', he: 'צהריים|צהרים' },
  { hour: 20, en: 'night', enAlways: 'tonight', ar: 'الليل|الليلة|الليله', he: 'לילה' },
  { hour: 18, en: 'evening', ar: 'المساء?|مساء\\p{M}*ا?', he: 'ערב' },
];

/**
 * A title loses the preposition with the part of the day — "call mom at
 * noon" is "call mom", not "call mom at".
 */
const EN_STRIP_LEAD = '(?:\\b(?:in|during|at|by|around|before|after|until|till|from|through|on|for|this)\\s+(?:the\\s+)?)?';

function dayPartSources(words: DayPartWords, mode: 'text' | 'answer' | 'strip'): string[] {
  const en = mode === 'answer'
    // A typed answer to "when?" is a time by being the answer: "morning is fine".
    ? `${EN_NOT_GREETING}\\b(?:${words.en})\\b`
    : `${mode === 'strip' ? EN_STRIP_LEAD : ''}${EN_NOT_GREETING}(?:(?<=\\b${EN_ANCHOR}\\s+)\\b(?:${words.en})\\b|\\b(?:${words.en})\\b(?!\\s+(?!${EN_FOLLOW}\\b)[a-z]))${EN_NOT_OPENING_GREETING}`;
  return [
    ...(words.enAlways ? [`\\b(?:${words.enAlways})\\b`] : []),
    ...(mode === 'strip' && words.enStaysInTitle ? [] : [en]),
    `${NOT_LETTER_BEFORE}${AR_PROCLITIC}(?:${words.ar})\\p{M}*${NOT_LETTER_AFTER}${AR_NOT_GREETING}`,
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
const RELATIVE_DAYS: ReadonlyArray<{ offset: number; en: string; ar: string; he: string }> = [
  { offset: 2, en: 'day\\s+after\\s+tomorrow|after\\s+tomorrow|after\\s+tmrw', ar: 'بعد\\s+(?:بكرا|بكرة|بكره|غد\\p{M}*ا?)', he: 'מחרתיים' },
  { offset: 1, en: 'tomorrow|tmrw|tmr|tomorow', ar: 'بكرا|بكرة|بكره|باچر|باكر|غد\\p{M}*ا', he: 'מחר' },
  {
    offset: 0,
    en: 'today|tonight|this\\s+(?:morning|afternoon|evening)',
    ar: 'اليوم|النهارده|اليومه|الليلة|الليله|ه(?:المسا|المساء|الصبح|العصر|الضهر|الظهر)',
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
 * Every relative-day mention, as sources, for `stripTiming` to lift out of a
 * title with its proclitic («واليوم» leaves no «و») and nothing else.
 */
export const RELATIVE_DAY_MENTION_SOURCES: readonly string[] = RELATIVE_DAYS.flatMap(relativeDaySources);

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
