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
  checkCoachingOutput,
  isDecisionEchoClaim,
  isEvidenceBackedClaim,
  type CoachingDefect,
  type CoachingDelivery,
  type CoachingGatewayGate,
  type CoachingOutput,
  type CoachingPlan,
} from '../../src/contracts/v1/coachingContracts';
import type {
  CandidateClaim,
  CandidateSegment,
  ProposedEffect,
  SafetyCandidate,
} from '../../src/contracts/v1/safetyContracts';
import {
  isInstant,
  offeredOptions,
  type Recommendation,
  type RecommendationDecision,
} from '../../src/contracts/v1/recommendationContracts';
import { toEpochMs } from '../planning/shared/time';
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
  if (typeof recommendation.inputDigest === 'string') found.push(recommendation.inputDigest);
  const nodes = Array.isArray(recommendation.evidence?.nodes) ? recommendation.evidence.nodes : [];
  for (const node of nodes) {
    if (node === null || node === undefined || typeof node !== 'object') continue;
    if (typeof node.nodeId === 'string') found.push(node.nodeId);
    found.push(...sourceIdentifiers((node as { source?: unknown }).source));
  }
  if (recommendation.outcome !== 'offered') return found;
  const options = recommendation.options;
  // `'excluded' in options` raised a `TypeError` on a primitive `options`, and
  // `excluded.action` raised on a null entry. Both found by the field-deletion
  // fuzz rather than by review — the shapes are ones `JSON.parse` produces and
  // no hand-picked corpus contained.
  const excluded =
    options !== null && options !== undefined && typeof options === 'object' && Array.isArray((options as { excluded?: unknown }).excluded)
      ? ((options as { excluded: readonly { action?: unknown }[] }).excluded)
      : [];
  const actions: unknown[] = [
    ...offeredOptions(options).map((option) => (option === null || option === undefined ? null : option.action)),
    ...excluded.map((entry) => (entry === null || entry === undefined ? null : entry.action)),
  ];
  for (const entry of actions) {
    if (entry === null || entry === undefined || typeof entry !== 'object') continue;
    const action = entry as { commitmentId?: unknown; kind?: unknown; proposalId?: unknown };
    if (typeof action.commitmentId === 'string') found.push(action.commitmentId);
    if (action.kind === 'decompose' && typeof action.proposalId === 'string') found.push(action.proposalId);
  }
  return found;
}

/**
 * Every caller-chosen string on a `TrustedSource`, read **generically**.
 *
 * `Object.values` rather than a variant-by-variant switch, and that is the
 * whole point. The hand-written version of this function did not exist at all,
 * so `plan_slot.itemId` never reached the identifier scan — and a sentence
 * reading `"Your call-dr-cohen-about-the-biopsy is due ..."` earned no
 * `IDENTIFIER_IN_PROSE` against a recommendation `checkRecommendation` reports
 * defect-free. That is Sprint 07's recorded leak, reproduced by the check
 * written to prevent it.
 *
 * A switch would have fixed today's six variants and missed the seventh.
 * `TrustedSource` is a closed union in a contract this module does not own, and
 * `commitmentId`, `policyVersion`, `itemId`, `planDigest`, `proposalId` and
 * `stepId` are all free strings; a generic walk cannot fall behind it.
 *
 * `kind` is skipped because it is a closed vocabulary rather than
 * caller-chosen — and because scanning for it would make the word
 * `commitment` a forbidden substring of ordinary prose.
 */
