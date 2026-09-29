/**
 * What says a clause asks for something to be done, with no other context:
 * a request or obligation said outright, or an errand verb it opens with.
 *
 * Its own module so both the clause splitter and the message classifier can
 * read it — the classifier to tell "good morning, call mom tomorrow" from
 * "hello, tonight is the game" (CL1 review I-2) — without an import cycle
 * (the splitter imports the rule-based extractor, which imports the
 * classifier). Moved verbatim from `clauseSplitter.ts`.
 */

const B = '(?<![\\p{L}\\p{M}])';
const A = '(?![\\p{L}\\p{M}])';

/** A request or an obligation, said outright. */
export const REQUEST_MARKER = new RegExp(
  [
    `${B}(?:بدي|بدّي|بدنا|بدّنا|لازم|لازمني|ضروري|محتاج|محتاجة|عليّ|ذكرني|ذكّرني|ذكريني|ذكّريني|تذكرني|تذكريني|سجل|سجّل|سجلي|سجّلي|ضيف|ضيفي|حطلي|حط\\s+لي|لا\\s+تنسى|ما\\s+تنسى)${A}`,
    "\\b(?:remind\\s+me|remember\\s+to|i\\s+(?:need|have)\\s+to|i've\\s+got\\s+to|i\\s+must|need\\s+to|have\\s+to|must|don'?t\\s+forget|do\\s+not\\s+forget)\\b",
    `${B}(?:צריך|צריכה|חייב|חייבת|תזכיר|תזכירי|להזכיר|אל\\s+תשכח|לא\\s+לשכוח|תוסיף|תרשום|לרשום)${A}`,
  ].join('|'),
  'iu',
);

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
export const LEADING_CONNECTOR = new RegExp('^[\\s,،"\'«(]*(?:and\\s+|و|ו)?', 'iu');
export const NOT_LETTERS = new RegExp('[^\\p{L}]+', 'gu');

/**
 * The clause opens with an errand verb — «أشتري خبز», "call mom tomorrow",
 * «לשלם חשבון» — with or without a leading «و» / «ו» / "and".
 */
export function opensWithAction(clause: string): boolean {
  if (typeof clause !== 'string' || !clause.trim()) return false;
  return [clause.trim(), clause.replace(LEADING_CONNECTOR, '').trim()].some((text) => {
    if (AR_LEADING_VERB.test(text) || EN_LEADING_VERB.test(text)) return true;
    const first = (text.split(/\s+/)[0] ?? '').replace(NOT_LETTERS, '');
    return /^[לת][א-ת]{3,}$/.test(first) && !HE_NON_VERB.has(first);
  });
}

/** A request said outright, or an errand verb the clause opens with. */
export function asksOrOpensWithAction(clause: string): boolean {
  return typeof clause === 'string' && (REQUEST_MARKER.test(clause) || opensWithAction(clause));
}
