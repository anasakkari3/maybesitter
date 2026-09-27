/**
 * What kind of message this is, before asking what commitment is in it
 * (UC-2.6, #166).
 *
 * The rule-based extractor used to answer "what task is this" for every input,
 * so «صباح الخير» became a task titled "الخير" and «מה השעה?» became one titled
 * "מה השעה?". Across the 40 synthetic safety cases in
 * `evaluation-data/capture-messy-multilingual-v1.jsonl` it created something for
 * 27 of them.
 *
 * ── Why this is deterministic and not a prompt instruction ───────
 *
 * Because the rule-based extractor is not a fallback. It is *the* engine
 * whenever AI consent has not been granted (#161 computes `requestedEngine`
 * from the stored record), which is the default for every new account. A
 * classification that lives only in the Gemini prompt would leave the create-
 * nothing promise untrue for exactly the users who declined the model.
 *
 * ── The ordering is the whole design ────────────────────────────
 *
 * A message can look like several kinds at once. "Can you remind me to call the
 * clinic tomorrow?" is a question by punctuation and a request by intent, and
 * getting that backwards in either direction is a real failure: read as a
 * question it silently creates nothing, read as a request every "what time is
 * it?" becomes a task. So an explicit commitment request wins over every other
 * signal, and the rest are checked from most specific to least.
 */

import { timeOfDayEvidence } from './timeLexicon';

export type MessageKind =
  /** Asks for something to be remembered, scheduled or done. */
  | 'request'
  /** States a fact, a feeling or news. Nothing is being asked for. */
  | 'informational'
  /** A greeting or small talk. */
  | 'greeting_or_chat'
  /** A question put to the assistant. */
  | 'question'
  /** Something that already happened. */
  | 'past_event'
  /** Asks *not* to be reminded. */
  | 'negated_request';

/**
 * An explicit ask. This is what outranks the question mark.
 *
 * Deliberately narrow: a verb that names remembering or scheduling, or a
 * first-person obligation («لازم», «צריך», "I need to"). A bare imperative is
 * not here — "tell me the weather" is not a commitment — and neither is a bare
 * infinitive, because «لسيارة» phrases and Hebrew infinitives appear in plain
 * narration too.
 */
