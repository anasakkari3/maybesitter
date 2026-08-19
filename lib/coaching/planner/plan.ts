/**
 * The coaching planner (Sprint 09, issue #38).
 *
 * Turns an approved recommendation — and optionally the decision the user made
 * about it — into a `CoachingPlan`: an intent, a strategy, and the ordered
 * claims the turn will make. **No prose.** The plan is complete without words,
 * which is what makes "rules-only realization remains available" a structural
 * property: a template adapter and a model adapter consume the same plan, so
 * the set of facts asserted cannot depend on which one ran.
 *
 * ## How this relates to the shipped `responsePlanning.ts`
 *
 * `lib/services/responseEngine/responsePlanning.ts` builds a `ResponsePlan`
 * from a `SemanticEvent`. Nothing here imports it. The difference that matters
 * is what the two put in the plan:
 *
 * - `ResponsePlan.facts` is a bag of **pre-rendered strings** —
 *   `titleCapitalized`, `timeWithPreposition`, `continuityText` — built by
 *   `phraseNormalization` and `formatDisplayTime` from the event, already
 *   interpolated with user text and already in English.
 * - `CoachingPlan.claims` are **provenance**: a kind, the position in the
 *   recommendation the claim came from, and the evidence node ids it rests on.
 *   There is no user text anywhere in a plan.
 *
 * That direction is the whole reason this module can check faithfulness and the
 * engine cannot: a claim is derivable from a reason, and a reason is not
 * recoverable from a rendered phrase. It is the same argument
 * `recommendationContracts` makes about `EvidenceCategory` versus the pilot's
 * `evidenceLabels`, one layer further out.
 *
 * ## Report, don't throw
 *
 * Every condition the taxonomy names comes back as a `CoachingDefect`. Sprint
 * 07 shipped three throws where the contract said report and Sprint 08 shipped
 * five more; each was invisible to a typed caller and immediate at the untyped
 * boundary the module existed to guard. There is no `throw` in this file.
 *
 * ## Fail-closed staleness, and its cost
 *
 * `currentFingerprints` defaults to an **empty map**, not to "assume
 * unchanged". Sprint 08's `RECOMMENDATION_INPUT_POLICY.unverifiableSourceIsStale`
 * decides which way that absence resolves, and the comfortable direction is the
 * wrong one: a freshness check that treats a missing fingerprint as unchanged
 * gets more confident exactly as the caller loses track of more sources.
 *
 * The cost is real and is stated rather than hidden: **a caller that supplies
 * no fingerprints gets a refusal, always.** Coaching about an offer whose
 * sources cannot be re-verified is prose about a world that may have moved, and
 * this module has no way to tell. `lib/recommendation`'s `currentFingerprints`
 * is what a caller builds the map with.
 */

import {
  COACHING_CONTRACT_VERSION,
  COACHING_LOCALES,
  COACHING_SCHEMA_VERSION,
  COACHING_SENTENCE_POLICY,
  type CoachingClaim,
  type CoachingDefect,
  type CoachingLocale,
  type CoachingPlan,
} from '../../../src/contracts/v1/coachingContracts';
import {
  EVIDENCE_GRAPH_DEFECT_CODES,
  checkRecommendation,
  checkRecommendationDecision,
  evaluateRecommendationStaleness,
  isInstant,
  summarizeOptionSet,
  type EvidenceNodeId,
  type Instant,
  type Recommendation,
  type RecommendationDecision,
  type RecommendationOption,
} from '../../../src/contracts/v1/recommendationContracts';
import { intentFor, maxSentencesFor, shapeOf, strategyFor, claimKindForReason, claimKindForVerdict } from './policy';

/** What the planner is handed. `now` is explicit; nothing here reads a clock. */
export interface CoachingPlannerInput {
  readonly recommendation: Recommendation;
  /** The user's decision about this offer, or null/absent when none was made. */
  readonly decision?: RecommendationDecision | null;
  readonly locale: CoachingLocale;
  /** The instant this turn is computed against. Never a clock reading. */
  readonly now: Instant;
  /**
   * Observed `nodeId` to the fingerprint the source carries now, or null if it
   * is gone. A **missing key fails closed** — see the header.
   */
  readonly currentFingerprints?: Readonly<Record<EvidenceNodeId, string | null>>;
}

