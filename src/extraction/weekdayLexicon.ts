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
import { localTimeSpecFor, relativeDaySource } from './timeLexicon';

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
  // Without the article, only inside a frame that makes them days (FIX-R8-
  // CAPTURE): «يوم سبت», «كل سبت», «كل يوم خميس» — see `AR_BARE_DAY`.
  'أحد': 0,
  'احد': 0,
  'اثنين': 1,
  'إثنين': 1,
  'ثلاثاء': 2,
  'ثلثاء': 2,
  'أربعاء': 3,
  'اربعاء': 3,
  'خميس': 4,
  'جمعة': 5,
  'جمعه': 5,
  'سبت': 6,
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

/*
 * ══ A WEEKDAY IS A WHOLE WORD, AND AN AMBIGUOUS ONE IS NOT A WEEKDAY ══
 *
 * The first version matched day names as substrings, the way the rules path
 * always had. Review found the words that contain them: «الأحداث» (events),
 * «الأحدث» (newest), «الاثنين» meaning "both", and the Hebrew ordinals
 * «הראשון», «השני» — "the first report", "the second chapter". Each became a
 * Sunday or a Monday. So a mention is a whole word (no letter or mark on either
 * side), and where a word has an ordinary second meaning it counts only in the
 * frame that makes it a day:
 *
 *   «الاثنين»      only after «يوم» or a deadline preposition («قبل», «حتى»),
 *                  or before «الجاي/القادم/اللي» or an hour word («الساعة»,
 *                  «الصبح», «المسا»…) — never bare.
 *   ראשון…שישי     only as «יום X» / «ביום X». Bare «ראשון» is "first".
 *   «שבת»          as a word of its own, or «בשבת»; not «השבת».
 *
 * When a word is ambiguous the answer is "no weekday": the price of a miss is
 * an item asking which day, the price of a false hit is a wrong day.
 */
const NOT_LETTER_BEFORE = '(?<![\\p{L}\\p{M}])';
const NOT_LETTER_AFTER = '(?![\\p{L}\\p{M}])';
const AR_COMING = '(?:الجاي|الجاية|الجايه|الجّاي|القادم|القادمة)';
const AR_SUFFIX = '(?:\\s+(?:الجاي|الجاية|الجايه|الجّاي|القادم|القادمة|الماضي|الماضية))?';
const AR_UNAMBIGUOUS_DAY = '(الأحد|الاحد|الثلاثاء|الثلثاء|الأربعاء|الاربعاء|الخميس|الجمعة|السبت)';
const AR_MONDAY = '(الاثنين|الإثنين|الأثنين)';
const AR_HOUR_WORD = '(?:اللي|الّي|الساعة|الساعه|الصبح|الصباح|الظهر|الضهر|العصر|المسا|المساء|بالليل|عالساعة)';
const HE_SUFFIX = '(?:\\s+(?:הבא|הבאה|הקרוב|הקרובה))?';
/*
 * A day name without «ال» (FIX-R8-CAPTURE, the owner's «كل سبت»). Spoken
 * Levantine drops the article after «يوم» and «كل»: «يوم سبت», «كل سبت», «كل
 * يوم خميس». Bare, every one of these has an ordinary second meaning — «أحد»
 * is "anyone", «اثنين» "two", «جمعة» "a week" — so each counts only in its
 * frame: any of them after «يوم»; after «كل» alone only the four whose other
 * meaning cannot follow «كل» («كل أحد» is "everyone", «كل اثنين» "every
 * two", «كل جمعة» "every week" as often as "every Friday").
 */
const AR_BARE_DAY = '(أحد|احد|اثنين|إثنين|ثلاثاء|ثلثاء|أربعاء|اربعاء|خميس|جمعة|جمعه|سبت)';
const AR_BARE_DAY_AFTER_EVERY = '(ثلاثاء|ثلثاء|أربعاء|اربعاء|خميس|سبت)';

