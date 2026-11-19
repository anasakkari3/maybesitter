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
 *   - always a limit: «آخر موعد», «أقصى موعد», «تسليم» / «موعد التسليم»
 *     (unless a delivery word is beside it: «تسليم الطرد»), «ديدلاين»;
 *     "deadline", "due date", "no / not later than"; «דדליין», «הגשה»;
 *   - a limit only before a time — a day, «بكرة», «الساعة», a date, «آخر
 *     الشهر», a clock: «قبل», «لحد», «لغاية», «بحلول», «حتى»; "by", "before",
 *     "due", "until"; «עד», «לפני». A number is a time only alone, before a
 *     half of the day, a day or a month, or as «5:30» / "5pm". «حتى» before a
 *     relative day is "even" («حتى اليوم ما خلصت»). «שני» / «שלישי» are days
 *     only after «יום» or as «בשני».
 *     «قبل ما أنام», «قبل النوم», «قبل يومين», «قبل 20 شيكل», «لحد ما يخلص»,
 *     "before I leave", "by bus", "by 3 of them", «לפני שאני הולך», «לפני
 *     שני ילדים», «עד שזה נגמר» name none.
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
  ['not', 'later', 'than'],
];

/** «تسليم» with the prefixes it takes: «التسليم», «للتسليم», «بالتسليم»… — never the verb «أسلّم». */
const HAND_IN = /^(?:و|ف)?(?:ب|ل|لل|ال|بال)?تسليم$/;

/**
 * Words that make «تسليم» a hand-over, not a hand-in: «تسليم الطرد», «استلم
 * وتسليم الأكل», «توصيل وتسليم» (review 2026-11-19). Read within
 * `DELIVERY_REACH` words either side.
 */
const DELIVERY = new Set([
  'طرد', 'الطرد', 'طرود', 'الطرود', 'اكل', 'الاكل', 'استلم', 'استلام', 'الاستلام', 'توصيل', 'التوصيل', 'وتوصيل',
  'طلبيه', 'الطلبيه', 'الطلب', 'شحنه', 'الشحنه', 'دليفري', 'الدليفري', 'المفتاح', 'المفاتيح', 'البريد', 'باكيت', 'الباكيت',
]);
const DELIVERY_REACH = 3;

/** A limit only when a time follows. */
const BEFORE_A_TIME = new Set([
  'قبل', 'وقبل', 'لحد', 'ولحد', 'لغايه', 'ولغايه', 'بحلول', 'وبحلول', 'حتي', 'وحتي',
  'by', 'before', 'due', 'until',
  'עד', 'ועד', 'לפני', 'ולפני',
]);

/**
 * «حتى» is "even" as often as "until": «حتى اليوم ما خلصت», «حتى بكرة بدي
 * أرتاح». After it a relative day is the "even", so only a day name, a clock
 * or a date makes it a limit.
 */
const EVEN = new Set(['حتي', 'وحتي']);
const RELATIVE_DAY = new Set(['اليوم', 'بكره', 'بكرا', 'غدا', 'الليله', 'هلق', 'الان']);

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
  // «שני» and «שלישי» are also "two" and "third": a day only as «בשני», or after «יום» (`HEBREW_NUMBER_DAYS`).
  'ראשון', 'בשני', 'בשלישי', 'רביעי', 'חמישי', 'שישי', 'שבת', 'השבת',
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

/** «שני» / «שלישי» after one of these is Monday / Tuesday, not "two" / "third". */
const HEBREW_NUMBER_DAYS = new Set(['שני', 'שלישי']);
const HEBREW_DAY_WORD = new Set(['יום', 'ליום']);

/** The half of the day after a bare number: «5 المسا», "5 pm", «5 בערב». */
const HALF_OF_DAY = new Set([
  'am', 'pm', 'الصبح', 'المسا', 'المساء', 'الظهر', 'الضهر', 'العصر', 'صباحا', 'مساء', 'بالليل',
  'בבוקר', 'בערב', 'בצהריים', 'בצהרים', 'בלילה',
]);

/**
 * A month after a number makes it a date: «قبل 15 آذار», «قبل ٣ تموز», "by 5
 * May", «לפני ה-5 בדצמבר»; and «٣ الشهر», the 3rd of this month. Folded
 * spellings, Levantine and Standard Arabic month names both (review
 * 2026-11-19, round 2). Only after a number: «آب» and "may" alone are words.
 */
const MONTH_AFTER_NUMBER = new Set([
  'الشهر',
  'كانون', 'شباط', 'اذار', 'نيسان', 'ايار', 'حزيران', 'تموز', 'اب', 'ايلول', 'تشرين',
  'يناير', 'فبراير', 'مارس', 'ابريل', 'مايو', 'ماي', 'يونيو', 'يوليو', 'اغسطس', 'سبتمبر', 'اكتوبر', 'نوفمبر', 'ديسمبر',
  'may',
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
  'בינואר', 'בפברואר', 'במרץ', 'באפריל', 'במאי', 'ביוני', 'ביולי', 'באוגוסט', 'בספטמבר', 'באוקטובר', 'בנובמבר', 'בדצמבר',
  'לינואר', 'לפברואר', 'למרץ', 'לאפריל', 'למאי', 'ליוני', 'ליולי', 'לאוגוסט', 'לספטמבר', 'לאוקטובר', 'לנובמבר', 'לדצמבר',
]);

