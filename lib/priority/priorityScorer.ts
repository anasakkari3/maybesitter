/**
 * Explainable priority scoring and ranking (Sprint 04, #18).
 *
 * Four decisions carry this module, and each of them is the difference between
 * an explanation that is true and one that merely looks true.
 *
 *  1. **The breakdown is the computation.** `total` is produced by summing the
 *     components that were emitted — there is no second expression anywhere in
 *     this file that computes a score. An explanation assembled alongside a
 *     total it did not produce can drift from that total silently; one that
 *     *is* the total cannot. The invariant
 *     `sum(components[].points) === total` therefore holds by construction,
 *     and is asserted on every score the tests build.
 *
 *  2. **The clamps are components, not hidden `Math.min` calls.** The band
 *     components reach 1350 points against a cap of 999, and the cap binds
 *     precisely on the most overdue, highest-priority, most-repeatedly-delayed
 *     items — exactly the ones where a user most needs the explanation to hold.
 *     A breakdown that listed only the four contributions would over-report by
 *     up to 351 points on those items. `band_clamp` and `total_clamp` are
 *     signed: negative when they bind, zero when they do not. They are emitted
 *     either way, because "the cap did not apply" is itself a fact about the
 *     score.
 *
 *  3. **Unknown is not zero.** A feature that is unknown contributes no
 *     component at all, rather than a zero-point one, so the breakdown never
 *     implies we measured something we did not. A feature that is *known* and
 *     worth nothing does emit a zero-point component, because "measured, and it
 *     added nothing" is a different statement from "not measured". `dependency`
 *     and `effort` have no source state on `Commitment` and are always unknown,
 *     so they never appear.
 *
 *  4. **Hard constraints are a distinct pass, not a large weight.** See
 *     `applyHardConstraints` below.
 *
 * Scoring consumes `PriorityFeatures` and never `DomainState`: extraction (#17)
 * owns the reading of state, this module owns the arithmetic. Nothing here
 * reads the system clock — every time-derived quantity arrives already measured
 * in the feature vector — so scoring the same vector twice is the same score,
 * and ranking the same set twice is the same order.
 */
import { compareStrings } from '../lifeState/fields';
import type {
  ImportanceFeature,
  LatenessFeature,
  PriorityFeature,
  PriorityPolicy,
  PriorityReason,
  PriorityScore,
  RankPrioritiesInput,
  ReasonCode,
  ScoreComponent,
  ScoreComponentCode,
  ScorePriorityInput,
  UrgencyFeature,
  UserPressureFeature,
} from '../../src/contracts/v1/priorityContracts';
import { PRIORITY_SCHEMA_VERSION } from '../../src/contracts/v1/priorityContracts';

/**
 * The components that make up the band score, and therefore the ones the band
 * cap applies to. `reason_base` is deliberately absent: the cap bounds how far
 * a commitment can travel *within* its band, not the band itself.
 */
const BAND_COMPONENT_CODES: readonly ScoreComponentCode[] = ['urgency', 'importance', 'lateness', 'user_pressure'];

/**
 * Emission order for reason codes. Fixed rather than derived from the order the
 * checks happen to run in, so two identical scores serialize identically and a
 * reader scans them from the situational facts down to the structural ones.
 */
const REASON_CODE_ORDER: readonly ReasonCode[] = [
  'OVERDUE',
  'DUE_SOON',
  'HIGH_IMPORTANCE',
  'REPEATEDLY_DELAYED',
  'RECENTLY_IGNORED',
  'BAND_CAPPED',
  'HARD_CONSTRAINT_APPLIED',
];

/**
 * Mirrors `agendaScoring`'s clamp, including its treatment of a non-finite
 * value as `min`. A NaN reaching the arithmetic must land on a real number
 * rather than propagating into the total, because a NaN total would break the
 * reconciliation invariant everywhere downstream instead of here.
 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function sumPoints(components: readonly ScoreComponent[]): number {
  return components.reduce((total, component) => total + component.points, 0);
}

/**
 * The evidence sources a feature was derived from, flattened onto the component
 * it produced, so a reader of the breakdown can get from a number back to the
 * state it came from without holding the feature vector too. Null when the
 * feature carried no evidence entries, and null for structural terms, which are
 * not derived from state at all.
 */
function evidenceOf<T>(feature: PriorityFeature<T>): string | null {
  if (!feature.known) return null;
  const sources = feature.value.evidence.map((entry) => entry.source);
  return sources.length === 0 ? null : sources.join(', ');
}

/**
 * Time only scores in the bands that are about time. `active` and `pending`
 * commitments score zero here even when their urgency feature is known, which
 * reproduces `agendaScoring.reasonTimeScore` exactly — and the component is
 * still emitted, because the feature *was* measured and simply did not count
 * in this band.
 */
