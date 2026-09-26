/**
 * One capture, split into the commitments it actually names (#162 step 3,
 * CL1).
 *
 * Moved here from the capture boundary so the question "does this sentence
 * open a commitment?" lives next to the time lexicon it depends on, and so the
 * boundary's rules fallback can ask the same question (`hasRequestEvidence`).
 *
 * ── Where a capture splits ───────────────────────────────────────
 *
 *   ; and a line break        always
 *   then / also / and then    always, and «وبعدين / وكمان / ثم», «ואז / וגם»
 *   the Arabic comma «،»       always
 *   «و» onto an opener         «وبدي / ولازم / وذكرني», "and I need to",
 *                             «וצריך»; «وعندي» / «ויש לי» only onto an
 *                             appointment noun or a time (C1)
 *   a sentence end . ! ? ؟     only when the next sentence itself opens a
 *                             commitment and the one before it is not a bare
 *                             request (C1)
 *
 * A bare «و» is never a boundary: «أحمد وسامي» is one errand.
 *
 * ── Why a sentence end is not always a boundary (CL1 review, C1) ──
 *
 * Splitting on every «.» fixed the UAT capture and broke dictation: «عندي
 * موعد دكتور بكرا. الساعة 5 المسا» became a doctor with no time plus an item
 * called «الساعة 5 المسا». A sentence that is only a time, a day, a place or a
 * remark — «الساعة 5 المسا», «بالمكتب», "She is sick" — belongs to the one
 * before it. And a sentence that is only a request with no action — "can you
 * remind me tomorrow?" — belongs to the one after it.
 */
import { stripTimeExpressions } from './ruleBasedExtractor';
import { timeOfDayEvidence } from './timeLexicon';

const B = '(?<![\\p{L}\\p{M}])';
const A = '(?![\\p{L}\\p{M}])';

/** The word before a «.» that is not a sentence end. Only consulted for «.». */
const ABBREVIATION = new RegExp(
  '^(?:[("\'«]*)(?:dr|mr|mrs|ms|prof|st|jr|sr|vs|etc|no|acc|approx|dept|ave|[ap]\\.m|e\\.g|i\\.e|\\p{L}|(?:\\p{L}\\.)+\\p{L})$',
  'iu',
);

/** A request or an obligation, said outright. */
const REQUEST_MARKER = new RegExp(
  [
    `${B}(?:بدي|بدّي|بدنا|بدّنا|لازم|لازمني|ضروري|محتاج|محتاجة|عليّ|ذكرني|ذكّرني|ذكريني|ذكّريني|تذكرني|تذكريني|سجل|سجّل|سجلي|سجّلي|ضيف|ضيفي|حطلي|حط\\s+لي|لا\\s+تنسى|ما\\s+تنسى)${A}`,
    "\\b(?:remind\\s+me|remember\\s+to|i\\s+(?:need|have)\\s+to|i've\\s+got\\s+to|i\\s+must|need\\s+to|have\\s+to|must|don'?t\\s+forget|do\\s+not\\s+forget)\\b",
    `${B}(?:צריך|צריכה|חייב|חייבת|תזכיר|תזכירי|להזכיר|אל\\s+תשכח|לא\\s+לשכוח|תוסיף|תרשום|לרשום)${A}`,
  ].join('|'),
  'iu',
);

/** Nouns that are a commitment on their own once a time is attached. */
const COMMITMENT_NOUN = new RegExp(
  [
    `${B}(?:ال)?(?:موعد|دكتور|دكتورة|طبيب|امتحان|إمتحان|مقابلة|مقابله|اجتماع|محاضرة|تمرين|درس|حصة|جلسة|فحص|تحليل|رحلة|طيارة|عزومة|عرس|دوام|شغل)${A}`,
    '\\b(?:appointment|appt|meeting|exam|interview|flight|class|lesson|training|practice|session|dentist|doctor|check-?up)\\b',
    `${B}[הו]?(?:תור|פגישה|מבחן|בחינה|ראיון|טיסה|שיעור|אימון|רופא|רופאה)${A}`,
  ].join('|'),
  'iu',
);

/**
 * Positive evidence that a clause asks for something (CL1 review, C2): an
 * explicit request or obligation marker, or a commitment noun with a time.
 *
 * Not `classifyMessageKind`, which answers `request` for anything it does not
 * recognise — so "She is sick" and «بالمكتب» qualified, and the rules then
 * turned a model's correct "nothing here" into an item.
 */
