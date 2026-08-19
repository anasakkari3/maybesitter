/**
 * The rules-first decomposition detector.
 *
 * Deterministic and inspectable: given the same text it returns the same steps,
 * and every boundary it draws can be traced to one named rule below. That is
 * the point of it being rules-first — the RTL cases are the ones most likely to
 * be wrong, and "the model felt like it" is not a debuggable answer for a
 * boundary in a script the reviewer may not read.
 *
 * ## The two failure modes, and why the second one drives the design
 *
 * Under-splitting loses a step the user can still read in their own sentence.
 * Over-splitting invents one — and an invented step carries a span, so it
 * *looks* sourced, survives the validator, and gets persisted. Inventing is the
 * worse error, so every rule here fails closed: a construction the detector has
 * no positive evidence for produces no boundary.
 *
 * That principle was stated in the first version of this file and not
 * implemented. The original rule guessed "an action starts here" from the first
 * *letter* — Arabic `ا أ إ آ ت ي ن س`, Hebrew `ת י א נ ל`. Those letters open a
 * large share of ordinary indefinite nouns (`سلطة`, `نسخة`, `תפריט`,
 * `תזכורת`), and Hebrew `ל` is the preposition "to" at least as often as an
 * infinitive prefix, so the rule fired on conjoined *objects*:
 * `جهز العشاء وسلطة خضراء` became two steps, and `תשלח מתנה לשרה ולדני כהן`
 * invented an errand addressed to half a name. The golden `do_not_split` rows
 * missed it because each happens to place a definite article after the clitic
 * or leave a single-token recipient; adding a surname dissolves both.
 *
 * A guess dressed as morphology is still a guess. Boundaries now require
 * **positive lexical evidence in every script**: the word after the conjunction
 * must be a known imperative. Recall is bounded by those lexicons and that is
 * the accepted cost — a verb missing from a list loses a split, while a noun
 * mistaken for a verb invents one.
 *
 * ## Where a boundary can be
 *
 * A whitespace tokenizer is not enough, and this is the crux of the RTL work.
 * In Arabic and Hebrew the coordinating conjunction is a *prefixed clitic*: the
 * "and" in `واطلب` (و + اطلب) and `ותזמין` (ו + תזמין) is the first character of
 * the following word, with no space anywhere near it. A word-level splitter
 * cannot see that boundary at all. So candidate boundaries are character
 * offsets, and a clitic candidate sits at `[wordStart, wordStart + 1)`.
 *
 * A sentence-final `.` is deliberately *not* a boundary, so
 * `Call the dentist. Buy the milk.` yields no split. Sentence segmentation is a
 * separate problem with its own abbreviation traps (`Dr.` in the golden set),
 * and getting it wrong splits inside a name. Under-split, and stated.
 *
 * ## Which candidates survive
 *
 * Two filters, in order:
 *
 *  1. **An imperative must follow.** This is what keeps `والأحكام`, `וההגבלות`
 *     and `terms and conditions` whole: the clitic is identical, but `الأحكام`
 *     is not an imperative and `اطلب` is.
 *  2. **Both clauses must be phrases.** A one-token clause beside a mere
 *     conjunction is a conjoined object that slipped the first filter. This
 *     rejects *that boundary only* — never the whole split — and never applies
 *     to an explicit sequencing marker, which is the strongest evidence the
 *     detector has: `Email the client, then call.` is two steps, and answering
 *     "this is one action" because the second clause is one word is a different
 *     and false claim.
 */

import type {
  DecompositionStepProposal,
  SourceSpan,
  StepDependency,
} from '../../../src/contracts/v1/decompositionContracts';

/* ── Markers ─────────────────────────────────────────────────────── */

/**
 * Words that order what follows after what came before. These are the only
 * boundaries that create a dependency edge: "and" between two steps says they
 * are both wanted, not that one waits for the other, and asserting a temporal
 * edge there would invent a constraint the user never stated.
 */
const SEQUENCE_WORD_LIST: readonly string[] = Object.freeze([
  'then', 'afterwards', 'ثم', 'وبعدها', 'بعدها', 'ואז', 'אז',
]);
const SEQUENCE_PHRASE_LIST: readonly string[] = Object.freeze([
  'and then',
  'after that',
  'بعد ذلك',
  'وبعد ذلك',
  'אחר כך',
  'ואחר כך',
  'לאחר מכן',
]);

