/**
 * The claim-to-evidence validator (Sprint 09, issue #38).
 *
 * One question: **does every claim in a coaching sentence trace to a support
 * reason in the approved recommendation it was derived from?**
 *
 * ## What this is not, and why that matters most
 *
 * Sprint 08 already solved claim-to-source tracing.
 * `recommendationContracts.ts` ships a full evidence graph with cycle
 * detection, dangling-reference rejection, blank-id rejection, unknown-kind
 * rejection and `resolveEvidenceRoots`, which guarantees an accepted claim
 * terminates at an `ObservedEvidence`. #39's Safety gateway reuses the same
 * three functions as value imports rather than copying them.
 *
 * **This file does not contain a second one.** It calls `checkEvidenceGraph`
 * for structure and `resolveEvidenceRoots` for termination, and there is no
 * traversal, no cycle detection and no id resolution written here. Sprint 06
 * paid four review rounds for two implementations of one mechanism, each round
 * finding a defect already fixed on the other side; Sprint 07 spent two
 * integration rounds pulling three copies of one arithmetic apart.
 *
 * The work that *is* new is the one question Sprint 08 structurally cannot
 * ask. `checkRecommendation` validates a recommendation **against itself**:
 * every id resolves, every derivation terminates, every reason has evidence.
 * This validates a **derived artefact against the recommendation it came
 * from**, and the failure it exists to catch is invisible to Sprint 08 by
 * construction — a coaching claim citing a perfectly valid node of a perfectly
 * valid graph that its source reason never cited. Every id resolves. Every
 * derivation terminates. And the sentence says something the recommendation
 * did not.
 *
 * ## The subset rule, and the weaker rule that was rejected
 *
 * A claim's evidence must be a subset of its source reason's evidence **by
 * id**. The tempting alternative is a root-set comparison —
 * `roots(claim) ⊆ roots(reason)` — and it is too weak: if reason `A` rests on
 * observation `O` and an unrelated derived node `D` also rests on `O` while
 * claiming something else entirely, then `roots(D) ⊆ roots(A)` and a claim
 * citing `D` passes while asserting a fact the recommendation never used.
 *
 * `resolveEvidenceRoots` is still used, in addition, to reject a cited node
 * whose own ancestry is broken — that is the half Sprint 08 owns and this file
 * delegates rather than re-deriving.
 *
 * The cost of the strict rule is real and stated: a coaching claim cannot cite
 * a node *more primitive* than its reason does, even though such a node is
 * strictly less of a claim. That is the conservative direction, and "adds no
 * new facts" points that way.
 */

import {
  CLAIM_KIND_FOR_DECISION_VERDICT,
  CLAIM_KIND_FOR_SUPPORT_REASON,
  checkCarriedEvidence,
  isEvidenceBackedClaim,
  type CoachingClaim,
  type CoachingDefect,
  type CoachingOutput,
} from '../../../src/contracts/v1/coachingContracts';
import {
  offeredOptions,
  resolveEvidenceRoots,
  type EvidenceNodeId,
  type Recommendation,
  type RecommendationDecision,
} from '../../../src/contracts/v1/recommendationContracts';

export interface ClaimSupportInput {
  readonly output: CoachingOutput;
  /** The approved recommendation the output was derived from. */
  readonly recommendation: Recommendation;
  /** The decision the output acknowledges, or null when it presents an offer. */
  readonly decision?: RecommendationDecision | null;
}

function defect(code: CoachingDefect['code'], detail: string, claimIndex: number | null): CoachingDefect {
  return { code, claimIndex, sentenceIndex: null, detail };
}

function asList<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [];
}

/**
 * The evidence a source cites, and the claim kind it licenses.
 *
 * Null when the source names a position the recommendation does not have —
 * `UNKNOWN_SOURCE_REASON`. Resolved in one place so that a source kind added to
 * the contract without a resolution here fails loudly at the one site rather
 * than quietly at four.
 */
function resolveSource(
  recommendation: Recommendation,
  claim: CoachingClaim,
): { readonly evidence: readonly EvidenceNodeId[]; readonly licensedKind: string | null } | null {
  if (!isEvidenceBackedClaim(claim)) return null;
  const source = claim.source;

  if (source.kind === 'withholding_reason') {
    if (recommendation.outcome !== 'withheld') return null;
    const reason = asList<{ code: string; supportedBy: readonly EvidenceNodeId[] }>(recommendation.reasons)[source.reasonIndex];
    if (reason === undefined) return null;
    return { evidence: asList<EvidenceNodeId>(reason.supportedBy), licensedKind: 'nothing_to_offer' };
  }

  if (recommendation.outcome !== 'offered') return null;

  if (source.kind === 'only_candidate_attestation') {
    const options = recommendation.options;
    if (options === null || options === undefined || options.kind !== 'only_candidate') return null;
    return { evidence: asList<EvidenceNodeId>(options.attested), licensedKind: 'sole_option' };
  }

  // `offeredOptions` rather than reaching into the `OptionSet` variants by hand:
  // it is the contract's own accessor, it never returns a hole, and a second
  // way of reading "the options in offer order" is a second thing that can
  // disagree about which option index 1 is.
  const options = offeredOptions(recommendation.options);
  const option = options[source.optionIndex];
  if (option === undefined) return null;

  if (source.kind === 'option_confidence') {
    const confidence = option.confidence;
    if (confidence === null || confidence === undefined) return null;
    return { evidence: asList<EvidenceNodeId>(confidence.basis), licensedKind: 'proposed_action' };
  }

  if (source.kind === 'support_reason') {
    const reason = asList<{ code: string; supportedBy: readonly EvidenceNodeId[] }>(option.support)[source.reasonIndex];
    if (reason === undefined) return null;
    const table = CLAIM_KIND_FOR_SUPPORT_REASON as Readonly<Record<string, string>>;
    const licensed = Object.prototype.hasOwnProperty.call(table, reason.code) ? table[reason.code] : null;
    return { evidence: asList<EvidenceNodeId>(reason.supportedBy), licensedKind: licensed };
  }

  return null;
}