/** Every whole-word weekday mention, as sources. Group 1 is the day name. */
const MENTION_SOURCES: readonly string[] = [
  `\\b${EN_DAY}\\b`,
  `${NOT_LETTER_BEFORE}(?:يوم\\s+)?و?${AR_UNAMBIGUOUS_DAY}${AR_SUFFIX}${NOT_LETTER_AFTER}`,
  `${NOT_LETTER_BEFORE}و?يوم\\s+${AR_BARE_DAY}${AR_SUFFIX}${NOT_LETTER_AFTER}`,
  `(?<=${NOT_LETTER_BEFORE}كل\\s+)${AR_BARE_DAY_AFTER_EVERY}${NOT_LETTER_AFTER}`,
  `${NOT_LETTER_BEFORE}يوم\\s+${AR_MONDAY}${AR_SUFFIX}${NOT_LETTER_AFTER}`,
  `${NOT_LETTER_BEFORE}و?${AR_MONDAY}(?:\\s+${AR_COMING}${NOT_LETTER_AFTER}|(?=\\s+${AR_HOUR_WORD}${NOT_LETTER_AFTER}))`,
  // «قبل الاثنين», «حتى الاثنين» — a deadline preposition makes it a day. Not
  // «بين الاثنين» ("between the two"), and the preposition stays in the title.
  `(?<=${NOT_LETTER_BEFORE}(?:قبل|حتى|لحد|لغاية|للغاية)\\s+)${AR_MONDAY}${AR_SUFFIX}${NOT_LETTER_AFTER}`,
  `${NOT_LETTER_BEFORE}ו?ב?יום\\s+${HE_DAY}${HE_SUFFIX}${NOT_LETTER_AFTER}`,
  `${NOT_LETTER_BEFORE}ו?ב?(שבת)${HE_SUFFIX}${NOT_LETTER_AFTER}`,
];

/**
 * The same mentions, for `stripTiming` to lift out of a title whole — «يوم»
 * and «الجاي» with them — and nothing else: «الأحداث» stays in the title.
 */
export const WEEKDAY_MENTION_SOURCES: readonly string[] = MENTION_SOURCES.slice(1);

interface Mention { weekday: number; index: number }

function firstMention(lower: string): Mention | null {
  let best: Mention | null = null;
  for (const source of MENTION_SOURCES) {
    const match = new RegExp(source, 'u').exec(lower);
    if (!match) continue;
    const weekday = WEEKDAY_INDEX[match[1]!];
    if (weekday !== undefined && (best === null || match.index < best.index)) best = { weekday, index: match.index };
  }
  return best;
}

/*
 * ══ A LIST OF DAYS IS EVERY DAY IN IT (audit 2026-10-03 #1) ══
 *
 * "Every Tuesday and Thursday at 7 PM" was read as Tuesday alone: the weekday
 * rules read the first mention, so the Thursday item was moved onto Tuesday
 * and three items sat at one hour. A day named in a list after another day —
 * "Tuesday and Thursday", "Tuesday, Thursday", «الثلاثاء والخميس», «كل ثلاثاء
 * وخميس», «כל יום שלישי וחמישי» — is a day the person said as well. The bare
 * Arabic and Hebrew names count here only right after «و» that follows a day:
 * the list is the frame that makes them days, as «يوم» and «كل» are.
 */
const LIST_JOINER_EN = '(?:\\s*,\\s*(?:and\\s+|&\\s*)?|\\s+(?:and|&)\\s+|\\s*&\\s*)(?:on\\s+)?(?:every\\s+|each\\s+)?';
const LIST_CONTINUATIONS: readonly RegExp[] = [
  new RegExp(`^${LIST_JOINER_EN}${EN_DAY}s?\\b`, 'u'),
  new RegExp(`^\\s*[,،]?\\s*و\\s*(?:كل\\s+)?(?:يوم\\s+)?(?:ال)?${AR_BARE_DAY}${NOT_LETTER_AFTER}`, 'u'),
  new RegExp(`^\\s*,?\\s*ו\\s*(?:ב?יום\\s+)?${HE_DAY}${NOT_LETTER_AFTER}`, 'u'),
];

/** The days listed right after a mention that ends at `end`, in order, with where the list ends. */
function listedAfter(lower: string, end: number): { weekdays: number[]; end: number } {
  const weekdays: number[] = [];
  let position = end;
  // Bounded: a week has seven days, and a list is never longer.
  for (let step = 0; step < 7; step += 1) {
    const rest = lower.slice(position, position + 40);
    let advanced = false;
    for (const pattern of LIST_CONTINUATIONS) {
      const match = pattern.exec(rest);
      const name = match?.slice(1).find((group) => group !== undefined);
      const weekday = name === undefined ? undefined : WEEKDAY_INDEX[name];
      if (match && weekday !== undefined) {
        weekdays.push(weekday);
        position += match[0].length;
        advanced = true;
        break;
      }
    }
    if (!advanced) break;
  }
  return { weekdays, end: position };
}

