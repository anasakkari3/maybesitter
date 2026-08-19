/**
 * Coaching contracts (Sprint 09, issue #38).
 *
 * Coaching answers "say that back to me in a sentence I can act on". It is the
 * last step before a user reads anything: Priority said what matters, Planning
 * said when it fits, Recommendation said which move to propose and *why*, and
 * Coaching turns that why into prose — **adding nothing**.
 *
 * That last word is the whole contract. Every sentence this module emits is a
 * set of claims, every claim names the reason in the approved recommendation it
 * was derived from, and every claim's evidence is a subset of that reason's
 * evidence. There is no path by which a coaching sentence can assert a fact the
 * recommendation did not already assert, and `lib/coaching/validator/` is what
 * makes that a checked property rather than a stated intention.
 *
 * ── Relationship to the shipped response engine ──────────────────────────
 *
 * `lib/services/responseEngine/` already ships a response planner
 * (`responsePlanning.ts`), an intent selector (`intentSelection.ts`), a
 * realizer (`realization.ts`) and a validator (`validation.ts`), plus
 * `lib/services/personalityService.ts` for tone. Those are this issue's
 * deliverable names almost verbatim, at product scope, behind the assistant
 * turn a user actually sees today.
 *
 * This file does **not** replace them, does not import them, and changes
 * nothing they return. The division of authority is the one Sprint 08 settled
 * for `recommendationContracts` beside the V03 pilot:
 *
 *   - `lib/services/responseEngine/**` is authoritative for the **shipped
 *     assistant turn** — a reply to a `SemanticEvent` produced by capture. Its
 *     job is to stay stable for a surface already deployed.
 *   - This file is authoritative for the **`coaching` intelligence module** —
 *     the thing that wraps a Sprint 08 `Recommendation`, at the same scope as
 *     `lib/priority/**`, `lib/planning/**` and `lib/recommendation/**` sit
 *     beside the product code they will eventually inform.
 *
 * The two answer different questions from different inputs. The engine's input
 * is a semantic event about something that *already happened* ("a reminder was
 * created", "a commitment was completed"); this module's input is a
 * recommendation about something that *has not happened yet*. That is why the
 * intent vocabularies are disjoint rather than shared — see `CoachingIntent`,
 * where each member states its relationship to the engine's
 * `CommunicativeIntent`.
 *
 * Where the two decide the same thing, the comment at the decision says which
 * of three it is: **same rule**, **deliberately stricter**, or **superset**.
 * Sprint 06's recorded cost of not doing that was four review rounds, each
 * finding a defect already fixed on the other side. A merge-owned cross-track
 * test compares the two on the same inputs, so an unintended difference is one
 * this track will hear about.
 *
 * ── Four structural decisions ─────────────────────────────────────────────
 *
 *  1. **The claim-to-evidence machinery is Sprint 08's, reused, not rebuilt.**
 *     `recommendationContracts` already ships an evidence graph with cycle
 *     detection, dangling-reference rejection, blank-id rejection and
 *     `resolveEvidenceRoots`, which guarantees an accepted claim terminates at
 *     an `ObservedEvidence`. Writing a second one is the Sprint 06 failure
 *     exactly: two implementations of one *mechanism*, each fixing defects the
 *     other still has.
 *
 *     So `lib/coaching/validator/` calls `checkEvidenceGraph` for structure and
 *     `resolveEvidenceRoots` for termination, and its own new work is the one
 *     question Sprint 08 could not ask: **does every claim in a coaching
 *     sentence trace to a support reason in the recommendation it was derived
 *     from?** Sprint 08 validates a recommendation against itself. This
 *     validates a *derived artefact* against the recommendation. Those are
 *     different questions and only the second one can catch a new fact being
 *     introduced downstream of an approved offer.
 *
 *     Likewise `isInstant` is imported rather than re-spelled — see
 *     `CoachingOutput.basisAt`.
 *
 *  2. **A claim's evidence is a subset of its source reason's evidence, by id.**
 *     Not "resolves to the same roots". The root-set rule is the tempting one
 *     and it is too weak: if support reason `A` rests on observation `O`, and
 *     an unrelated derived node `D` also rests on `O` while claiming something
 *     else entirely, then `roots(D) ⊆ roots(A)` and a claim citing `D` passes
 *     while asserting a fact the recommendation never used. A user reads that
 *     as the system knowing something it was never told to say.
 *
 *     The subset is therefore on the ids the reason actually cites, and
 *     `resolveEvidenceRoots` is used *in addition*, to reject a cited node
 *     whose own ancestry is broken. The cost is real and stated: a coaching
 *     claim cannot cite a more primitive node than its reason does. That is
 *     the conservative direction, and the conservative direction is the one
 *     "adds no new facts" points in.
 *
 *  3. **A decision echo is a separate claim variant with no evidence list.**
 *     "You marked that done" is a claim about the *user's own act*, not about
 *     trusted state the recommendation read, so there is no node in the
 *     evidence graph it could honestly cite. The dishonest options were both
 *     available: attach it to the accepted option's evidence (which would make
 *     a fabricated completion look sourced) or exempt it with a nullable
 *     field (which makes "no evidence" and "evidence we forgot to attach" the
 *     same value).
 *
 *     Instead `CoachingClaim` is a two-variant union: an evidence-backed claim
 *     carries a non-empty `supportedBy`, and a `DecisionEchoClaim` carries no
 *     `supportedBy` field at all and can only be one of three kinds. The
 *     exception is therefore visible in the type, bounded to the decision
 *     vocabulary, and checkable — `DECISION_CLAIM_WITHOUT_DECISION` and
 *     `DECISION_CLAIM_VERDICT_MISMATCH` exist because an echo of a decision
 *     that was never made is the one unsourced claim this shape could still
 *     admit.
 *
 *  4. **No tone vocabulary, deliberately.** `personalityService` already owns
 *     tone at product scope and is single-valued (`AssistantTone = 'calm_firm'`),
 *     and `ToneStage` owns the engine's five-stage version. A third spelling
 *     would be a second copy of a decision already made, and worse, an
 *     unenforceable one: a plan labelled `tone: 'calm'` is not calmer for the
 *     label. The non-shaming property is enforced instead as a *lexical
 *     validator rule* over the realized text (`FORBIDDEN_LANGUAGE`), which is
 *     a check rather than an assertion, and which the shipped
 *     `validation.ts` already does in the same direction — see
 *     `COACHING_FORBIDDEN_LANGUAGE`.
 *
 * ── The seam with the Safety gateway (#39) ────────────────────────────────
 *
 * "Unsupported claims block delivery" has two independent gates and this file
 * owns exactly one of them:
 *
 *   - **This module's gate** is claim-to-evidence support. It is computed here
 *     and reported as `CoachingDefect`s.
 *   - **The Safety gateway's gate** is #39's, over privacy, harmful pressure,
 *     injection, hallucinated time and persistence boundaries. #39 owns that
 *     verdict vocabulary and this file deliberately declares none of its own —
 *     two verdict vocabularies is the duplication this sprint is most likely
 *     to ship.
 *
 * `CoachingOutput` is therefore shaped so it converts to #39's `SafetyCandidate`
 * without loss — `toSafetyCandidate` in `lib/coaching/` is that conversion — and
 * delivery is decided by destructuring #39's `SafetyVerdict`. This file declares
 * no disposition vocabulary of its own; `CoachingDelivery` names *which gate*
 * refused and carries #39's verdict and `SafeUserPath` verbatim.
 */

import { MODULE_CONTRACT_VERSION } from './moduleContracts';
import {
  SUPPORT_REASON_CODES,
  checkEvidenceGraph,
  isInstant,
  type EvidenceGraph,
  type EvidenceNodeId,
  type Instant,
  type RecommendationDecisionVerdict,
  type SupportReasonCode,
} from './recommendationContracts';
import type { NextStepLocale } from './nextStepContracts';
import type {
  CandidateClaimKind,
  PressureIntensityLevel,
  SafeUserPath,
  SafetyCandidate,
  SafetySurface,
  SafetyVerdict,
} from './safetyContracts';

export const COACHING_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;
export const COACHING_SCHEMA_VERSION = 'coaching-v1' as const;

/**
 * Re-exported so a consumer of a coaching plan does not have to import two
 * contracts to read one field, and **type-only** so it cannot close a runtime
 * cycle. Re-exporting rather than redeclaring is the Sprint 06 rule applied to
 * types: two structurally identical `Instant` aliases assign to each other
 * silently, so the day one grows a constraint the other keeps accepting what
 * the first now rejects.
 */
export type { EvidenceGraph, EvidenceNodeId, Instant };

/* ── Locale ──────────────────────────────────────────────────────── */

/**
 * The locales coaching prose exists in.
 *
 * Frozen as data because the producibility sweeps have to iterate it at
 * runtime, and pinned mutually assignable to the pilot's `NextStepLocale`
 * below for the reason `REVIEW_LOCALES` is: a fourth spelling of the same three
 * languages is three copies of one list waiting for one of them to be edited.
 * The import is type-only, so it is erased and adds no runtime edge.
 */
export const COACHING_LOCALES = Object.freeze(['en', 'ar', 'he'] as const);
export type CoachingLocale = (typeof COACHING_LOCALES)[number];

type _MutuallyAssignable<A extends B, B extends C, C = A> = true;
const _coachingLocalesMatchPilot: _MutuallyAssignable<CoachingLocale, NextStepLocale> = true;
export const COACHING_LOCALE_PILOT_PARITY = _coachingLocalesMatchPilot;

/** The locales written right to left. Consumed by #37's evaluation set. */
export const RTL_COACHING_LOCALES = Object.freeze(['ar', 'he'] as const) satisfies readonly CoachingLocale[];