function urgencyPoints(reason: PriorityReason, urgency: UrgencyFeature, policy: PriorityPolicy): number {
  const { weights } = policy;
  if (reason === 'overdue') {
    return clamp(Math.round(urgency.hoursOverdue * weights.urgencyOverduePerHour), 0, weights.urgencyOverdueMax);
  }
  if (reason === 'due_soon') {
    return clamp(Math.round(urgency.dueSoonCloseness * weights.urgencyDueSoonMax), 0, weights.urgencyDueSoonMax);
  }
  return 0;
}

/**
 * `userSet` is not scored. Whether the user set the level themselves is a
 * question of authority, not of magnitude, and it is handled by the hard
 * constraint pass rather than by inflating a weight.
 */
function importancePoints(importance: ImportanceFeature, policy: PriorityPolicy): number {
  if (importance.level === 'high') return policy.weights.importanceHigh;
  if (importance.level === 'normal') return policy.weights.importanceNormal;
  return 0;
}

function latenessPoints(lateness: LatenessFeature, policy: PriorityPolicy): number {
  const { weights } = policy;
  const snoozes = clamp(lateness.snoozedCount * weights.latenessPerSnooze, 0, weights.latenessSnoozeMax);
  return (
    snoozes +
    (lateness.postponed ? weights.latenessPostponed : 0) +
    (lateness.deferred ? weights.latenessDeferred : 0)
  );
}

/**
 * A single recency step rather than a decay curve, matching the live scorer: an
 * ignore inside the recency window is worth twice a stale one, and no ignore at
 * all is worth nothing. `ignoredCount` gates the term — a count of zero means
 * "we looked and found no ignore", which is a measurement worth zero, not an
 * absent feature.
 */
function userPressurePoints(pressure: UserPressureFeature, policy: PriorityPolicy): number {
  if (pressure.ignoredCount <= 0) return 0;
  return pressure.ignoredRecently ? policy.weights.userPressureRecent : policy.weights.userPressureStale;
}

/**
 * The soft score: every component the feature vector supports, plus the two
 * clamp terms, with the total taken as their sum.
 */
function scoreSoftly(input: ScorePriorityInput): { components: ScoreComponent[]; total: number } {
  const { features, reason, policy } = input;
  const components: ScoreComponent[] = [];

  components.push({ code: 'reason_base', points: policy.reasonBase[reason], evidence: null });

  if (features.urgency.known) {
    components.push({
      code: 'urgency',
      points: urgencyPoints(reason, features.urgency.value.value, policy),
      evidence: evidenceOf(features.urgency),
    });
  }
  if (features.importance.known) {
    components.push({
      code: 'importance',
      points: importancePoints(features.importance.value.value, policy),
      evidence: evidenceOf(features.importance),
    });
  }
  if (features.lateness.known) {
    components.push({
      code: 'lateness',
      points: latenessPoints(features.lateness.value.value, policy),
      evidence: evidenceOf(features.lateness),
    });
  }
  if (features.userPressure.known) {
    components.push({
      code: 'user_pressure',
      points: userPressurePoints(features.userPressure.value.value, policy),
      evidence: evidenceOf(features.userPressure),
    });
  }

  // The clamp is measured against the components that were actually emitted,
  // which is what keeps it honest when a feature is unknown: an unmeasured
  // feature cannot push the band into the cap.
  const rawBand = sumPoints(components.filter((component) => BAND_COMPONENT_CODES.includes(component.code)));
  components.push({ code: 'band_clamp', points: clamp(rawBand, 0, policy.bandCap) - rawBand, evidence: null });

  const beforeTotalCap = sumPoints(components);
  components.push({
    code: 'total_clamp',
    points: clamp(beforeTotalCap, 0, policy.totalCap) - beforeTotalCap,
    evidence: null,
  });

  return { components, total: sumPoints(components) };
}

/**
 * Reason codes derived from the components that were emitted, never from the
 * inputs independently. Deriving them from the features instead would let a
 * code and the number it is supposed to describe disagree — `BAND_CAPPED`
 * without a `band_clamp`, or a `REPEATEDLY_DELAYED` on a score with no lateness
 * points. Each code below is a statement about a component that is present.
 */
