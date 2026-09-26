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
 *   a sentence end . ! ? ؟     only when the next sentence starts with an
 *                             explicit request marker (CL1 round 4, N1) or an
 *                             errand verb (round 5), and the one before it is
 *                             not a bare request
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
 *
 * Round 4 (re-review N1) closed the list. Guessing whether a sentence "looks
 * like" a commitment — a commitment noun with a time, any English first word
 * that was not a pronoun — split restatements and places off the appointment
 * they belonged to: «…بكرا. الموعد الساعة 5 المسا» and "Interview on Tuesday.
 * Zoom at 3pm" each became an appointment with no time plus a second item
 * proposed today. Now a sentence opens a clause only when it starts, after an
 * optional «و» / "and" / «ו», with a marker from `SENTENCE_OPENER`; everything
 * else attaches to the sentence before it.
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

/** Common errand verbs opening an Arabic clause, imperative or first person. */
const AR_LEADING_VERB = new RegExp(
  `^(?:[أاإنب]?)(?:دفع|تصل|شتري|روح|بعت|بعث|خلص|خلّص|جيب|حجز|رد|ردّ|كلم|كلّم|حكي|زور|نظف|نضف|كتب|جدد|جدّد|صلح|صلّح|طبخ|غسل|رتب|رتّب|مرق|وصل|وصّل|سلم|سلّم|جهز|جهّز|حضر|حضّر|طبع|سأل|نزل|قدم|قدّم|لغي|شوف|راجع)${A}`,
  'u',
);

/** Common errand verbs opening an English clause — a closed list, never a stop list. */
const EN_LEADING_VERB = new RegExp(
  '^(?:please\\s+)?(?:call|phone|ring|text|email|e-mail|message|reply|answer|write|send|mail|post|buy|get|grab|pick|order|pay|book|schedule|reschedule|cancel|renew|submit|finish|complete|prepare|fix|repair|clean|wash|cook|visit|see|meet|go|drive|take|bring|return|drop|collect|check|review|read|study|practice|print|sign|file|apply|register|confirm|ask|tell|water|feed|walk|charge|update|install|pack|deliver|invite|plan|pickup)\\b',
  'i',
);

/** Words that open a Hebrew clause and look like a verb without being one. */
const HE_NON_VERB = new Set(['לפני', 'למחר', 'לגבי', 'ליד', 'לכן', 'למה', 'לפחות', 'תודה', 'תמיד', 'תור']);

// Built from strings: the root `tsconfig.json` targets ES5, which refuses the
// `u` flag on a literal (the runtime is Node 24).
const LEADING_CONNECTOR = new RegExp('^[\\s,،"\'«(]*(?:and\\s+|و|ו)?', 'iu');
const NOT_LETTERS = new RegExp('[^\\p{L}]+', 'gu');
const REMIND_WORD = /\b(?:remind|reminder)\b|تذكرني|تذكريني|תזכיר/i;

/**
 * Positive evidence that a clause asks for or names something to do, for the
 * clauses the model never answered (CL1 round 4, N4): a request marker or a
 * commitment noun with a time (`hasRequestEvidence`), or a clause that opens
 * with an errand verb — «أشتري خبز», "call mom tomorrow", «לשלם חשבון».
 *
 * Wider than the recovery gate on purpose. There the model read the clause
 * and said "nothing", and only a request said outright overrules it. Here the
 * model said nothing at all — its call timed out — and "call mom tomorrow"
 * has no request marker, so the recovery gate alone would drop it with its
 * chunk. "She is sick" and "Parking is on level 2" still do not pass.
 */
export function hasActionEvidence(clause: string): boolean {
  if (typeof clause !== 'string' || !clause.trim()) return false;
  if (hasRequestEvidence(clause)) return true;
  // With and without a leading «و» / «ו»: «وصّل أمي» starts with its verb.
  return [clause.trim(), clause.replace(LEADING_CONNECTOR, '').trim()].some((text) => {
    if (AR_LEADING_VERB.test(text) || EN_LEADING_VERB.test(text)) return true;
    const first = (text.split(/\s+/)[0] ?? '').replace(NOT_LETTERS, '');
    return /^[לת][א-ת]{3,}$/.test(first) && !HE_NON_VERB.has(first);
  });
}

/** The commitment nouns of a clause, without «ال» / «ה» / «ו», lower-cased. */
function commitmentNounsOf(text: string): Set<string> {
  const found = new Set<string>();
  const all = new RegExp(COMMITMENT_NOUN.source, 'giu');
  let match: RegExpExecArray | null;
  while ((match = all.exec(text)) !== null) found.add(normalizeNoun(match[0]!));
  return found;
}

function normalizeNoun(noun: string): string {
  return noun.toLowerCase().replace(/^ال/, '').replace(/^[הו]/, '').replace(/^appt$/, 'appointment');
}

/**
 * How a sentence has to start to open a clause of its own (CL1 round 4, N1):
 * the controller's closed list, after an optional «و» / "and" / «ו».
 */