/**
 * Check an output's claims against the recommendation they came from.
 *
 * Returns findings; it does not throw, for **any** input. Ordering is by input
 * position — graph findings first, then claim by claim in `claims` order, and
 * for each claim in a fixed code order — so two callers checking the same
 * output get byte-identical results. No string comparator is involved, which is
 * the same device `checkEvidenceGraph` uses and the reason there is no
 * `localeCompare` in this module to ban.
 *
 * **The suppression rule**: a finding is suppressed only when it borrows a
 * bound from something already reported malformed. An unresolvable source
 * suppresses the subset check and the kind check, because both would borrow a
 * list from a position that does not exist. A malformed graph does **not**
 * suppress the subset check — a claim citing a node its reason never cited is
 * wrong whether or not the graph is sound, and suppressing it would hide the
 * load-bearing finding behind a structural one from a different producer.
 */
export function checkClaimSupport(input: ClaimSupportInput): readonly CoachingDefect[] {
  const defects: CoachingDefect[] = [];
  const safe = input === null || input === undefined || typeof input !== 'object' ? ({} as ClaimSupportInput) : input;
  const output = safe.output === null || safe.output === undefined ? ({} as CoachingOutput) : safe.output;
  const recommendation = safe.recommendation;
  const decision = safe.decision === undefined ? null : safe.decision;

  if (recommendation === null || recommendation === undefined || typeof recommendation !== 'object') {
    return [defect('RECOMMENDATION_MISMATCH', 'no recommendation was supplied to validate against', null)];
  }
  if (output.recommendationId !== recommendation.recommendationId) {
    // Stated without quoting either id: both are caller-chosen free strings and
    // a `detail` here sits one copy-paste from rendered prose.
    defects.push(defect('RECOMMENDATION_MISMATCH', 'the output names a different recommendation than the one supplied', null));
  }

  // Sprint 08's graph checker, called. There is no second one in this module.
  defects.push(...checkCarriedEvidence(output.evidence));

  const graph = output.evidence === null || output.evidence === undefined ? { nodes: [] } : output.evidence;
  const claims = asList<CoachingClaim>(output.claims);

  for (let index = 0; index < claims.length; index += 1) {
    const claim = claims[index];
    if (claim === null || claim === undefined || typeof claim !== 'object') {
      defects.push(defect('UNKNOWN_SOURCE_REASON', 'claim is not an object', index));
      continue;
    }

    if (!isEvidenceBackedClaim(claim)) {
      const source = claim.source;
      if (decision === null) {
        defects.push(defect('DECISION_CLAIM_WITHOUT_DECISION', 'the output echoes a decision that was not supplied', index));
        continue;
      }
      if (source.verdict !== decision.verdict) {
        defects.push(defect('DECISION_CLAIM_VERDICT_MISMATCH', 'the echoed verdict is not the verdict the user gave', index));
      }
      if ((source.optionIndex ?? null) !== (decision.optionIndex ?? null)) {
        defects.push(defect('UNKNOWN_SOURCE_REASON', 'the echo names a different option position than the decision did', index));
      }
      const table = CLAIM_KIND_FOR_DECISION_VERDICT as Readonly<Record<string, string>>;
      const licensed = Object.prototype.hasOwnProperty.call(table, decision.verdict) ? table[decision.verdict] : null;
      if (licensed !== null && claim.kind !== licensed) {
        defects.push(defect('CLAIM_KIND_NOT_DERIVABLE', 'the echo asserts a kind this verdict does not license', index));
      }
      continue;
    }

    const resolved = resolveSource(recommendation, claim);
    if (resolved === null) {
      defects.push(defect('UNKNOWN_SOURCE_REASON', 'the claim names a source position the recommendation does not have', index));
      continue;
    }

    if (resolved.licensedKind !== null && claim.kind !== resolved.licensedKind) {
      // A claim citing an `OVERDUE` reason while asserting `importance` is
      // fully sourced and still says something the recommendation did not.
      defects.push(defect('CLAIM_KIND_NOT_DERIVABLE', 'the claim asserts a kind its source reason does not license', index));
    }

    const allowed = new Set<string>(resolved.evidence.map((id) => String(id)));
    const cited = asList<EvidenceNodeId>(claim.supportedBy);
    for (let position = 0; position < cited.length; position += 1) {
      const id = cited[position];
      if (!allowed.has(String(id))) {
        // The load-bearing finding. Named by position in the claim's own
        // reference list rather than by id, because an evidence `nodeId` is a
        // caller-chosen free string.
        defects.push(
          defect(
            'CLAIM_EVIDENCE_NOT_IN_REASON',
            `evidence reference at position ${position} is not cited by the source reason`,
            index,
          ),
        );
        continue;
      }
      if (resolveEvidenceRoots(graph, id) === null) {
        // Sprint 08's resolver, called. Null means the node reaches no
        // observation — a cycle, a dangling parent, a parentless derivation or
        // an unrecognised kind — and this module has no second opinion about
        // which.
        defects.push(
          defect(
            'UNRESOLVABLE_EVIDENCE',
            `evidence reference at position ${position} reaches no observation of trusted state`,
            index,
          ),
        );
      }
    }
  }

  return defects;
}