/** Coordination without ordering. */
const CONJUNCTION_WORD_LIST: readonly string[] = Object.freeze([
  'and', 'also', 'plus', 'و', 'وكذلك', 'ו', 'וגם',
]);

export const SEQUENCE_WORDS: ReadonlySet<string> = new Set(SEQUENCE_WORD_LIST);
export const SEQUENCE_PHRASES: ReadonlySet<string> = new Set(SEQUENCE_PHRASE_LIST);
export const CONJUNCTION_WORDS: ReadonlySet<string> = new Set(CONJUNCTION_WORD_LIST);

/**
 * Every word or phrase this detector will cut a clause at.
 *
 * Derived from the three sets above rather than written out again, so it cannot
 * become a stale copy of them — a separately-maintained list would keep the
 * subset test green while the sets it claims to describe drifted.
 *
 * It exists because the relationship between these markers and
 * `lib/decomposition/shared/connectives.ts` was maintained by hand. A word the
 * splitter treats as a clause boundary is, by definition, a split artefact when
 * it arrives back as a whole step title — so a marker missing from the shared
 * lexicon is a residue the validator will not reject and the boundary will
 * persist. Five markers were folded into that lexicon only after a reviewer
 * noticed; tests/decomposition/engineRulesDetector.test.ts now fails if a sixth
 * is ever added here without being added there. The lists must stay separate
 * — the lexicon is a superset, containing artefacts this detector never emits
 * — so the check is a subset assertion, not a shared constant.
 *
 * Exported for that test only. It is a description of this module's behaviour,
 * which is why it lives here rather than in the test that reads it: a copy in a
 * test file is a copy that can be wrong.
 */
export const DETECTOR_BOUNDARY_MARKERS: readonly string[] = Object.freeze(
  SEQUENCE_WORD_LIST.concat(SEQUENCE_PHRASE_LIST).concat(CONJUNCTION_WORD_LIST),
);

const PUNCTUATION_BOUNDARY = /[,;،؛]/;

/**
 * How much a boundary of each kind is worth.
 *
 * Read this as a ranking of *evidence kinds*, not as a per-split quality score:
 * every clitic boundary scores the same 0.55 whether the split is right or
 * wrong, so `minimumConfidence` cannot separate a good clitic split from a bad
 * one. What it can do is switch off a whole class of evidence — a threshold
 * above 0.55 disables clitic-based decomposition, which is most of Arabic and
 * Hebrew. That is a blunt, legitimate, conservative posture and it is the only
 * thing the knob does. Correctness of individual boundaries is the lexicons'
 * job, not the threshold's.
 */
const SEQUENCE_CONFIDENCE = 0.9;
const CONJUNCTION_CONFIDENCE = 0.7;
const PUNCTUATION_CONFIDENCE = 0.7;
const CLITIC_CONFIDENCE = 0.55;

/** A clause shorter than this beside a mere conjunction is a conjoined object. */
const MINIMUM_CLAUSE_TOKENS = 2;

/* ── "Does an action start here?" ────────────────────────────────── */

const ARABIC_CHAR = /[؀-ۿݐ-ݿ]/;
const HEBREW_CHAR = /[֐-׿יִ-ﭏ]/;
const ARABIC_DIACRITIC = /[ً-ْٰـ]/g;

/**
 * Arabic imperatives, normalized (diacritics stripped, hamza-carrying alef
 * folded to bare alef, final ya folded).
 *
 * Normalization rather than listing every spelling: `أرسل`/`ارسل` and
 * `ذكّر`/`ذكر` are the same instruction typed by different keyboards, and a
 * lexicon that missed half of them would fail on input the user considers
 * identical.
 */
