/**
 * Stable selection and explanation assembly (Sprint 08, issue #34).
 *
 * `selectRecommendation` is a pure function from a request and a config to a
 * `Recommendation`. It is the only place in this module that decides what to
 * *say*; `candidates.ts` decides what was read and what is excluded, `policy.ts`
 * decides what is offerable and in what order.
 *
 * Five properties are arranged for rather than merely true today.
 *
 *  1. **Hard constraints are unbypassable because the ranking never sees
 *     them.** A candidate `hardExclusionCodes` rejects never becomes an
 *     `OptionCandidate` at all — there is no list it sits in from which a high
 *     score could recover it, and no branch that reads its confidence. The
 *     structural version of the acceptance criterion, rather than a rule an
 *     implementation has to keep obeying.
 *
 *  2. **The digest is taken after the static pass, never before.**
 *     `generateCandidates` runs first; only then is the input canonicalised and
 *     hashed. `RECOMMENDATION_INPUT_POLICY.digestAfterStaticPass` states the
 *     rule and Sprint 07 shipped the other order — a digest that threw on
 *     exactly the malformed inputs the pass existed to report.
 *
 *  3. **Nothing reads a clock, mints an id, or calls `localeCompare`.** `now`
 *     comes from the caller, `recommendationId` comes from the caller,
 *     `expiresAt` is `now` plus a stated TTL, and every string ordering goes
 *     through `compareByCodePoint`.
 *
 *  4. **No caller-chosen identifier reaches a human-readable string.** Every
 *     `detail` names a candidate by its canonical index, an option by its offer
 *     index, evidence by count, and otherwise carries only numbers derived from
 *     the input. Ids travel in the typed fields the contract gives them, where a
 *     consumer that must not display them can drop them.
 *     `tests/recommendation/selectorBoundaries.test.ts` fuzzes distinctive ids
 *     through the selector and asserts none of them appears in any string the
 *     output carries — the leak Sprint 07 recorded was real, and a test that
 *     only checked titles passed straight over it.
 *
 *  5. **The module checks its own output with the contract's checker.** The
 *     result carries `defects`, and it is always empty. `checkRecommendation` is
 *     run by the producer here *and* by #35's reviewer; a check run only by the
 *     producer is a check the consumer trusts on the producer's word.
 *
 * ── Which actions this module proposes, and which it does not ────────────
 *
 * `do_now`, `schedule` and `decompose`. `decompose` replaces `do_now` for a
 * commitment that already has a decomposition proposal rather than competing
 * with it — see the comment at the generation site. There is no `defer`
 * candidate in v1, and the reason is not oversight: `RecommendedAction`'s `defer` variant
 * requires an `until` instant, and this module has no policy that says how far
 * to push something out. Inventing one — "tomorrow", "the next free slot" —
 * would be a coaching judgement made by a selector, and shipping the shape
 * before the policy that governs it is how the shape becomes the policy. A
 * `defer` is a *user decision* today (`RecommendationDecisionVerdict` has one),
 * and a user's chosen instant is a real input rather than a guessed one.
 */

import { createHash } from 'node:crypto';

import {
  RECOMMENDATION_CONTRACT_VERSION,
  actionKey,
  bandForConfidence,
  checkRecommendation,
  offeredOptions,
  type Confidence,
  type EvidenceNodeId,
  type ExcludedOption,
  type ExclusionReason,
  type ExclusionReasonCode,
  type Instant,
  type OptionSet,
  type Recommendation,
  type RecommendationDefect,
  type RecommendationOption,
  type RecommendedAction,
  type SupportReason,
  type SupportReasonCode,
  type WithholdingReason,
  type WithholdingReasonCode,
} from '../../../src/contracts/v1/recommendationContracts';
import type { PriorityScore } from '../../../src/contracts/v1/priorityContracts';
import type { Plan } from '../../../src/contracts/v1/planningContracts';
import type { LifeState } from '../../../src/contracts/v1/lifeStateContracts';
// `addMinutes` and `toInstant` are the repo's instant arithmetic. Imported
// rather than rewritten: a second copy of "add sixty minutes to an ISO string"
// is the Sprint 06 gap in its smallest form, and it is also what keeps a bare
// `new Date(...)` out of this directory entirely.
import { addMinutes } from '../../planning/shared/time';
import { compareByCodePoint } from '../../planning/shared/compare';
import {
  epochMsOrNull,
  generateCandidates,
  type Candidate,
  type CandidateSet,
  type CommitmentSnapshot,
  type RecommendationSelectorInput,
} from './candidates';
import {
  DEFAULT_RECOMMENDATION_SELECTOR_CONFIG,
  applyDiversityPolicy,
  confidenceFor,
  leadClearsRiskFloor,
  rankOptionCandidates,
  applyRiskPolicy,
  type OptionCandidate,
  type PolicyRejection,
  type RecommendationSelectorConfig,
} from './policy';