function sourceIdentifiers(source: unknown): readonly string[] {
  if (source === null || source === undefined || typeof source !== 'object') return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (key === 'kind') continue;
    if (typeof value === 'string') found.push(value);
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

    if (isDecisionEchoClaim(claim)) {
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

    if (!isEvidenceBackedClaim(claim)) {
      // The third case. A claim with no readable `source` is neither
      // evidence-backed nor an echo, and the previous code routed it down the
      // echo branch — where `claim.source.verdict` raised a `TypeError` out of a
      // function documented never to throw.
      //
      // What reaches here is narrower than "a source this version does not
      // recognise", which is what this comment used to say. `isEvidenceBacked`
      // accepts any string `kind` other than `user_decision`, so a source object
      // carrying an unfamiliar kind is read as evidence-backed and never arrives
      // — only a missing or non-object source does.
      //
      // It converts to the blocking kind with a null index. The claim is then
      // refused by #38's own structural pass, which reports
      // `UNKNOWN_CLAIM_SOURCE_KIND`; #39 alone does not refuse it, and the
      // earlier note here saying it did was wrong. This is defence in depth on
      // #38's side of the seam, not a gateway guarantee.
      claims.push({
        claimId: `claim-${index}`,
        kind: UNKNOWN_COACHING_CLAIM_CANDIDATE_KIND,
        statedInstant: null,
        decisionIndex: null,
        echoedVerdict: null,
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
 * `DECISION_ECHO_MISMATCHED` could never fire.
 *
 * **Among several matches, the latest by `decidedAt` wins — not the first.**
 * Taking the first made the verdict depend on the order of an array this module
 * does not own: with `[accept@0, done@0]` an honest completion echo was blocked,
 * and with the same two records reversed it was allowed. A guard whose answer
 * changes when a caller reorders a list is not a guard, and the direction it
 * failed in was the worse one — the array most likely to be built in chronological
 * order is exactly the one that blocked the honest turn.
 *
 * The most recent act on an option is the one a coaching sentence should be
 * about, so recency is the principled tie-break rather than a convenient one.
 * `isInstant` gates the parse and `toEpochMs` performs it: the repo's single
 * predicate and its single instant arithmetic, composed rather than re-spelled,
 * and the guard is what makes the parser unable to throw behind it.
 *
 * Ties and unparseable timestamps resolve to **null**, which #39 blocks as
 * `DECISION_ECHO_UNATTESTED`. Two records claiming the same instant for the
 * same option is an ambiguity this module must not resolve by guessing.
 */
function attestationIndexOf(
  attested: readonly RecommendationDecision[],
  output: CoachingOutput,
  optionIndex: number | null,
): number | null {
  let best: number | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  let tied = false;
  for (let index = 0; index < attested.length; index += 1) {
    const record = attested[index];
    if (record === null || record === undefined || typeof record !== 'object') continue;
    if (record.recommendationId !== output?.recommendationId) continue;
    if ((record.optionIndex ?? null) !== optionIndex) continue;
    if (!isInstant(record.decidedAt)) return null;
    const ms = toEpochMs(record.decidedAt);
    if (best === null || ms > bestMs) {
      best = index;
      bestMs = ms;
      tied = false;
      continue;
    }
    if (ms === bestMs) tied = true;
  }
  return tied ? null : best;
}

export interface CoachingDeliveryInput extends ClaimSupportInput {
  readonly candidateId: string;
  /**
   * The plan the output claims to realize.
   *
   * Required, because `checkCoachingOutput` is only answerable against it — and
   * because a delivery path that could not run the structural pass is the
   * defect this field was added to close. See `deliverCoaching`.
   */
  readonly plan: CoachingPlan;
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

  /**
   * The structural pass runs **first**, and its absence here was the defect.
   *
   * `deliverCoaching` is documented in this file and in `index.ts` as the gate
   * where "unsupported claims block delivery" is decided, and it ran only the
   * claim-support and language passes. Every structural code — `PLAN_OUTPUT_MISMATCH`,
   * `MODEL_REALIZATION_NOT_ENABLED`, `UNKNOWN_CLAIM_REFERENCE`,
   * `SENTENCE_LIMIT_EXCEEDED` — was therefore unenforced at the only place it
   * mattered.
   *
   * The compounding failure is what made it a blocker rather than a gap:
   * `checkClaimSupport` iterates `output.claims`, so an output declaring
   * **zero** claims produced zero findings, and the candidate handed to the
   * gateway then declared no claims either — so #39 found nothing too. A single
   * output carrying a fabricated instant, a leaked identifier, a false
   * persistence claim, a disabled realization mode and references to claims
   * that did not exist was delivered with an empty finding list from both
   * gates. Two independent gates, and the same empty input silenced both.
   */
  const defects: CoachingDefect[] = [
    ...checkCoachingOutput(output, safe.plan),
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