const ARABIC_IMPERATIVES = new Set([
  // Form I, alef-initial.
  'اتصل', 'اطلب', 'ارسل', 'احجز', 'اشتر', 'ادفع', 'اكتب', 'اقرا', 'اسال',
  'احضر', 'اجمع', 'ارجع', 'اعمل', 'اعد', 'افتح', 'اغلق', 'اغسل', 'ابدا',
  'احفظ', 'امسح', 'اطبع', 'انشر', 'استاجر', 'استلم', 'ابحث', 'اختر', 'احسب',
  'انقل', 'اضف', 'الغ', 'اسحب', 'اطبخ', 'اشترك', 'انتظر', 'اسمع', 'انظر',
  'اترك', 'اربط', 'اقفل', 'املا', 'ارفع', 'انزل', 'احسم', 'اقترح',
  // Form II/III/IV and hollow/defective imperatives, which carry no prefix.
  'راجع', 'ذكر', 'جهز', 'رتب', 'حدد', 'كلم', 'نظف', 'سلم', 'حضر', 'قابل',
  'شارك', 'صحح', 'غير', 'بلغ', 'اكد', 'اخبر', 'ارفق', 'وقع', 'زر', 'خذ',
  'ضع', 'قل', 'رد', 'تابع', 'تاكد', 'تحقق', 'تواصل', 'سجل', 'خطط', 'نسق',
  'جدد', 'حول', 'رتبي', 'صل', 'ادع', 'سدد', 'وفر', 'قدم', 'سلمي',
]);

/**
 * Hebrew imperatives: the 2nd-person future used as an imperative (`תשלח`),
 * the infinitive (`לשלוח`), and the bare imperative (`שלח`).
 *
 * All three are ordinary task phrasing, so all three are listed. Note that
 * `ה`-initial imperatives (`הזמן`, `הכן`) are now safe to include: the earlier
 * version had to treat every `ה` as the definite article to protect
 * `וההגבלות`, which lost every hif'il verb. Positive evidence costs nothing
 * here — `ההגבלות` is simply not in the list.
 *
 * One known homograph remains: `תקנה` is both "you will buy" and "regulation".
 * Hebrew is written without vowels and nothing in the surface form separates
 * them, so `ותקנה` after a noun can still over-split. It stays because it is a
 * common task verb; the alternative loses a frequent correct split.
 */
const HEBREW_IMPERATIVES = new Set([
  // 2nd-person future as imperative.
  'תשלח', 'תזמין', 'תקנה', 'תבדוק', 'תתקשר', 'תסדר', 'תכתוב', 'תשלם', 'תקבע',
  'תארגן', 'תסגור', 'תפתח', 'תדבר', 'תקרא', 'תשמור', 'תבטל', 'תאסוף', 'תיקח',
  'תיתן', 'תשים', 'תעשה', 'תחתום', 'תבקש', 'תרשום', 'תזכיר', 'תעדכן', 'תשלים',
  'תמלא', 'תדפיס', 'תעביר', 'תחזיר', 'תיצור', 'תמצא', 'תבחר', 'תתאם', 'תחדש',
  'תנקה', 'תבשל', 'תשאל', 'תענה', 'תעקוב', 'תוודא', 'תסיים', 'תתחיל', 'תאשר',
  'תצלם', 'תזמן', 'תגיש', 'תוסיף', 'תוריד', 'תעלה',
  // Infinitive.
  'לשלוח', 'להזמין', 'לקנות', 'לבדוק', 'להתקשר', 'לסדר', 'לכתוב', 'לשלם',
  'לקבוע', 'לארגן', 'לסגור', 'לפתוח', 'לדבר', 'לקרוא', 'לשמור', 'לבטל',
  'לאסוף', 'לקחת', 'לתת', 'לשים', 'לעשות', 'לחתום', 'לבקש', 'לרשום',
  'להזכיר', 'לעדכן', 'למלא', 'להדפיס', 'להעביר', 'להחזיר', 'ליצור', 'למצוא',
  'לבחור', 'לתאם', 'לחדש', 'לנקות', 'לבשל', 'לשאול', 'לענות', 'לעקוב',
  'לסיים', 'להתחיל', 'לאשר', 'לצלם', 'להגיש', 'להוסיף',
  // Bare imperative.
  'קנה', 'שלח', 'כתוב', 'בדוק', 'סדר', 'צור', 'שלם', 'קבע', 'ארגן', 'סגור',
  'פתח', 'דבר', 'קרא', 'שמור', 'בטל', 'אסוף', 'קח', 'תן', 'בוא', 'שים',
  'עשה', 'חתום', 'בקש', 'רשום', 'נקה', 'בשל', 'סיים', 'התחל', 'אשר', 'עדכן',
  'מלא', 'הדפס', 'העבר', 'החזר', 'מצא', 'בחר', 'חדש', 'שאל', 'ענה', 'עקוב',
  'הזמן', 'הכן', 'ספר', 'זמן',
]);