/**
 * The schema this module speaks, spelled out as a literal.
 *
 * `recommendationContracts.ts` imports `MODULE_CONTRACT_VERSION` from
 * `moduleContracts.ts`, so importing `RECOMMENDATION_SCHEMA_VERSION` *into*
 * `moduleContracts.ts` would close a cycle that ESM resolves by evaluating the
 * contract while `moduleContracts`'s body has not run — a TDZ `ReferenceError`
 * at import time that `tsc` reports nothing about. The `recommendation`
 * descriptor therefore spells the string out, and
 * `tests/contract/intelligenceModuleBoundaries.test.ts` pins the two spellings
 * together. This constant is the module-side half of that pin.
 */
export const RECOMMENDATION_SELECTOR_SCHEMA = 'recommendation-v1' as const;

/** The version of the canonical input encoding, prefixed into every digest. */
export const RECOMMENDATION_INPUT_DIGEST_VERSION = 'recommendation-digest-v1' as const;

const MS_PER_MINUTE = 60_000;

/* ── The canonical input encoding ────────────────────────────────── */

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * A scalar, with non-finite numbers tagged rather than refused.
 *
 * `JSON.stringify(NaN)` is `"null"` and so is `JSON.stringify(null)`, so a naive
 * encoding would hash a broken priority total and an absent one identically.
 * Tagging rather than throwing is `RECOMMENDATION_INPUT_POLICY` applied to the
 * digest: the digest is computed for every run, including the ones whose whole
 * answer is a list of findings about bad values.
 */
function scalar(value: string | number | boolean | null): string {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return record([['nonFinite', JSON.stringify(String(value))]]);
  }
  return JSON.stringify(value);
}

/** A record whose key order is the argument order, never insertion order. */
function record(entries: readonly (readonly [string, string])[]): string {
  return `{${entries.map(([key, encoded]) => `${JSON.stringify(key)}:${encoded}`).join(',')}}`;
}

/** A list ordered by its own encoded content, so input order cannot leak in. */
function sortedList(encodings: readonly string[]): string {
  return `[${encodings.slice().sort(compareByCodePoint).join(',')}]`;
}

function encodeSnapshot(snapshot: CommitmentSnapshot): string {
  return record([
    ['commitmentId', scalar(snapshot.commitmentId)],
    ['status', scalar(snapshot.status)],
    ['confirmedAt', scalar(snapshot.confirmedAt)],
    ['dueAt', scalar(snapshot.dueAt)],
    ['remindAt', scalar(snapshot.remindAt)],
    ['importance', scalar(snapshot.importance)],
    ['blockedByCommitmentIds', sortedList(snapshot.blockedByCommitmentIds.map(scalar))],
    ['planItemId', scalar(snapshot.planItemId)],
    ['decompositionProposalId', scalar(snapshot.decompositionProposalId)],
    ['decompositionStepId', scalar(snapshot.decompositionStepId)],
  ]);
}

function encodePriority(score: PriorityScore): string {
  return record([
    ['commitmentId', scalar(score.commitmentId)],
    ['total', scalar(score.total)],
    ['policyVersion', scalar(score.policyVersion)],
    ['reasonCodes', sortedList(score.reasonCodes.map(scalar))],
  ]);
}