/* ── Intents ─────────────────────────────────────────────────────── */

/**
 * What a coaching turn is *for*.
 *
 * **Deliberately disjoint from the engine's `CommunicativeIntent`,** and the
 * disjointness is the design rather than an oversight. The engine's nine
 * intents answer a `SemanticEvent` — something that already happened in
 * capture. These six answer a `Recommendation` — a proposal about something
 * that has not happened. Sharing one enum would force each side to carry
 * members the other can never produce, which is the *unreachable outcome*
 * defect Sprint 08 shipped twice: a vocabulary member no input can reach, with
 * every surface downstream rendering it as though a user could see one.
 *
 * The relationship member by member, so a cross-track comparison has something
 * to compare against:
 *
 * - `present_choice`         — no engine counterpart. The engine never offers
 *                              two actions; `NEXT_STEP_PRODUCT_POLICY` caps the
 *                              product at one primary step.
 * - `present_sole_option`    — nearest engine relative is `nudge`, and
 *                              **deliberately stricter**: a nudge may be
 *                              emitted from pressure alone, while this requires
 *                              an offered option carrying support reasons.
 * - `explain_withholding`    — **same concept** as the engine's
 *                              `acknowledge_no_change`, at module scope. The
 *                              engine's carries a flat `noChangeReason` string;
 *                              this carries evidence-backed withholding
 *                              reasons, so "there is nothing to do" is a
 *                              sourced claim rather than a label.
 * - `acknowledge_acceptance` — **same concept** as `confirm_result`, and
 *                              **deliberately weaker about persistence**: the
 *                              engine's `confirm_result` requires
 *                              `facts.stateChange`, because the engine speaks
 *                              after a write. This module never writes
 *                              (`COACHING_PERSISTENCE_POLICY`), so it
 *                              acknowledges a *decision*, never a state change.
 * - `acknowledge_completion` — **same concept** as `close_loop`. The engine's
 *                              rule that a completion must not read as creation
 *                              or tracking is reproduced here as a *superset* —
 *                              see `COMPLETION_DESCRIBED_AS_TRACKING`.
 * - `acknowledge_dismissal`  — no engine counterpart; the engine has no verdict
 *                              a user can decline with.
 *
 * There is no `escalate_choice`, `probe_blocker` or `reset_plan` here. Those
 * are pressure moves the engine makes on its own initiative, and a module whose
 * every sentence must trace to an approved recommendation has no evidence for
 * them: "what is blocking you?" asserts that something is, and nothing in a
 * recommendation says so. Shipping the intent before the evidence that could
 * support it is how the intent becomes the evidence.
 */
export type CoachingIntent =
  | 'present_choice'
  | 'present_sole_option'
  | 'explain_withholding'
  | 'acknowledge_acceptance'
  | 'acknowledge_completion'
  | 'acknowledge_dismissal';

export const COACHING_INTENTS = Object.freeze([
  'present_choice',
  'present_sole_option',
  'explain_withholding',
  'acknowledge_acceptance',
  'acknowledge_completion',
  'acknowledge_dismissal',
] as const) satisfies readonly CoachingIntent[];

type _IntentsCovered =
  Exclude<CoachingIntent, (typeof COACHING_INTENTS)[number]> extends never ? true : never;
const _intentsAreExhaustive: _IntentsCovered = true;
export const COACHING_INTENT_COVERAGE = _intentsAreExhaustive;

/* ── Strategies ──────────────────────────────────────────────────── */

/**
 * *How* the intent is carried out — which claim leads the sentence.
 *
 * Five, and every one must be producible by some input. Sprint 08's recorded
 * lesson is that a declared vocabulary member no input can reach is invisible
 * to every assertion about the thing itself: the code path is reachable, the
 * outcome is not, and each surface downstream renders it as though a user could
 * be shown one. `tests/coaching/plannerPolicy.test.ts` enumerates this list and
 * demands each member be produced by a real planner run, and the same sweep
 * runs over `COACHING_INTENTS` and `COACHING_CLAIM_KINDS`.
 *
 * **Same concept at module scope as the engine's `ResponseStrategy`,** whose
 * ten members are pressure-rotation states (`easy_choice`, `smaller_step`,
 * `blocker_probe`, `reset_plan`, `close_loop`, …). The engine rotates strategy
 * across turns to avoid repeating itself, reading `commitmentState.lastStrategy`
 * from a conversation store. **Deliberately different here:** this module is
 * pure and stateless, so strategy is a function of the offer alone and two runs
 * of one input produce the same strategy. Anti-repetition is a conversation
 * concern and belongs to whoever owns the conversation, not to a module whose
 * whole claim is replayability.
 */
export type CoachingStrategy =
  | 'lead_with_action'
  | 'lead_with_reason'
  | 'name_the_alternatives'
  | 'state_the_gap'
  | 'confirm_and_stop';

export const COACHING_STRATEGIES = Object.freeze([
  'lead_with_action',
  'lead_with_reason',
  'name_the_alternatives',
  'state_the_gap',
  'confirm_and_stop',
] as const) satisfies readonly CoachingStrategy[];

type _StrategiesCovered =
  Exclude<CoachingStrategy, (typeof COACHING_STRATEGIES)[number]> extends never ? true : never;
const _strategiesAreExhaustive: _StrategiesCovered = true;
export const COACHING_STRATEGY_COVERAGE = _strategiesAreExhaustive;

/**
 * Which strategies each intent may use.
 *
 * Data rather than a `switch` inside the planner, for the reason
 * `RECOMMENDATION_ORDERING_KEYS` is data: the planner produces the pair and the
 * validator checks it, and a rule living inside the planner is a rule only the
 * planner can be wrong about. `INTENT_STRATEGY_MISMATCH` is decided against
 * this table at both ends.
 *
 * Every intent maps to a non-empty list and every strategy appears at least
 * once — pinned by a test, because a table is exactly where an unreachable
 * vocabulary member hides.
 */
export const COACHING_INTENT_STRATEGIES = Object.freeze({
  present_choice: Object.freeze(['name_the_alternatives'] as const),
  present_sole_option: Object.freeze(['lead_with_action', 'lead_with_reason'] as const),
  explain_withholding: Object.freeze(['state_the_gap'] as const),
  acknowledge_acceptance: Object.freeze(['confirm_and_stop'] as const),
  acknowledge_completion: Object.freeze(['confirm_and_stop'] as const),
  acknowledge_dismissal: Object.freeze(['confirm_and_stop'] as const),
}) satisfies Readonly<Record<CoachingIntent, readonly CoachingStrategy[]>>;

/* ── Claims ──────────────────────────────────────────────────────── */

/**
 * What kind of thing a coaching sentence asserts.
 *
 * Closed, and small on purpose. A free label here would make
 * `kind: 'motivational'` a valid claim, and the validator could still report it
 * fully sourced — the claim would cite real evidence while asserting something
 * that evidence does not say. A closed list means every kind is one this file
 * had to grow before a planner could emit it, and every kind is checked against
 * the reason code it was derived from (`CLAIM_KIND_NOT_DERIVABLE`).
 *
 * The first eight are evidence-backed. The last three are decision echoes and
 * carry no evidence at all — see `DecisionEchoClaim` and decision 3.
 */
export type CoachingClaimKind =
  | 'proposed_action'
  | 'timing'
  | 'importance'
  | 'delay_history'
  | 'dependency'
  | 'effort'
  | 'sole_option'
  | 'nothing_to_offer'
  | 'user_accepted'
  | 'user_completed'
  | 'user_dismissed';

export const COACHING_CLAIM_KINDS = Object.freeze([
  'proposed_action',
  'timing',
  'importance',
  'delay_history',
  'dependency',
  'effort',
  'sole_option',
  'nothing_to_offer',
  'user_accepted',
  'user_completed',
  'user_dismissed',
] as const) satisfies readonly CoachingClaimKind[];

type _ClaimKindsCovered =
  Exclude<CoachingClaimKind, (typeof COACHING_CLAIM_KINDS)[number]> extends never ? true : never;
const _claimKindsAreExhaustive: _ClaimKindsCovered = true;
export const COACHING_CLAIM_KIND_COVERAGE = _claimKindsAreExhaustive;

/** The kinds that may appear on a `DecisionEchoClaim`, and only there. */
export const DECISION_ECHO_CLAIM_KINDS = Object.freeze([
  'user_accepted',
  'user_completed',
  'user_dismissed',
] as const) satisfies readonly CoachingClaimKind[];

/** The kinds that may appear on an `EvidenceBackedCoachingClaim`, and only there. */
export const EVIDENCE_BACKED_CLAIM_KINDS = Object.freeze([
  'proposed_action',
  'timing',
  'importance',
  'delay_history',
  'dependency',
  'effort',
  'sole_option',
  'nothing_to_offer',
] as const) satisfies readonly CoachingClaimKind[];

/**
 * Which claim kind each of Sprint 08's support reason codes licenses.
 *
 * Total over `SupportReasonCode`, so adding a support reason to
 * `recommendationContracts` without deciding what a coach may say about it is a
 * **compile error** rather than a claim that silently fails to be derivable.
 * That is the device `LIFE_STATE_SOURCE_FIELDS` and #35's copy tables use, and
 * it is the cheap half of keeping a vocabulary honest.
 *
 * The mapping is many-to-one on purpose. Three reasons collapse to `timing`
 * because a user does not need to know whether the clock pressure came from a
 * due date, a soon-ness window or a plan slot — and a coach that distinguished
 * them would be spending its two sentences on provenance rather than on the
 * next move. The provenance is not lost: the claim still names the reason it
 * came from, so `#37`'s faithfulness evaluation can recover it.
 */