export function hasRequestEvidence(clause: string): boolean {
  if (typeof clause !== 'string' || !clause.trim()) return false;
  if (REQUEST_MARKER.test(clause)) return true;
  return COMMITMENT_NOUN.test(clause) && timeOfDayEvidence(clause) !== 'none';
}

/** Common errand verbs opening an Arabic sentence, imperative or first person. */
const AR_LEADING_VERB = new RegExp(
  `^(?:[أاإنب]?)(?:دفع|تصل|شتري|روح|بعت|بعث|خلص|خلّص|جيب|حجز|رد|ردّ|كلم|كلّم|حكي|زور|نظف|نضف|كتب|جدد|جدّد|صلح|صلّح|طبخ|غسل|رتب|رتّب|مرق|وصل|وصّل|سلم|سلّم|جهز|جهّز|حضر|حضّر|طبع|سأل|نزل|قدم|قدّم|لغي|شوف|راجع)${A}`,
  'u',
);

/** Words that open an English sentence without being its verb. */
const EN_NON_VERB = new Set([
  'i', "i'm", 'im', 'she', 'he', 'it', "it's", 'its', 'they', 'we', 'you', 'this', 'that', 'these', 'those',
  'the', 'a', 'an', 'my', 'your', 'his', 'her', 'our', 'their', 'at', 'on', 'in', 'by', 'for', 'from', 'to',
  'with', 'about', 'around', 'before', 'after', 'until', 'till', 'tomorrow', 'today', 'tonight', 'morning',
  'afternoon', 'evening', 'night', 'next', 'then', 'also', 'and', 'or', 'but', 'so', 'no', 'yes', 'ok', 'okay',
  'thanks', 'thank', 'is', 'was', 'are', 'were', 'will', 'would', 'should', 'could', 'can', 'maybe', 'probably',
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'there', 'here', 'because',
  'since', 'if', 'when', 'where', 'what', 'who', 'how', 'why', 'not', 'just', 'only', 'very', 'really', 'am',
  'pm', 'noon', 'midnight', 'oclock', "o'clock", 'everything', 'all', 'some', 'nothing', 'hi', 'hey', 'hello',
]);

/** Words that open a Hebrew sentence and look like a verb without being one. */
const HE_NON_VERB = new Set(['לפני', 'למחר', 'לגבי', 'ליד', 'לכן', 'למה', 'לפחות', 'תודה', 'תמיד', 'תור']);

// Built from strings: the root `tsconfig.json` targets ES5, which refuses the
// `u` flag on a literal (the runtime is Node 24).
const LEADING_CONNECTOR = new RegExp('^[\\s,،]*(?:and\\s+|و|ו)?', 'iu');
const NOT_WORD_CHAR = new RegExp("[^\\p{L}'’]", 'gu');
const NOT_LETTERS = new RegExp('[^\\p{L}]+', 'gu');
const REMIND_WORD = /\b(?:remind|reminder)\b|تذكرني|تذكريني|תזכיר/i;