/**
 * The plan enters by its own digest plus the placements this module reads.
 *
 * Not by re-encoding the whole `Plan`: `Plan.inputDigest` already answers "was
 * this the same planning request", and a second encoding of the same object
 * would be a second thing to keep in step with `planningContracts`. The
 * placements are folded in as well because two different plans can share a
 * request digest only if the scheduler is broken, and this module should notice
 * that rather than assume it.
 */
function encodePlan(plan: Plan | null): string {
  if (plan === null) return scalar(null);
  return record([
    ['scopeId', scalar(plan.scopeId)],
    ['inputDigest', scalar(plan.inputDigest)],
    [
      'scheduled',
      sortedList(
        plan.scheduled.map((placed) =>
          record([
            ['itemId', scalar(placed.itemId)],
            ['startsAt', scalar(placed.interval.startsAt)],
            ['endsAt', scalar(placed.interval.endsAt)],
          ]),
        ),
      ),
    ],
  ]);
}

/**
 * The projection enters by the two fields this module reads, plus its identity.
 *
 * Encoding all four `LIFE_STATE_SOURCE_FIELDS` would make the digest change when
 * a field this module never consults changes, and "the same inputs" would then
 * be false for two runs that must produce identical output.
 */
function encodeLifeState(lifeState: LifeState): string {
  const commitments = lifeState.commitments;
  const load = lifeState.load;
  return record([
    ['version', scalar(lifeState.version)],
    ['scopeId', scalar(lifeState.scopeId)],
    ['computedAt', scalar(lifeState.computedAt)],
    ['inputDigest', scalar(lifeState.inputDigest)],
    [
      'commitments',
      record([
        ['known', scalar(commitments.known)],
        ['openCount', scalar(commitments.known ? commitments.value.openCount : null)],
        ['overdueCount', scalar(commitments.known ? commitments.value.overdueCount : null)],
        ['reason', scalar(commitments.known ? null : commitments.reason)],
      ]),
    ],
    [
      'load',
      record([
        ['known', scalar(load.known)],
        ['band', scalar(load.known ? load.value.band : null)],
        ['openCount', scalar(load.known ? load.value.openCount : null)],
        ['reason', scalar(load.known ? null : load.reason)],
      ]),
    ],
  ]);
}

function encodeConfig(config: RecommendationSelectorConfig): string {
  return record([
    ['enabled', scalar(config.enabled)],
    ['dueTodayHours', scalar(config.dueTodayHours)],
    ['dueSoonHours', scalar(config.dueSoonHours)],
    ['planSlotImminentMinutes', scalar(config.planSlotImminentMinutes)],
    ['quickWinMaxMinutes', scalar(config.quickWinMaxMinutes)],
    ['ttlMinutes', scalar(config.ttlMinutes)],
    ['maxInputAgeMinutes', scalar(config.maxInputAgeMinutes)],
  ]);
}

/**
 * The canonical string a digest is taken over. Exported because tests assert on
 * it directly — a hash says two inputs differ and never says where.
 *
 * `recommendationId` is deliberately **not** encoded. It names the run, not the
 * state the run read, so including it would make two replays of one request
 * report different inputs and every equality check built on the digest would
 * pass vacuously by never matching anything.
 */
export function canonicalSelectorInput(
  input: RecommendationSelectorInput,
  config: RecommendationSelectorConfig,
): string {
  return record([
    ['digestVersion', scalar(RECOMMENDATION_INPUT_DIGEST_VERSION)],
    ['schema', scalar(RECOMMENDATION_SELECTOR_SCHEMA)],
    ['scopeId', scalar(input.scopeId)],
    ['now', scalar(input.now)],
    ['lifeState', encodeLifeState(input.lifeState)],
    ['commitments', sortedList(input.commitments.map(encodeSnapshot))],
    ['priorityScores', sortedList(input.priorityScores.map(encodePriority))],
    ['plan', encodePlan(input.plan)],
    ['config', encodeConfig(config)],
  ]);
}

/** SHA-256 of `canonicalSelectorInput`, hex. This is `Recommendation.inputDigest`. */
export function selectorInputDigest(
  input: RecommendationSelectorInput,
  config: RecommendationSelectorConfig,
): string {
  return sha256Hex(canonicalSelectorInput(input, config));
}