export const CLAIM_KIND_FOR_SUPPORT_REASON = Object.freeze({
  OVERDUE: 'timing',
  DUE_SOON: 'timing',
  PLAN_SLOT_IMMINENT: 'timing',
  HIGH_IMPORTANCE: 'importance',
  REPEATEDLY_DELAYED: 'delay_history',
  UNBLOCKS_DEPENDENTS: 'dependency',
  QUICK_WIN: 'effort',
  ONLY_ELIGIBLE_ACTION: 'sole_option',
}) satisfies Readonly<Record<SupportReasonCode, CoachingClaimKind>>;

/** Which claim kind each decision verdict licenses. Total over the verdicts. */
export const CLAIM_KIND_FOR_DECISION_VERDICT = Object.freeze({
  accept: 'user_accepted',
  edit: 'user_accepted',
  done: 'user_completed',
  dismiss: 'user_dismissed',
  defer: 'user_dismissed',
}) satisfies Readonly<Record<RecommendationDecisionVerdict, CoachingClaimKind>>;

/**
 * Where a claim came from in the approved recommendation.
 *
 * Positions, never identifiers. A source names an option by `optionIndex` and a
 * reason by `reasonIndex` for exactly the reason `EvidenceBackedReason.detail`
 * names options by index: ids are caller-chosen free strings that people fill
 * with content, and this module emits **user-facing prose**, which is the one
 * place in the repo where an id that leaks is read by a person. The recorded
 * leak was a detail string reading `working window call-dr.cohen-about-the-biopsy`
 * that passed a test checking only that titles were absent.
 *
 * `only_candidate_attestation` names no position because there is only one
 * `attested` list on an `only_candidate` offer.
 */
export type EvidenceClaimSource =
  | { readonly kind: 'support_reason'; readonly optionIndex: number; readonly reasonIndex: number }
  | { readonly kind: 'option_confidence'; readonly optionIndex: number }
  | { readonly kind: 'withholding_reason'; readonly reasonIndex: number }
  | { readonly kind: 'only_candidate_attestation' };

export const EVIDENCE_CLAIM_SOURCE_KINDS = Object.freeze([
  'support_reason',
  'option_confidence',
  'withholding_reason',
  'only_candidate_attestation',
] as const) satisfies readonly EvidenceClaimSource['kind'][];

type _SourceKindsCovered =
  Exclude<EvidenceClaimSource['kind'], (typeof EVIDENCE_CLAIM_SOURCE_KINDS)[number]> extends never ? true : never;
const _sourceKindsAreExhaustive: _SourceKindsCovered = true;
export const EVIDENCE_CLAIM_SOURCE_KIND_COVERAGE = _sourceKindsAreExhaustive;

/**
 * A claim that rests on the recommendation's evidence graph.
 *
 * `supportedBy` is a non-empty tuple for the same reason
 * `EvidenceBackedReason.supportedBy` is, and — per Sprint 08's recorded
 * generalisation that **every non-empty tuple is a hole at the untyped
 * boundary** — it also has a runtime code, `UNSOURCED_COACHING_CLAIM`. The
 * tuple keeps honest producers honest; the checker is what the guarantee rests
 * on.
 *
 * `claimIndex` duplicates the array position on purpose and
 * `CLAIM_INDEX_MISMATCH` checks the two agree, on the same terms as
 * `RecommendationOption.optionIndex`: a sentence refers to its claims by index
 * precisely so no identifier has to appear anywhere near rendered text, and an
 * index that has drifted from its position silently retargets every one of
 * those references — which here means a sentence would be validated against a
 * claim it does not make.
 */
export interface EvidenceBackedCoachingClaim {
  readonly claimIndex: number;
  readonly kind: CoachingClaimKind;
  readonly source: EvidenceClaimSource;
  readonly supportedBy: readonly [EvidenceNodeId, ...EvidenceNodeId[]];
}

/**
 * A claim that echoes the user's own decision back to them.
 *
 * No `supportedBy` field at all — see decision 3. The user's act is not a fact
 * about trusted state, so there is no node it could cite, and a nullable field
 * would make "rests on nothing" and "we forgot to attach the evidence" the same
 * value.
 *
 * The exception is bounded three ways and each bound has a code:
 * `kind` must be one of `DECISION_ECHO_CLAIM_KINDS` (`UNKNOWN_CLAIM_KIND`);
 * the plan must actually carry a decision (`DECISION_CLAIM_WITHOUT_DECISION`);
 * and the echoed `verdict` must be the one the user gave
 * (`DECISION_CLAIM_VERDICT_MISMATCH`). An echo of a decision nobody made is the
 * one unsourced claim this shape could otherwise still admit, and it is the
 * worst one available: a fabricated completion.
 */
export interface DecisionEchoClaim {
  readonly claimIndex: number;
  readonly kind: 'user_accepted' | 'user_completed' | 'user_dismissed';
  readonly source: {
    readonly kind: 'user_decision';
    /** Null only when the whole offer was dismissed, matching `RecommendationDecision`. */
    readonly optionIndex: number | null;
    readonly verdict: RecommendationDecisionVerdict;
  };
}

export type CoachingClaim = EvidenceBackedCoachingClaim | DecisionEchoClaim;

/** Whether a claim rests on the evidence graph rather than on a user decision. */
export function isEvidenceBackedClaim(claim: CoachingClaim): claim is EvidenceBackedCoachingClaim {
  if (claim === null || claim === undefined) return false;
  const source = (claim as { source?: { kind?: unknown } }).source;
  if (source === null || source === undefined) return false;
  return source.kind !== 'user_decision';
}

/* ── The plan ────────────────────────────────────────────────────── */

/**
 * What the coach intends to say, before any words exist.
 *
 * The plan is the unit the validator judges and the realizer consumes, and it
 * is deliberately *complete without prose*: an intent, a strategy, and the
 * ordered claims that will be made. That separation is what makes "rules-only
 * realization remains available" a structural property rather than a
 * configuration flag — a model adapter and the template adapter consume the
 * same plan, so the set of facts asserted cannot depend on which one ran.
 *
 * **Same concept at module scope as the engine's `ResponsePlan`,** with one
 * difference that matters. `ResponsePlan.facts` is a bag of pre-rendered
 * strings (`titleCapitalized`, `timeWithPreposition`, `continuityText`) built
 * by `phraseNormalization` from the event — presentation, already interpolated
 * with user text. `CoachingPlan.claims` are *provenance*: a kind plus the
 * position in the recommendation it came from plus the evidence it rests on,
 * with **no user text anywhere**. A claim is derivable from a reason; a reason
 * is not recoverable from a rendered phrase. That direction is why this module
 * can check faithfulness and the engine cannot.
 *
 * `maxSentences` is 1 or 2, **the same rule** the engine's `IntentSelection`
 * uses, and it is the same number for the same reason: two sentences is what a
 * person reads before deciding, and the product's verbosity is
 * `AssistantVerbosity = 'low'`. Stated as data here so
 * `SENTENCE_LIMIT_EXCEEDED` is checkable by a consumer that never sees the
 * planner.
 */
export interface CoachingPlan {
  readonly version: typeof COACHING_CONTRACT_VERSION;
  readonly schema: typeof COACHING_SCHEMA_VERSION;
  /**
   * The recommendation this plan was derived from. Carried so a validator can
   * refuse a plan paired with a different offer — the coaching analogue of
   * `DECISION_RECOMMENDATION_MISMATCH`, and the worst outcome available: real
   * prose about an action the user never saw.
   */
  readonly recommendationId: string;
  readonly locale: CoachingLocale;
  readonly intent: CoachingIntent;
  readonly strategy: CoachingStrategy;
  readonly claims: readonly [CoachingClaim, ...CoachingClaim[]];
  /** 1 or 2. See `COACHING_SENTENCE_POLICY`. */
  readonly maxSentences: number;
  /**
   * The verdict this plan acknowledges, or null when it presents an offer.
   *
   * Present on the plan rather than looked up from a decision the validator
   * happens to be handed, so `DECISION_CLAIM_WITHOUT_DECISION` is decidable
   * from the plan alone. A plan that carries decision echoes and no verdict is
   * malformed on its face.
   */
  readonly acknowledges: RecommendationDecisionVerdict | null;
}

/* ── The output ──────────────────────────────────────────────────── */

/**
 * How the prose was produced.
 *
 * `template` is the rules-only path and is the only one v1 uses. `model` is a
 * declared seam with **no implementation in v1**, and that is stated in the
 * type rather than left to a comment: `COACHING_REALIZATION_POLICY.enabledModes`
 * lists `template` alone, and `MODEL_REALIZATION_NOT_ENABLED` is the code a
 * validator reports for an output claiming the model path. The acceptance
 * criterion "rules-only realization remains available" is therefore not a
 * fallback that might be missing — it is the only path that exists, and the
 * model path has to be *added* to the policy before it can be taken.
 */
export type CoachingRealizationMode = 'template' | 'model';

export const COACHING_REALIZATION_MODES = Object.freeze(['template', 'model'] as const) satisfies
  readonly CoachingRealizationMode[];

/**
 * One realized sentence, and the claims it makes.
 *
 * `claimIndices` is non-empty because a sentence that makes no claim is prose
 * with no provenance — the exact thing this module exists to make
 * unrepresentable. `SENTENCE_WITHOUT_CLAIM` is its runtime code.
 *
 * `templateId` names the closed template the text came from. It is a code, not
 * a free string, so a reviewer can look up what was said without reading the
 * output, and so `#37`'s evaluation set can group sentences by template across
 * three locales without parsing prose.
 */