/** Whether a sentence opens a commitment of its own. */
function opensCommitment(sentence: string): boolean {
  const text = sentence.replace(LEADING_CONNECTOR, '').trim();
  if (!text) return false;
  if (hasRequestEvidence(text)) return true;
  if (AR_LEADING_VERB.test(text)) return true;
  const first = text.split(/\s+/)[0]!.replace(NOT_WORD_CHAR, '').toLowerCase();
  if (/^[a-z'’]{2,}$/.test(first)) return !EN_NON_VERB.has(first);
  if (/^[לת][א-ת]{3,}$/.test(first)) return !HE_NON_VERB.has(first);
  return false;
}

/** What is left of a request once its markers, times and punctuation go. */
const BARE_WORDS = new RegExp(
  [
    "\\b(?:can|could|would|will|you|please|pls|remind|reminder|me|us|to|about|it|this|that|at|on|in|the|o'?clock)\\b",
    `${B}(?:هل|ممكن|بتقدر|بتقدري|فيك|فيكي|تذكرني|تذكريني|ذكرني|ذكّرني|ذكريني|ذكّريني|بليز|لو|سمحت|سمحتي|الساعة|الساعه|يوم)${A}`,
    `${B}(?:תזכיר|תזכירי|לי|בבקשה|אפשר|תוכל|תוכלי|להזכיר|בשעה|ביום)${A}`,
  ].join('|'),
  'giu',
);

/** A request with no action in it: "can you remind me tomorrow?". */
function isBareRequest(sentence: string): boolean {
  if (!REQUEST_MARKER.test(sentence) && !REMIND_WORD.test(sentence)) return false;
  const rest = stripTimeExpressions(sentence).replace(BARE_WORDS, ' ').replace(NOT_LETTERS, '');
  return rest.length === 0;
}

/**
 * The sentences of a capture, re-joined where one is only part of the next.
 * Each keeps its own mark: a seed keeps the sentence as typed, and a question
 * is still read as one.
 */
function sentencesOf(raw: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  const boundary = new RegExp('(\\S*?)([.!?؟]+)(\\s+)', 'gu');
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(raw)) !== null) {
    const [, word, stop] = match;
    if (stop === '.' && ABBREVIATION.test(word!)) continue;
    const end = match.index + match[0].length;
    sentences.push(raw.slice(start, end).trim());
    start = end;
  }
  sentences.push(raw.slice(start).trim());
  const merged: string[] = [];
  for (const sentence of sentences.filter(Boolean)) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && (!opensCommitment(sentence) || isBareRequest(previous))) {
      merged[merged.length - 1] = `${previous} ${sentence}`;
    } else {
      merged.push(sentence);
    }
  }
  return merged;
}

/**
 * «و» onto a word that opens a commitment (CL1, D1; «عندي» narrowed in C1).
 * The opener word itself stays in the next clause, by the lookahead.
 */
const CLAUSE_OPENER = new RegExp(
  [
    `(?:^|[\\s,،|]+)و(?=(?:بدي|بدّي|بدنا|بدّنا|لازم|لازمني|ذكرني|ذكّرني|ذكريني|ذكّريني)${A})`,
    // «وعندي» only onto an appointment noun or a time — «وعندي سؤال»,
    // «وعندي كوبون» are possession, not a second commitment.
    `(?:^|[\\s,،|]+)و(?=(?:عندي|عندنا)\\s+(?:(?:ال)?(?:موعد|دكتور|دكتورة|طبيب|امتحان|إمتحان|مقابلة|مقابله|اجتماع|محاضرة|تمرين|درس|حصة|جلسة|فحص|تحليل|رحلة|طيارة|عزومة|دوام)${A}|الساعة|الساعه|بكرا|بكرة|اليوم|يوم|[0-9٠-٩]))`,
    "\\s+and\\s+(?=(?:remind\\s+me|i\\s+(?:need|have)\\s+to|i\\s+must|i've\\s+got\\s+to)\\b)",
    `\\s+ו(?=(?:צריך|צריכה|תזכיר|תזכירי)${A})`,
    `\\s+ו(?=יש\\s+לי\\s+(?:[הו]?(?:תור|פגישה|מבחן|בחינה|ראיון|טיסה|שיעור|אימון)${A}|מחר|היום|ב-?[0-9]))`,
  ].join('|'),
  'giu',
);

export function splitCaptureClauses(raw: string): string[] {
  const segments = sentencesOf(raw)
    .join('|')
    .replace(CLAUSE_OPENER, '|')
    .replace(/[;\n]+/g, '|')
    .replace(/\s+(?:and then|then|also)\s+/gi, '|')
    // «وبعدين»/«وبعدها»/«وكمان» (and then / and after / and also), and Hebrew
    // «ואז»/«וגם». Each is a whole word, so «وكمانك» is untouched.
    .replace(/\s*(?:وبعدين|وبعدها|وكمان|ثم|بعدين)\s+/g, '|')
    .replace(/\s*(?:ואז|וגם|אחר כך)\s+/g, '|')
    .replace(/،+/g, '|')
    .split('|')
    .map((part) => part.trim())
    .map((part) => part.replace(/^[\s,;،]+|[\s,;،]+$/g, '').replace(/^(?:and\b|ثم(?![؀-ۿ])|ו)\s*/i, '').trim())
    .filter(Boolean);
  return segments.length > 0 ? segments : [raw];
}