function deriveReasonCodes(
  input: ScorePriorityInput,
  components: readonly ScoreComponent[],
): Set<ReasonCode> {
  const codes = new Set<ReasonCode>();
  const pointsFor = (code: ScoreComponentCode): number | null => {
    const component = components.find((candidate) => candidate.code === code);
    return component === undefined ? null : component.points;
  };

  if (input.reason === 'overdue') codes.add('OVERDUE');
  if (input.reason === 'due_soon') codes.add('DUE_SOON');

  const importance = input.features.importance;
  if (importance.known && importance.value.value.level === 'high') codes.add('HIGH_IMPORTANCE');

  const lateness = pointsFor('lateness');
  if (lateness !== null && lateness > 0) codes.add('REPEATEDLY_DELAYED');

  const pressure = input.features.userPressure;
  if (pressure.known && pressure.value.value.ignoredCount > 0 && pressure.value.value.ignoredRecently) {
    codes.add('RECENTLY_IGNORED');
  }

  if ((pointsFor('band_clamp') ?? 0) !== 0) codes.add('BAND_CAPPED');

  return codes;
}

/**
 * The v1 hard constraint: a commitment whose importance the **user set
 * themselves** to `high` is pinned above commitments that were only ranked
 * high by inference.
 *
 * Deliberately one constraint, and deliberately a narrow one. It fires only on
 * explicit user action (`ImportanceFeature.userSet`, which maps to
 * `Commitment.priority.source === 'user_explicit'`) combined with the top
 * level, so nothing the system inferred on the user's behalf can trigger it.
 *
 * Two properties make this an override rather than a weight:
 *
 *  - **It adds no points.** A pinned commitment scores exactly what an
 *    identical unpinned one scores. Implementing the override as a weight large
 *    enough to always dominate would satisfy the ordering while making the
 *    explanation useless — the total would no longer measure anything, and the
 *    breakdown would attribute the item's position to a number rather than to
 *    the user's instruction.
 *  - **It is recorded, not hidden.** `HARD_CONSTRAINT_APPLIED` is on the score,
 *    so ranking can honour it (see `rankPriorities`) and a reader can see that
 *    the position came from an override rather than from the arithmetic.
 *
 * What was considered and rejected for v1: *deadline feasibility* and *an
 * active postponement window* are the other natural hard constraints, but
 * neither is derivable from the committed feature contract — `LatenessFeature`
 * records that a commitment was postponed, not until when, and no effort or
 * duration feature exists at all (`effort` is permanently unknown in v1).
 * Inventing them would mean inventing the state they need.
 */
function hasHardConstraint(input: ScorePriorityInput): boolean {
  const importance = input.features.importance;
  return importance.known && importance.value.value.level === 'high' && importance.value.value.userSet;
}

/**
 * The override pass, run after scoring rather than inside it, so that the score
 * and the constraint stay separable: the total keeps meaning "what the soft
 * signals are worth", and the constraint is an annotation on top of it.
 */
function applyHardConstraints(input: ScorePriorityInput, codes: Set<ReasonCode>): Set<ReasonCode> {
  if (hasHardConstraint(input)) codes.add('HARD_CONSTRAINT_APPLIED');
  return codes;
}

export function scorePriority(input: ScorePriorityInput): PriorityScore {
  const { components, total } = scoreSoftly(input);
  const codes = applyHardConstraints(input, deriveReasonCodes(input, components));

  return {
    version: PRIORITY_SCHEMA_VERSION,
    commitmentId: input.features.commitmentId,
    total,
    components,
    reasonCodes: REASON_CODE_ORDER.filter((code) => codes.has(code)),
    policyVersion: input.policy.version,
  };
}

/**
 * Hard-constrained items form their own ordering tier ahead of everything else.
 * A tier, rather than a bonus, is what keeps the override out of the numbers:
 * the constraint decides position, the score keeps describing the signals.
 */
function constraintTier(score: PriorityScore): number {
  return score.reasonCodes.includes('HARD_CONSTRAINT_APPLIED') ? 0 : 1;
}

/**
 * A total order: tier, then total descending, then `commitmentId` by code-unit
 * comparison. The final key matters — `Array#sort` is stable, so a comparator
 * that returned 0 for equal totals would silently order ties by the caller's
 * input order, and the same set of commitments would rank differently depending
 * on how it was assembled. `compareStrings` rather than `localeCompare` for the
 * same class of reason: a locale-dependent order would make the ranking depend
 * on the host.
 */
function comparePriorityScores(left: PriorityScore, right: PriorityScore): number {
  const tier = constraintTier(left) - constraintTier(right);
  if (tier !== 0) return tier;
  if (left.total !== right.total) return right.total - left.total;
  return compareStrings(left.commitmentId, right.commitmentId);
}

/**
 * Ranks a scored set. Copies before sorting: the input is `readonly` in the
 * contract, and a caller that handed us its own array must not find it
 * reordered underneath it.
 */
export function rankPriorities(input: RankPrioritiesInput): readonly PriorityScore[] {
  return [...input.scored].sort(comparePriorityScores);
}