export interface CoachingSentence {
  readonly sentenceIndex: number;
  /**
   * The user-facing text.
   *
   * **Selected, never assembled.** Nothing in `lib/coaching/realizer/`
   * interpolates an input string into this field: the templates are a closed
   * table keyed by claim kind, locale and template id, exactly as
   * `lib/recommendation/review/copy.ts` is, so there is no path by which a
   * commitment title, a `commitmentId`, a `scopeId`, a `proposalId` or an
   * evidence `nodeId` reaches rendered text. `IDENTIFIER_IN_PROSE` checks it
   * anyway, because a table with one interpolation added is one edit away.
   */
  readonly text: string;
  readonly templateId: string;
  readonly claimIndices: readonly [number, ...number[]];
}

/**
 * A candidate coaching output: prose, the claims it makes, and the evidence
 * those claims rest on.
 *
 * Shaped as **exactly what #39's Safety gateway takes** — "a candidate output
 * carrying claims and evidence references" — and self-contained on purpose. The
 * gateway is generic and never imports this module, so it must be able to judge
 * an output without also being handed the recommendation: hence `claims` and
 * `evidence` travel with the prose rather than being looked up.
 *
 * `evidence` is the recommendation's graph, carried verbatim. Carrying a
 * *filtered* subgraph was the tempting alternative and it is the Sprint 08
 * watch-list defect in a new costume: a subset chosen at build time cannot be
 * checked, and "we chose not to carry that node" is indistinguishable from a
 * correct narrow carry.
 */
export interface CoachingOutput {
  readonly version: typeof COACHING_CONTRACT_VERSION;
  readonly schema: typeof COACHING_SCHEMA_VERSION;
  readonly recommendationId: string;
  readonly locale: CoachingLocale;
  readonly intent: CoachingIntent;
  readonly strategy: CoachingStrategy;
  readonly realization: CoachingRealizationMode;
  readonly sentences: readonly [CoachingSentence, ...CoachingSentence[]];
  /** The plan's claims, carried so the output can be judged standalone. */
  readonly claims: readonly [CoachingClaim, ...CoachingClaim[]];
  readonly evidence: EvidenceGraph;
  /**
   * The `now` this turn was computed against, taken from the caller.
   *
   * Never a clock reading — `COACHING_PERSISTENCE_POLICY.noAmbientClock`. It
   * exists so a consumer can re-run `evaluateRecommendationStaleness` against
   * the same basis the coach used, rather than against a later moment at which
   * a different answer would look like a coaching defect. Validated with
   * `isInstant` from `recommendationContracts` — imported, never re-spelled,
   * because a second definition of "what is a valid instant" is a second
   * definition of the offset rule.
   */
  readonly basisAt: Instant;
}

/* ── Delivery, and the seam with #39 ─────────────────────────────── */

/**
 * The Safety gateway, as this module calls it.
 *
 * A function from #39's `SafetyCandidate` to #39's `SafetyVerdict`, and
 * **neither type is redeclared here**. #39 owns the cross-module Safety policy
 * gateway and owns its verdict vocabulary; two verdict vocabularies is the
 * duplication this sprint was most likely to ship, and the one hardest to undo
 * because both would have callers by the time it was noticed.
 *
 * Null is the value for "no gateway was wired", and it is **not** permission —
 * see `COACHING_INPUT_POLICY.absentGatewayBlocksDelivery`. A delivery path that
 * read a missing gateway as approval would get more permissive exactly as the
 * caller lost more of its safety plumbing, which is Sprint 08's
 * `unverifiableSourceIsStale` applied to a different absence.
 */
export type CoachingGatewayGate = ((candidate: SafetyCandidate) => SafetyVerdict) | null;

/**
 * Which gate refused, when one did.
 *
 * Names the *gate*, never its reasoning: `safety_gateway` means "#39 said no",
 * and what it said travels as #39's own `SafetyFinding`s inside the verdict
 * this module carries verbatim. `claim_support` is this module's own gate, and
 * its detail is in `defects`.
 */
export type CoachingBlockOrigin = 'claim_support' | 'safety_gateway';

export const COACHING_BLOCK_ORIGINS = Object.freeze(['claim_support', 'safety_gateway'] as const) satisfies
  readonly CoachingBlockOrigin[];

/**
 * The outcome of a delivery attempt.
 *
 * Two variants and no `delivered: boolean` field, following `SafetyVerdict` and
 * `OptionSet`: a consumer must destructure, and the withholding variant carries
 * a **non-empty** `blockedBy` and a `SafeUserPath`, so a refusal cannot be
 * rendered without the way out in hand. That is #39's rule, adopted rather than
 * restated, and the reason `recovery` is `SafeUserPath` rather than a coaching
 * type: a second spelling of "what the user can do next" is a second thing to
 * keep in step with the 21 reason codes that map onto it.
 *
 * **`allow_with_redaction` withholds, in v1.** #39's gateway may drop segments
 * by index; a coaching turn is one or two sentences and its claims are checked
 * against the plan as a whole, so dropping a sentence leaves the remaining
 * prose resting on claims nothing realizes — `PLANNED_CLAIM_NOT_REALIZED` for
 * an output already out the door. The conservative direction is the one "adds
 * no new facts" points in, and a fragment of a coaching sentence is not a
 * shorter coaching sentence. Stated here rather than discovered downstream; a
 * later version that composes a redacted turn is a change with its own note.
 */
export type CoachingDelivery =
  | {
      readonly disposition: 'delivered';
      readonly output: CoachingOutput;
      /** #39's verdict, carried verbatim. Always `allow` in this variant. */
      readonly verdict: SafetyVerdict;
    }
  | {
      readonly disposition: 'withheld';
      readonly blockedBy: readonly [CoachingBlockOrigin, ...CoachingBlockOrigin[]];
      /** This module's own findings. Empty when only the gateway refused. */
      readonly defects: readonly CoachingDefect[];
      /** #39's verdict when a gateway ran, null when none was wired. */
      readonly verdict: SafetyVerdict | null;
      readonly recovery: SafeUserPath;
    };

/**
 * The safe path this module offers when **its own** gate refuses.
 *
 * `show_evidence_only` because that is what `SAFETY_CODE_RECOVERY` maps
 * `UNSOURCED_CLAIM`, `CLAIM_NOT_TRACEABLE` and `EVIDENCE_GRAPH_MALFORMED` to —
 * the three of #39's codes that mean what a claim-support failure means. Read
 * off that table rather than chosen independently: a coaching block and a
 * gateway block for the same underlying problem must not offer the user two
 * different ways forward.
 *
 * `retryAdmissible` is true because a corrected plan can succeed, and
 * `retryAfter` is null because the fix is a better candidate rather than time —
 * which is the distinction `SafeUserPath` draws and this module does not get to
 * redraw.
 */
export const COACHING_CLAIM_SUPPORT_RECOVERY: SafeUserPath = Object.freeze({
  kind: 'show_evidence_only',
  retryAdmissible: true,
  retryAfter: null,
});

/**
 * The surface every coaching candidate declares.
 *
 * A constant rather than a parameter, because a producer that could choose its
 * own surface could choose the one whose sensitivity ceiling and pressure
 * budget suit it — which is the decision #39's `SafetySurface` comment says the
 * producer must not get to make about itself.
 */
export const COACHING_SAFETY_SURFACE: SafetySurface = 'coaching_message';

/**
 * How each coaching intent maps onto #39's `CandidateClaim` kinds.
 *
 * Total over `CoachingClaimKind`, so a claim kind added here without deciding
 * what the gateway should see is a compile error.
 *
 * **Every coaching claim is a `statement`, and that is a property rather than a
 * default.** `time` is the kind whose `statedInstant` the hallucinated-time
 * boundary reads, and this module's realizer never renders an instant: its
 * templates are *selected* from a closed table and never assembled from input
 * (`COACHING_REALIZATION_POLICY.templatesAreSelectedNotAssembled`), so there is
 * no path by which a time reaches prose. `FABRICATED_INSTANT` therefore cannot
 * fire on this producer, and `tests/coaching/claimValidator.test.ts` pins the
 * reason it cannot — every converted claim carries `statedInstant: null` — so
 * the day a template grows an interpolated time, the pin fails rather than the
 * gateway silently starting to matter.
 *
 * `quantity` and `commitment_state` are the tempting mappings for `effort` and
 * `nothing_to_offer`, and both are wrong for the same reason: they promise the
 * gateway a number or a lifecycle state it could check, and a coaching sentence
 * carries neither — `'That one is quick.'` states no quantity. Claiming a
 * checkable kind and giving nothing to check is how a boundary reports a pass
 * it never performed.
 */
export const CANDIDATE_CLAIM_KIND_FOR_COACHING_CLAIM = Object.freeze({
  proposed_action: 'statement',
  timing: 'statement',
  importance: 'statement',
  delay_history: 'statement',
  dependency: 'statement',
  effort: 'statement',
  sole_option: 'statement',
  nothing_to_offer: 'statement',
  user_accepted: 'statement',
  user_completed: 'statement',
  user_dismissed: 'statement',
}) satisfies Readonly<Record<CoachingClaimKind, CandidateClaimKind>>;

/**
 * The pressure intensity each intent declares to the gateway.
 *
 * #39 checks the declared level against the request's `PressureBudget`, so this
 * is a claim the producer makes about itself and one it can be caught
 * overstating — `PRESSURE_INTENSITY_EXCEEDED`. Declaring `none` everywhere
 * would be the comfortable choice and the dishonest one: presenting a next step
 * *is* a nudge, and a module that told the budget it applied no pressure would
 * be invisible to the budget that exists to cap it.
 *
 * Nothing here reaches `high`. `high` is the engine's escalation territory
 * (`escalate_choice`, `force_choice`), and this module has no intent that could
 * honestly claim it — which is why `high` is a named exclusion here rather than
 * an unreachable value nothing notices.
 */