/** Every weekday the text names, first said first, each once — a list's later days included. */
function allMentions(lower: string): Mention[] {
  const found: Mention[] = [];
  for (const source of MENTION_SOURCES) {
    for (const match of Array.from(lower.matchAll(new RegExp(source, 'gu')))) {
      const weekday = WEEKDAY_INDEX[match[1]!];
      if (weekday === undefined) continue;
      const index = match.index ?? 0;
      found.push({ weekday, index });
      const listed = listedAfter(lower, index + match[0].length);
      listed.weekdays.forEach((listedDay, offset) => found.push({ weekday: listedDay, index: index + 1 + offset }));
    }
  }
  found.sort((left, right) => left.index - right.index);
  const seen = new Set<number>();
  return found.filter((mention) => (seen.has(mention.weekday) ? false : (seen.add(mention.weekday), true)));
}

/** «اللي بعده» and «اللي بعد الجاي» spellings of "which". */
const AR_WHICH = '(?:اللي|الّي|الي|إللي|يلي)';

/**
 * Rule 2's phrases, per language. Each names a weekday and asks for the one
 * after the coming one. They are matched before the bare name, and
 * `FOLLOWING_WEEK_STRIP_SOURCES` removes exactly these from a title.
 */
const FOLLOWING_WEEK_SOURCES: readonly string[] = [
  // «مش هالأحد، اللي بعده» / «مش هاد الأحد اللي بعده»
  `مش\\s+(?:ه|هذا\\s+|هاد\\s+|هادا\\s+)?${AR_DAY}\\s*[,،]?\\s*${AR_WHICH}\\s+بعده${NOT_LETTER_AFTER}`,
  // «الأحد اللي بعد الجاي» / «الأحد بعد الجاي»
  `${NOT_LETTER_BEFORE}(?:يوم\\s+)?${AR_DAY}\\s+(?:${AR_WHICH}\\s+)?بعد\\s+${AR_COMING}${NOT_LETTER_AFTER}`,
  // "the Sunday after next"
  `\\b(?:the\\s+)?${EN_DAY}\\s+after\\s+next\\b`,
  // «בעוד שבוע ביום ראשון» / «ביום ראשון בעוד שבוע»
  `בעוד\\s+שבוע\\s+(?:ב?יום\\s+${HE_DAY}|ב?(שבת))${NOT_LETTER_AFTER}`,
  `${NOT_LETTER_BEFORE}(?:ב?יום\\s+${HE_DAY}|ב?(שבת))\\s+בעוד\\s+שבוע${NOT_LETTER_AFTER}`,
];

/** The same phrases as sources, for `stripTiming` to lift out of a title whole. */
export const FOLLOWING_WEEK_STRIP_SOURCES: readonly string[] = FOLLOWING_WEEK_SOURCES;

function followingWeekMention(lower: string): Mention | null {
  for (const source of FOLLOWING_WEEK_SOURCES) {
    const match = new RegExp(source, 'u').exec(lower);
    const name = match?.slice(1).find((group) => group !== undefined);
    const weekday = name === undefined ? undefined : WEEKDAY_INDEX[name];
    if (match && weekday !== undefined) return { weekday, index: match.index };
  }
  return null;
}

function withoutFollowingWeekPhrases(lower: string): string {
  let text = lower;
  for (const source of FOLLOWING_WEEK_SOURCES) text = text.replace(new RegExp(source, 'gu'), ' ');
  return text;
}

/** Rule 3: the text says today, or now. */
// The relative days are `timeLexicon`'s, so «واليوم», «ومחר» and «למחר» read
// the same here as in the parser (CL1 review m-1).
const TODAY_TOKEN = new RegExp(
  `${relativeDaySource(0)}|${NOT_LETTER_BEFORE}(?:هلأ|هلّأ|هلق|هلّق|עכשיו)${NOT_LETTER_AFTER}`,
  'u',
);

/** Another relative day beside the weekday: the weekday may not be the date. */
const OTHER_RELATIVE_DAY = new RegExp(`${relativeDaySource(1)}|${relativeDaySource(2)}`, 'u');

const MONTHS_EN = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTHS_AR = '(?:يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر|كانون\\s+(?:الثاني|الأول|الاول)|شباط|آذار|اذار|نيسان|أيار|ايار|حزيران|تموز|آب|أيلول|ايلول|تشرين\\s+(?:الأول|الاول|الثاني))';
const MONTHS_HE = 'ב?(?:ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר)';

/**
 * A date the text states some other way than a weekday: a calendar date, an
 * ordinal day, a count of days or weeks. Matched against the text with
 * Arabic-Indic and Persian digits already folded to Latin ones.
 */