const REQUEST = new RegExp([
  /\b(?:remind me|remember to|don't let me forget|add (?:a )?(?:task|reminder)|schedule|book|set (?:a )?reminder)\b/.source,
  /\bi (?:need|have|want|must|gotta|should)\b/.source,
  /\bneed to\b|\bhave to\b|\bmust\b|\bgotta\b|\bpls remind\b|\bplease remind\b/.source,
  /ذكرني|ذكريني|ذكرنى|فكرني|لازم|بدي|أبي|ابي|محتاج|احتاج|أحتاج|علي\s|عليّ/.source,
  /תזכיר לי|תזכירי לי|צריך|צריכה|אני חייב|חייבת|תוסיף|לקבוע/.source,
].join('|'), 'i');

/**
 * Asks not to be reminded. Checked before `REQUEST`, because every one of these
 * contains a request verb — that is what is being negated.
 */
const NEGATED = new RegExp([
  /\b(?:don't|dont|do not|never|no need to|stop)\s+(?:remind|remember|schedule|add|create|notify|bug)\b/.source,
  /\b(?:remind me|remember to|bug me)\s+not\b/.source,
  // A request verb in one language negated in another. Code-switching puts the
  // negation on the English side of «תזכיר לי not to worry about it», where a
  // same-script pattern never sees it.
  /(?:תזכיר לי|תזכירי לי|ذكرني|ذكريني|remind me)\s+not\b/.source,
  /لا تذكرني|لا تذكريني|ما تذكرني|ما تذكريني|بلا تذكير|مش بدي تذكير|ما بدي تذكير|ما بديش تذكير|بطل تذكرني|بطلي تذكريني/.source,
  /אל תזכיר לי|אל תזכירי לי|לא צריך להזכיר|תפסיק להזכיר|תפסיקי להזכיר/.source,
].join('|'), 'i');

/**
 * A greeting, or the opening of small talk. Whole words: «שלום» inside
 * «לשלום» (to Shalom), «سلام» inside «الإسلام», «هلا» inside «هلال» are not
 * greetings. Farewells and wishes are small talk too — "see you tomorrow",
 * «بشوفك بكرا», «נתראה מחר» — so the day in them is not a commitment.
 */
const GREETING_SOURCES: readonly string[] = [
  // A bare "Morning" / "Evening" opens small talk only when it stands alone
  // ("Morning!", "Morning, call mom…"); "morning run tomorrow" is the run.
  /^\s*(?:hi|hey|hello|yo|good\s+(?:morning|afternoon|evening|night)|thanks|thank you|ok|okay)\b|^\s*(?:morning|evening)\b(?=\s*(?:[,!.]|$))/.source,
  /\bhow are you\b|\bwhat'?s up\b|\bhow'?s it going\b/.source,
  /\bgood\s+(?:morning|afternoon|evening|night)\b|\bsee you\b|\btalk (?:to you )?(?:later|soon)\b|\bcatch you later\b|\btake care\b|\bhave a (?:good|great|nice|lovely) (?:day|night|evening|weekend|one)\b/.source,
  '(?<![\\p{L}\\p{M}])(?:صباح الخير|صباح النور|مساء الخير|مسا الخير|مرحبا|مرحبتين|أهلا|اهلا|هلا|سلام|السلام عليكم|مع السلامة|كيفك|كيف حالك|شو الأخبار|شو الاخبار|شكرا|تصبح على خير|تصبحي على خير|بشوفك|منشوفك|نشوفك|بنشوفك|يومك سعيد|نهارك سعيد)(?![\\p{L}\\p{M}])',
  '(?<![\\p{L}\\p{M}])(?:בוקר טוב|צהריים טובים|ערב טוב|לילה טוב|שלום|היי|מה קורה|מה נשמע|מה העניינים|תודה|נתראה|נדבר|יום טוב|המשך יום טוב)(?![\\p{L}\\p{M}])',
];
const GREETING = new RegExp(GREETING_SOURCES.join('|'), 'iu');
// Strings, not literals: the `u` flag is not available to a regex literal
// under this tsconfig's target (see INTERROGATIVE below).
const LEADING_MARKS = new RegExp('^[\\s,.!،؛:;-]+', 'u');
const WORD_BREAK = new RegExp('[\\s,.!?؟،؛:;]+', 'u');
const HAS_LETTER = new RegExp('\\p{L}', 'u');

/**
 * What a greeting leaves once it is taken out — every greeting, the ones that
 * open the message first, so "ok thanks, see you" leaves nothing.
 */
function withoutGreetings(text: string): string {
  let rest = text;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = rest.replace(new RegExp(GREETING_SOURCES.join('|'), 'giu'), ' ').replace(LEADING_MARKS, '');
    if (next === rest) break;
    rest = next;
  }
  return rest.trim();
}

const LEADING_GREETING = new RegExp(`^[\\s,.!،؛:;-]*(?:${GREETING_SOURCES.join('|')})[\\s,.!،؛:;-]*`, 'iu');

/**
 * The text without the greetings it opens with, for a title: "good morning,
 * call mom" is "call mom". Only the opening ones — "tell dad good night" keeps
 * its words.
 */
export function stripLeadingGreetings(text: string): string {
  let rest = text;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = rest.replace(LEADING_GREETING, '');
    if (next === rest) break;
    rest = next;
  }
  return rest;
}

/**
 * The part after a greeting states a commitment: it names a day or a time,
 * and says something besides it. "Good morning, call mom tomorrow" does;
 * "thanks, see you tomorrow" leaves only "tomorrow"; "good morning everyone"
 * names no day. A greeting with no day or time after it stays small talk —
 * the rules cannot tell "call mom" from "everyone", and a greeting made into a
 * task is the #166 failure this file exists for.
 */
function carriesCommitment(rest: string): boolean {
  if (timeOfDayEvidence(rest) === 'none') return false;
  return rest
    .split(WORD_BREAK)
    .filter((word) => HAS_LETTER.test(word))
    .some((word) => timeOfDayEvidence(word) === 'none');
}

/**
 * A question put to the assistant.
 *
 * Either an interrogative opener or a trailing question mark — Latin `?` and
 * Arabic `؟` both. A question mark alone is enough: someone who typed one is
 * asking, not committing.
 */