export const PRESSURE_INTENSITY_FOR_INTENT = Object.freeze({
  present_choice: 'low',
  present_sole_option: 'medium',
  explain_withholding: 'none',
  acknowledge_acceptance: 'none',
  acknowledge_completion: 'none',
  acknowledge_dismissal: 'none',
}) satisfies Readonly<Record<CoachingIntent, PressureIntensityLevel>>;

/** Levels no coaching intent declares. See above; a named exclusion, not a gap. */
export const COACHING_EXCLUDED_PRESSURE_LEVELS = Object.freeze(['high'] as const) satisfies
  readonly PressureIntensityLevel[];

/* ── Defects ─────────────────────────────────────────────────────── */

/**
 * What can be wrong with a coaching plan or output.
 *
 * Reported, never thrown — `COACHING_INPUT_POLICY.reportWhatTheTaxonomyNames`,
 * which is `PLANNING_INPUT_POLICY`'s rule carried forward. Sprint 07 shipped
 * three throws where the contract said report and Sprint 08 shipped five more;
 * both times the throw was invisible to a typed caller and immediate at the
 * untyped boundary the module existed to guard.
 *
 * Structural — decidable from the plan or output alone:
 *
 * - `UNKNOWN_COACHING_INTENT`     — an intent outside `COACHING_INTENTS`.
 * - `UNKNOWN_COACHING_STRATEGY`   — a strategy outside `COACHING_STRATEGIES`.
 * - `INTENT_STRATEGY_MISMATCH`    — a pair `COACHING_INTENT_STRATEGIES` forbids.
 *                                   A `present_choice` realized as
 *                                   `confirm_and_stop` would tell a user a
 *                                   decision had been made for them.
 * - `UNKNOWN_CLAIM_KIND`          — a kind outside `COACHING_CLAIM_KINDS`, or a
 *                                   decision-echo kind on an evidence-backed
 *                                   claim, or the reverse. One code, because it
 *                                   is one defect wearing two field names.
 * - `UNKNOWN_CLAIM_SOURCE_KIND`   — a source kind this version does not know.
 * - `CLAIM_INDEX_MISMATCH`        — `claimIndex` is not the array position.
 * - `EMPTY_CLAIM_LIST`            — a plan or output with no claims. Prose with
 *                                   no provenance.
 * - `UNSOURCED_COACHING_CLAIM`    — an evidence-backed claim with an empty
 *                                   `supportedBy`. The non-empty tuple is a
 *                                   compile-time claim and `JSON.parse` does
 *                                   not honour it.
 * - `SENTENCE_WITHOUT_CLAIM`      — a sentence citing no claim.
 * - `UNKNOWN_CLAIM_REFERENCE`     — a sentence citing a `claimIndex` the plan
 *                                   does not have. Distinct from
 *                                   `SENTENCE_WITHOUT_CLAIM` for the reason
 *                                   `UNSOURCED_CLAIM` and
 *                                   `UNKNOWN_EVIDENCE_NODE` are distinct:
 *                                   citing nothing and citing something absent
 *                                   are different mistakes by different
 *                                   producers.
 * - `PLANNED_CLAIM_NOT_REALIZED`  — a plan claim no sentence carries. The plan
 *                                   is the contract of what will be said, so a
 *                                   dropped claim means the planner and the
 *                                   realizer disagree about the turn — and the
 *                                   silent direction is the dangerous one: the
 *                                   validator would go on approving a claim
 *                                   nobody reads while the sentence that *is*
 *                                   read rests on the remainder.
 * - `SENTENCE_LIMIT_EXCEEDED`     — more sentences than `maxSentences`, or a
 *                                   `maxSentences` outside
 *                                   `COACHING_SENTENCE_POLICY`.
 * - `EMPTY_SENTENCE_TEXT`         — blank or non-string prose. A blank sentence
 *                                   passes every claim check by making no
 *                                   claim, and renders as a coach that said
 *                                   nothing while reporting success.
 * - `UNKNOWN_LOCALE`              — a locale outside `COACHING_LOCALES`.
 * - `PLAN_OUTPUT_MISMATCH`        — an output whose intent, strategy, locale,
 *                                   claims or `recommendationId` disagree with
 *                                   the plan it claims to realize.
 * - `MODEL_REALIZATION_NOT_ENABLED` — an output claiming a realization mode
 *                                   `COACHING_REALIZATION_POLICY` does not
 *                                   enable. The seam exists; taking it is a
 *                                   decision someone records.
 *
 * Faithfulness — decidable only against the approved recommendation:
 *
 * - `RECOMMENDATION_MISMATCH`      — the plan names a different recommendation.
 * - `RECOMMENDATION_EVIDENCE_MALFORMED` — `checkEvidenceGraph` reported findings
 *                                   on the carried graph. Reported as one
 *                                   coaching defect per finding rather than
 *                                   re-derived, because the graph checker is
 *                                   Sprint 08's and this module has no second
 *                                   opinion about it.
 * - `UNKNOWN_SOURCE_REASON`        — the source names an option, a reason or an
 *                                   attestation the recommendation does not
 *                                   have.
 * - `CLAIM_KIND_NOT_DERIVABLE`     — the claim's kind is not what
 *                                   `CLAIM_KIND_FOR_SUPPORT_REASON` (or
 *                                   `CLAIM_KIND_FOR_DECISION_VERDICT`) licenses
 *                                   for the reason it cites. A claim citing an
 *                                   `OVERDUE` reason while asserting
 *                                   `importance` is fully sourced and still
 *                                   says something the recommendation did not.
 * - `CLAIM_EVIDENCE_NOT_IN_REASON` — the load-bearing one. An evidence id the
 *                                   claim cites that its source reason does
 *                                   not. This is "adds no new facts", and it is
 *                                   the only defect in this list that Sprint
 *                                   08's checkers structurally cannot find:
 *                                   they validate a recommendation against
 *                                   itself, and every id here is a perfectly
 *                                   valid node of a perfectly valid graph.
 * - `UNRESOLVABLE_EVIDENCE`        — a cited node that `resolveEvidenceRoots`
 *                                   cannot terminate at an observation. Kept
 *                                   distinct from the graph-malformed code
 *                                   because a graph can be structurally sound
 *                                   while one particular node is unreachable
 *                                   from any observation.
 * - `DECISION_CLAIM_WITHOUT_DECISION` — a decision echo on a plan that
 *                                   acknowledges nothing.
 * - `DECISION_CLAIM_VERDICT_MISMATCH` — an echo of a verdict other than the one
 *                                   the plan acknowledges. A fabricated
 *                                   completion is the worst output this module
 *                                   could produce, and it is one field away
 *                                   from a correct one.
 * - `SOURCE_RECOMMENDATION_STALE`  — the recommendation is not offerable at
 *                                   `basisAt`. Coaching about an expired offer
 *                                   is prose about a world that has moved, and
 *                                   the judgement is Sprint 08's
 *                                   `evaluateRecommendationStaleness`, called,
 *                                   never re-derived.
 *
 * Language — decidable from the prose:
 *
 * - `COMPLETION_DESCRIBED_AS_TRACKING` — the acceptance criterion, as a code.
 *                                   See `COACHING_FORBIDDEN_LANGUAGE`.
 * - `FORBIDDEN_LANGUAGE`           — shame language or internal scaffolding in
 *                                   user-facing prose.
 * - `IDENTIFIER_IN_PROSE`          — a caller-chosen identifier reached the
 *                                   rendered text.
 */
export type CoachingStructureDefectCode =
  | 'UNKNOWN_COACHING_INTENT'
  | 'UNKNOWN_COACHING_STRATEGY'
  | 'INTENT_STRATEGY_MISMATCH'
  | 'UNKNOWN_CLAIM_KIND'
  | 'UNKNOWN_CLAIM_SOURCE_KIND'
  | 'CLAIM_INDEX_MISMATCH'
  | 'EMPTY_CLAIM_LIST'
  | 'UNSOURCED_COACHING_CLAIM'
  | 'SENTENCE_WITHOUT_CLAIM'
  | 'UNKNOWN_CLAIM_REFERENCE'
  | 'PLANNED_CLAIM_NOT_REALIZED'
  | 'SENTENCE_LIMIT_EXCEEDED'
  | 'EMPTY_SENTENCE_TEXT'
  | 'UNKNOWN_LOCALE'
  | 'PLAN_OUTPUT_MISMATCH'
  | 'MODEL_REALIZATION_NOT_ENABLED';

export type CoachingFaithfulnessDefectCode =
  | 'RECOMMENDATION_MISMATCH'
  | 'RECOMMENDATION_EVIDENCE_MALFORMED'
  | 'UNKNOWN_SOURCE_REASON'
  | 'CLAIM_KIND_NOT_DERIVABLE'
  | 'CLAIM_EVIDENCE_NOT_IN_REASON'
  | 'UNRESOLVABLE_EVIDENCE'
  | 'DECISION_CLAIM_WITHOUT_DECISION'
  | 'DECISION_CLAIM_VERDICT_MISMATCH'
  | 'SOURCE_RECOMMENDATION_STALE';

export type CoachingLanguageDefectCode =
  | 'COMPLETION_DESCRIBED_AS_TRACKING'
  | 'FORBIDDEN_LANGUAGE'
  | 'IDENTIFIER_IN_PROSE';

export type CoachingDefectCode =
  | CoachingStructureDefectCode
  | CoachingFaithfulnessDefectCode
  | CoachingLanguageDefectCode;