/** A date written in digits: «5/12», «12.03», «2026-12-05». A part out of range («20.50») is an amount. */
function numericDate(word: string): boolean {
  const parts = word.split(/[/.-]/).map(Number);
  if (parts.length === 3) {
    const [a, b, c] = parts as [number, number, number];
    return a > 999 ? b >= 1 && b <= 12 && c >= 1 && c <= 31 : a >= 1 && a <= 31 && b >= 1 && b <= 12;
  }
  const [a, b] = parts as [number, number];
  // Day and month either way round: «5/12» and "12/5".
  return a >= 1 && b >= 1 && ((a <= 31 && b <= 12) || (a <= 12 && b <= 31));
}

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

/** Words, with a clock «5:30» and a date «5/12», «12.03», «2026-12-05» kept whole. */
function wordsOf(text: string): string[] {
  return fold(text).match(/\d{1,4}[/.-]\d{1,2}(?:[/.-]\d{1,4})?(?![0-9]|[/.-]\d)|\d{1,2}:\d{2}|[0-9a-z\u0590-\u05FF\u0620-\u064A\u066E-\u06D3]+/g) ?? [];
}

/**
 * A number is a time only when nothing counts with it (review 2026-11-19):
 * «قبل 20 شيكل», "by 3 of them", «قبل 3 مرات» are amounts. So: a clock
 * («5:30», "5pm", "5 o'clock"), a date in digits («5/12»), or a bare number or
 * an ordinal ("the 5th") at the end, before a half of the day, a day or a
 * month («قبل 5 المسا», «قبل 15 آذار», «٣ الشهر», "by 15 March").
 */
function numberIsTime(words: readonly string[], at: number): boolean {
  const word = words[at]!;
  if (/^\d{1,2}:\d{2}$/.test(word) || /^\d{1,2}(?:am|pm)$/.test(word)) return true;
  if (/[/.-]/.test(word)) {
    // «5.5 كيلو», "12.5 kg": one dot is a decimal as often as a date, so it is
    // a date only at the end or before a time. «5/12», «2026-12-05» and
    // «5.12.2026» are dates wherever they stand.
    const next = words[at + 1];
    const decimalLike = /^\d+\.\d+$/.test(word);
    return numericDate(word) && (!decimalLike || next === undefined || TIME.has(next) || HALF_OF_DAY.has(next));
  }
  if (!/^\d+(?:st|nd|rd|th)?$/.test(word)) return false;
  const next = words[at + 1];
  if (next === 'oclock' || (next === 'o' && words[at + 2] === 'clock')) return true;
  if (next === 'of') return MONTH_AFTER_NUMBER.has(words[at + 2] ?? '') || TIME.has(words[at + 2] ?? '');
  return next === undefined || HALF_OF_DAY.has(next) || TIME.has(next) || MONTH_AFTER_NUMBER.has(next);
}

/** A day of the month at `at`, closing the phrase or before a time: the "5" of "May 5". */
function monthDayAt(words: readonly string[], at: number): boolean {
  const day = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(words[at] ?? '');
  if (!day || Number(day[1]) < 1 || Number(day[1]) > 31) return false;
  const next = words[at + 1];
  return next === undefined || TIME.has(next) || HALF_OF_DAY.has(next);
}

/** Whether a time starts at word `at`. */
function timeAt(words: readonly string[], at: number): boolean {
  const word = words[at];
  if (word === undefined) return false;
  if (TIME.has(word)) return true;
  // A month before its day: "by May 5", "May 5th", «قبل آذار 15».
  if (MONTH_AFTER_NUMBER.has(word)) return monthDayAt(words, at + 1);
  // «עד שני בערב»: a half of the day after it makes it Monday too.
  if (HEBREW_NUMBER_DAYS.has(word)) return HEBREW_DAY_WORD.has(words[at - 1] ?? '') || HALF_OF_DAY.has(words[at + 1] ?? '');
  if (/^\d/.test(word)) return numberIsTime(words, at);
  if (PERIOD_HEAD.has(word)) return PERIOD.has(words[at + 1] ?? '');
  return false;
}

/** Whether the person's words name a limit. Pure; false for anything that is not text. */
export function namesExplicitDeadline(text: unknown): boolean {
  if (typeof text !== 'string' || !text.trim()) return false;
  const words = wordsOf(text);
  return words.some((word, index) => {
    if (ALWAYS.has(word)) return true;
    if (HAND_IN.test(word)) {
      return !words.slice(Math.max(0, index - DELIVERY_REACH), index + DELIVERY_REACH + 1).some((near) => DELIVERY.has(near));
    }
    if (ALWAYS_PHRASES.some((phrase) => phrase.every((part, offset) => words[index + offset] === part))) return true;
    if (!BEFORE_A_TIME.has(word)) return false;
    let at = index + 1;
    while (at < index + 3 && SKIP.has(words[at] ?? '') && !timeAt(words, at)) at += 1;
    if (EVEN.has(word) && RELATIVE_DAY.has(words[at] ?? '')) return false;
    return timeAt(words, at);
  });
}