export type CoachingPlanningOutcome =
  | { readonly outcome: 'planned'; readonly plan: CoachingPlan }
  | { readonly outcome: 'refused'; readonly defects: readonly [CoachingDefect, ...CoachingDefect[]] };

function defect(
  code: CoachingDefect['code'],
  detail: string,
  claimIndex: number | null = null,
): CoachingDefect {
  return { code, claimIndex, sentenceIndex: null, detail };
}

function isGraphCode(code: string): boolean {
  return (EVIDENCE_GRAPH_DEFECT_CODES as readonly string[]).includes(code);
}

/**
 * The evidence a claim about the lead option's *action* rests on.
 *
 * `confidence.basis`, not the union of the option's support reasons. The
 * distinction is the point of decision 2 in the contract: "doing this next is
 * the move" is precisely the claim `Confidence` exists to quantify, and its
 * `basis` is the evidence the module said that number rests on. Widening to
 * every reason's evidence would let the action claim cite a fact the confidence
 * never used, which is a new fact wearing an old one's clothes.
 */
function actionEvidence(option: RecommendationOption): readonly EvidenceNodeId[] {
  const basis = option === null || option === undefined ? null : option.confidence;
  const list = basis === null || basis === undefined ? [] : basis.basis;
  return Array.isArray(list) ? (list as readonly EvidenceNodeId[]) : [];
}

/**
 * Build the plan, or say why not.
 *
 * The ordering of the passes is `COACHING_INPUT_POLICY.digestAfterStaticPass`
 * applied to a planner: decide what is wrong with the input **before** doing
 * anything that assumes it is well-formed. Sprint 07 shipped the other order
 * and its digest threw on exactly the malformed inputs the static pass existed
 * to report.
 *
 * The passes do not suppress each other except where one borrows a bound from
 * the other. A malformed recommendation stops everything, because every later
 * pass reads positions out of it. A stale recommendation also stops everything,
 * because coaching about an expired offer is the defect rather than a caveat on
 * one. A malformed *decision* stops everything for the same reason a malformed
 * offer does — its `optionIndex` is the position every decision-echo claim
 * would be built from.
 */