/* ── Explanation assembly ────────────────────────────────────────── */

/**
 * One support reason under construction.
 *
 * `nodeIds` is checked non-empty at the point of use rather than typed as a
 * non-empty tuple here, because the codes are gathered in one loop and a tuple
 * type would force a cast at every push. The check is in `toSupportReason`, and
 * `checkRecommendation` catches anything it missed.
 */
interface DraftReason {
  readonly code: SupportReasonCode;
  readonly nodeIds: readonly EvidenceNodeId[];
  readonly detail: string;
}

function minutesBetweenMs(fromMs: number, toMs: number): number {
  return Math.round((toMs - fromMs) / MS_PER_MINUTE);
}

/**
 * The support reasons for one action on one candidate.
 *
 * Emitted in the contract's `SUPPORT_REASON_CODES` order by construction — the
 * conditions are written in that order and nothing sorts afterwards — so two
 * runs cannot differ in the order they explain the same decision.
 *
 * `PLAN_SLOT_IMMINENT` and `QUICK_WIN` attach only to a `schedule` action, and
 * that is a judgement worth stating: they are claims about a *slot*, and a
 * `do_now` on the same commitment is not a proposal to use that slot. Attaching
 * them to every action would let "there is a 15-minute slot at 14:00" argue for
 * doing the thing immediately, which is an argument nobody made.
 *
 * No `detail` here names a commitment, a node, a proposal or a plan item. They
 * name the candidate by canonical index and otherwise carry numbers.
 */
function supportReasonsFor(
  candidate: Candidate,
  action: RecommendedAction,
  nowMs: number,
  onlyEligibleCandidate: boolean,
  scopeCommitmentsNodeId: EvidenceNodeId,
  candidates: readonly Candidate[],
  config: RecommendationSelectorConfig,
): readonly DraftReason[] {
  const reasons: DraftReason[] = [];
  const evidence = candidate.evidence;
  const index = candidate.canonicalIndex;

  if (evidence.overdueNodeId !== null && candidate.effectiveTimeMs !== null) {
    reasons.push({
      code: 'OVERDUE',
      nodeIds: [evidence.overdueNodeId],
      detail: `candidate #${index} has an effective deadline ${minutesBetweenMs(candidate.effectiveTimeMs, nowMs)} minutes before the evaluation instant`,
    });
  }

  if (evidence.dueSoonNodeId !== null && candidate.effectiveTimeMs !== null) {
    reasons.push({
      code: 'DUE_SOON',
      nodeIds: [evidence.dueSoonNodeId],
      detail: `candidate #${index} has an effective deadline ${minutesBetweenMs(nowMs, candidate.effectiveTimeMs)} minutes ahead, inside the ${evidence.dueSoonCategory === 'due_today' ? config.dueTodayHours : config.dueSoonHours}-hour horizon`,
    });
  }

  if (candidate.snapshot.importance === 'high') {
    reasons.push({
      code: 'HIGH_IMPORTANCE',
      nodeIds: [evidence.importanceNodeId],
      detail: `candidate #${index} was recorded at the highest of the three importance levels`,
    });
  }

  if (
    candidate.priority !== null
    && evidence.rankNodeId !== null
    && candidate.priority.reasonCodes.indexOf('REPEATEDLY_DELAYED') !== -1
  ) {
    reasons.push({
      code: 'REPEATEDLY_DELAYED',
      nodeIds: [evidence.rankNodeId],
      detail: `candidate #${index} carries a delay signal from the priority policy it was scored under`,
    });
  }

  if (action.kind === 'schedule' && evidence.slotImminentNodeId !== null) {
    reasons.push({
      code: 'PLAN_SLOT_IMMINENT',
      nodeIds: [evidence.slotImminentNodeId],
      detail: `candidate #${index} has a planned slot beginning inside the next ${config.planSlotImminentMinutes} minutes`,
    });
  }

  if (candidate.dependentIndices.length > 0) {
    const nodeIds: EvidenceNodeId[] = [];
    for (let edge = 0; edge < candidate.dependentIndices.length; edge += 1) {
      const dependent = candidates[candidate.dependentIndices[edge]];
      if (dependent.evidence.blockedNodeId !== null) nodeIds.push(dependent.evidence.blockedNodeId);
    }
    if (nodeIds.length > 0) {
      reasons.push({
        code: 'UNBLOCKS_DEPENDENTS',
        nodeIds,
        detail: `candidate #${index} is the open prerequisite of ${nodeIds.length} other candidate(s) in this request`,
      });
    }
  }

  if (
    action.kind === 'schedule'
    && evidence.effortNodeId !== null
    && evidence.effortMinutes !== null
    && evidence.effortMinutes <= config.quickWinMaxMinutes
  ) {
    reasons.push({
      code: 'QUICK_WIN',
      nodeIds: [evidence.effortNodeId],
      detail: `candidate #${index} is planned into a ${evidence.effortMinutes}-minute slot, at or under the ${config.quickWinMaxMinutes}-minute threshold`,
    });
  }

  if (onlyEligibleCandidate) {
    reasons.push({
      code: 'ONLY_ELIGIBLE_ACTION',
      nodeIds: [scopeCommitmentsNodeId],
      detail: `candidate #${index} is the only one in this scope that no hard constraint excluded`,
    });
  }

  return reasons;
}

