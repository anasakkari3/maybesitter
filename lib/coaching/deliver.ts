/**
 * The delivery path (Sprint 09, issue #38).
 *
 * "Unsupported claims block delivery" has **two independent gates**, and this
 * file is where they meet:
 *
 *   1. **This module's gate** — claim-to-evidence support and language, from
 *      `lib/coaching/validator/`.
 *   2. **#39's Safety gateway** — privacy, harmful pressure, injection,
 *      hallucinated time and persistence boundaries. #39 owns that verdict
 *      vocabulary and this file declares none of its own: `CoachingDelivery`
 *      names *which gate* refused and carries #39's `SafetyVerdict` and
 *      `SafeUserPath` verbatim.
 *
 * ## The order, and why the gateway is not consulted second-guessing a refusal
 *
 * This module's gate runs first and, when it refuses, the gateway is **not
 * called**. Handing a candidate with an unsupported claim to a guard whose job
 * is to catch unsupported claims would produce a second finding about the same
 * defect, from a different taxonomy, that a caller would then have to
 * reconcile. Worse, it would make this module's own check look optional: a
 * reviewer reading a green suite could not tell whether the block came from
 * here or from there, and the day this check regressed the gateway would cover
 * for it silently.
 *
 * ## `allow_with_redaction` withholds
 *
 * A deliberate v1 narrowing, recorded with its deletion condition on
 * `CoachingDelivery`. The gateway drops segments by index; a coaching turn is
 * one or two sentences whose claims are checked against the plan as a whole, so
 * dropping a sentence leaves the remaining prose resting on a claim nothing
 * realizes. A fragment of a coaching sentence is not a shorter coaching
 * sentence. **Revisit when** re-planning under a constraint exists as its own
 * capability, with its own acceptance criteria.
 */

import {
  COACHING_ABSENT_GATEWAY_RECOVERY,
  COACHING_CLAIM_SUPPORT_RECOVERY,
  COACHING_SAFETY_SURFACE,
  CANDIDATE_CLAIM_KIND_FOR_COACHING_CLAIM,
  PRESSURE_INTENSITY_FOR_INTENT,
  isEvidenceBackedClaim,
  type CoachingDefect,
  type CoachingDelivery,
  type CoachingGatewayGate,
  type CoachingOutput,
} from '../../src/contracts/v1/coachingContracts';
import type {
  CandidateClaim,
  CandidateSegment,
  ProposedEffect,
  SafetyCandidate,
} from '../../src/contracts/v1/safetyContracts';
import { offeredOptions, type Recommendation } from '../../src/contracts/v1/recommendationContracts';
import { checkClaimSupport, type ClaimSupportInput } from './validator/claimSupport';
import { checkCoachingLanguage } from './validator/language';

/**
 * The effect a coaching turn proposes: none.
 *
 * A turn is words. It writes nothing, proposes no write, and sends no
 * notification — `COACHING_PERSISTENCE_POLICY.describesNoStateChange`. The list
 * is non-empty and explicitly `'none'` rather than empty, because an empty
 * effects list and "we declare no effect" are the same value to a guard, and
 * the second is a claim this module wants on the record. It is also where the
 * "completion is not described as tracking" criterion lands structurally:
 * describing something as tracked while declaring `kind: 'none'` is a claim
 * about an effect that did not happen, and #39's `PERSISTENCE_CLAIMED` reads
 * exactly that pairing.
 */
export const COACHING_PROPOSED_EFFECTS: readonly ProposedEffect[] = Object.freeze([
  Object.freeze({ effectId: 'coaching-utterance', kind: 'none' as const, requiresConfirmation: false }),
]);

/**
 * Every caller-chosen free string a recommendation carries.
 *
 * Collected in one place so the identifier scan cannot cover four of the five
 * kinds and read as complete. The fifth — `RecommendedAction.proposalId` — is
 * the one a hand-written collector forgets, because it exists on one action
 * variant only.
 */
export function identifiersOf(recommendation: Recommendation): readonly string[] {
  const found: string[] = [];
  if (recommendation === null || recommendation === undefined || typeof recommendation !== 'object') return found;
  if (typeof recommendation.recommendationId === 'string') found.push(recommendation.recommendationId);
  if (typeof recommendation.scopeId === 'string') found.push(recommendation.scopeId);
  const nodes = Array.isArray(recommendation.evidence?.nodes) ? recommendation.evidence.nodes : [];
  for (const node of nodes) {
    if (node !== null && node !== undefined && typeof node.nodeId === 'string') found.push(node.nodeId);
  }
  if (recommendation.outcome !== 'offered') return found;
  const options = recommendation.options;
  const actions = [
    ...offeredOptions(options).map((option) => option.action),
    ...(options !== null && options !== undefined && 'excluded' in options && Array.isArray(options.excluded)
      ? options.excluded.map((excluded) => excluded.action)
      : []),
  ];
  for (const action of actions) {
    if (action === null || action === undefined || typeof action !== 'object') continue;
    if (typeof action.commitmentId === 'string') found.push(action.commitmentId);
    if (action.kind === 'decompose' && typeof action.proposalId === 'string') found.push(action.proposalId);
  }
  return found;
}