const SENTENCE_OPENER = new RegExp(
  '^(?:' + [
    // Arabic: I want / I have to / remind me / note down / don't forget.
    `(?:بدي|بدّي|بدنا|بدّنا|لازم|لازمني|ذكرني|ذكّرني|ذكريني|ذكّريني|سجل|سجّل|سجلي|سجّلي|لا\\s+تنسى|لا\\s+تنسي|ما\\s+تنسى|ما\\s+تنسي)${A}`,
    `(?:ممكن|بتقدر|بتقدري|هل\\s+بتقدر|هل\\s+بتقدري|لو\\s+سمحت|بليز)\\s+(?:تذكرني|تذكريني|ذكرني|ذكّرني|تسجل|تسجّل|تسجلي)${A}`,
    // English: I need / I have to / I must / remind me / I want to / I'll / don't forget.
    "(?:(?:please|can\\s+you|could\\s+you|would\\s+you)\\s+)?remind\\s+me\\b",
    "i\\s+need\\b",
    "i\\s+(?:have|'ve\\s+got|have\\s+got)\\s+to\\b",
    "i've\\s+got\\s+to\\b",
    "i\\s+must\\b",
    "i\\s+want\\s+to\\b",
    "i(?:'|’)ll\\b",
    "i\\s+will\\b",
    "(?:don(?:'|’)?t|do\\s+not)\\s+forget\\b",
    "remember\\s+to\\b",
    // Hebrew: I need / remind me / I want / not to forget.
    `(?:אני\\s+)?(?:צריך|צריכה)${A}`,
    `(?:תזכיר|תזכירי)\\s+לי${A}`,
    `אני\\s+(?:רוצה)${A}`,
    `(?:לא\\s+לשכוח|אל\\s+תשכח|אל\\s+תשכחי)${A}`,
  ].join('|') + ')',
  'iu',
);

/**
 * «عندي» / "I have" / «יש לי» and the commitment noun after it: a new
 * appointment only when that noun is not the one the sentence before already
 * named — «عندي موعد دكتور بكرا. عندي موعد الساعة 5» is the same appointment.
 */
const POSSESSION_OPENER = new RegExp(
  `^(?:(?:عندي|عندنا)\\s+|i\\s+(?:have|'ve\\s+got|have\\s+got)\\s+(?:a|an|the|my)?\\s*|i've\\s+got\\s+(?:a|an|the|my)?\\s*|יש\\s+לי\\s+)(${COMMITMENT_NOUN.source})`,
  'iu',
);

/**
 * A sentence that starts with an errand verb opens a clause too (CL1 round 5):
 * "buy rice. Call mom", «…يوم الأحد. أدفع فاتورة الكهربا», "… Pay the bill
 * tomorrow" are two commitments, and read as one clause the model is asked
 * for one object and drops the second — D1's shape without «و».
 *
 * The same closed verb lists as `hasActionEvidence`, less the verbs that just
 * as often restate the appointment before them — go, see, meet, visit, check,
 * get there, «أروح», «أزور», «أشوف», «راجع» — and less the forms that are also
 * common nouns or words: a bare «خلص» ("done"), «كلم» ("word"), «برد»
 * ("cold"). An Arabic verb needs its person prefix (أ/ا/إ/ن/ب) unless it is a
 * doubled imperative («جيب», «كلّم», «خلّص»). Hebrew is a list of forms, not
 * the ל-/ת- shape, which also catches «לובי», «תרופה», «תאריך».
 */
const SENTENCE_VERB_OPENER = new RegExp(
  '^(?:' + [
    `(?:[أاإن]|ب(?!ردّ?${A}))(?:دفع|تصل|شتري|بعت|بعث|خلص|خلّص|جيب|حجز|رد|ردّ|كلم|كلّم|حكي|نظف|نضف|نظّف|نضّف|كتب|جدد|جدّد|صلح|صلّح|طبخ|غسل|رتب|رتّب|وصّل|سلم|سلّم|جهز|جهّز|حضّر|طبع|سأل|قدّم|لغي)${A}`,
    `(?:جيب|كلّم|خلّص|ردّ|جهّز|حضّر|رتّب|نظّف|نضّف|صلّح|جدّد|سلّم|وصّل)${A}`,
    '(?:please\\s+)?(?:call|phone|ring|text|email|e-mail|message|reply|write|send|mail|buy|grab|pick\\s+up|pickup|order|pay|book|schedule|reschedule|cancel|renew|submit|finish|complete|prepare|fix|repair|clean|wash|cook|bring|take|drop\\s+off|collect|print|apply|register|confirm|ask|tell|feed|install|pack|deliver|invite)\\b',
    `(?:לקנות|לשלם|להתקשר|לשלוח|להזמין|לקבוע|לסיים|להגיש|לאסוף|לכתוב|לענות|לחדש|לבטל|להביא|לנקות|לתקן|לבשל|לכבס|להדפיס|תתקשר|תתקשרי|תקנה|תקני|תשלם|תשלמי|תשלח|תשלחי|תזמין|תזמיני|תקבע|תקבעי|תאסוף|תאספי|תביא|תביאי|תכתוב|תכתבי|תענה|תעני|תבטל|תבטלי|תחדש|תחדשי|אתקשר|אקנה|אשלם|אשלח|אזמין|אקבע|אאסוף|אביא|אכתוב|אענה|אבטל)${A}`,
  ].join('|') + ')',
  'iu',
);

/** Whether a sentence opens a clause of its own, after `previous`. */
function opensCommitment(sentence: string, previous: string): boolean {
  const text = sentence.replace(LEADING_CONNECTOR, '').trim();
  if (!text) return false;
  if (SENTENCE_OPENER.test(text) || SENTENCE_VERB_OPENER.test(text)) return true;
  const possession = POSSESSION_OPENER.exec(text);
  if (!possession) return false;
  return !commitmentNounsOf(previous).has(normalizeNoun(possession[1]!.trim()));
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
    if (previous !== undefined && (!opensCommitment(sentence, previous) || isBareRequest(previous))) {
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
