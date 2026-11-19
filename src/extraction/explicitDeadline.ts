/**
 * Did the person name a limit? (Owner decision 2026-11-19, «ما اتصرّفت فيها».)
 *
 * Capture writes a `due_by` for every item with a day and no hour, so «بدي
 * أدرس الثلاثاء» was a `due_by` like «لازم أسلّم التقرير قبل الخميس», and
 * the place listed a study session as a missed hand-in. Only a limit the
 * person said is one: this reads the person's own words for it, so capture
 * can store `timeSpec.deadline: 'explicit'` and the place can list only those.
 *
 * Deterministic and in code on purpose: the model is not asked, so its prompt
 * and the pinned fingerprints stay exactly as they were, and no evaluation
 * has to be paid for.
 *
 * ── Conservative ─────────────────────────────────────────────────
 *
 * A miss leaves a deadline out of the place, where it stays on Today (#383);
 * a false hit puts an ordinary task in the place as a missed deadline, which
 * is the defect this exists to remove. So a word that also means something
 * else counts only when a time follows it:
 *
 *   - always a limit: «آخر موعد», «أقصى موعد», «تسليم» / «موعد التسليم»,
 *     «ديدلاين»; "deadline", "due date", "no later than"; «דדליין», «הגשה»;
 *   - a limit only before a time — a day, «بكرة», «الساعة», a date, «آخر
 *     الشهر»: «قبل», «لحد», «لغاية»; "by", "before", "due"; «עד», «לפני».
 *     «قبل ما أنام», «قبل النوم», «قبل يومين», «لحد ما يخلص», "before I
 *     leave", "by bus", "before 5 minutes", «לפני שאני הולך», «עד שזה נגמר»
 *     name none.
 *
 * The words are matched as whole words after the same spelling folds the
 * lexicon uses (hamza forms, ة/ه, ى/ي, no tashkeel, Arabic digits).
 */

/** Whole words that are a limit on their own. Folded spellings. */
const ALWAYS = new Set([
  'ديدلاين',
  'deadline', 'deadlines',
  'דדליין', 'הדדליין', 'לדדליין',
  'הגשה', 'ההגשה', 'להגשה', 'בהגשה', 'והגשה',
]);

/** Limits of more than one word. Folded spellings. */
const ALWAYS_PHRASES: ReadonlyArray<readonly string[]> = [
  ['اخر', 'موعد'],
  ['اقصي', 'موعد'],
  ['due', 'date'],
  ['no', 'later', 'than'],
];

/** «تسليم» with the prefixes it takes: «التسليم», «للتسليم», «بالتسليم»… — never the verb «أسلّم». */
const HAND_IN = /^(?:و|ف)?(?:ب|ل|لل|ال|بال)?تسليم$/;

/** A limit only when a time follows. */
const BEFORE_A_TIME = new Set([
  'قبل', 'وقبل', 'لحد', 'ولحد', 'لغايه', 'ولغايه',
  'by', 'before', 'due',
  'עד', 'ועד', 'לפני', 'ולפני',
]);

/** Words passed over between the marker and its time: «قبل يوم الخميس», "by the 5th", "due on Friday", «עד יום חמישי», «עד ה-5». */
const SKIP = new Set(['يوم', 'the', 'on', 'by', 'יום', 'ליום', 'ה', 'ל']);

/** A time on its own. Folded spellings. */
const TIME = new Set([
  // Arabic: the days, the relative days, the parts of the day, the clock.
  'الاحد', 'احد', 'الاثنين', 'اثنين', 'الاتنين', 'اتنين', 'التنين',
  'الثلاثاء', 'ثلاثاء', 'الثلاثا', 'التلاتا', 'التلاته', 'الاربعاء', 'اربعاء', 'الاربعا', 'الخميس', 'خميس',
  'الجمعه', 'جمعه', 'السبت', 'سبت',
  'بكره', 'بكرا', 'غدا', 'اليوم', 'الليله', 'الظهر', 'الضهر', 'العصر', 'المغرب', 'العشا', 'العشاء',
  'المسا', 'المساء', 'الصبح', 'الساعه',
  // English.
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
  'today', 'tonight', 'tomorrow', 'tmrw', 'tmr', 'noon', 'midday', 'midnight', 'eod', 'eow', 'cob',
  'morning', 'afternoon', 'evening', 'weekend',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  // Hebrew.
  'ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת', 'השבת',
  'היום', 'מחר', 'מחרתיים', 'הערב', 'הלילה', 'הבוקר', 'הצהריים', 'הצהרים', 'השעה',
]);

/** A word that is a time only with the period after it: «آخر الشهر», "end of the week", "next Friday", «סוף החודש». */
const PERIOD_HEAD = new Set([
  'اخر', 'نهايه', 'اول', 'نص', 'منتصف',
  'end', 'next', 'this',
  'סוף', 'אמצע', 'תחילת',
]);
const PERIOD = new Set([
  'الشهر', 'الاسبوع', 'السنه', 'الدوام', 'النهار', 'اليوم', 'الليل', 'الفصل', 'الترم', 'السمستر',
  'of', 'week', 'month', 'year', 'weekend', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'החודש', 'השבוע', 'השנה', 'היום', 'הסמסטר',
]);

/** A number followed by one of these is a length, not a time: «قبل 3 أيام», "by 2 hours", «עד 5 דקות». */
const LENGTH = new Set([
  'دقيقه', 'دقايق', 'دقائق', 'ساعه', 'ساعات', 'ساعتين', 'يوم', 'ايام', 'يومين', 'اسبوع', 'اسابيع', 'اسبوعين',
  'شهر', 'شهور', 'اشهر', 'شهرين', 'سنه', 'سنين', 'سنوات',
  'minute', 'minutes', 'min', 'mins', 'hour', 'hours', 'hr', 'hrs', 'day', 'days', 'week', 'weeks',
  'month', 'months', 'year', 'years', 'people', 'times', 'percent',
  'דקה', 'דקות', 'שעה', 'שעות', 'ימים', 'יומיים', 'שבוע', 'שבועות', 'חודש', 'חודשים', 'שנה', 'שנים', 'אנשים',
]);

function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06F0));
}

function wordsOf(text: string): string[] {
  return fold(text).split(/[^0-9a-z֐-׿ؠ-يٮ-ۓ]+/).filter(Boolean);
}

/** Whether a time starts at word `at`. */
function timeAt(words: readonly string[], at: number): boolean {
  const word = words[at];
  if (word === undefined) return false;
  if (TIME.has(word)) return true;
  if (/^\d/.test(word)) return !LENGTH.has(words[at + 1] ?? '');
  if (PERIOD_HEAD.has(word)) return PERIOD.has(words[at + 1] ?? '');
  return false;
}

/** Whether the person's words name a limit. Pure; false for anything that is not text. */
export function namesExplicitDeadline(text: unknown): boolean {
  if (typeof text !== 'string' || !text.trim()) return false;
  const words = wordsOf(text);
  return words.some((word, index) => {
    if (ALWAYS.has(word) || HAND_IN.test(word)) return true;
    if (ALWAYS_PHRASES.some((phrase) => phrase.every((part, offset) => words[index + offset] === part))) return true;
    if (!BEFORE_A_TIME.has(word)) return false;
    let at = index + 1;
    while (at < index + 3 && SKIP.has(words[at] ?? '') && !timeAt(words, at)) at += 1;
    return timeAt(words, at);
  });
}