/**
 * Common English task verbs.
 *
 * English never had morphology to lean on — `order the cake` and
 * `conditions before Friday` differ only in the word — so this list has always
 * been the English rule. Arabic and Hebrew now work the same way.
 */
const ENGLISH_ACTION_VERBS = new Set([
  'add', 'arrange', 'ask', 'book', 'bring', 'buy', 'call', 'cancel', 'check',
  'clean', 'collect', 'confirm', 'contact', 'cook', 'create', 'deliver',
  'draft', 'drop', 'email', 'file', 'find', 'finish', 'fix', 'follow', 'get',
  'give', 'hand', 'invite', 'mail', 'make', 'message', 'order', 'pack', 'pay',
  'pick', 'plan', 'post', 'prepare', 'print', 'publish', 'read', 'register',
  'remind', 'renew', 'reply', 'reserve', 'return', 'review', 'schedule',
  'send', 'set', 'share', 'ship', 'sign', 'start', 'submit', 'take', 'talk',
  'text', 'update', 'upload', 'visit', 'wash', 'write',
]);

function normalizeArabic(word: string): string {
  return word
    .replace(ARABIC_DIACRITIC, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي');
}

/**
 * Object pronouns Arabic suffixes onto the verb itself.
 *
 * `ارسله` is `ارسل` + `ه`, `اطبعها` is `اطبع` + `ها`. Matching the surface form
 * alone misses most transitive instructions, because most of them name their
 * object this way. Longest suffix first, so `ها` is not read as `ا`.
 *
 * This can only ever *add* a lexicon match, never remove one, so it cannot
 * create a boundary where the bare word already failed — the risk is confined
 * to a noun whose stripped form happens to be a known imperative, which the
 * conjoined-object suite is what guards.
 */
const ARABIC_OBJECT_PRONOUNS: readonly string[] = ['هما', 'كما', 'هم', 'هن', 'كم', 'كن', 'ها', 'نا', 'ني', 'ه', 'ك'];

function isArabicImperative(word: string): boolean {
  const normalized = normalizeArabic(word);
  if (ARABIC_IMPERATIVES.has(normalized)) return true;
  for (const suffix of ARABIC_OBJECT_PRONOUNS) {
    if (normalized.length - suffix.length >= 2 && normalized.endsWith(suffix)) {
      const stem = normalized.slice(0, normalized.length - suffix.length);
      if (ARABIC_IMPERATIVES.has(stem)) return true;
    }
  }
  return false;
}

/**
 * Positive evidence only, in every script. An unknown word is not an action —
 * which is what makes an unrecognised construction produce no boundary rather
 * than a speculative one.
 */
function beginsAction(word: string): boolean {
  if (word.length === 0) return false;
  if (ARABIC_CHAR.test(word[0])) return isArabicImperative(word);
  if (HEBREW_CHAR.test(word[0])) return HEBREW_IMPERATIVES.has(word);
  return ENGLISH_ACTION_VERBS.has(word.toLowerCase());
}

/* ── Stated timing ───────────────────────────────────────────────── */

/**
 * Trailing time phrases, captured verbatim.
 *
 * Verbatim is the whole requirement: resolving "by Friday" against a clock is
 * Capture's job, and a decomposer that computed a date here would be inventing
 * a fact the sentence does not contain — the `INVENTED_TIMING` case. The phrase
 * is lifted out of the step's span so the span still selects the action alone.
 */
const TIMING_SUFFIXES: readonly RegExp[] = [
  /\s+((?:by|on|at|before|after|until|due)\s+(?:the\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|noon|midnight|tomorrow|today|tonight|next\s+\w+|this\s+\w+|\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?))$/i,
  /\s+((?:tomorrow|today|tonight|next\s+week|next\s+month|this\s+week|this\s+weekend))$/i,
  /\s+((?:يوم\s+\S+|قبل\s+\S+|بعد\s+\S+|الساعة\s+\S+|غدا|غدًا|بكرة|اليوم|الليلة))$/,
  /\s+((?:לפני\s+\S+(?:\s+\S+)?|אחרי\s+\S+|ביום\s+\S+|מחר|היום|הערב))$/,
];

interface TimingSplit {
  /** Number of trailing characters of the segment that the timing phrase occupies. */
  readonly consumed: number;
  readonly timing: string | null;
}

function splitTiming(segment: string): TimingSplit {
  for (const pattern of TIMING_SUFFIXES) {
    const match = pattern.exec(segment);
    if (match) return { consumed: match[0].length, timing: match[1] };
  }
  return { consumed: 0, timing: null };
}

/* ── Tokenizing ──────────────────────────────────────────────────── */

const SEPARATOR = /[\s.,;:!?،؛…()"'«»‎‏]/;

interface Token {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    if (SEPARATOR.test(text[index])) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < text.length && !SEPARATOR.test(text[index])) index += 1;
    tokens.push({ start, end: index, text: text.slice(start, index) });
  }
  return tokens;
}