function toSupportReason(draft: DraftReason): SupportReason {
  return {
    code: draft.code,
    supportedBy: draft.nodeIds as [EvidenceNodeId, ...EvidenceNodeId[]],
    detail: draft.detail,
  };
}

/**
 * The evidence a hard exclusion rests on.
 *
 * Every code cites the derivation that decided it rather than the raw
 * observation, where one exists: `ELIGIBLE_FROM_CONFIRMATION` is the claim "this
 * is not confirmed", and `resolveEvidenceRoots` walks it back to the
 * `confirmed_at` observation anyway. Citing the derivation is what makes the
 * reason and the graph tell the same story.
 */
function hardExclusionEvidence(
  candidate: Candidate,
  code: ExclusionReasonCode,
): readonly EvidenceNodeId[] {
  const evidence = candidate.evidence;
  if (code === 'NOT_CONFIRMED') return [evidence.eligibleConfirmationNodeId];
  if (code === 'ALREADY_CLOSED') return [evidence.eligibleStatusNodeId];
  if (code === 'INVALID_SOURCE_TIME') return [evidence.timeNodeId];
  if (code === 'BLOCKED_BY_DEPENDENCY' && evidence.blockedNodeId !== null) {
    return [evidence.blockedNodeId];
  }
  return [evidence.statusNodeId];
}

function hardExclusionDetail(candidate: Candidate, code: ExclusionReasonCode): string {
  const index = candidate.canonicalIndex;
  if (code === 'NOT_CONFIRMED') return `candidate #${index} carries no confirmation instant`;
  if (code === 'ALREADY_CLOSED') return `candidate #${index} sits in one of the three finished statuses`;
  if (code === 'INVALID_SOURCE_TIME') {
    return `candidate #${index} states a time value that does not parse as an instant`;
  }
  if (code === 'BLOCKED_BY_DEPENDENCY') {
    return `candidate #${index} waits on ${candidate.openBlockerIndices.length} prerequisite(s) in this request that are not finished`;
  }
  return `candidate #${index} was removed by a hard constraint`;
}

/* ── Selection ───────────────────────────────────────────────────── */

/**
 * What `selectRecommendation` returns.
 *
 * `defects` is the contract's own check over the recommendation this module just
 * built, and it is always empty — a non-empty list is a bug *here*, reported
 * rather than thrown because `RECOMMENDATION_INPUT_POLICY` does not carve out an
 * exception for a module's opinion of itself.
 *
 * `excludedCount` and `consideredCount` are reported so a caller can tell "we
 * looked at nothing" from "we looked at forty and offered none" without
 * re-deriving either from the graph.
 */