export const COACHING_STRUCTURE_DEFECT_CODES = Object.freeze([
  'UNKNOWN_COACHING_INTENT',
  'UNKNOWN_COACHING_STRATEGY',
  'INTENT_STRATEGY_MISMATCH',
  'UNKNOWN_CLAIM_KIND',
  'UNKNOWN_CLAIM_SOURCE_KIND',
  'CLAIM_INDEX_MISMATCH',
  'EMPTY_CLAIM_LIST',
  'UNSOURCED_COACHING_CLAIM',
  'SENTENCE_WITHOUT_CLAIM',
  'UNKNOWN_CLAIM_REFERENCE',
  'PLANNED_CLAIM_NOT_REALIZED',
  'SENTENCE_LIMIT_EXCEEDED',
  'EMPTY_SENTENCE_TEXT',
  'UNKNOWN_LOCALE',
  'PLAN_OUTPUT_MISMATCH',
  'MODEL_REALIZATION_NOT_ENABLED',
] as const) satisfies readonly CoachingStructureDefectCode[];

export const COACHING_FAITHFULNESS_DEFECT_CODES = Object.freeze([
  'RECOMMENDATION_MISMATCH',
  'RECOMMENDATION_EVIDENCE_MALFORMED',
  'UNKNOWN_SOURCE_REASON',
  'CLAIM_KIND_NOT_DERIVABLE',
  'CLAIM_EVIDENCE_NOT_IN_REASON',
  'UNRESOLVABLE_EVIDENCE',
  'DECISION_CLAIM_WITHOUT_DECISION',
  'DECISION_CLAIM_VERDICT_MISMATCH',
  'SOURCE_RECOMMENDATION_STALE',
] as const) satisfies readonly CoachingFaithfulnessDefectCode[];

export const COACHING_LANGUAGE_DEFECT_CODES = Object.freeze([
  'COMPLETION_DESCRIBED_AS_TRACKING',
  'FORBIDDEN_LANGUAGE',
  'IDENTIFIER_IN_PROSE',
] as const) satisfies readonly CoachingLanguageDefectCode[];

/**
 * The three partitions as one value, so a coverage sweep can iterate them.
 *
 * Disjoint, unlike `REASON_CODE_PARTITIONS` — and the disjointness is pinned by
 * a test rather than assumed, because the partition's whole job is to say which
 * *pass* owns a code, and a code in two passes is a code two producers can
 * emit for two different reasons.
 */
export const COACHING_DEFECT_PARTITIONS = Object.freeze({
  structure: COACHING_STRUCTURE_DEFECT_CODES,
  faithfulness: COACHING_FAITHFULNESS_DEFECT_CODES,
  language: COACHING_LANGUAGE_DEFECT_CODES,
});

export const COACHING_DEFECT_CODES = Object.freeze([
  ...COACHING_STRUCTURE_DEFECT_CODES,
  ...COACHING_FAITHFULNESS_DEFECT_CODES,
  ...COACHING_LANGUAGE_DEFECT_CODES,
] as const) satisfies readonly CoachingDefectCode[];

type _DefectCodesCovered =
  Exclude<CoachingDefectCode, (typeof COACHING_DEFECT_CODES)[number]> extends never ? true : never;
const _defectCodesAreExhaustive: _DefectCodesCovered = true;
export const COACHING_DEFECT_CODE_COVERAGE = _defectCodesAreExhaustive;

/**
 * One finding.
 *
 * `claimIndex` and `sentenceIndex` are the typed fields a caller may render or
 * drop; `detail` carries **no identifier**, on the same terms as
 * `EvidenceBackedReason.detail` and for a sharper reason: this module's whole
 * output is read by a person, so a defect detail is one copy-paste away from a
 * user-facing string. A detail names claims and sentences by index, evidence by
 * position in the graph's node list, and otherwise carries only numbers.
 */
export interface CoachingDefect {
  readonly code: CoachingDefectCode;
  /** The claim the finding is about, or null. */
  readonly claimIndex: number | null;
  /** The sentence the finding is about, or null. */
  readonly sentenceIndex: number | null;
  readonly detail: string;
}

/* ── Language policy ─────────────────────────────────────────────── */

/**
 * The lexicons user-facing coaching prose is checked against.
 *
 * Exported as **lowercase word lists, not `RegExp`s**, for the reason
 * `isInstant` is a predicate rather than an exported pattern: a `RegExp` is
 * mutable shared state, and one edit adding a `g` flag makes `lastIndex`
 * persist across unrelated callers so `test` returns alternating answers for
 * the same input. The matcher is built from these, word-anchored, in
 * `lib/coaching/validator/`.
 *
 * ── How this relates to the shipped `validation.ts` ──────────────
 *
 * `lib/services/responseEngine/validation.ts` already enforces forbidden
 * language over the assistant turn, with `LEGACY_AND_INTERNAL_PATTERNS`,
 * `SHAME_PATTERNS` and a `CREATION_OR_TRACKING_CLAIM` regex. This is a
 * **deliberate superset in one direction and identical in the other**:
 *
 *   - `shame` is the engine's `SHAME_PATTERNS` **verbatim** — `avoidant`,
 *     `inconsistent`, `lazy`, `fault`, `failed`, `shame`, `guilt`,
 *     `disappointed`. Same rule, same words, on purpose: a user reading two
 *     surfaces of one product must not find one of them willing to say
 *     "you failed". If the engine's list grows, the merge-owned cross-track
 *     test compares the two and this one must grow with it.
 *   - `scaffold` is the engine's `LEGACY_AND_INTERNAL_PATTERNS` plus
 *     `personalityService`'s `SYSTEM_LIKE_PATTERNS` — the union, because the
 *     engine checks one and `isAssistantCopyAllowed` checks the other and this
 *     module has one surface where both apply.
 *   - `trackingVerbs` is a **strict superset** of the engine's
 *     `CREATION_OR_TRACKING_CLAIM`, and the difference is the acceptance
 *     criterion. The engine fires that regex only when
 *     `facts.stateChange === 'completed'`, because outside a completion those
 *     verbs are honest — the engine *does* create reminders and says so. This
 *     module never writes anything (`COACHING_PERSISTENCE_POLICY`), so
 *     **every** one of these verbs is a false claim of persistence here,
 *     whatever the intent, and `COMPLETION_DESCRIBED_AS_TRACKING` fires on any
 *     of them.
 *
 *     The extra members over the engine's list are `logging`, `noting`,
 *     `monitoring`, `watching`, `keeping track` and `following up on` — the
 *     surveillance vocabulary specifically. "Completion is not described as
 *     tracking" is not only about the word `tracking`: "I'll keep an eye on
 *     that" said about something the user just finished is the same false
 *     claim in friendlier words, and it is the one a template author reaches
 *     for.
 */
export const COACHING_FORBIDDEN_LANGUAGE = Object.freeze({
  /** Identical to the engine's `SHAME_PATTERNS`. Never a superset by accident. */
  shame: Object.freeze([
    'avoidant',
    'inconsistent',
    'lazy',
    'fault',
    'failed',
    'shame',
    'guilt',
    'disappointed',
  ] as const),
  /** Union of the engine's internal-scaffold list and `SYSTEM_LIKE_PATTERNS`. */
  scaffold: Object.freeze([
    'tracking',
    'drafted',
    'executed',
    "you're set",
    'disposition',
    'command',
    'engine used',
    'raw output',
    'debug meta',
  ] as const),
  /** Strict superset of the engine's `CREATION_OR_TRACKING_CLAIM`. */
  trackingVerbs: Object.freeze([
    'saved',
    'saving',
    'created',
    'creating',
    'scheduled',
    'scheduling',
    'reminder',
    'remind',
    'tracking',
    'tracked',
    'logging',
    'logged',
    'noting',
    'monitoring',
    'watching',
    'keeping track',
    'following up on',
  ] as const),
});

/* ── Policies ────────────────────────────────────────────────────── */

/**
 * How long a coaching turn may be.
 *
 * `maxSentences: 2` is **the same number** the engine's `IntentSelection` uses
 * and for the same reason: `AssistantVerbosity` is `'low'` and two sentences is
 * what a person reads before deciding. Stated as data so a consumer that never
 * sees the planner can check `SENTENCE_LIMIT_EXCEEDED`, and so the two numbers
 * can be compared by the cross-track test rather than agreeing by coincidence.
 *
 * `maxClaimsPerSentence` is this module's own and exists because a limit that
 * lives only as a number is the Sprint 08 defect verbatim:
 * `maxEvidenceRefsPerReason` sat exported and enforced by nothing, and a valid
 * recommendation repeating one node id 400,000 times took 8.2 seconds of CPU on
 * an unauthenticated route and returned 200. Every bound here is enforced by
 * `checkCoachingPlan` or `checkCoachingOutput`; a bound added without an
 * enforcement site is a bound that does not exist.
 */
export const COACHING_SENTENCE_POLICY = Object.freeze({
  minSentences: 1,
  maxSentences: 2,
  maxClaimsPerPlan: 4,
  maxClaimsPerSentence: 3,
  maxEvidenceRefsPerClaim: 8,
});

/**
 * Which realization modes are enabled.
 *
 * `enabledModes` holds `template` alone. That is the acceptance criterion
 * "rules-only realization remains available" expressed as the *only* path
 * rather than as a fallback — a fallback is a thing that can be missing, and a
 * fallback nobody exercises is a fallback nobody knows is broken.
 *
 * The model seam is declared (`CoachingRealizationMode` has a `model` member,
 * and `lib/coaching/realizer/modelAdapter.ts` defines the interface an adapter
 * would satisfy) and **is not wired**. `MODEL_REALIZATION_NOT_ENABLED` is
 * reported for an output claiming it. Sprint 08's lesson about unreachable
 * outcomes says a declared-but-unreachable member must be a *named* exclusion
 * rather than an omission nothing notices, which is what this field is: the
 * producibility sweep in `tests/coaching/realizer.test.ts` enumerates
 * `COACHING_REALIZATION_MODES` and asserts every member is either producible or
 * listed here as excluded.
 */