interface Marker {
  start: number;
  end: number;
  /** True when the marker orders the two sides rather than merely joining them. */
  sequencing: boolean;
  confidence: number;
}

function collectMarkers(text: string, tokens: readonly Token[]): Marker[] {
  const markers: Marker[] = [];

  for (let index = 0; index < text.length; index += 1) {
    if (PUNCTUATION_BOUNDARY.test(text[index])) {
      markers.push({ start: index, end: index + 1, sequencing: false, confidence: PUNCTUATION_CONFIDENCE });
    }
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const lower = token.text.toLowerCase();
    const next = tokens[index + 1];

    if (next && SEQUENCE_PHRASES.has(`${lower} ${next.text.toLowerCase()}`)) {
      markers.push({ start: token.start, end: next.end, sequencing: true, confidence: SEQUENCE_CONFIDENCE });
      index += 1;
      continue;
    }
    if (SEQUENCE_WORDS.has(lower)) {
      markers.push({ start: token.start, end: token.end, sequencing: true, confidence: SEQUENCE_CONFIDENCE });
      continue;
    }
    if (CONJUNCTION_WORDS.has(lower)) {
      markers.push({ start: token.start, end: token.end, sequencing: false, confidence: CONJUNCTION_CONFIDENCE });
      continue;
    }
    // The clitic case: the conjunction is character zero of the next word, so
    // the marker is one character wide and the following step begins mid-token.
    // Guarded on length because a two-character word starting with the clitic
    // leaves a one-letter remainder, which is a particle far more often than a
    // verb. `startsWith` already pins the script, so no separate script test.
    const isCliticCandidate = token.text.startsWith('و') || token.text.startsWith('ו');
    if (isCliticCandidate && token.text.length >= 3) {
      markers.push({ start: token.start, end: token.start + 1, sequencing: false, confidence: CLITIC_CONFIDENCE });
    }
  }

  markers.sort((left, right) => left.start - right.start || left.end - right.end);
  return mergeAdjacent(text, markers);
}

/**
 * Fold markers separated only by whitespace into one.
 *
 * `, then` is one boundary stated twice, not two boundaries with an empty step
 * between them. Merged confidence is the *maximum* of the parts because two
 * markers agreeing on the same seam is corroboration; taking the minimum would
 * make an explicitly sequenced boundary score lower for being punctuated.
 */
function mergeAdjacent(text: string, markers: readonly Marker[]): Marker[] {
  const merged: Marker[] = [];
  for (const marker of markers) {
    const previous = merged[merged.length - 1];
    if (previous && text.slice(previous.end, marker.start).trim().length === 0 && marker.start >= previous.end) {
      previous.end = Math.max(previous.end, marker.end);
      previous.sequencing = previous.sequencing || marker.sequencing;
      previous.confidence = Math.max(previous.confidence, marker.confidence);
      continue;
    }
    if (previous && marker.start < previous.end) continue;
    merged.push({ ...marker });
  }
  return merged;
}