export interface RecommendationSelection {
  readonly recommendation: Recommendation;
  readonly defects: readonly RecommendationDefect[];
  readonly consideredCount: number;
  readonly excludedCount: number;
}

function withheld(
  input: RecommendationSelectorInput,
  config: RecommendationSelectorConfig,
  set: CandidateSet,
  digest: string,
  code: WithholdingReasonCode,
  detail: string,
  supportedBy: readonly [EvidenceNodeId, ...EvidenceNodeId[]],
  excludedCount: number,
): RecommendationSelection {
  const reason: WithholdingReason = { code, supportedBy, detail };
  const recommendation: Recommendation = {
    version: RECOMMENDATION_CONTRACT_VERSION,
    schema: RECOMMENDATION_SELECTOR_SCHEMA,
    recommendationId: input.recommendationId,
    scopeId: input.scopeId,
    validity: {
      basisAt: input.now,
      expiresAt: addMinutes(input.now, config.ttlMinutes),
    },
    evidence: set.evidence,
    inputDigest: digest,
    outcome: 'withheld',
    reasons: [reason],
  };
  return {
    recommendation,
    defects: checkRecommendation(recommendation),
    consideredCount: set.candidates.length,
    excludedCount,
  };
}

/**
 * Select a small set of next actions.
 *
 * The pipeline, in the order the properties in the header require:
 *
 *   1. static pass — `generateCandidates` reads the input, builds the evidence
 *      graph and applies the hard filters;
 *   2. digest — only now, per `digestAfterStaticPass`;
 *   3. the four withholding checks, in the order a reader would ask them;
 *   4. option generation from surviving candidates;
 *   5. risk, then rank, then diversity;
 *   6. assembly, then the contract's own check.
 *
 * Throws only `RecommendationInputError`, and only for the three conditions the
 * taxonomy has no word for — see that class. Everything else is reported.
 */
