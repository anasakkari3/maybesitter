/**
 * The strategy and intent policy (Sprint 09, issue #38).
 *
 * Two questions and nothing else: given an approved recommendation and
 * optionally the decision the user made about it, **what is this turn for**
 * (`CoachingIntent`) and **which claim leads it** (`CoachingStrategy`).
 *
 * ## How this relates to the shipped `intentSelection.ts`
 *
 * `lib/services/responseEngine/intentSelection.ts` already ships an intent
 * selector at product scope. Nothing here imports it and nothing there imports
 * this. Where the two decide the same thing:
 *
 * - **Deliberately different: statelessness.** The engine reads
 *   `commitmentState.lastStrategy` and `conversationState.fatigue` from a
 *   conversation store, and `rotateStrategy` moves it on when it would repeat
 *   itself. This module is a pure function of the offer: the same input
 *   produces the same strategy, always. Anti-repetition is a property of a
 *   *conversation* and belongs to whoever owns one; a module whose central
 *   claim is replayability cannot own a rotation counter. The consequence is
 *   stated rather than hidden — this module will happily produce the same
 *   sentence twice for the same unchanged recommendation, and the caller that
 *   dislikes that is the caller holding the conversation state.
 *
 * - **Deliberately stricter: no escalation ladder.** The engine escalates
 *   `easy_choice → smaller_step → blocker_probe → reset_plan → close_loop` as
 *   `pressureCount` rises. There is no counterpart here, because every one of
 *   those moves asserts something no recommendation carries: `probe_blocker`
 *   asserts that something is blocking, `close_loop` asserts the user has been
 *   asked before. A module that must trace every claim to a support reason has
 *   no evidence for either, and shipping the strategy before the evidence that
 *   could support it is how the strategy becomes the evidence.
 *
 * - **Same rule: two sentences.** `maxSentences` is 1 or 2 in both, for the
 *   same reason — `AssistantVerbosity` is `'low'`. The number lives in
 *   `COACHING_SENTENCE_POLICY` so the cross-track test can compare the two
 *   rather than have them agree by coincidence.
 *
 * ## Determinism
 *
 * No clock, no random source, no identifier minted, and **no ordering**. The
 * lead reason is the first element of the offer's `support` tuple, which the
 * selector already ordered; this module does not re-sort and so needs no
 * comparator at all. That is the same device `checkEvidenceGraph` uses to be
 * deterministic without importing one, and it is why there is no
 * `localeCompare` here to ban.
 */

import {
  COACHING_INTENT_STRATEGIES,
  COACHING_SENTENCE_POLICY,
  CLAIM_KIND_FOR_DECISION_VERDICT,
  CLAIM_KIND_FOR_SUPPORT_REASON,
  type CoachingIntent,
  type CoachingStrategy,
} from '../../../src/contracts/v1/coachingContracts';
import {
  bandForConfidence,
  summarizeOptionSet,
  type Recommendation,
  type RecommendationDecision,
  type RecommendationDecisionVerdict,
  type SupportReasonCode,
} from '../../../src/contracts/v1/recommendationContracts';

/**
 * The shape the intent decision reads.
 *
 * Narrower than `Recommendation` on purpose: this is the whole of what the
 * policy is allowed to look at, so a rule that started depending on something
 * else has to widen this type in a diff a reviewer sees. `PlanShape` is derived
 * by `shapeOf` below rather than supplied, so a caller cannot hand the policy a
 * shape that disagrees with the recommendation it came from.
 */
export interface PlanShape {
  readonly outcome: 'offered' | 'withheld' | 'unknown';
  readonly soleness: 'choice' | 'sole_survivor' | 'only_candidate' | 'unknown';
  /** The lead option's confidence band, or null when there is no lead. */
  readonly leadBand: 'low' | 'medium' | 'high' | null;
  readonly verdict: RecommendationDecisionVerdict | null;
}

/**
 * What the policy may read, derived rather than trusted.
 *
 * `bandForConfidence` is called on `value` rather than `band` being read off
 * the option. The stored band is what a UI renders and the value is what
 * ranking uses, and `CONFIDENCE_BAND_MISMATCH` exists because the two can
 * disagree — so a policy that read the stored band would take a strategy
 * decision from the field that is wrong in exactly the case the contract added
 * a code for. Null propagates rather than clamping to `'low'`: a NaN confidence
 * presented as a measured judgement of low confidence is the repair
 * `bandForConfidence` was written to refuse.
 */
export function shapeOf(
  recommendation: Recommendation,
  decision: RecommendationDecision | null | undefined,
): PlanShape {
  const verdict =
    decision === null || decision === undefined || typeof decision !== 'object'
      ? null
      : (decision.verdict as RecommendationDecisionVerdict) ?? null;
  const safe = recommendation === null || recommendation === undefined ? null : recommendation;
  if (safe === null || (safe.outcome !== 'offered' && safe.outcome !== 'withheld')) {
    return { outcome: 'unknown', soleness: 'unknown', leadBand: null, verdict };
  }
  if (safe.outcome === 'withheld') {
    return { outcome: 'withheld', soleness: 'unknown', leadBand: null, verdict };
  }
  const summary = summarizeOptionSet(safe.options);
  const lead = summary.lead;
  const value =
    lead === null || lead === undefined || lead.confidence === null || lead.confidence === undefined
      ? Number.NaN
      : lead.confidence.value;
  return {
    outcome: 'offered',
    soleness: summary.soleness,
    leadBand: bandForConfidence(value),
    verdict,
  };
}