/* ── Segmenting ──────────────────────────────────────────────────── */

const TRIMMABLE = /[\s.,;:!?،؛…()"'«»‎‏]/;

function trimRange(text: string, rawStart: number, rawEnd: number): { start: number; end: number } {
  let start = rawStart;
  let end = rawEnd;
  while (start < end && TRIMMABLE.test(text[start])) start += 1;
  while (end > start && TRIMMABLE.test(text[end - 1])) end -= 1;
  return { start, end };
}

/**
 * The first word at or after `offset`, resuming from `fromToken`.
 *
 * Returns the token index to resume from, so pass 1 can walk the marker list
 * without rescanning the token array from zero each time — that rescan was one
 * of the two things that made a long comma-separated list quadratic.
 */
function firstWordAfter(
  tokens: readonly Token[],
  offset: number,
  fromToken: number,
): { readonly word: string; readonly nextToken: number } {
  for (let index = fromToken; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.start >= offset) return { word: token.text, nextToken: index };
    // A clitic marker ends inside a token, so the "next word" is the remainder
    // of the token it split — `واطلب` cut at offset 1 leaves `اطلب`, and asking
    // whether *that* is an imperative is the whole clitic discrimination.
    if (token.end > offset) return { word: token.text.slice(offset - token.start), nextToken: index };
  }
  return { word: '', nextToken: tokens.length };
}

/**
 * How many tokens intersect `[from, to)`, by binary search.
 *
 * Token starts and ends are both strictly increasing, so both edges are
 * findable in O(log n). Counting this way rather than re-tokenising a slice is
 * what lets a clause be measured repeatedly as it grows without the
 * measurement itself becoming quadratic.
 */
function countTokensIn(tokens: readonly Token[], from: number, to: number): number {
  if (to <= from || tokens.length === 0) return 0;

  let lo = 0;
  let hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].end > from) hi = mid;
    else lo = mid + 1;
  }
  const first = lo;

  lo = 0;
  hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].start >= to) hi = mid;
    else lo = mid + 1;
  }
  return Math.max(0, lo - first);
}

/**
 * One raw segment between two accepted markers, shaped once.
 *
 * `contentEnd` already excludes any trailing stated-timing phrase, so a merged
 * clause needs no re-parsing: merging only ever prepends, so the merged
 * clause's trailing timing is its last component's. (A timing phrase written
 * across a dropped conjunction would be missed; the phrases are short trailing
 * patterns and a marker sits between them, so this is a bound worth stating
 * rather than a case worth parsing for.)
 */
interface Segment {
  readonly trimStart: number;
  readonly contentEnd: number;
  readonly timing: string | null;
}

/** Shape every segment once. Linear in the length of the source. */
function segmentsFor(sourceText: string, accepted: readonly Marker[]): Segment[] | null {
  const segments: Segment[] = [];
  for (let index = 0; index <= accepted.length; index += 1) {
    const rawStart = index === 0 ? 0 : accepted[index - 1].end;
    const rawEnd = index === accepted.length ? sourceText.length : accepted[index].start;
    const trimmed = trimRange(sourceText, rawStart, rawEnd);
    if (trimmed.start >= trimmed.end) return null;

    const timing = splitTiming(sourceText.slice(trimmed.start, trimmed.end));
    const bounded = trimRange(sourceText, trimmed.start, trimmed.end - timing.consumed);
    // A segment that is nothing but a time phrase is not a step. Rather than
    // emit it and rely on the validator, the whole split is abandoned: a
    // detector that knows its output is wrong should not have produced it.
    if (bounded.start >= bounded.end) return null;

    segments.push({ trimStart: bounded.start, contentEnd: bounded.end, timing: timing.timing });
  }
  return segments;
}

export interface RulesDetectionResult {
  readonly steps: readonly DecompositionStepProposal[];
  /**
   * Weakest boundary the split relied on, or 0 when nothing split. Zero rather
   * than one so a caller cannot read "I found nothing" as "I am certain".
   */
  readonly confidence: number;
}