/**
 * Convert a coaching output into the candidate #39's gateway takes.
 *
 * `candidateId` is **supplied**, never minted: `randomUUID` is banned under
 * `lib/coaching/**` and two runs of one request must agree.
 *
 * ## Every claim is a `statement`, and no claim states an instant
 *
 * `CANDIDATE_CLAIM_KIND_FOR_COACHING_CLAIM` maps all eleven coaching claim
 * kinds to `'statement'`, so every converted claim carries
 * `statedInstant: null` and #39's `FABRICATED_INSTANT` cannot fire on this
 * producer. That is a property rather than a default, and the property rests on
 * `COACHING_TEMPLATES` interpolating nothing — which is what
 * `tests/coaching/realizer.test.ts` scans, rather than scanning this mapping.
 *
 * ## Decision echoes are omitted from `claims`, and this is deliberate
 *
 * A `DecisionEchoClaim` has no evidence, because the user's own act is not a
 * fact about trusted state that the recommendation read. Converting it to
 * `supportedBy: []` would make #39 report `UNSOURCED_CLAIM` — a **blocking**
 * severity — on every honest acknowledgement this module can produce, and the
 * only ways to avoid that would be to attach the accepted option's evidence to
 * it (which makes a fabricated completion look sourced) or to suppress the
 * gateway for those turns (which removes the guard exactly where a false
 * completion would live).
 *
 * So an echo contributes its **segment** and not a claim: the gateway still
 * scans the prose for shame language, persistence claims and identifiers, and
 * still sees `effects: [{ kind: 'none' }]` — so "you finished that, I am
 * tracking it" is still caught by `PERSISTENCE_CLAIMED`. What it does not do is
 * ask the gateway to trace a claim about the world where the module is making
 * none.
 *
 * `tests/coaching/claimValidator.test.ts` pins the omission with a count, so it
 * reads as a decision rather than as a claim that went missing. **Revisit if**
 * #39 grows a claim kind for a user act; that is #39's taxonomy to extend, not
 * this module's.
 */
export function toSafetyCandidate(output: CoachingOutput, candidateId: string): SafetyCandidate {
  const sentences = Array.isArray(output?.sentences) ? output.sentences : [];
  const segments: CandidateSegment[] = sentences.map((sentence) => ({
    role: 'body' as const,
    text: typeof sentence?.text === 'string' ? sentence.text : '',
  }));

  const claims: CandidateClaim[] = [];
  const source = Array.isArray(output?.claims) ? output.claims : [];
  for (let index = 0; index < source.length; index += 1) {
    const claim = source[index];
    if (claim === null || claim === undefined || !isEvidenceBackedClaim(claim)) continue;
    const table = CANDIDATE_CLAIM_KIND_FOR_COACHING_CLAIM as Readonly<Record<string, CandidateClaim['kind']>>;
    claims.push({
      // Positional, not caller-chosen. An index cannot carry content.
      claimId: `claim-${index}`,
      kind: table[claim.kind] ?? 'statement',
      statedInstant: null,
      supportedBy: Array.isArray(claim.supportedBy) ? claim.supportedBy : [],
    });
  }

  const pressure = (PRESSURE_INTENSITY_FOR_INTENT as Readonly<Record<string, SafetyCandidate['pressure']>>)[
    output?.intent as string
  ];

  return {
    candidateId,
    surface: COACHING_SAFETY_SURFACE,
    segments,
    claims,
    evidence: output?.evidence ?? { nodes: [] },
    effects: COACHING_PROPOSED_EFFECTS,
    pressure: pressure ?? 'none',
  };
}

export interface CoachingDeliveryInput extends ClaimSupportInput {
  readonly candidateId: string;
  /** #39's gateway. Null is refusal, never permission. */
  readonly gate: CoachingGatewayGate;
}

/**
 * Decide whether a coaching output may be delivered.
 *
 * The two gates in order, neither substituting for the other, and every
 * withholding path carrying a `SafeUserPath` — because withholding is only
 * defensible while the refusal carries its way out.
 */
export function deliverCoaching(input: CoachingDeliveryInput): CoachingDelivery {
  const safe = input === null || input === undefined || typeof input !== 'object' ? ({} as CoachingDeliveryInput) : input;
  const output = safe.output;

  const defects: CoachingDefect[] = [
    ...checkClaimSupport(safe),
    ...checkCoachingLanguage(output, identifiersOf(safe.recommendation)),
  ];
  if (defects.length > 0) {
    return {
      disposition: 'withheld',
      blockedBy: ['claim_support'],
      defects,
      verdict: null,
      recovery: COACHING_CLAIM_SUPPORT_RECOVERY,
    };
  }

  if (safe.gate === null || safe.gate === undefined) {
    // `COACHING_INPUT_POLICY.absentGatewayBlocksDelivery`. A delivery path that
    // read a missing gateway as approval would get more permissive exactly as
    // the caller lost more of its safety plumbing.
    return {
      disposition: 'withheld',
      blockedBy: ['safety_gateway'],
      defects: [],
      verdict: null,
      recovery: COACHING_ABSENT_GATEWAY_RECOVERY,
    };
  }

  const verdict = safe.gate(toSafetyCandidate(output, safe.candidateId));
  if (verdict === null || verdict === undefined || typeof verdict !== 'object') {
    return {
      disposition: 'withheld',
      blockedBy: ['safety_gateway'],
      defects: [],
      verdict: null,
      recovery: COACHING_ABSENT_GATEWAY_RECOVERY,
    };
  }
  if (verdict.disposition === 'allow') {
    return { disposition: 'delivered', output, verdict };
  }
  if (verdict.disposition === 'block' || verdict.disposition === 'allow_with_redaction') {
    return {
      disposition: 'withheld',
      blockedBy: ['safety_gateway'],
      defects: [],
      verdict,
      recovery: verdict.recovery,
    };
  }
  // A disposition this version does not recognise is a refusal, not a pass.
  // `summarizeOptionSet` returning `soleness: 'only_candidate'` for an offer it
  // had failed to parse is the recorded shape of the other choice.
  return {
    disposition: 'withheld',
    blockedBy: ['safety_gateway'],
    defects: [],
    verdict: null,
    recovery: COACHING_ABSENT_GATEWAY_RECOVERY,
  };
}