const QUESTION_MARK = /[?؟]\s*$/;
const INTERROGATIVE = new RegExp([
  /^\s*(?:what|what'?s|how|when|where|why|who|which|can you|could you|do you|does|is there|are there)\b/.source,
  // Not `\b` after the Arabic and Hebrew openers: JS word boundaries are
  // defined over `[A-Za-z0-9_]`, so «متى» followed by a space is *not* a
  // boundary and «متى الاجتماع» was read as a request — and became a
  // commitment titled "متى الاجتماع" (#401). The boundary is "not another
  // letter or digit", which is what `\b` means and cannot say here, and it
  // still keeps «كيفك» (a greeting) from reading as «كيف» (a question).
  // Written as strings: the `u` flag these need is not available to a regex
  // literal under this tsconfig's target, and the compiled RegExp carries it.
  '^\\s*(?:شو|شنو|إيش|ايش|كيف|كيفية|وين|فين|ليش|لماذا|مين|من هو|متى|إمتى|امتى|هل|أين)(?![\\p{L}\\p{N}])',
  '^\\s*(?:מה|איך|מתי|איפה|למה|מי|האם|כמה)(?![\\p{L}\\p{N}])',
].join('|'), 'iu');

/**
 * First-person state, feeling or narration: something is being told, not asked.
 *
 * No therapeutic reading is attached to any of this. «حسّيت بضغط» is classified
 * as informational for one reason — nothing was requested — and the product's
 * answer is to create nothing and say so neutrally. It is not an emotion to be
 * interpreted, and #166 is explicit that it must not be.
 */
const INFORMATIONAL = new RegExp([
  /\b(?:i|we)\s+(?:had|feel|felt|am feeling|was|were)\b/.source,
  /\bfeeling\b|\bfyi\b|\bjust so you know\b|\bfor your information\b/.source,
  /\b(?:is|are)\s+waiting on\b|\bwaiting on\b/.source,
  /\b(?:asked|told)\s+me\b/.source,
  /كان يوم|حسّيت|حسيت|شاعر|تعبان|تعبانة|مرهق|زادت|ارتفعت|سألتني|سألني|قال لي|قالت لي|مستني|مستنية|بانتظار/.source,
  /היה לי|אני מרגיש|אני מרגישה|עייף|עייפה|שאל אותי|שאלה אותי|ביקש ממני|מחכה|מחכים/.source,
].join('|'), 'i');

/** Already happened, and nothing is being asked about it. */
const PAST = new RegExp([
  /\b(?:yesterday|last night|last week|last month|earlier today|this morning already)\b/.source,
  /\b(?:was|were|had|met|saw|went|finished|cancelled|canceled)\b.*\b(?:yesterday|last week|last night)\b/.source,
  /مبارح|امبارح|أمس|الأسبوع الماضي|الشهر الماضي|انتهى|خلص/.source,
  /אתמול|שלשום|בשבוע שעבר|בחודש שעבר|נגמר|בוטל/.source,
].join('|'), 'i');

/** A forwarded message, which is somebody else's text rather than a request. */
const FORWARDED = /^\s*(?:fwd|fw|forwarded)\s*:/i;

/**
 * Classifies the message.
 *
 * Order, and why each step comes where it does:
 *
 *  1. **negated** — every one of these contains a request verb; that verb is
 *     what is being negated, so it has to be read before `REQUEST` sees it.
 *  2. **request** — an explicit ask outranks a question mark and a greeting.
 *     "Can you remind me to call the clinic tomorrow?" is a request.
 *  3. **forwarded** — somebody else's text. Whatever is inside it was not asked
 *     of us, and #166's dataset has these as create-nothing.
 *  4. **past_event** — before `question` and `greeting`, because "was the
 *     meeting cancelled yesterday?" is about something that already happened.
 *  5. **question** — an interrogative or a trailing question mark.
 *  6. **greeting_or_chat** — a greeting with nothing asked. What follows a
 *     greeting is classified on its own when it names a day or a time and
 *     says something besides it: a greeting does not swallow a commitment.
 *  7. **informational** — a state, a feeling or news.
 *  8. otherwise a request, which keeps every plain imperative ("buy milk")
 *     working: that is the overwhelmingly common case and it carries none of
 *     the markers above.
 */
export function classifyMessageKind(rawText: string): MessageKind {
  const text = (rawText ?? '').trim();
  if (!text) return 'informational';

  if (NEGATED.test(text)) return 'negated_request';
  if (REQUEST.test(text)) return 'request';
  if (FORWARDED.test(text)) return 'past_event';
  if (PAST.test(text)) return 'past_event';
  if (INTERROGATIVE.test(text) || QUESTION_MARK.test(text)) return 'question';
  if (GREETING.test(text)) {
    // A greeting in front of a commitment does not swallow it (CL1): "good
    // morning, call mom tomorrow" is the call. The rest is read on its own.
    const rest = withoutGreetings(text);
    return rest && carriesCommitment(rest) ? classifyMessageKind(rest) : 'greeting_or_chat';
  }
  if (INFORMATIONAL.test(text)) return 'informational';
  return 'request';
}

/** True when this kind must never produce a commitment. */
export function createsNothing(kind: MessageKind): boolean {
  return kind !== 'request';
}

/**
 * The reason code the proposal carries, for the client to map to one neutral
 * line. `request` has no reason: it is not a no-commitment outcome.
 */
export function noCommitmentReasonFor(kind: MessageKind): Exclude<MessageKind, 'request'> | null {
  return kind === 'request' ? null : kind;
}
