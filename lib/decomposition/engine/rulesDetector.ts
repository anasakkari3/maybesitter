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
 * Under-splitting loses a step. Over-splitting invents one, and inventing is
 * worse: an invented step carries a span, so it *looks* sourced, and the golden
 * set is deliberately weighted toward the cases where firing is wrong. So every
 * rule here fails closed — an unrecognised construction produces no boundary,
 * never a speculative one.
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
 * ## Which candidates survive
 *
 * The same clitic also appears inside fixed noun phrases — `والأحكام` in
 * `الشروط والأحكام`, `וההגבלות`, and English `terms and conditions` — where
 * splitting produces two fragments the user never said. The discriminator is
 * *what follows the conjunction*, not the conjunction itself: a step is an
 * action, so a candidate survives only when the text after it begins one.
 *
 * That test is answered by morphology where the language provides it, and only
 * by lexicon where it does not:
 *
 *  - **Arabic**: a word carrying the definite article `ال` is a noun, so
 *    `الأحكام` cannot open a step; `اطلب` and `أرسل` carry imperative/imperfect
 *    prefixes and can.
 *  - **Hebrew**: `ה` is the definite article, so `ההגבלות` cannot open a step;
 *    `תזמין` and `תשלח` carry the imperfect prefix and can.
 *  - **English** has no such morphology — `order` and `conditions` are
 *    distinguishable only by knowing the words — so English falls back to a
 *    lexicon of common task verbs, and its recall is bounded by that list. This
 *    is a real limit, stated rather than hidden: an English verb outside the
 *    list yields no split, which is the failure direction we chose.
 *
 * The Hebrew rule has a known cost, recorded because it is a genuine ambiguity
 * rather than an oversight: `ה` is also the hif'il prefix, so a hif'il
 * imperative after a conjunction (`והזמן`) is read as a noun phrase and does
 * not split. Preferring the verb reading instead would split `וההגבלות`, which
 * the golden set says is the worse error.
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
const SEQUENCE_WORDS = new Set(['then', 'afterwards', 'ثم', 'وبعدها', 'بعدها', 'ואז', 'אז']);
const SEQUENCE_PHRASES = new Set([
  'and then',
  'after that',
  'بعد ذلك',
  'وبعد ذلك',
  'אחר כך',
  'ואחר כך',
  'לאחר מכן',
]);

/** Coordination without ordering. */
const CONJUNCTION_WORDS = new Set(['and', 'also', 'plus', 'و', 'وكذلك', 'ו', 'וגם']);

const PUNCTUATION_BOUNDARY = /[,;،؛]/;

/**
 * How much a boundary of each kind is worth.
 *
 * A bare clitic is the weakest evidence in the set precisely because it is the
 * one that also occurs inside noun phrases; a caller that wants only
 * high-confidence splits raises its threshold above this and loses the clitic
 * boundaries first, which is the correct order to lose them in.
 */
const SEQUENCE_CONFIDENCE = 0.9;
const CONJUNCTION_CONFIDENCE = 0.7;
const PUNCTUATION_CONFIDENCE = 0.7;
const CLITIC_CONFIDENCE = 0.55;

/* ── "Does an action start here?" ────────────────────────────────── */

const ARABIC_CHAR = /[؀-ۿݐ-ݿ]/;
const HEBREW_CHAR = /[֐-׿יִ-ﭏ]/;
const ARABIC_DIACRITIC = /[ً-ْٰـ]/g;

/** Arabic imperative and imperfect prefixes. */
const ARABIC_VERB_PREFIX = /^[اأإآتينس]/;
/** Hebrew imperfect, infinitive and imperative prefixes. Deliberately excludes `ה`. */
const HEBREW_VERB_PREFIX = /^[תיאנל]/;

/**
 * Particles and pronouns that can follow a conjunction. Checked before the
 * prefix rules because several of them (`أو`, `أنا`, `את`, `אני`) begin with a
 * letter that is also a verbal prefix — prefix-first would read every one of
 * them as the start of a step.
 */
const ARABIC_NON_ACTION = new Set([
  'في', 'على', 'مع', 'من', 'إلى', 'الى', 'عن', 'قبل', 'بعد', 'عند', 'حتى',
  'لكن', 'أو', 'او', 'أيضا', 'هذا', 'هذه', 'ذلك', 'كل', 'بعض', 'أنا', 'أنت',
  'هو', 'هي', 'نحن', 'هم', 'التي', 'الذي',
]);
const HEBREW_NON_ACTION = new Set([
  'את', 'של', 'עם', 'לפני', 'אחרי', 'על', 'אל', 'מן', 'או', 'גם', 'כי', 'אבל',
  'זה', 'כל', 'אני', 'אתה', 'הוא', 'היא', 'אנחנו', 'הם',
]);

/**
 * Arabic form II/III imperatives, which carry no prefix the morphology rule can
 * see (`راجع`, `ذكر`). Small on purpose: this is the escape hatch, not the
 * mechanism.
 */
const ARABIC_ACTION_VERBS = new Set([
  'راجع', 'ذكر', 'حاول', 'سلم', 'جهز', 'رتب', 'حدد', 'كلم', 'نظف', 'دفع',
  'حجز', 'طلب', 'شارك', 'صحح', 'حضر', 'قابل', 'زور', 'غير', 'بلغ', 'رد',
]);
const HEBREW_ACTION_VERBS = new Set([
  'קנה', 'שלח', 'כתוב', 'בדוק', 'סדר', 'צור', 'שלם', 'קבע', 'ארגן', 'סגור',
  'פתח', 'דבר', 'קרא', 'שמור', 'בטל', 'קח', 'תן', 'בוא', 'שים', 'עשה',
  'חתום', 'בקש', 'זמן', 'ספר', 'רשום',
]);