export const COACHING_REALIZATION_POLICY = Object.freeze({
  enabledModes: Object.freeze(['template'] as const),
  excludedModes: Object.freeze(['model'] as const),
  defaultMode: 'template' as const,
  /** A template is selected by a code and never assembled from input text. */
  templatesAreSelectedNotAssembled: true,
});

/**
 * What a coaching entry point may do with input it cannot use.
 *
 * The first three clauses are `PLANNING_INPUT_POLICY`'s and
 * `RECOMMENDATION_INPUT_POLICY`'s, carried here rather than imported so a
 * reader of this contract does not have to know two others to know the rule.
 * The last three are this module's own, and each decides which way an
 * *absence* resolves — the direction that is comfortable is the wrong one
 * every time:
 *
 * - `unsupportedClaimBlocksDelivery` — the acceptance criterion. A claim whose
 *   evidence is not in its source reason blocks the whole output, not just the
 *   sentence carrying it. Dropping the sentence was the tempting repair and it
 *   is the `Math.max` buffer clamp in a new place: a turn silently missing its
 *   load-bearing claim reads as a complete, calm, correct coaching sentence.
 * - `absentGatewayBlocksDelivery` — a `null` `CoachingGatewayGate` is refusal,
 *   not permission. A delivery path that treats "no safety gateway was wired"
 *   as "safety approved" gets more permissive exactly as the caller loses more
 *   of its safety plumbing, which is `unverifiableSourceIsStale` applied to a
 *   different absence.
 * - `noNewFacts` — the whole contract, as a flag a test can read.
 */
export const COACHING_INPUT_POLICY = Object.freeze({
  reportWhatTheTaxonomyNames: true,
  throwOnlyWhenNoCodeApplies: true,
  digestAfterStaticPass: true,
  unsupportedClaimBlocksDelivery: true,
  absentGatewayBlocksDelivery: true,
  noNewFacts: true,
});

/**
 * The persistence boundary, on the same terms every intelligence module here
 * has one.
 *
 * `NEXT_STEP_PRODUCT_POLICY` states the product-surface form of several of
 * these. The clause worth naming is `coachingCanPersist: false` together with
 * `describesNoStateChange: true`: the shipped engine's `confirm_result` speaks
 * *after* a write and is required to name the `stateChange` it made. This
 * module speaks *before* anything is written, so it must never name one — which
 * is why every `trackingVerbs` member is forbidden here and only conditionally
 * forbidden there. Same product value, opposite default, because the two speak
 * at opposite ends of the same act.
 */
export const COACHING_PERSISTENCE_POLICY = Object.freeze({
  /** A coaching turn is prose about a proposal. It is never canonical state. */
  coachingCanPersist: false,
  /** Coaching never claims a write happened; it has not. */
  describesNoStateChange: true,
  adapterOwnsCanonicalWrites: true,
  rawInputInAudit: false,
  /** Every instant comes from an explicit input; no `Date.now()`, ever. */
  noAmbientClock: true,
  /** Every claim traces to a reason in the recommendation it came from. */
  everyClaimTracesToAnApprovedReason: true,
  /** Prose is selected from a closed table; no identifier can reach it. */
  noIdentifierInProse: true,
});

/* ── Structural checking ─────────────────────────────────────────── */

/**
 * Blank, or not a string at all. Total on purpose, exactly as
 * `recommendationContracts.isBlank` is: the typed signature says `string` and
 * the runtime receives whatever the boundary produced, and a checker whose
 * whole contract is to *return* a list must not raise on the way.
 */
function isBlankText(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

function asList<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [];
}

function isKnownIntent(value: unknown): value is CoachingIntent {
  return (COACHING_INTENTS as readonly string[]).includes(value as string);
}

function isKnownStrategy(value: unknown): value is CoachingStrategy {
  return (COACHING_STRATEGIES as readonly string[]).includes(value as string);
}

function isKnownLocale(value: unknown): value is CoachingLocale {
  return (COACHING_LOCALES as readonly string[]).includes(value as string);
}

/**
 * Structural check over a plan alone.
 *
 * Returns findings; it does not throw, for **any** input. Ordering is by input
 * position — plan-level findings first, then claim by claim in `claims` order,
 * and for each claim in a fixed code order. That makes the output deterministic
 * without this file needing a string comparator at all, which matters because
 * the repo's comparator lives in `lib/planning/shared/compare.ts` and a
 * contract must not import `lib/`; the only alternatives would be a second copy
 * of that arithmetic or `localeCompare`, whose result moves with the host's ICU
 * data and `LANG`.
 *
 * **The suppression rule**, matching `planningContracts` and
 * `recommendationContracts`: a finding is suppressed only when it borrows a
 * bound from something already reported malformed. An unrecognised intent
 * suppresses `INTENT_STRATEGY_MISMATCH`, because the pair check would borrow a
 * row from a table that has none. A claim of unknown kind is still index- and
 * evidence-checked, because those borrow nothing from the kind.
 */
export function checkCoachingPlan(plan: CoachingPlan): readonly CoachingDefect[] {
  const defects: CoachingDefect[] = [];
  const safe = plan === null || plan === undefined ? ({} as CoachingPlan) : plan;

  if (!isKnownLocale(safe.locale)) {
    defects.push({ code: 'UNKNOWN_LOCALE', claimIndex: null, sentenceIndex: null, detail: 'locale is not one of the three coaching locales' });
  }

  const intentKnown = isKnownIntent(safe.intent);
  const strategyKnown = isKnownStrategy(safe.strategy);
  if (!intentKnown) {
    defects.push({ code: 'UNKNOWN_COACHING_INTENT', claimIndex: null, sentenceIndex: null, detail: 'intent is not a member of this contract version' });
  }
  if (!strategyKnown) {
    defects.push({ code: 'UNKNOWN_COACHING_STRATEGY', claimIndex: null, sentenceIndex: null, detail: 'strategy is not a member of this contract version' });
  }
  if (intentKnown && strategyKnown) {
    const allowed = COACHING_INTENT_STRATEGIES[safe.intent as CoachingIntent] as readonly string[];
    if (!allowed.includes(safe.strategy as string)) {
      defects.push({
        code: 'INTENT_STRATEGY_MISMATCH',
        claimIndex: null,
        sentenceIndex: null,
        detail: `strategy is not one of the ${allowed.length} this intent permits`,
      });
    }
  }

  const max = safe.maxSentences;
  if (
    typeof max !== 'number' ||
    !Number.isInteger(max) ||
    max < COACHING_SENTENCE_POLICY.minSentences ||
    max > COACHING_SENTENCE_POLICY.maxSentences
  ) {
    defects.push({
      code: 'SENTENCE_LIMIT_EXCEEDED',
      claimIndex: null,
      sentenceIndex: null,
      detail: `maxSentences must be an integer in ${COACHING_SENTENCE_POLICY.minSentences}..${COACHING_SENTENCE_POLICY.maxSentences}`,
    });
  }

  const claims = asList<CoachingClaim>(safe.claims);
  if (claims.length === 0) {
    defects.push({ code: 'EMPTY_CLAIM_LIST', claimIndex: null, sentenceIndex: null, detail: 'a plan that claims nothing is prose with no provenance' });
  }
  if (claims.length > COACHING_SENTENCE_POLICY.maxClaimsPerPlan) {
    defects.push({
      code: 'SENTENCE_LIMIT_EXCEEDED',
      claimIndex: null,
      sentenceIndex: null,
      detail: `plan carries ${claims.length} claims; the cap is ${COACHING_SENTENCE_POLICY.maxClaimsPerPlan}`,
    });
  }

  for (let index = 0; index < claims.length; index += 1) {
    defects.push(...claimDefects(claims[index], index, safe));
  }

  return defects;
}

/**
 * Findings for one claim, in a fixed code order.
 *
 * Split out because `checkCoachingPlan` and `checkCoachingOutput` both need it
 * and a second copy would be a second opinion about what a well-formed claim
 * is — the Sprint 06 gap at the exact place this module is least able to afford
 * it.
 */
