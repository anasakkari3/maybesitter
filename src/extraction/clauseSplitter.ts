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
 *                             errand verb (round 5) that is followed by an
 *                             object (round 6), the one before it is not a
 *                             bare request, and the new sentence does not
 *                             restate the appointment's hour (round 6)
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
 *
 * Round 6 (re-review 2, NEW-2) closed the two ways the defect came back
 * through the openers themselves:
 *
 *   - a restatement of the hour attaches. «عندي موعد دكتور بكرا. بدي أكون
 *     هناك الساعة 5 المسا», "Meeting with Sam on Sunday. I'll be there at
 *     10", "Job interview on Tuesday. Call at 3pm" each start with an opener
 *     and are still the same appointment. When the sentence before names a
 *     day but no clock time, and the new one names a clock time but no day,
 *     the clock belongs to that day — whatever word the sentence starts with
 *     (`restatesTheHour`). The accepted price: "Dentist on Sunday. Call mom at
 *     5" is one clause too.
 *   - an opener splits only onto an object. "Call is at 10am", "Email has the
 *     address", "Book is on the table", "Pickup at 3:15", "Take off at 6am"
 *     open with an English noun that is also an errand verb; «بدي أكون هناك»
 *     and «אני צריך להיות שם» open with a marker onto "to be". A copula, a
 *     preposition, "at", a time or a day right after the opener means the
 *     sentence is about something, not asking for it (`followedByObject`).
 */
import { stripTimeExpressions } from './ruleBasedExtractor';
import { namesDay, statesClock, timeOfDayEvidence } from './timeLexicon';
import { LEADING_CONNECTOR, NOT_LETTERS, REQUEST_MARKER, opensWithAction } from './requestEvidence';

const B = '(?<![\\p{L}\\p{M}])';
const A = '(?![\\p{L}\\p{M}])';

/** The word before a «.» that is not a sentence end. Only consulted for «.». */
const ABBREVIATION = new RegExp(
  '^(?:[("\'«]*)(?:dr|mr|mrs|ms|prof|st|jr|sr|vs|etc|no|acc|approx|dept|ave|[ap]\\.m|e\\.g|i\\.e|\\p{L}|(?:\\p{L}\\.)+\\p{L})$',
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
  return opensWithAction(clause);
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
    '(?:please\\s+)?(?:call|phone|ring|text|email|e-mail|message|reply|write|send|mail|buy|grab|pick\\s+up|pickup|order|pay|book|schedule|reschedule|cancel|renew|submit|finish|complete|prepare|fix|repair|clean|wash|cook|bring|take\\s+(?:out|back|down)|take|drop\\s+off|collect|print|apply|register|confirm|ask|tell|feed|install|pack|deliver|invite)\\b',
    `(?:לקנות|לשלם|להתקשר|לשלוח|להזמין|לקבוע|לסיים|להגיש|לאסוף|לכתוב|לענות|לחדש|לבטל|להביא|לנקות|לתקן|לבשל|לכבס|להדפיס|תתקשר|תתקשרי|תקנה|תקני|תשלם|תשלמי|תשלח|תשלחי|תזמין|תזמיני|תקבע|תקבעי|תאסוף|תאספי|תביא|תביאי|תכתוב|תכתבי|תענה|תעני|תבטל|תבטלי|תחדש|תחדשי|אתקשר|אקנה|אשלם|אשלח|אזמין|אקבע|אאסוף|אביא|אכתוב|אענה|אבטל)${A}`,
  ].join('|') + ')',
  'iu',
);

/**
 * The sentence gives the hour of the appointment the sentence before it named
 * on a day (CL1 round 6, NEW-2): the one before has a day and no clock time,
 * this one a clock time and no day. Whatever it opens with — «بدي», "I'll",
 * "Call", «נחכי» — the clock is that day's, and the sentence is not a second
 * commitment to be proposed today.
 */
function restatesTheHour(sentence: string, previous: string): boolean {
  // Sentences are joined before the hard separators split them, so only the
  // clause on each side of the sentence end is compared: «…بكرا. بدي أكون
  // هناك الساعة 5 المسا، وذكرني…» restates on its first clause.
  const parts = (text: string) => text.split(HARD_SEPARATOR).map((part) => part.trim()).filter(Boolean);
  const before = parts(previous).at(-1) ?? previous;
  const after = parts(sentence)[0] ?? sentence;
  return namesDay(before) && !statesClock(before) && statesClock(after) && !namesDay(after);
}

/** What `splitCaptureClauses` splits on regardless of sentence ends. */
const HARD_SEPARATOR = /[;\n،]+|\s+(?:and then|then|also)\s+|\s*(?:وبعدين|وبعدها|وكمان|ثم|بعدين|ואז|וגם|אחר כך)\s+/gi;

/**
 * Words that, right after an opener, say the sentence is not an errand (CL1
 * round 6, NEW-2): a copula or auxiliary ("Call is at 10am", «بدي أكون هناك»,
 * «אני צריך להיות שם»), a preposition ("Take off at 6am", «أحكي معه»), "at",
 * a place adverb («هناك», «שם»). A time or a day word is caught by the lexicon
 * (`timeOfDayEvidence`), a bare number by its digits. Pronoun objects stay
 * objects: «אשלח לו את הדוח» is an errand.
 */