export function planCoaching(input: CoachingPlannerInput): CoachingPlanningOutcome {
  const defects: CoachingDefect[] = [];
  const safe = input === null || input === undefined || typeof input !== 'object' ? ({} as CoachingPlannerInput) : input;

  if (!(COACHING_LOCALES as readonly string[]).includes(safe.locale as string)) {
    defects.push(defect('UNKNOWN_LOCALE', 'locale is not one of the three coaching locales'));
  }
  if (!isInstant(safe.now)) {
    // `isInstant` is imported, never re-spelled. A second definition of "what is
    // a valid instant" is a second definition of the explicit-offset rule, and
    // that rule is why a verdict does not move with the host's `TZ`.
    defects.push(defect('PLAN_OUTPUT_MISMATCH', 'now is not an instant carrying an explicit offset'));
  }

  const recommendation = safe.recommendation;
  const structural = checkRecommendation(recommendation);
  for (const finding of structural) {
    // The Sprint 08 code travels in the detail: it is a closed vocabulary
    // member, not a caller-chosen identifier. `nodeId` does not travel, because
    // it is a free string and this module's details sit one copy-paste from
    // rendered prose.
    defects.push(
      isGraphCode(finding.code)
        ? defect('RECOMMENDATION_EVIDENCE_MALFORMED', `source recommendation is malformed: ${finding.code}`)
        : defect('UNKNOWN_SOURCE_REASON', `source recommendation is malformed: ${finding.code}`),
    );
  }

  const decision = safe.decision === undefined ? null : safe.decision;
  if (decision !== null && structural.length === 0) {
    for (const finding of checkRecommendationDecision(recommendation, decision)) {
      // A decision this module cannot trust is a source it cannot name: every
      // decision-echo claim is built from `optionIndex`, so a defective
      // decision means the position the claim would cite is not a position the
      // offer has.
      defects.push(defect('UNKNOWN_SOURCE_REASON', `decision is malformed: ${finding.code}`));
    }
  }

  if (structural.length === 0 && isInstant(safe.now)) {
    const verdict = evaluateRecommendationStaleness({
      recommendation,
      now: safe.now,
      currentFingerprints: safe.currentFingerprints ?? {},
    });
    if (!verdict.fresh) {
      for (const reason of verdict.reasons) {
        defects.push(defect('SOURCE_RECOMMENDATION_STALE', `source recommendation is not offerable: ${reason.code}`));
      }
    }
  }

  if (defects.length > 0) {
    return { outcome: 'refused', defects: defects as [CoachingDefect, ...CoachingDefect[]] };
  }

  const shape = shapeOf(recommendation, decision);
  const intent = intentFor(shape);
  if (intent === null) {
    return {
      outcome: 'refused',
      defects: [defect('UNKNOWN_COACHING_INTENT', 'no intent covers this recommendation and decision shape')],
    };
  }
  const strategy = strategyFor(intent, shape);
  if (strategy === null) {
    return {
      outcome: 'refused',
      defects: [defect('UNKNOWN_COACHING_STRATEGY', 'no strategy covers this intent')],
    };
  }

  const claims = claimsFor(recommendation, decision, intent, strategy);
  if (claims.length === 0) {
    return { outcome: 'refused', defects: [defect('EMPTY_CLAIM_LIST', 'no claim could be derived from this offer')] };
  }
  if (claims.length > COACHING_SENTENCE_POLICY.maxClaimsPerPlan) {
    return {
      outcome: 'refused',
      defects: [
        defect(
          'SENTENCE_LIMIT_EXCEEDED',
          `plan would carry ${claims.length} claims; the cap is ${COACHING_SENTENCE_POLICY.maxClaimsPerPlan}`,
        ),
      ],
    };
  }

  return {
    outcome: 'planned',
    plan: {
      version: COACHING_CONTRACT_VERSION,
      schema: COACHING_SCHEMA_VERSION,
      recommendationId: recommendation.recommendationId,
      locale: safe.locale,
      intent,
      strategy,
      claims: claims as [CoachingClaim, ...CoachingClaim[]],
      maxSentences: maxSentencesFor(intent),
      acknowledges: shape.verdict,
    },
  };
}

/**
 * The claims, in the order they will be said.
 *
 * Claim `i` is realized by sentence `i` — `COACHING_SENTENCE_POLICY.maxClaimsPerSentence`
 * is 1 in v1 — so `PLANNED_CLAIM_NOT_REALIZED` is satisfied by construction
 * rather than by the realizer remembering to. The realizer still asserts it,
 * because "satisfied by construction" is a claim about today's realizer.
 *
 * Every returned claim's `supportedBy` is copied **from the source it names**,
 * never assembled from elsewhere in the graph. That is what makes the
 * validator's subset check pass for an honest planner and fail for a dishonest
 * one — and the validator is a separate module precisely so that this function
 * being wrong is a thing something else can see.
 */