/**
 * The intent for a shape.
 *
 * Null rather than a thrown error and rather than a default intent, per
 * `COACHING_INPUT_POLICY.reportWhatTheTaxonomyNames`: a shape this version does
 * not recognise has no honest intent, and picking the mildest one would mean a
 * malformed offer is coached about as though it were an ordinary one. The
 * caller turns the null into `UNKNOWN_COACHING_INTENT`.
 *
 * **A decision wins over the offer.** Once the user has acted, the turn is
 * about their act; presenting the offer again would be a system that did not
 * notice. The one case that could still go either way — a `dismiss` targeting
 * the whole offer — resolves the same way, because "you dismissed that" is
 * still a claim about the user's act rather than about the world.
 */
export function intentFor(shape: PlanShape): CoachingIntent | null {
  // Total on purpose. `shapeOf` always returns an object, but this is exported
  // and a null shape raised a `TypeError` out of a function whose contract is
  // to *return* null for a shape it does not cover.
  if (shape === null || shape === undefined || typeof shape !== 'object') return null;
  if (shape.verdict !== null && shape.verdict !== undefined) {
    if (shape.verdict === 'accept' || shape.verdict === 'edit') return 'acknowledge_acceptance';
    if (shape.verdict === 'done') return 'acknowledge_completion';
    if (shape.verdict === 'dismiss' || shape.verdict === 'defer') return 'acknowledge_dismissal';
    return null;
  }
  if (shape.outcome === 'withheld') return 'explain_withholding';
  if (shape.outcome !== 'offered') return null;
  if (shape.soleness === 'choice') return 'present_choice';
  if (shape.soleness === 'sole_survivor' || shape.soleness === 'only_candidate') return 'present_sole_option';
  return null;
}

/**
 * The strategy for an intent and a shape.
 *
 * Every branch returns a member `COACHING_INTENT_STRATEGIES` permits for that
 * intent, and the assertion that this holds for **every** producible pair lives
 * in `tests/coaching/plannerPolicy.test.ts` rather than here — a rule checked
 * only by the code that applies it is a rule only that code can be wrong about,
 * which is why the table is exported data in the first place.
 *
 * The one real choice is between `lead_with_action` and `lead_with_reason` for
 * a sole option, and it is decided on the confidence band: **high leads with
 * the action, anything else leads with the reason.** The direction matters. A
 * confident recommendation can afford to name the move first, because the user
 * asking "why?" gets an answer in the second sentence. A recommendation the
 * module is *not* confident about must earn the move before naming it, or a
 * medium-confidence guess reads with the same authority as a certainty. A null
 * band — an unparseable confidence — leads with the reason for the same reason
 * it is not treated as `'low'`: the conservative branch is the one that does
 * not spend authority the module has not established it has.
 */
export function strategyFor(intent: CoachingIntent, shape: PlanShape): CoachingStrategy | null {
  const band = shape === null || shape === undefined || typeof shape !== 'object' ? null : shape.leadBand;
  if (intent === 'present_choice') return 'name_the_alternatives';
  // A null band leads with the reason, exactly as a low one does: the
  // conservative branch is the one that does not spend authority the module has
  // not established it has.
  if (intent === 'present_sole_option') return band === 'high' ? 'lead_with_action' : 'lead_with_reason';
  if (intent === 'explain_withholding') return 'state_the_gap';
  if (
    intent === 'acknowledge_acceptance' ||
    intent === 'acknowledge_completion' ||
    intent === 'acknowledge_dismissal'
  ) {
    return 'confirm_and_stop';
  }
  return null;
}

/**
 * How many sentences an intent is allowed.
 *
 * Two for the presenting intents, because a proposal that names a move without
 * naming why it was chosen is an instruction. One for everything else: an
 * acknowledgement that runs to two sentences has started explaining itself, and
 * a system explaining a decision the user just made is the shape
 * `personalityService`'s filler patterns exist to keep out.
 */
export function maxSentencesFor(intent: CoachingIntent): number {
  const two = intent === 'present_choice' || intent === 'present_sole_option';
  return two ? COACHING_SENTENCE_POLICY.maxSentences : COACHING_SENTENCE_POLICY.minSentences;
}

/**
 * The claim kind a support reason licenses, or null for a code this version
 * does not map.
 *
 * A lookup rather than a `switch`, so the table and the code cannot drift.
 * `CLAIM_KIND_FOR_SUPPORT_REASON` is total over `SupportReasonCode`, so the
 * null branch is only reachable from the untyped boundary — which is exactly
 * where it needs to be reachable, and why this returns null rather than
 * asserting the table is total.
 */
export function claimKindForReason(code: SupportReasonCode): string | null {
  const table = CLAIM_KIND_FOR_SUPPORT_REASON as Readonly<Record<string, string>>;
  const found = Object.prototype.hasOwnProperty.call(table, code as string) ? table[code as string] : undefined;
  return found === undefined ? null : found;
}

/** The claim kind a decision verdict licenses, or null at the boundary. */
export function claimKindForVerdict(verdict: RecommendationDecisionVerdict): string | null {
  const table = CLAIM_KIND_FOR_DECISION_VERDICT as Readonly<Record<string, string>>;
  const found = Object.prototype.hasOwnProperty.call(table, verdict as string) ? table[verdict as string] : undefined;
  return found === undefined ? null : found;
}

/** Whether a pair is one the contract's table permits. Used at both ends. */
export function isPermittedPair(intent: CoachingIntent, strategy: CoachingStrategy): boolean {
  const allowed = COACHING_INTENT_STRATEGIES[intent] as readonly string[] | undefined;
  return allowed !== undefined && allowed.includes(strategy);
}