function claimDefects(claim: CoachingClaim, index: number, plan: CoachingPlan): readonly CoachingDefect[] {
  const defects: CoachingDefect[] = [];
  if (claim === null || claim === undefined || typeof claim !== 'object') {
    defects.push({ code: 'UNKNOWN_CLAIM_SOURCE_KIND', claimIndex: index, sentenceIndex: null, detail: 'claim is not an object' });
    return defects;
  }

  if (claim.claimIndex !== index) {
    defects.push({ code: 'CLAIM_INDEX_MISMATCH', claimIndex: index, sentenceIndex: null, detail: 'claimIndex does not equal its position in the claim list' });
  }

  const source = (claim as { source?: { kind?: unknown } }).source;
  const sourceKind = source === null || source === undefined ? undefined : source.kind;
  const isEcho = sourceKind === 'user_decision';
  const knownSource = isEcho || (EVIDENCE_CLAIM_SOURCE_KINDS as readonly string[]).includes(sourceKind as string);
  if (!knownSource) {
    defects.push({ code: 'UNKNOWN_CLAIM_SOURCE_KIND', claimIndex: index, sentenceIndex: null, detail: 'claim source kind is not a member of this contract version' });
  }

  const kindKnown = (COACHING_CLAIM_KINDS as readonly string[]).includes(claim.kind as string);
  if (!kindKnown) {
    defects.push({ code: 'UNKNOWN_CLAIM_KIND', claimIndex: index, sentenceIndex: null, detail: 'claim kind is not a member of this contract version' });
  } else if (knownSource) {
    // The kind must sit on the side of the union its source puts it on. Checked
    // here rather than trusted from the type, because the type is absent at the
    // boundary and this is the seam the decision-echo exception opens: an
    // evidence-backed kind on an echo would be a claim about the world with no
    // evidence list to check, and it would look like an ordinary claim.
    const echoKind = (DECISION_ECHO_CLAIM_KINDS as readonly string[]).includes(claim.kind as string);
    if (isEcho !== echoKind) {
      defects.push({
        code: 'UNKNOWN_CLAIM_KIND',
        claimIndex: index,
        sentenceIndex: null,
        detail: isEcho
          ? 'a decision echo may only carry a decision-echo claim kind'
          : 'a decision-echo claim kind may only appear on a decision echo',
      });
    }
  }

  if (isEcho) {
    if (plan.acknowledges === null || plan.acknowledges === undefined) {
      defects.push({
        code: 'DECISION_CLAIM_WITHOUT_DECISION',
        claimIndex: index,
        sentenceIndex: null,
        detail: 'the plan echoes a decision it does not acknowledge',
      });
    } else if ((source as { verdict?: unknown }).verdict !== plan.acknowledges) {
      defects.push({
        code: 'DECISION_CLAIM_VERDICT_MISMATCH',
        claimIndex: index,
        sentenceIndex: null,
        detail: 'the echoed verdict is not the verdict this plan acknowledges',
      });
    }
    return defects;
  }

  const supportedBy = asList<EvidenceNodeId>((claim as { supportedBy?: unknown }).supportedBy);
  if (supportedBy.length === 0) {
    defects.push({ code: 'UNSOURCED_COACHING_CLAIM', claimIndex: index, sentenceIndex: null, detail: 'an evidence-backed claim cites no evidence' });
  }
  if (supportedBy.length > COACHING_SENTENCE_POLICY.maxEvidenceRefsPerClaim) {
    defects.push({
      code: 'UNSOURCED_COACHING_CLAIM',
      claimIndex: index,
      sentenceIndex: null,
      detail: `claim cites ${supportedBy.length} evidence nodes; the cap is ${COACHING_SENTENCE_POLICY.maxEvidenceRefsPerClaim}`,
    });
  }
  return defects;
}

/**
 * Structural check over an output, against the plan it claims to realize.
 *
 * Takes the plan rather than re-deriving one, because `PLAN_OUTPUT_MISMATCH` is
 * only answerable against the plan and because a checker that rebuilt the plan
 * would be a second planner — the duplication this sprint is written to avoid,
 * at the one place it would be invisible (both would be right about the same
 * inputs until one of them changed).
 *
 * `basisAt` is validated with `isInstant`, imported. There is no second
 * definition of what an instant is anywhere under `lib/coaching/**`.
 */
export function checkCoachingOutput(output: CoachingOutput, plan: CoachingPlan): readonly CoachingDefect[] {
  const defects: CoachingDefect[] = [];
  const safe = output === null || output === undefined ? ({} as CoachingOutput) : output;
  const safePlan = plan === null || plan === undefined ? ({} as CoachingPlan) : plan;

  if (
    safe.recommendationId !== safePlan.recommendationId ||
    safe.intent !== safePlan.intent ||
    safe.strategy !== safePlan.strategy ||
    safe.locale !== safePlan.locale
  ) {
    defects.push({ code: 'PLAN_OUTPUT_MISMATCH', claimIndex: null, sentenceIndex: null, detail: 'output does not agree with its plan on recommendation, intent, strategy or locale' });
  }

  if (!(COACHING_REALIZATION_POLICY.enabledModes as readonly string[]).includes(safe.realization as string)) {
    defects.push({
      code: 'MODEL_REALIZATION_NOT_ENABLED',
      claimIndex: null,
      sentenceIndex: null,
      detail: 'realization mode is not enabled by COACHING_REALIZATION_POLICY',
    });
  }

  if (!isInstant(safe.basisAt)) {
    // Reported as a plan/output disagreement rather than given a code of its
    // own: `evaluateRecommendationStaleness` already owns `INVALID_INSTANT` and
    // a second code for the same judgement is a second judgement waiting to
    // disagree with the first.
    defects.push({ code: 'PLAN_OUTPUT_MISMATCH', claimIndex: null, sentenceIndex: null, detail: 'basisAt is not an instant carrying an explicit offset' });
  }

  const planClaims = asList<CoachingClaim>(safePlan.claims);
  const outputClaims = asList<CoachingClaim>(safe.claims);
  if (outputClaims.length === 0) {
    defects.push({ code: 'EMPTY_CLAIM_LIST', claimIndex: null, sentenceIndex: null, detail: 'the output carries no claims' });
  }
  if (outputClaims.length !== planClaims.length) {
    defects.push({ code: 'PLAN_OUTPUT_MISMATCH', claimIndex: null, sentenceIndex: null, detail: 'the output carries a different number of claims than its plan' });
  }
  for (let index = 0; index < outputClaims.length; index += 1) {
    defects.push(...claimDefects(outputClaims[index], index, safePlan));
  }

  const sentences = asList<CoachingSentence>(safe.sentences);
  const limit =
    typeof safePlan.maxSentences === 'number' && Number.isInteger(safePlan.maxSentences)
      ? safePlan.maxSentences
      : COACHING_SENTENCE_POLICY.maxSentences;
  if (sentences.length === 0 || sentences.length > limit) {
    defects.push({
      code: 'SENTENCE_LIMIT_EXCEEDED',
      claimIndex: null,
      sentenceIndex: null,
      detail: `the output carries ${sentences.length} sentences; the plan permits 1..${limit}`,
    });
  }

  const realized = new Set<number>();
  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index];
    if (sentence === null || sentence === undefined || typeof sentence !== 'object') {
      defects.push({ code: 'EMPTY_SENTENCE_TEXT', claimIndex: null, sentenceIndex: index, detail: 'sentence is not an object' });
      continue;
    }
    if (isBlankText(sentence.text)) {
      defects.push({ code: 'EMPTY_SENTENCE_TEXT', claimIndex: null, sentenceIndex: index, detail: 'sentence text is blank or not a string' });
    }
    if (isBlankText(sentence.templateId)) {
      defects.push({ code: 'EMPTY_SENTENCE_TEXT', claimIndex: null, sentenceIndex: index, detail: 'sentence names no template' });
    }
    const references = asList<number>(sentence.claimIndices);
    if (references.length === 0) {
      defects.push({ code: 'SENTENCE_WITHOUT_CLAIM', claimIndex: null, sentenceIndex: index, detail: 'sentence cites no claim' });
    }
    if (references.length > COACHING_SENTENCE_POLICY.maxClaimsPerSentence) {
      defects.push({
        code: 'SENTENCE_LIMIT_EXCEEDED',
        claimIndex: null,
        sentenceIndex: index,
        detail: `sentence cites ${references.length} claims; the cap is ${COACHING_SENTENCE_POLICY.maxClaimsPerSentence}`,
      });
    }
    for (const reference of references) {
      if (!Number.isInteger(reference) || reference < 0 || reference >= outputClaims.length) {
        defects.push({ code: 'UNKNOWN_CLAIM_REFERENCE', claimIndex: null, sentenceIndex: index, detail: 'sentence cites a claim position the output does not have' });
        continue;
      }
      realized.add(reference);
    }
  }

  for (let index = 0; index < outputClaims.length; index += 1) {
    if (!realized.has(index)) {
      defects.push({ code: 'PLANNED_CLAIM_NOT_REALIZED', claimIndex: index, sentenceIndex: null, detail: 'no sentence carries this claim' });
    }
  }

  return defects;
}

/**
 * Whether an evidence graph is structurally usable by this module.
 *
 * A thin delegation to `checkEvidenceGraph`, and thin on purpose: this module
 * has **no second opinion** about what a well-formed evidence graph is. The
 * value it adds is the translation into this taxonomy — one
 * `RECOMMENDATION_EVIDENCE_MALFORMED` per Sprint 08 finding, so a coaching
 * consumer reads one defect list rather than two — and the count in the detail,
 * which is the only number a caller needs to decide whether to look at the
 * recommendation instead.
 *
 * Sprint 06's lesson is the reason this is not a re-check: two implementations
 * of one *judgement* are a check on each other only when something compares
 * them, and nothing would compare these. Two implementations of one
 * *mechanism* are a gap waiting for whichever caller falls into it.
 */
export function checkCarriedEvidence(graph: EvidenceGraph): readonly CoachingDefect[] {
  const findings = checkEvidenceGraph(graph);
  const defects: CoachingDefect[] = [];
  for (let index = 0; index < findings.length; index += 1) {
    defects.push({
      code: 'RECOMMENDATION_EVIDENCE_MALFORMED',
      claimIndex: null,
      sentenceIndex: null,
      // The Sprint 08 code travels in the detail because it is a closed
      // vocabulary member, not a caller-chosen identifier. `nodeId` does not:
      // it is a free string, and this module's details are one copy-paste from
      // rendered prose.
      detail: `carried evidence graph is malformed: ${findings[index].code} at node position ${index}`,
    });
  }
  return defects;
}

/**
 * The support reason codes this module can turn into a claim.
 *
 * Derived from `CLAIM_KIND_FOR_SUPPORT_REASON` rather than listed again, so
 * "every support reason a recommendation can carry is one a coach can speak
 * to" is true by construction. `tests/coaching/plannerPolicy.test.ts` walks
 * `SUPPORT_REASON_CODES` against this and fails on a gap, which is the sweep
 * Sprint 08 added after `NO_PLANNED_SLOT` and `OUTSIDE_WORKING_WINDOW` sat
 * structurally unemittable with nothing failing.
 */
export const COACHABLE_SUPPORT_REASON_CODES = Object.freeze(
  SUPPORT_REASON_CODES.filter((code) => code in CLAIM_KIND_FOR_SUPPORT_REASON),
) as readonly SupportReasonCode[];