const NON_OBJECT_AFTER_OPENER = new Set([
  // English copulas and auxiliaries.
  'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'do', 'does', 'did',
  'will', 'would', 'can', 'could', 'should', 'might', 'may', 'says', 'said', 'went', 'goes',
  // English prepositions and adverbs of place or time.
  'at', 'on', 'in', 'for', 'from', 'by', 'off', 'out', 'up', 'with', 'about', 'of', 'into', 'there', 'here',
  'then', 'now', 'later', 'again', 'soon', 'early', 'late', "o'clock",
  // Arabic: to be, prepositions with a pronoun, place and time adverbs, «الساعة».
  'أكون', 'اكون', 'نكون', 'يكون', 'بكون', 'منكون', 'تكون', 'كنت',
  'معه', 'معها', 'معهم', 'معي', 'معك', 'معكم', 'فيه', 'فيها', 'فيهم', 'فيي', 'فيني', 'فيك', 'فيكم',
  'عليه', 'عليها', 'عليهم', 'عليي', 'عليك', 'عنه', 'عنها', 'عنهم', 'إله', 'اله', 'إلها', 'الها', 'إلهم', 'الهم',
  'له', 'لها', 'لهم', 'لي', 'حالي', 'حالك', 'حالنا',
  'هناك', 'هنيك', 'هون', 'هنا', 'بعدين', 'قبل', 'بعد', 'لحد', 'عند', 'على', 'في', 'مع', 'من', 'إلى', 'الى', 'لـ',
  'الساعة', 'الساعه',
  // Hebrew: to be, place and time adverbs, «בשעה».
  'להיות', 'יהיה', 'אהיה', 'נהיה', 'תהיה', 'הוא', 'היא', 'זה', 'זאת',
  'שם', 'פה', 'כאן', 'אז', 'בשעה', 'שעה', 'ב', 'על', 'עם', 'אל', 'עד', 'לפני', 'אחרי', 'מ',
]);

const EDGE_PUNCTUATION = new RegExp('^[^\\p{L}\\p{N}]+|[^\\p{L}\\p{N}]+$', 'gu');

/** Whether the words after an opener are an object: something to act on. */
function followedByObject(rest: string): boolean {
  const words = rest.trim().split(/\s+/).map((word) => word.replace(EDGE_PUNCTUATION, '')).filter(Boolean);
  // A day word between the opener and its object is when, not what (CL1
  // round 7, I-1): «ذكرني بكرا أدفع…», "Remind me tomorrow to pay…", «תזכיר
  // לי מחר לשלם…», «بدي بكرا أشتري…». Skipped, and the word after it judged.
  const skipDays = () => { while (words.length > 1 && timeOfDayEvidence(words[0]!) === 'day_only') words.shift(); };
  skipDays();
  // "I need to pay" — the infinitive marker is skipped, its verb is judged;
  // "I need to tomorrow buy" puts the day after it.
  if (words[0]?.toLowerCase() === 'to') words.shift();
  skipDays();
  const first = words[0];
  if (!first) return false;
  const lower = first.toLowerCase();
  if (NON_OBJECT_AFTER_OPENER.has(lower)) return false;
  if (/^[0-9\u0660-\u0669\u06F0-\u06F9]/.test(first)) return false;
  if (/^ב-?[0-9]/.test(first)) return false;
  if (timeOfDayEvidence(first) !== 'none') return false;
  // "Text reminder says 4:45": a noun subject, told by the verb after it.
  const second = words[1]?.toLowerCase();
  if (second && /^(?:is|are|was|were|has|says|said)$/.test(second)) return false;
  return true;
}

/**
 * An explicit reminder said outright: «ذكرني», "remind me", «תזכיר לי», with
 * the polite lead-ins the sentence openers accept (CL1 round 7). It always
 * opens a clause of its own — it is never a restatement of the appointment
 * before it, and what follows it ("at 6pm", "tomorrow") is when to remind,
 * not a reason to attach: "Dentist on Sunday. Remind me at 6pm to call mom"
 * is two commitments, and the dentist does not get 18:00.
 */
const EXPLICIT_REMINDER_OPENER = new RegExp(
  '^(?:' + [
    `(?:(?:ممكن|بتقدر|بتقدري|هل\\s+بتقدر|هل\\s+بتقدري|لو\\s+سمحت|بليز)\\s+)?(?:ذكرني|ذكّرني|ذكريني|ذكّريني|تذكرني|تذكريني)${A}`,
    "(?:(?:please|can\\s+you|could\\s+you|would\\s+you)\\s+)?remind\\s+me\\b",
    `(?:תזכיר|תזכירי)\\s+לי${A}`,
  ].join('|') + ')',
  'iu',
);

/** Whether a sentence opens a clause of its own, after `previous`. */
function opensCommitment(sentence: string, previous: string): boolean {
  const text = sentence.replace(LEADING_CONNECTOR, '').trim();
  if (!text) return false;
  if (EXPLICIT_REMINDER_OPENER.test(text)) return true;
  if (restatesTheHour(text, previous)) return false;
  const opener = SENTENCE_OPENER.exec(text) ?? SENTENCE_VERB_OPENER.exec(text);
  if (opener) return followedByObject(text.slice(opener[0].length));
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
  // A bare reminder with nothing after it — "Dentist on Sunday. Remind me
  // tomorrow." — is about the sentence before it (CL1 round 7): joined back
  // rather than left as a clause with no action.
  if (merged.length > 1 && isBareRequest(merged[merged.length - 1]!)) {
    const last = merged.pop()!;
    merged[merged.length - 1] = `${merged[merged.length - 1]} ${last}`;
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
