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
  UNKNOWN_COACHING_CLAIM_CANDIDATE_KIND,
  UNKNOWN_INTENT_PRESSURE_INTENSITY,
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
import {
  offeredOptions,
  type Recommendation,
  type RecommendationDecision,
} from '../../src/contracts/v1/recommendationContracts';
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
 * `attestedDecisions` is the same array the caller will put on the
 * `SafetyRequest`. It is a parameter rather than something derived here,
 * because the whole value of the check is that the producer and the request
 * are different places: a `decisionIndex` computed against a list this function
 * invented would be a claim measuring its own fixture.
 *
 * ## Decision echoes are emitted, not dropped
 *
 * An earlier version of this function dropped them. #39 ruled against that and
 * the ruling is adopted in full — see the long note on
 * `CANDIDATE_CLAIM_KIND_FOR_COACHING_CLAIM`. The short version: the class only
 * looked uncheckable because `SafetyRequest` did not carry the decision record,
 * which is a gap in the safety contract rather than a fact about the world.
 * Dropping them would have left the sharpest thing this module can emit —
 * a fabricated completion, which this module's own contract calls the worst
 * output it can produce — checked by this module alone, which is exactly what
 * #39 refuses to import `lib/coaching/**` in order to prevent.
 *
 * So an echo now travels as `kind: 'decision_echo'`, `supportedBy: []` (correct
 * rather than a violation, because the exemption is explicit in #39's contract
 * and tested there in both directions), `echoedVerdict` set to what the prose
 * attributes to the user, and `decisionIndex` pointing at the attested record.
 *
 * **A decision this function was handed but which is not attested gets
 * `decisionIndex: null`**, and #39 blocks it with `DECISION_ECHO_UNATTESTED`.
 * That is deliberate and is the division of labour: attestation is the
 * gateway's judgement, not this module's, and re-deriving it here would be the
 * second *copy of data* Sprint 06's lesson forbids — as opposed to the second
 * *judgement* it endorses, which is what this module's own
 * `DECISION_CLAIM_WITHOUT_DECISION` and `DECISION_CLAIM_VERDICT_MISMATCH`
 * already are.
 *
 * ## Every other claim is a statement, and no claim states an instant
 *
 * The eight evidence-backed kinds map to `'statement'`, so every one of them
 * carries `statedInstant: null` and #39's `FABRICATED_INSTANT` cannot fire on
 * this producer. That property rests on `COACHING_TEMPLATES` interpolating
 * nothing, which is what `tests/coaching/realizer.test.ts` scans — rather than
 * on this mapping, which is only what this track decided.
 *
 * ## The two fallbacks both fail closed
 *
 * An unrecognised claim kind becomes `UNKNOWN_COACHING_CLAIM_CANDIDATE_KIND`
 * (`decision_echo`, with a null index, so #39 blocks it) rather than
 * `'statement'`, and an unrecognised intent declares
 * `UNKNOWN_INTENT_PRESSURE_INTENSITY` rather than `'none'`. Both were quiet
 * `??` defaults that substituted the *most permissive* member of a
 * contract-owned vocabulary — the same shape as the private copies of
 * `CANDIDATE_CLAIM_KINDS` and `PROPOSED_EFFECT_KINDS` that #39 found in its own
 * `postValidator.ts`, where the new kind would have been reported
 * `UNKNOWN_CANDIDATE_SHAPE` by the very validator meant to check it.
 */
export function toSafetyCandidate(
  output: CoachingOutput,
  candidateId: string,
  attestedDecisions: readonly RecommendationDecision[] = [],
): SafetyCandidate {
  const sentences = Array.isArray(output?.sentences) ? output.sentences : [];
  const segments: CandidateSegment[] = sentences.map((sentence) => ({
    role: 'body' as const,
    text: typeof sentence?.text === 'string' ? sentence.text : '',
  }));

  const attested = Array.isArray(attestedDecisions) ? attestedDecisions : [];
  const claims: CandidateClaim[] = [];
  const source = Array.isArray(output?.claims) ? output.claims : [];
  for (let index = 0; index < source.length; index += 1) {
    const claim = source[index];
    if (claim === null || claim === undefined || typeof claim !== 'object') continue;
    const table = CANDIDATE_CLAIM_KIND_FOR_COACHING_CLAIM as Readonly<Record<string, CandidateClaim['kind']>>;
    const kind = Object.prototype.hasOwnProperty.call(table, claim.kind as string)
      ? table[claim.kind as string]
      : UNKNOWN_COACHING_CLAIM_CANDIDATE_KIND;

    if (!isEvidenceBackedClaim(claim)) {
      claims.push({
        // Positional, not caller-chosen. An index cannot carry content.
        claimId: `claim-${index}`,
        kind,
        statedInstant: null,
        decisionIndex: attestationIndexOf(attested, output, claim.source.optionIndex ?? null),
        echoedVerdict: claim.source.verdict,
        supportedBy: [],
      });
      continue;
    }

    claims.push({
      claimId: `claim-${index}`,
      kind,
      statedInstant: null,
      decisionIndex: null,
      echoedVerdict: null,
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
    pressure: pressure ?? UNKNOWN_INTENT_PRESSURE_INTENSITY,
  };
}

/**
 * The position of the attested record this echo is about, or null.
 *
 * Matched on `recommendationId` **and** `optionIndex`, never on the verdict.
 * Matching on the verdict is the tempting shortcut and it destroys the check:
 * an echo claiming `done` would then find whichever record happens to say
 * `done`, so a fabricated completion would locate an attestation for itself and
 * `DECISION_ECHO_MISMATCHED` could never fire. The index must name the record
 * the echo is *about*, so that #39 can compare what the prose says against what
 * that record actually carries.
 *
 * Null when nothing matches — which #39 blocks as `DECISION_ECHO_UNATTESTED`.
 * That is the right answer rather than a gap: this module is saying "I name no
 * attested decision", and it is the gateway's job to decide what that means.
 */
function attestationIndexOf(
  attested: readonly RecommendationDecision[],
  output: CoachingOutput,
  optionIndex: number | null,
): number | null {
  for (let index = 0; index < attested.length; index += 1) {
    const record = attested[index];
    if (record === null || record === undefined || typeof record !== 'object') continue;
    if (record.recommendationId !== output?.recommendationId) continue;
    if ((record.optionIndex ?? null) !== optionIndex) continue;
    return index;
  }
  return null;
}

export interface CoachingDeliveryInput extends ClaimSupportInput {
  readonly candidateId: string;
  /**
   * The user acts the caller attests happened — the same array it will put on
   * the `SafetyRequest`. Defaults to empty, which means every decision echo
   * converts with a null `decisionIndex` and #39 blocks it: the fail-closed
   * direction, on the same terms as `absentGatewayBlocksDelivery`.
   */
  readonly attestedDecisions?: readonly RecommendationDecision[];
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

  const verdict = safe.gate(toSafetyCandidate(output, safe.candidateId, safe.attestedDecisions ?? []));
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