const EXPLICIT_DATE = new RegExp(
  [
    // 4/10, 4.10.2026, 4-10
    '(?<!\\d)\\d{1,2}[/.\\-]\\d{1,2}(?:[/.\\-]\\d{2,4})?(?!\\d)',
    // Oct 4, 4 October, the 4th, Sunday 4th
    `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTHS_EN}\\b`,
    `\\b${MONTHS_EN}\\s+\\d{1,2}\\b`,
    '\\b\\d{1,2}(?:st|nd|rd|th)\\b',
    '\\bthe\\s+\\d{1,2}\\b',
    `\\d{1,2}\\s*(?:من\\s+)?(?:شهر\\s+)?${MONTHS_AR}`,
    `\\d{1,2}\\s*${MONTHS_HE}`,
    // in two weeks, in 3 days, next week, next month, week after next
    '\\bin\\s+(?:a|an|one|two|three|four|five|six|a\\s+couple\\s+of|\\d+)\\s+(?:days?|weeks?|months?)\\b',
    '\\b(?:next|this|coming|following)\\s+(?:week|month|year)\\b',
    '\\bweek\\s+after\\s+next\\b',
    '\\b\\d+\\s+(?:days?|weeks?)\\s+from\\b',
    // «بعد أسبوعين», «بعد ٣ أيام», «الأسبوع الجاي», «الشهر الجاي»
    `${NOT_LETTER_BEFORE}بعد\\s+(?:أسبوع|اسبوع|أسبوعين|اسبوعين|جمعة|جمعتين|شهر|شهرين|يوم|يومين|\\d+\\s*(?:أيام|ايام|يوم|أسابيع|اسابيع|أسبوع|اسبوع))${NOT_LETTER_AFTER}`,
    `${NOT_LETTER_BEFORE}(?:الأسبوع|الاسبوع|الجمعة|الشهر)\\s+(?:الجاي|الجاية|القادم|القادمة|اللي\\s+بعده)${NOT_LETTER_AFTER}`,
    // «בעוד שבועיים», «בעוד 3 ימים», «בשבוע הבא», «בחודש הבא»
    `${NOT_LETTER_BEFORE}בעוד\\s+(?:שבוע|שבועיים|חודש|חודשיים|יום|יומיים|\\d+\\s*(?:ימים|שבועות|חודשים)|שלושה|ארבעה)${NOT_LETTER_AFTER}`,
    `${NOT_LETTER_BEFORE}ב(?:שבוע|חודש)\\s+הבא${NOT_LETTER_AFTER}`,
  ].join('|'),
  'iu',
);

function foldDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (digit) => {
    const arabic = '٠١٢٣٤٥٦٧٨٩'.indexOf(digit);
    return String(arabic !== -1 ? arabic : '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit));
  });
}

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
  const following = followingWeekMention(lower);
  if (following) return { weekday: following.weekday, weeksLater: 1, today };
  const mention = firstMention(lower);
  return mention ? { weekday: mention.weekday, weeksLater: 0, today } : null;
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

/**
 * True when the text states the date some other way as well — a calendar date,
 * "the 4th", "in two weeks", «بعد أسبوعين», «בעוד שבועיים», today or tomorrow.
 * Then a weekday beside it is decoration, and whatever date was read is not
 * ours to call a guess. Rule 2's own phrases («בעוד שבוע ביום ראשון») are taken
 * out first: they are weekday resolutions, not a second date.
 */
export function namesExplicitDate(rawText: string): boolean {
  if (typeof rawText !== 'string' || !rawText.trim()) return false;
  const text = withoutFollowingWeekPhrases(foldDigits(rawText.toLowerCase()));
  return EXPLICIT_DATE.test(text) || TODAY_TOKEN.test(text) || OTHER_RELATIVE_DAY.test(text);
}

/**
 * A date the text states other than by a day word or a weekday — a calendar
 * date, an ordinal day, a count of days or weeks (`namesExplicitDate` without
 * today and tomorrow; FZ1 N10).
 */
export function namesCalendarDate(rawText: string): boolean {
  if (typeof rawText !== 'string' || !rawText.trim()) return false;
  return EXPLICIT_DATE.test(withoutFollowingWeekPhrases(foldDigits(rawText.toLowerCase())));
}