export function selectRecommendation(
  input: RecommendationSelectorInput,
  config: RecommendationSelectorConfig = DEFAULT_RECOMMENDATION_SELECTOR_CONFIG,
): RecommendationSelection {
  const set = generateCandidates(input, config);
  const digest = selectorInputDigest(input, config);
  const nowMs = epochMsOrNull(input.now) as number;
  const scopeNode = set.scope.commitmentsNodeId;

  if (!config.enabled) {
    return withheld(
      input,
      config,
      set,
      digest,
      'MODULE_DISABLED',
      'the selector was configured off for this run, so no state was judged',
      [scopeNode],
      0,
    );
  }

  const computedAtMs = epochMsOrNull(input.lifeState.computedAt);
  const ageMinutes = computedAtMs === null ? null : (nowMs - computedAtMs) / MS_PER_MINUTE;
  if (ageMinutes === null || ageMinutes < 0 || ageMinutes > config.maxInputAgeMinutes) {
    return withheld(
      input,
      config,
      set,
      digest,
      'INPUT_STALE',
      ageMinutes === null
        ? 'the projection this run would have read does not state a parseable computation instant'
        : `the projection this run read was computed ${Math.round(ageMinutes)} minutes from the evaluation instant, outside the ${config.maxInputAgeMinutes}-minute window`,
      [scopeNode],
      0,
    );
  }

  if (set.candidates.length === 0) {
    return withheld(
      input,
      config,
      set,
      digest,
      'NO_ELIGIBLE_CANDIDATE',
      'this scope offered nothing to consider',
      [scopeNode],
      0,
    );
  }

  /* ── Hard filters ─────────────────────────────────────────────── */

  const survivors: Candidate[] = [];
  const excluded: ExcludedOption[] = [];
  for (let index = 0; index < set.candidates.length; index += 1) {
    const candidate = set.candidates[index];
    if (candidate.hardExclusions.length === 0) {
      survivors.push(candidate);
      continue;
    }
    const reasons: ExclusionReason[] = candidate.hardExclusions.map((code) => ({
      code,
      supportedBy: hardExclusionEvidence(candidate, code) as [EvidenceNodeId, ...EvidenceNodeId[]],
      detail: hardExclusionDetail(candidate, code),
    }));
    excluded.push({
      // The representative action for a candidate that never became an option.
      // `do_now` rather than the strongest action it might have had: it is the
      // action every commitment admits, so the excluded row means "this
      // commitment, at all" rather than "this particular way of touching it".
      action: { kind: 'do_now', commitmentId: candidate.commitmentId },
      exclusion: reasons as [ExclusionReason, ...ExclusionReason[]],
    });
  }

  if (survivors.length === 0) {
    return withheld(
      input,
      config,
      set,
      digest,
      'ALL_CANDIDATES_EXCLUDED',
      `all ${set.candidates.length} candidate(s) in this scope were removed by a hard constraint`,
      [scopeNode],
      excluded.length,
    );
  }

  /* ── Option generation ────────────────────────────────────────── */

  const onlyEligible = survivors.length === 1;
  const drafts = new Map<string, readonly DraftReason[]>();
  const optionCandidates: OptionCandidate[] = [];

  for (let index = 0; index < survivors.length; index += 1) {
    const candidate = survivors[index];
    const hasProposal =
      candidate.snapshot.decompositionProposalId !== null
      && candidate.snapshot.decompositionStepId !== null;
    // `decompose` **replaces** `do_now` rather than sitting beside it.
    //
    // Not a ranking accident — it is the one place action generation makes a
    // judgement, and it has to be made here rather than left to the comparator.
    // A commitment someone has already produced a decomposition proposal for is
    // one the product has judged too big to do in one sitting, so "do this now"
    // and "break this down" are not two options: they are a contradiction and
    // its resolution. Offering both would also be the exact fake choice
    // `maxOptionsPerCommitment` exists to prevent, and the quota would then
    // silently pick between them by action-kind order — which is to say by the
    // order the contract happens to list the kinds in, a decision nobody made.
    const actions: RecommendedAction[] = hasProposal
      ? [
          {
            kind: 'decompose',
            commitmentId: candidate.commitmentId,
            proposalId: candidate.snapshot.decompositionProposalId as string,
          },
        ]
      : [{ kind: 'do_now', commitmentId: candidate.commitmentId }];
    if (candidate.slot !== null) {
      actions.push({ kind: 'schedule', commitmentId: candidate.commitmentId, slot: candidate.slot });
    }
    for (let edge = 0; edge < actions.length; edge += 1) {
      const action = actions[edge];
      const reasons = supportReasonsFor(
        candidate,
        action,
        nowMs,
        onlyEligible,
        scopeNode,
        set.candidates,
        config,
      );
      const codes = reasons.map((reason) => reason.code);
      drafts.set(actionKey(action), reasons);
      optionCandidates.push({
        canonicalIndex: candidate.canonicalIndex,
        commitmentId: candidate.commitmentId,
        action,
        supportCodes: codes,
        confidence: confidenceFor(codes),
        priority: candidate.priority === null ? null : candidate.priority.total,
        earliestDeadlineMs: candidate.effectiveTimeMs,
      });
    }
  }

  /* ── Risk, then rank, then diversity ──────────────────────────── */

  const ranked = rankOptionCandidates(optionCandidates);
  const risk = applyRiskPolicy(ranked);
  const diversity = applyDiversityPolicy(risk.offered);
  const rejections: PolicyRejection[] = risk.rejected.slice().concat(diversity.rejected);

  for (let index = 0; index < rejections.length; index += 1) {
    const rejection = rejections[index];
    const reasons = drafts.get(actionKey(rejection.candidate.action)) || [];
    const nodeIds: EvidenceNodeId[] = [];
    for (let edge = 0; edge < reasons.length; edge += 1) {
      for (let inner = 0; inner < reasons[edge].nodeIds.length; inner += 1) {
        const nodeId = reasons[edge].nodeIds[inner];
        if (nodeIds.indexOf(nodeId) === -1) nodeIds.push(nodeId);
      }
    }
    if (nodeIds.length === 0) {
      // A candidate rejected for having no support has, by definition, no
      // support evidence to cite. It cites what was read and found wanting —
      // which is a claim about trusted state, so decision 1 is satisfied rather
      // than excused.
      const candidate = set.candidates[rejection.candidate.canonicalIndex];
      nodeIds.push(candidate.evidence.eligibleStatusNodeId);
      nodeIds.push(candidate.evidence.timeNodeId);
      nodeIds.push(candidate.evidence.importanceNodeId);
    }
    excluded.push({
      action: rejection.candidate.action,
      exclusion: [
        {
          code: rejection.code,
          supportedBy: nodeIds as [EvidenceNodeId, ...EvidenceNodeId[]],
          detail: rejection.detail,
        },
      ],
    });
  }

  if (!leadClearsRiskFloor(diversity.offered)) {
    return withheld(
      input,
      config,
      set,
      digest,
      'INSUFFICIENT_EVIDENCE',
      diversity.offered.length === 0
        ? `none of the ${survivors.length} eligible candidate(s) carried enough evidence to offer`
        : 'the strongest surviving option did not reach the lead-confidence floor',
      [scopeNode],
      excluded.length,
    );
  }

  /* ── Assembly ─────────────────────────────────────────────────── */

  const options: RecommendationOption[] = diversity.offered.map((candidate, index) => {
    const reasons = drafts.get(actionKey(candidate.action)) as readonly DraftReason[];
    const support = reasons.map(toSupportReason);
    const basis: EvidenceNodeId[] = [];
    for (let edge = 0; edge < support.length; edge += 1) {
      for (let inner = 0; inner < support[edge].supportedBy.length; inner += 1) {
        const nodeId = support[edge].supportedBy[inner];
        if (basis.indexOf(nodeId) === -1) basis.push(nodeId);
      }
    }
    const value = candidate.confidence;
    const confidence: Confidence = {
      value,
      // `bandForConfidence` is the contract's function, not a local
      // reimplementation. `confidenceFor` is bounded to 0..1 by construction, so
      // the null branch is unreachable — and it is written as a throw rather
      // than a fallback to `'low'`, because a band that quietly became `'low'`
      // would be presented to a user as a measured judgement of low confidence.
      band: bandForConfidence(value) || unreachableBand(value),
      basis: basis as [EvidenceNodeId, ...EvidenceNodeId[]],
    };
    return {
      optionIndex: index,
      action: candidate.action,
      support: support as [SupportReason, ...SupportReason[]],
      confidence,
    };
  });

  let optionSet: OptionSet;
  if (options.length >= 2) {
    optionSet = {
      kind: 'choice',
      options: options as [RecommendationOption, RecommendationOption, ...RecommendationOption[]],
      excluded,
    };
  } else if (excluded.length > 0) {
    optionSet = {
      kind: 'sole_survivor',
      option: options[0],
      excluded: excluded as [ExcludedOption, ...ExcludedOption[]],
    };
  } else {
    optionSet = { kind: 'only_candidate', option: options[0], attested: [scopeNode] };
  }

  const recommendation: Recommendation = {
    version: RECOMMENDATION_CONTRACT_VERSION,
    schema: RECOMMENDATION_SELECTOR_SCHEMA,
    recommendationId: input.recommendationId,
    scopeId: input.scopeId,
    validity: { basisAt: input.now, expiresAt: addMinutes(input.now, config.ttlMinutes) },
    evidence: set.evidence,
    inputDigest: digest,
    outcome: 'offered',
    options: optionSet,
  };

  return {
    recommendation,
    defects: checkRecommendation(recommendation),
    consideredCount: set.candidates.length,
    excludedCount: excluded.length,
  };
}

/**
 * Unreachable by construction; see the comment at the call site.
 *
 * A function rather than an inline `throw` so the expression stays an
 * expression, and named so that a stack trace says what happened rather than
 * naming a ternary.
 */
function unreachableBand(value: number): never {
  throw new RangeError(`confidence outside 0..1 reached band assignment: ${String(value)}`);
}

/** Every offered option's action key, in offer order. For tests and callers. */
export function offeredActionKeys(recommendation: Recommendation): readonly string[] {
  if (recommendation.outcome === 'withheld') return [];
  return offeredOptions(recommendation.options).map((option) => actionKey(option.action));
}

export type { Instant };
