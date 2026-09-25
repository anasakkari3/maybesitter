/**
 * The deterministic reader of unresolved intent (#519).
 *
 * Between "this message asks for nothing" and "this is a commitment" there is
 * a third thing people actually type: «يمكن أقدّم على NVIDIA هالفصل», "I'm
 * waiting for the doctor to reply", «אני שוקל לטוס בדצמבר». Today all three
 * fall out of the capture as `no_commitment`, and the product answers a
 * neutral line and forgets them. A Seed is what survives instead — but only
 * if the user picks it in Review, and only if this file recognised it without
 * a model's help.
 *
 * ── Why this is deterministic, and not a prompt ──────────────────
 *
 * The same reason `classifyMessageKind` is (UC-2.6, #166): the rule-based
 * extractor is *the* engine whenever AI consent has not been granted, which is
 * the default for every new account. A seed detector living in the Gemini
 * prompt would offer this feature to exactly the users who said yes to a model
 * and to nobody else.
 *
 * It also makes the issue's validation rules mean something. "Exact source
 * evidence, no invented date, no invented person, no sensitive inference" is
 * not a list of things a model is asked to respect here — it is a property of
 * the output shape:
 *
 *  - **exact source evidence** — `summary` is the segment, `trim()`ed and
 *    otherwise byte-for-byte. Nothing paraphrases, nothing summarises, and
 *    there is no field a paraphrase could occupy.
 *  - **no invented date** — the detector returns a kind and nothing else. A
 *    seed's `revisitAt` is null when it is created and can only be set later,
 *    by the user, through the patch route.
 *  - **no invented person** — same: there is no person field to fill.
 *  - **no sensitive inference** — `kind` is read off intent markers («maybe»,
 *    «waiting for», «someday»), never off what the sentence is *about*. "I'm
 *    waiting for the doctor to reply" is `waiting_for` because of "waiting
 *    for", not because of "doctor"; nothing here reads a topic, and the four
 *    kinds carry no topic between them.
 *  - **first-person relevance** — every marker below is first-person by
 *    construction. «مستني» and «אני מחכה» are the speaker waiting; "the doctor
 *    is waiting for a reply" matches nothing here.
 *  - **no action already concrete enough to be a Commitment** — enforced by
 *    where this is *called* rather than by a pattern: the capture boundary
 *    offers a segment to this detector only after the segment produced no
 *    commitment item of its own. Anything the extractor could read as an
 *    action never reaches here.
 *
 * ── The corpora both stay where they are ────────────────────────
 *
 * Two things must not move, and each is a test rather than an intention:
 * `tests/extraction/createNothing.test.ts`'s no-op corpus and the actionable
 * corpus beside it. A greeting, a question, a feeling and a past event carry
 * none of these markers, so they keep answering `no_commitment` exactly as
 * before; a request never reaches this file at all.
 */
import type { SeedKind } from '../contracts/v1/intentContracts';
import { SEED_SUMMARY_MAX_CHARACTERS } from '../contracts/v1/intentContracts';

/**
 * The speaker is waiting on somebody or something else.
 *
 * First person on both sides: the English forms bind "waiting" to "I"/"we",
 * and the Arabic and Hebrew participles («مستني», «مستنية», «بستنى», «מחכה»)
 * are the speaker's own by inflection. «بانتظار» is included because it is how
 * the same sentence is written more formally, and it is not a third-person
 * construction in the way "he is waiting" is.
 */
const WAITING_FOR = new RegExp([
  /\b(?:i'?m|i am|we'?re|we are)\s+(?:still\s+)?waiting\s+(?:for|on)\b/.source,
  /\bi'?m\s+(?:still\s+)?expecting\s+(?:a|an|the)\s+(?:reply|answer|response|call|email)\b/.source,
  /\bwaiting\s+(?:to hear|for a reply|for an answer|on a reply)\b/.source,
  /مستني|مستنية|مستنّي|بستنى|عم بستنى|بانتظار|لسا ما رد|لسه ما رد/.source,
  /אני מחכה|אנחנו מחכים|מחכה לתשובה|עדיין מחכה/.source,
].join('|'), 'i');

/**
 * Something the speaker may want, one day, with no date attached.
 *
 * Checked before `CONSIDERATION` because "maybe someday I'll move abroad" is
 * both, and the further-off reading is the safer one: a `possible_goal` is the
 * kind the product is least tempted to do anything with.
 */