/*
 * ══ A RECURRENCE IS SAID, NOT A DATE (FIX-R8-CAPTURE) ══
 *
 * «عندي تدريب كل سبت من الساعة 10 لـ 4» on the owner's phone became one event
 * *today*, Tuesday, at 10:00 — «سبت» without «ال» was not a day, and a clock
 * alone falls back to today. Nothing stores a weekly block yet (a later lane
 * does), so until then an item that states a recurrence is a one-off on the
 * next occurrence of its weekday by rule 1 — never today, never a day nobody
 * named — and carries `recurrenceHint` so that lane can turn it into a weekly
 * proposal. The phrase itself stays in the title («تدريب كل سبت»).
 *
 *   Arabic   «كل سبت» (the four days `AR_BARE_DAY_AFTER_EVERY` allows), «كل
 *            يوم سبت», «كل يوم السبت», «كل السبت», and the week itself: «كل
 *            أسبوع», «كل جمعة» ("every week" as often as "every Friday"),
 *            «أسبوعياً».
 *   English  "every/each Saturday", "on Saturdays", "every week", "weekly".
 *   Hebrew   «כל שבת», «בכל שבת», «כל יום ראשון», «כל שבוע», «מדי שבוע»,
 *            «שבועי/שבועית».
 *
 * «كل يوم» alone is every day, not a weekday, and is not read here.
 */
const AR_EVERY = `${NOT_LETTER_BEFORE}[وف]?(?:ب|في\\s+)?كل`;
const RECURRENCE_SOURCES: readonly string[] = [
  `${AR_EVERY}\\s+(?:يوم\\s+)?${AR_UNAMBIGUOUS_DAY}${NOT_LETTER_AFTER}`,
  `${AR_EVERY}\\s+يوم\\s+(?:${AR_BARE_DAY}|${AR_MONDAY})${NOT_LETTER_AFTER}`,
  `${AR_EVERY}\\s+${AR_BARE_DAY_AFTER_EVERY}${NOT_LETTER_AFTER}`,
  `\\b(?:every|each)\\s+${EN_DAY}\\b`,
  '\\bon\\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s\\b',
  `${NOT_LETTER_BEFORE}ו?ב?כל\\s+(?:יום\\s+${HE_DAY}|(שבת))${NOT_LETTER_AFTER}`,
];
/** The week itself, with no day in the phrase: the day comes from elsewhere in the words, or is asked. */
const WEEKLY_SOURCES: readonly string[] = [
  `${AR_EVERY}\\s+(?:أسبوع|اسبوع|جمعة|جمعه)${NOT_LETTER_AFTER}`,
  `${NOT_LETTER_BEFORE}(?:أسبوعي|اسبوعي)(?:اً|ا|ًا)?${NOT_LETTER_AFTER}`,
  '\\b(?:every|each)\\s+week\\b',
  '\\bweekly\\b',
  `${NOT_LETTER_BEFORE}ו?ב?(?:כל|מדי)\\s+שבוע${NOT_LETTER_AFTER}`,
  `${NOT_LETTER_BEFORE}(?:שבועי|שבועית)${NOT_LETTER_AFTER}`,
];
const RECURRENCE_PATTERNS = RECURRENCE_SOURCES.map((source) => new RegExp(source, 'giu'));
const WEEKLY_PATTERNS = WEEKLY_SOURCES.map((source) => new RegExp(source, 'giu'));

/** Every recurrence phrase, as sources, for `stripTiming` to keep whole in a title. */
export const RECURRENCE_PHRASE_SOURCES: readonly string[] = [...RECURRENCE_SOURCES, ...WEEKLY_SOURCES];

export interface StatedRecurrence {
  /** 0 = Sunday … 6 = Saturday, in the order said; empty when only the week was said. */
  weekdays: number[];
  /** The phrases as the person wrote them, in order. */
  phrases: string[];
}