/**
 * Common English task verbs.
 *
 * English gives the detector no morphological handle: `order the cake` and
 * `conditions before Friday` differ only in the word. So this list *is* the
 * English rule, and the detector's English recall is exactly its coverage — a
 * verb missing here means a missed split, never a wrong one.
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
  return word.replace(ARABIC_DIACRITIC, '');
}

function beginsAction(word: string): boolean {
  if (word.length === 0) return false;

  if (ARABIC_CHAR.test(word[0])) {
    const normalized = normalizeArabic(word);
    if (normalized.startsWith('ال')) return false;
    if (ARABIC_NON_ACTION.has(normalized)) return false;
    if (ARABIC_VERB_PREFIX.test(normalized)) return true;
    return ARABIC_ACTION_VERBS.has(normalized);
  }

  if (HEBREW_CHAR.test(word[0])) {
    if (word.startsWith('ה')) return false;
    if (HEBREW_NON_ACTION.has(word)) return false;
    if (HEBREW_VERB_PREFIX.test(word)) return true;
    return HEBREW_ACTION_VERBS.has(word);
  }

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
    // leaves a one-letter remainder, which is a particle far more often than a verb.
    const isCliticCandidate =
      (token.text.startsWith('و') && ARABIC_CHAR.test(token.text[0]))
      || (token.text.startsWith('ו') && HEBREW_CHAR.test(token.text[0]));
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

function firstWordAfter(tokens: readonly Token[], offset: number): string {
  for (const token of tokens) {
    if (token.start >= offset) return token.text;
    // A clitic marker ends inside a token, so the "next word" is the remainder
    // of the token it split — `واطلب` cut at offset 1 leaves `اطلب`, and asking
    // whether *that* opens an action is the whole clitic discrimination.
    if (token.end > offset) return token.text.slice(offset - token.start);
  }
  return '';
}

export interface RulesDetectionResult {
  readonly steps: readonly DecompositionStepProposal[];
  /**
   * Weakest boundary the split relied on, or 0 when nothing split. Zero rather
   * than one so a caller cannot read "I found nothing" as "I am certain".
   */
  readonly confidence: number;
}

export function detectSteps(sourceText: string): RulesDetectionResult {
  const empty: RulesDetectionResult = { steps: [], confidence: 0 };
  if (sourceText.trim().length === 0) return empty;

  const tokens = tokenize(sourceText);
  const markers = collectMarkers(sourceText, tokens);

  const segments: { start: number; end: number; sequencedFromPrevious: boolean }[] = [];
  const accepted: Marker[] = [];
  let cursor = 0;
  let sequencedFromPrevious = false;

  for (const marker of markers) {
    if (marker.start < cursor) continue;
    const candidate = trimRange(sourceText, cursor, marker.start);
    if (candidate.start >= candidate.end) continue;
    if (!beginsAction(firstWordAfter(tokens, marker.end))) continue;

    segments.push({ start: cursor, end: marker.start, sequencedFromPrevious });
    accepted.push(marker);
    sequencedFromPrevious = marker.sequencing;
    cursor = marker.end;
  }

  if (accepted.length === 0) return empty;
  segments.push({ start: cursor, end: sourceText.length, sequencedFromPrevious });

  const steps: DecompositionStepProposal[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const trimmed = trimRange(sourceText, segment.start, segment.end);
    if (trimmed.start >= trimmed.end) return empty;

    const timing = splitTiming(sourceText.slice(trimmed.start, trimmed.end));
    const bounded = trimRange(sourceText, trimmed.start, trimmed.end - timing.consumed);
    // A segment that is nothing but a time phrase is not a step. Rather than
    // emit it and rely on the validator, the whole split is abandoned: a
    // detector that knows its output is wrong should not have produced it.
    if (bounded.start >= bounded.end) return empty;

    const span: SourceSpan = {
      start: bounded.start,
      end: bounded.end,
      text: sourceText.slice(bounded.start, bounded.end),
    };
    // A one-word step is almost always a conjoined *object* that the
    // begins-an-action test could not rule out. Hebrew is where this bites:
    // `ל` is both the infinitive prefix and the preposition "to", so `ולעומר`
    // ("and to Omar") is morphologically indistinguishable from a conjoined
    // infinitive, and the prefix rule alone splits `תשלח מכתב לשרה ולעומר`
    // into an errand nobody described. Requiring a step to be a phrase costs
    // the rare genuinely one-word step ("Shop and cook") and buys back the
    // whole class of trailing-recipient over-splits.
    if (tokenize(span.text).length < 2) return empty;
    const dependsOn: StepDependency[] = segment.sequencedFromPrevious
      ? [{ dependsOnStepId: `s${index}`, kind: 'temporal' }]
      : [];

    steps.push({
      stepId: `s${index + 1}`,
      title: span.text,
      sourceSpans: [span],
      inferred: false,
      dependsOn,
      statedTiming: timing.timing,
      // Never populated. No rule distinguishes the person who must act from the
      // person acted upon — "send a note to Sarah" names a recipient, not an
      // owner — and guessing is exactly the `INVENTED_OWNER` failure.
      statedOwner: null,
    });
  }

  if (steps.length < 2) return empty;
  return {
    steps,
    confidence: accepted.reduce((weakest, marker) => Math.min(weakest, marker.confidence), 1),
  };
}