const POSSIBLE_GOAL = new RegExp([
  /\b(?:some\s?day|one day|eventually)\b/.source,
  /\bi(?:'d| would) (?:love|like) to\b/.source,
  /\bi dream of\b|\bmy dream is\b/.source,
  /يوم من الأيام|بيوم من الأيام|حلمي|بحلم|نفسي يوم/.source,
  /יום אחד|החלום שלי|אני חולם|אני חולמת/.source,
].join('|'), 'i');

/**
 * The speaker is turning something over: «maybe», «thinking about»,
 * «considering», «I want to think about it».
 *
 * «يمكن» and «ممكن» are here as openers of a first-person clause. They are not
 * anchored to a verb list, because Levantine puts the verb in a dozen shapes
 * and a list of them would be a list of the ones somebody thought of. The
 * narrowing that matters is upstream: this detector only ever sees a segment
 * the extractor already declined to read as a commitment.
 */
const CONSIDERATION = new RegExp([
  /\bmaybe i(?:'ll|'m| will| might| should| can| could)?\b/.source,
  /\bi(?:'m| am) (?:thinking|considering)\b/.source,
  /\bi might\b|\bi'?m tempted to\b/.source,
  /\bi want to think about\b|\bi need to think about\b|\bthinking it over\b/.source,
  /\bnot sure (?:yet )?(?:if|whether) i\b/.source,
  /يمكن|ممكن|ربما|بفكر|بفكّر|عم أفكر|عم بفكر|مفكر|مفكّر|ناوي|ناوية|بدي أفكر/.source,
  /אולי|אני חושב על|אני חושבת על|אני שוקל|אני שוקלת|צריך לחשוב על/.source,
].join('|'), 'i');

/**
 * A possibility noted down, not yet even considered. The narrowest of the
 * four, and deliberately so: without an explicit «idea:» opener or a "it would
 * be nice to" frame, an idea is indistinguishable from narration.
 */
const IDEA = new RegExp([
  /^\s*idea\s*[:\-]/.source,
  /\bit (?:would|could) be (?:nice|good|great|cool) to\b/.source,
  /^\s*فكرة\s*[:\-]|حلو لو|حلوة لو|كان زين لو/.source,
  /^\s*רעיון\s*[:\-]|יהיה נחמד ל|שווה לחשוב/.source,
].join('|'), 'i');

/**
 * An explicit ask to be reminded, to schedule, or to add something.
 *
 * This is the one thing that outranks every marker below it, and it is why the
 * detector may run *before* the extractor rather than only on what the
 * extractor threw away. «ممكن تذكرني بكرة الساعة ٩؟» — "could you remind me
 * tomorrow at nine?" — opens with «ممكن», which is as ordinary a way to start a
 * request in Levantine as "could you" is in English. Reading it as a
 * consideration would take the single most common Arabic phrasing of a
 * reminder and quietly file it as something the user was merely thinking
 * about, and they would find out when it did not ring.
 *
 * Deliberately narrower than `messageKind`'s `REQUEST`. That pattern also
 * matches "I want", "I need" and «لازم», which are exactly how somebody says
 * "I want to think about travelling in December" — a sentence that is
 * unresolved intent and nothing else. Only the verbs that name *scheduling*
 * are here.
 */
const EXPLICIT_SCHEDULING = new RegExp([
  /\b(?:remind me|remind us|remember to|don'?t let me forget|add (?:a )?(?:task|reminder)|set (?:a )?reminder|schedule|book)\b/.source,
  /ذكرني|ذكريني|ذكرنى|فكرني|ضيف مهمة|حط تذكير|احجز/.source,
  /תזכיר לי|תזכירי לי|תוסיף משימה|לקבוע|תזמן/.source,
].join('|'), 'i');

/**
 * An instruction aimed at the product rather than a thought about the user's
 * own life. The capture boundary already refuses these outright; the check is
 * repeated here so that a caller which reaches the detector by another path
 * cannot turn a prompt injection into a stored sentence the user then sees
 * offered back as their own intent.
 */
const INJECTION = new RegExp([
  /(?:ignore|disregard|override).{0,40}(?:instruction|system|policy)|(?:system|developer)\s*:/.source,
  /(?:[أاتني]?تجاهل|انس|تجاوز).{0,40}(?:التعليمات|التوجيهات|البرومبت|أوامر|النظام(?!\s+(?:الغذائي|الصحي|القديم)))/.source,
  /(?:התעלם|תתעלם|להתעלם|עקוף).{0,40}(?:הוראות|מערכת)/.source,
].join('|'), 'i');

/** What the detector found: a kind, and nothing else. */
export interface UnresolvedIntentReading {
  readonly kind: SeedKind;
}

/**
 * Reads one segment as unresolved intent, or does not.
 *
 * `null` is the ordinary answer and the safe one: the capture then behaves
 * exactly as it did before this file existed.
 *
 * Order is `waiting_for` → `possible_goal` → `consideration` → `idea`, most
 * specific first. «يمكن أستنى الدكتور» is a wait, not a maybe. An explicit
 * scheduling verb anywhere in the segment beats all four.
 */
export function detectUnresolvedIntent(rawSegment: unknown): UnresolvedIntentReading | null {
  const segment = typeof rawSegment === 'string' ? rawSegment.trim() : '';
  if (!segment) return null;
  // Counted in code points for the reason `SEED_SUMMARY_MAX_CHARACTERS` gives.
  // `Array.from` rather than spread: the repository's TS target does not
  // down-level string iteration.
  if (Array.from(segment).length > SEED_SUMMARY_MAX_CHARACTERS) return null;
  if (INJECTION.test(segment)) return null;
  if (EXPLICIT_SCHEDULING.test(segment)) return null;

  if (WAITING_FOR.test(segment)) return { kind: 'waiting_for' };
  if (POSSIBLE_GOAL.test(segment)) return { kind: 'possible_goal' };
  if (CONSIDERATION.test(segment)) return { kind: 'consideration' };
  if (IDEA.test(segment)) return { kind: 'idea' };
  return null;
}