/** The weekly recurrence the words state, or null. */
export function readRecurrence(rawText: string): StatedRecurrence | null {
  if (typeof rawText !== 'string' || !rawText.trim()) return null;
  const lower = rawText.toLowerCase();
  const found: Array<{ index: number; text: string; weekday: number | null }> = [];
  for (const pattern of RECURRENCE_PATTERNS) {
    for (const match of Array.from(lower.matchAll(pattern))) {
      const name = match.slice(1).find((group) => group !== undefined);
      const weekday = name === undefined ? undefined : WEEKDAY_INDEX[name];
      if (weekday === undefined) continue;
      const index = match.index ?? 0;
      // "every Tuesday and Thursday", «كل ثلاثاء وخميس»: the listed days recur
      // too, and the phrase runs to the list's end so a title loses all of it.
      const listed = listedAfter(lower, index + match[0].length);
      found.push({ index, text: rawText.slice(index, listed.end).trim(), weekday });
      listed.weekdays.forEach((listedDay, offset) => found.push({ index: index + 1 + offset, text: '', weekday: listedDay }));
    }
  }
  for (const pattern of WEEKLY_PATTERNS) {
    for (const match of Array.from(lower.matchAll(pattern))) {
      found.push({ index: match.index ?? 0, text: rawText.slice(match.index ?? 0, (match.index ?? 0) + match[0].length).trim(), weekday: null });
    }
  }
  if (found.length === 0) return null;
  found.sort((left, right) => left.index - right.index);
  const weekdays: number[] = [];
  for (const { weekday } of found) if (weekday !== null && !weekdays.includes(weekday)) weekdays.push(weekday);
  // "every week on Saturday", «كل أسبوع يوم السبت»: the week's day is the one named beside it.
  if (weekdays.length === 0) {
    const mention = readWeekdayReference(rawText);
    if (mention) weekdays.push(mention.weekday);
  }
  return { weekdays, phrases: found.map(({ text }) => text).filter((text) => text.length > 0) };
}

/**
 * The days the text names as one list — "Tuesday and Thursday", «الثلاثاء
 * والخميس», «שלישי וחמישי» — first said first, or empty. Two days the words
 * name apart ("Sunday, but it moved to Monday", «يوم الجمعة … ويوم الأحد» for
 * two different things) are not a list.
 */
export function readListedWeekdays(rawText: string): number[] {
  if (typeof rawText !== 'string' || !rawText.trim()) return [];
  const lower = rawText.toLowerCase();
  let best: { index: number; weekdays: number[] } | null = null;
  for (const source of MENTION_SOURCES) {
    for (const match of Array.from(lower.matchAll(new RegExp(source, 'gu')))) {
      const weekday = WEEKDAY_INDEX[match[1]!];
      if (weekday === undefined) continue;
      const index = match.index ?? 0;
      const listed = listedAfter(lower, index + match[0].length);
      if (listed.weekdays.length === 0) continue;
      if (best === null || index < best.index) best = { index, weekdays: Array.from(new Set([weekday, ...listed.weekdays])) };
    }
  }
  return best && best.weekdays.length > 1 ? best.weekdays : [];
}

/** Every weekday the text names, in the order said, each once ("Tuesday and Thursday" → 2, 4). */
export function readWeekdayMentions(rawText: string): number[] {
  if (typeof rawText !== 'string' || !rawText.trim()) return [];
  return allMentions(rawText.toLowerCase()).map((mention) => mention.weekday);
}

/**
 * The local dates every weekday the text names lands on, by rules 1 and 3 —
 * "Tuesday and Thursday" is the coming Tuesday and the coming Thursday. A
 * following-week phrase (rule 2) names one day and answers only that one, as
 * `resolveWeekdayDate` does.
 */
export function resolveWeekdayDates(rawText: string, now: Date, timeZone: string): string[] {
  const first = resolveWeekdayDate(rawText, now, timeZone);
  if (!first) return [];
  const lower = rawText.toLowerCase();
  if (followingWeekMention(lower)) return [first.date];
  const today = localTimeSpecFor(now, timeZone)?.date;
  if (!today) return [first.date];
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  const currentWeekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const saysToday = TODAY_TOKEN.test(lower);
  const dates = allMentions(lower).map((mention) => {
    const ahead = daysUntilWeekday(currentWeekday, { weekday: mention.weekday, weeksLater: 0, today: saysToday });
    return new Date(Date.UTC(year, month - 1, day + ahead)).toISOString().slice(0, 10);
  });
  return Array.from(new Set([first.date, ...dates]));
}

export interface WeekdayResolution {
  /** `YYYY-MM-DD`, on the user's clock. */
  date: string;
  /** Rule 4: false only when the text said today (rule 3). */
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
  return { date, inferred: days !== 0 };
}

/**
 * Whether a date the *model* resolved is a guess from a weekday name (L4).
 *
 * The validator never moves the model's date (controller ruling). It only says
 * whether that date came from a weekday alone: a whole-word weekday the date
 * actually falls on, and no other statement of the date. Anything ambiguous is
 * not flagged.
 */
export function modelDateIsWeekdayGuess(rawText: string, date: string | null | undefined): boolean {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const reference = readWeekdayReference(rawText);
  if (!reference || namesExplicitDate(rawText)) return false;
  return new Date(`${date}T12:00:00Z`).getUTCDay() === reference.weekday;
}