function claimsFor(
  recommendation: Recommendation,
  decision: RecommendationDecision | null,
  intent: string,
  strategy: string,
): readonly CoachingClaim[] {
  if (decision !== null && decision !== undefined) {
    const kind = claimKindForVerdict(decision.verdict);
    if (kind === null) return [];
    return [
      {
        claimIndex: 0,
        kind: kind as 'user_accepted' | 'user_completed' | 'user_dismissed',
        source: {
          kind: 'user_decision',
          optionIndex: decision.optionIndex ?? null,
          verdict: decision.verdict,
        },
      },
    ];
  }

  if (recommendation.outcome === 'withheld') {
    const reasons = Array.isArray(recommendation.reasons) ? recommendation.reasons : [];
    const first = reasons[0];
    if (first === undefined || !Array.isArray(first.supportedBy) || first.supportedBy.length === 0) return [];
    return [
      {
        claimIndex: 0,
        kind: 'nothing_to_offer',
        source: { kind: 'withholding_reason', reasonIndex: 0 },
        supportedBy: first.supportedBy as [EvidenceNodeId, ...EvidenceNodeId[]],
      },
    ];
  }

  const summary = summarizeOptionSet(recommendation.options);
  const lead = summary.lead;
  if (lead === null) return [];

  if (intent === 'present_choice' && strategy === 'name_the_alternatives') {
    const second = summary.alternatives[0];
    if (second === undefined) return [];
    const leadEvidence = actionEvidence(lead);
    const secondEvidence = actionEvidence(second);
    if (leadEvidence.length === 0 || secondEvidence.length === 0) return [];
    return [
      {
        claimIndex: 0,
        kind: 'proposed_action',
        source: { kind: 'option_confidence', optionIndex: 0 },
        supportedBy: leadEvidence as [EvidenceNodeId, ...EvidenceNodeId[]],
      },
      {
        claimIndex: 1,
        kind: 'proposed_action',
        source: { kind: 'option_confidence', optionIndex: 1 },
        supportedBy: secondEvidence as [EvidenceNodeId, ...EvidenceNodeId[]],
      },
    ];
  }

  const leadEvidence = actionEvidence(lead);
  if (leadEvidence.length === 0) return [];
  const actionClaim = {
    kind: 'proposed_action' as const,
    source: { kind: 'option_confidence' as const, optionIndex: 0 },
    supportedBy: leadEvidence as [EvidenceNodeId, ...EvidenceNodeId[]],
  };

  const reasonClaim = supportClaimFor(recommendation, lead);
  if (reasonClaim === null) return [];

  // `lead_with_action` says the move first and earns it second;
  // `lead_with_reason` earns it first and says it second. Same two claims, and
  // the order is the entire difference — which is why the strategy is a
  // separate field rather than something a reader infers from the claim list.
  const ordered = strategy === 'lead_with_action' ? [actionClaim, reasonClaim] : [reasonClaim, actionClaim];
  return ordered.map((claim, index) => ({ ...claim, claimIndex: index })) as readonly CoachingClaim[];
}

/**
 * The claim that says *why* this option, sourced from whichever account the
 * offer actually carries.
 *
 * An `only_candidate` offer is sourced from its `attested` list rather than
 * from a support reason, and the distinction is the one `OptionSet` draws:
 * "this is the only thing on your plate" is a claim about the *absence of
 * alternatives*, and `attested` is the evidence for that absence. Reaching for
 * a support reason instead would say "this matters because it is overdue" about
 * an offer whose real story is that there was nothing else — true in both
 * halves and wrong about which one is the reason.
 */
function supportClaimFor(
  recommendation: Recommendation,
  lead: RecommendationOption,
): { kind: string; source: unknown; supportedBy: readonly EvidenceNodeId[] } | null {
  if (recommendation.outcome === 'offered' && recommendation.options?.kind === 'only_candidate') {
    const attested = recommendation.options.attested;
    if (!Array.isArray(attested) || attested.length === 0) return null;
    return {
      kind: 'sole_option',
      source: { kind: 'only_candidate_attestation' },
      supportedBy: attested as readonly EvidenceNodeId[],
    };
  }
  const support = Array.isArray(lead.support) ? lead.support : [];
  const first = support[0];
  if (first === undefined) return null;
  const kind = claimKindForReason(first.code);
  if (kind === null) return null;
  if (!Array.isArray(first.supportedBy) || first.supportedBy.length === 0) return null;
  return {
    kind,
    source: { kind: 'support_reason', optionIndex: 0, reasonIndex: 0 },
    supportedBy: first.supportedBy as readonly EvidenceNodeId[],
  };
}