const NOTHING: RulesDetectionResult = { steps: [], confidence: 0 };

export function detectSteps(sourceText: string): RulesDetectionResult {
  if (sourceText.trim().length === 0) return NOTHING;

  const tokens = tokenize(sourceText);
  const markers = collectMarkers(sourceText, tokens);

  // Pass 1: a marker survives only if a known imperative starts after it.
  const accepted: Marker[] = [];
  let cursor = 0;
  let tokenCursor = 0;
  for (const marker of markers) {
    if (marker.start < cursor) continue;
    // "Is there anything but punctuation and space between the cursor and this
    // marker?" — asked of the token index rather than by walking the characters.
    // The character walk restarted at `cursor`, which does not move while
    // markers are being rejected, so a long run of trimmable text was rescanned
    // once per marker. `SEPARATOR` and `TRIMMABLE` are the same class, so a
    // token intersecting the range is exactly equivalent, and binary search
    // cannot rescan.
    if (countTokensIn(tokens, cursor, marker.start) === 0) continue;
    const next = firstWordAfter(tokens, marker.end, tokenCursor);
    tokenCursor = next.nextToken;
    if (!beginsAction(next.word)) continue;
    accepted.push(marker);
    cursor = marker.end;
  }
  if (accepted.length === 0) return NOTHING;

  const segments = segmentsFor(sourceText, accepted);
  if (segments === null) return NOTHING;

  // Pass 2: one left-to-right sweep. A boundary whose clauses are too short to
  // be steps is dropped, which merges its left clause into the next candidate's
  // left clause — so the sweep carries `groupStart` forward instead of
  // re-cutting the whole source. Dropping only ever *grows* a clause, and a
  // clause already long enough stays long enough, so a boundary that is kept
  // never needs revisiting: one pass reaches the same answer the repeated
  // re-cut did, without its quadratic cost.
  //
  // Sequencing markers are exempt. An explicit `then`/`ثم`/`ואז` is the
  // strongest evidence available, and a token count must not overrule it.
  const kept: number[] = [];
  let groupStart = 0;
  for (let index = 0; index < accepted.length; index += 1) {
    const left = segments[index];
    const right = segments[index + 1];
    const longEnough = accepted[index].sequencing
      || (countTokensIn(tokens, segments[groupStart].trimStart, left.contentEnd) >= MINIMUM_CLAUSE_TOKENS
        && countTokensIn(tokens, right.trimStart, right.contentEnd) >= MINIMUM_CLAUSE_TOKENS);
    if (!longEnough) continue;
    kept.push(index);
    groupStart = index + 1;
  }
  if (kept.length === 0) return NOTHING;

  // Each surviving boundary closes a clause; a clause spans every segment from
  // the last kept boundary to this one, and carries that last segment's timing.
  const steps: DecompositionStepProposal[] = [];
  for (let index = 0; index <= kept.length; index += 1) {
    const firstSegment = index === 0 ? 0 : kept[index - 1] + 1;
    const lastSegment = index === kept.length ? segments.length - 1 : kept[index];
    const span: SourceSpan = {
      start: segments[firstSegment].trimStart,
      end: segments[lastSegment].contentEnd,
      text: sourceText.slice(segments[firstSegment].trimStart, segments[lastSegment].contentEnd),
    };
    const dependsOn: StepDependency[] = index > 0 && accepted[kept[index - 1]].sequencing
      ? [{ dependsOnStepId: `s${index}`, kind: 'temporal' }]
      : [];
    steps.push({
      stepId: `s${index + 1}`,
      title: span.text,
      sourceSpans: [span],
      inferred: false,
      dependsOn,
      statedTiming: segments[lastSegment].timing,
      // Never populated. No rule distinguishes the person who must act from the
      // person acted upon — "send a note to Sarah" names a recipient, not an
      // owner — and guessing is exactly the `INVENTED_OWNER` failure.
      statedOwner: null,
    });
  }

  if (steps.length < 2) return NOTHING;
  return {
    steps,
    confidence: kept.reduce((weakest, index) => Math.min(weakest, accepted[index].confidence), 1),
  };
}
