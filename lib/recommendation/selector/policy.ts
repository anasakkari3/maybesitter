/**
 * The selector's policy: the bound, the order, the confidence formula, and the
 * diversity and risk rules (Sprint 08, issue #34).
 *
 * Everything in this file that is a *number* is exported frozen data, and that
 * is the point of the file existing separately from `select.ts`. The reason is
 * the one `CONFIDENCE_BAND_THRESHOLDS`, `LOAD_BAND_THRESHOLDS` and
 * `PriorityPolicy` all state: a threshold hidden inside a loop cannot be checked
 * by the reviewer that renders its consequence, and "a small set of next
 * actions" is a claim about a bound, so the bound has to be inspectable. #35
 * renders bands this file computes; the merge's cross-track test reads the
 * caps; neither can reach a literal buried in a `slice()`.
 *
 * ── The three policies, and why they are three ───────────────────────────
 *
 *  1. **The cap** is the contract's, not this file's.
 *     `RECOMMENDATION_OPTION_POLICY.maxOptions` lives in
 *     `recommendationContracts.ts` and is *referenced* here rather than
 *     restated. `checkRecommendation` reports `OPTION_CAP_EXCEEDED` against that
 *     same constant, so a second spelling would be a second copy of a number
 *     that two things compare against — the Sprint 06 gap in its smallest form.
 *
 *  2. **Diversity** is about the shape of the offer. Three options that are
 *     three ways of touching one commitment is not a choice, and neither is
 *     three `schedule` actions in a row. `checkRecommendation` already catches
 *     the degenerate case (`DUPLICATE_OPTION_ACTION`, two identical actions),
 *     but two *different* actions on one commitment pass every structural check
 *     while presenting the user with one decision wearing two hats.
 *
 *  3. **Risk** is about whether to offer at all. It is separate from diversity
 *     because it can empty the offer, and an emptied offer is a withheld
 *     recommendation with a stated reason rather than a shorter list. The
 *     acceptance criterion "the selector returns no recommendation when
 *     evidence is insufficient" is this policy, and it is applied *before*
 *     diversity so that a weak option can never survive by being the only one
 *     left in its action kind.
 *
 * ── Relationship to the shipped V03 pilot ────────────────────────────────
 *
 * `nextStepBaseline.ts` decides evidence sufficiency as
 * `eligible && evidenceLabels.length > 0`. `RECOMMENDATION_RISK_POLICY`'s
 * `minSupportReasons: 1` is **the same rule**: one support reason here
 * corresponds to one evidence label there, and the label set (`overdue`,
 * `due within 24 hours`, `due within 7 days`, `importance: …`, `effort: …`) is
 * built from the same commitment fields. `minOfferConfidence` and
 * `minLeadConfidence` are **deliberately stricter** — the pilot has no
 * confidence concept at all, so it will offer a step supported only by
 * `importance: low`, and this module will not.
 *
 * The strictness runs in one direction on purpose. Everything the pilot excludes,
 * this module excludes; the reverse does not hold, and where it does not hold the
 * comment says so. A cross-track comparison that found this module *offering*
 * something the pilot excluded would be a real defect; finding it withholding
 * where the pilot offers is this policy working.
 */

import {
  CONFIDENCE_BAND_THRESHOLDS,
  DEFAULT_RECOMMENDATION_TTL_MINUTES,
  RECOMMENDATION_OPTION_POLICY,
  RECOMMENDATION_ORDERING_KEYS,
  RECOMMENDED_ACTION_KINDS,
  actionKey,
  type ExclusionReasonCode,
  type RecommendedAction,
  type SupportReasonCode,
} from '../../../src/contracts/v1/recommendationContracts';
import { compareByCodePoint } from '../../planning/shared/compare';

/* ── Configuration ───────────────────────────────────────────────── */

/**
 * The knobs that change the offer.
 *
 * Part of the determinism contract in the same way `PlanningConfig` is: "same
 * inputs produce the same output" means this record is an input, and a
 * recommendation is only reproducible when replayed alongside the config that
 * produced it. It is therefore folded into `inputDigest`.
 */
export interface RecommendationSelectorConfig {
  /**
   * When false the module offers nothing and says `MODULE_DISABLED`.
   *
   * A kill switch that produces a *stated* withholding rather than an empty
   * result, because "we are turned off" and "we looked and found nothing" are
   * different messages and a caller that could not tell them apart would cache
   * the first as the second.
   */
  readonly enabled: boolean;
  /** Hours ahead within which a deadline reads as `due_today`. */
  readonly dueTodayHours: number;
  /** Hours ahead within which a deadline reads as `due_this_week`. */
  readonly dueSoonHours: number;
  /** Minutes ahead within which a planned slot reads as imminent. */
  readonly planSlotImminentMinutes: number;
  /** A planned slot at or under this length is a `QUICK_WIN`. */
  readonly quickWinMaxMinutes: number;
  /** `expiresAt` is this many minutes after the supplied `now`. */
  readonly ttlMinutes: number;
  /**
   * How stale the supplied `LifeState` may be before the run withholds.
   *
   * `INPUT_STALE` exists so a caller cannot express "I could not recommend" and
   * "the state I read had already moved" with the same code. Judged against the
   * projection's own `computedAt` and the caller's `now`, never a clock.
   */
  readonly maxInputAgeMinutes: number;
}

/**
 * `dueTodayHours: 24` and `dueSoonHours: 168` are **the same thresholds as the
 * pilot's** urgency bands (`<= DAY_MS` and `<= 7 * DAY_MS`), so `due_today` and
 * `due_this_week` mean what `due within 24 hours` and `due within 7 days` mean
 * on the shipped surface. They are stated in hours rather than milliseconds
 * because the contract's `EvidenceUnit` has `hours` and does not have
 * milliseconds, and a unit that only exists in one of two places is where a
 * factor of 1000 hides.
 */
export const DEFAULT_RECOMMENDATION_SELECTOR_CONFIG: RecommendationSelectorConfig = Object.freeze({
  enabled: true,
  dueTodayHours: 24,
  dueSoonHours: 168,
  planSlotImminentMinutes: 120,
  quickWinMaxMinutes: 15,
  ttlMinutes: DEFAULT_RECOMMENDATION_TTL_MINUTES,
  maxInputAgeMinutes: 1440,
});

/* ── Confidence ──────────────────────────────────────────────────── */

/**
 * What each support reason is worth, and the weight at which confidence
 * saturates.
 *
 * A weighted count over a fixed saturation, rather than a tuned function of the
 * priority score, and the choice is deliberate. Priority's total is already a
 * number with its own policy version and its own explanation; re-deriving
 * confidence from it would make this module a second reader of that score with
 * no way to notice when the two readings diverged — Sprint 06's four-review-round
 * shape. Counting the *reasons this module itself emitted* means the number and
 * the explanation beside it cannot disagree: they are the same list.
 *
 * `ONLY_ELIGIBLE_ACTION` is weighted **zero**, and that is the interesting
 * entry. Being the only thing left is a reason to *offer* something; it is not
 * evidence that doing it is right. Weighting it above zero would make a scope
 * with one thin candidate look more certain than the same candidate in a busy
 * scope, which is exactly backwards. The consequence is load-bearing and tested:
 * a candidate supported *only* by `ONLY_ELIGIBLE_ACTION` scores 0, falls under
 * `minOfferConfidence`, and the run withholds.
 *
 * The arithmetic is bounded by construction — a sum of non-negative constants
 * over a positive saturation, taken at most 1 — so `confidenceFor` cannot
 * produce a value outside 0..1 and never needs the kind of repair
 * `bandForConfidence` returns null for.
 */
export const RECOMMENDATION_CONFIDENCE_WEIGHTS: Readonly<Record<SupportReasonCode, number>> =
  Object.freeze({
    OVERDUE: 3,
    DUE_SOON: 2,
    HIGH_IMPORTANCE: 1.5,
    REPEATEDLY_DELAYED: 1,
    PLAN_SLOT_IMMINENT: 2,
    UNBLOCKS_DEPENDENTS: 1.5,
    QUICK_WIN: 0.5,
    ONLY_ELIGIBLE_ACTION: 0,
  });

/**
 * The weight at which confidence reaches 1.
 *
 * Five, which two strong independent signals reach (`OVERDUE` + `HIGH_IMPORTANCE`
 * is 4.5 and bands `high`) and one alone does not (`OVERDUE` alone is 0.6 and
 * bands `medium`). Stated as data because #35 renders the band and the merge's
 * cross-track test reads the value, so the mapping between them has to be
 * checkable from outside this module.
 */
export const RECOMMENDATION_CONFIDENCE_SATURATION = 5;

/**
 * Confidence from the support reasons that were actually emitted.
 *
 * Duplicates in `codes` contribute once: the argument is a set of reasons, and
 * a caller that passed the same code twice would otherwise buy confidence by
 * repeating itself.
 */
export function confidenceFor(codes: readonly SupportReasonCode[]): number {
  const counted = new Set<SupportReasonCode>();
  let weight = 0;
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (counted.has(code)) continue;
    counted.add(code);
    weight += RECOMMENDATION_CONFIDENCE_WEIGHTS[code];
  }
  const value = weight / RECOMMENDATION_CONFIDENCE_SATURATION;
  return value > 1 ? 1 : value;
}

/* ── The bound, diversity, and risk ──────────────────────────────── */

/**
 * How many options an offer may carry, and how varied they must be.
 *
 * `maxOptions` is read from the contract rather than restated. The other two are
 * this module's, and each forbids a shape that passes every structural check in
 * `checkRecommendation`:
 *
 *   - `maxOptionsPerCommitment: 1` — "do this now" and "schedule this for 14:00"
 *     are two rows about one decision. `DUPLICATE_OPTION_ACTION` does not catch
 *     it, because the two actions genuinely differ.
 *   - `maxOptionsPerActionKind: 2` — three `schedule` actions is a calendar, not
 *     a choice. Two is the bound rather than one because a real choice between
 *     two times is a choice, and forcing every offer to mix verbs would make the
 *     module drop a better option to satisfy a shape rule.
 */
export const RECOMMENDATION_DIVERSITY_POLICY = Object.freeze({
  maxOptions: RECOMMENDATION_OPTION_POLICY.maxOptions,
  minOptionsForChoice: RECOMMENDATION_OPTION_POLICY.minOptionsForChoice,
  maxOptionsPerCommitment: 1,
  maxOptionsPerActionKind: 2,
});

/**
 * When an option is too weakly supported to offer, and when the whole run is.
 *
 * `minLeadConfidence` is `CONFIDENCE_BAND_THRESHOLDS.medium` — referenced, not
 * copied, so the sentence "the lead option is at least `medium`" stays true if
 * the bands ever move. It is the acceptance criterion "returns no recommendation
 * when evidence is insufficient" expressed as a number: below it, the module
 * withholds with `INSUFFICIENT_EVIDENCE` rather than offering its best guess.
 *
 * `minOfferConfidence` is lower than `minLeadConfidence` on purpose. An
 * alternative does not have to be as strong as the lead to be worth showing —
 * the user is choosing, not being told — but it does have to clear the floor of
 * a single weak signal. At 0.2 a lone `QUICK_WIN` (0.1) does not clear it and a
 * lone `DUE_SOON` (0.4) does.
 */
export const RECOMMENDATION_RISK_POLICY = Object.freeze({
  minSupportReasons: 1,
  minOfferConfidence: 0.2,
  minLeadConfidence: CONFIDENCE_BAND_THRESHOLDS.medium,
});

/* ── Ordering ────────────────────────────────────────────────────── */

/**
 * One option candidate, reduced to what the order and the policies read.
 *
 * `priority` is null when no priority score was supplied — which is not the same
 * as zero, and the comparator below treats it as "no signal" rather than as a
 * low score. Unknown is not zero is Sprint 04's rule and Sprint 07's rule and it
 * is this one too.
 */
export interface OptionCandidate {
  readonly canonicalIndex: number;
  readonly commitmentId: string;
  readonly action: RecommendedAction;
  readonly supportCodes: readonly SupportReasonCode[];
  readonly confidence: number;
  readonly priority: number | null;
  /** Epoch millis of the effective deadline, or null when there is none. */
  readonly earliestDeadlineMs: number | null;
}

const ACTION_KIND_RANK: Readonly<Record<RecommendedAction['kind'], number>> = Object.freeze(
  RECOMMENDED_ACTION_KINDS.reduce(
    (ranks, kind, index) => Object.assign(ranks, { [kind]: index }),
    {} as Record<RecommendedAction['kind'], number>,
  ),
);

/** Descending, with "no signal" last. A missing priority is not a low priority. */
function compareDescendingNullable(left: number | null, right: number | null): number {
  const leftUsable = left !== null && Number.isFinite(left);
  const rightUsable = right !== null && Number.isFinite(right);
  if (!leftUsable && !rightUsable) return 0;
  if (!leftUsable) return 1;
  if (!rightUsable) return -1;
  return (right as number) - (left as number);
}

/** Ascending, with null last. A missing deadline is not an early deadline. */
function compareAscendingNullable(left: number | null, right: number | null): number {
  const leftUsable = left !== null && Number.isFinite(left);
  const rightUsable = right !== null && Number.isFinite(right);
  if (!leftUsable && !rightUsable) return 0;
  if (!leftUsable) return 1;
  if (!rightUsable) return -1;
  return (left as number) - (right as number);
}

/**
 * The contract's total order, walked as data.
 *
 * `RECOMMENDATION_ORDERING_KEYS` is iterated rather than the four comparisons
 * being written out in the order they happen to appear there — the reason
 * `comparePlanOrder` does the same in `lib/planning/scheduler`. A selector that
 * inlined the order would keep working after the contract changed and would then
 * disagree with #35 and with the cross-track test about what "stable" means,
 * which is a disagreement no test in this module can see.
 *
 * **Two keys are appended after the contract's four**, and they must be, because
 * the contract's keys are stated over *commitments* and this module ranks
 * *actions*. `do_now` and `schedule` on one commitment tie on all four — same
 * confidence is possible, same priority, same deadline, same id — and a
 * comparator that returned 0 there would hand the outcome to `Array.prototype.sort`'s
 * stability, which is to say to the caller's input order. The appended keys are
 * the action's kind (in the contract's own `RECOMMENDED_ACTION_KINDS` order) and
 * then its `actionKey`, which is unique among candidates. The order is therefore
 * total, and `tests/recommendation/selectorDeterminism.test.ts` pins that
 * reversing the input changes nothing.
 */
export function compareOptionCandidates(left: OptionCandidate, right: OptionCandidate): number {
  for (let index = 0; index < RECOMMENDATION_ORDERING_KEYS.length; index += 1) {
    const key = RECOMMENDATION_ORDERING_KEYS[index];
    let delta = 0;
    if (key === '-confidence') {
      delta = compareDescendingNullable(left.confidence, right.confidence);
    } else if (key === '-priority') {
      delta = compareDescendingNullable(left.priority, right.priority);
    } else if (key === 'earliestDeadline') {
      delta = compareAscendingNullable(left.earliestDeadlineMs, right.earliestDeadlineMs);
    } else {
      delta = compareByCodePoint(left.commitmentId, right.commitmentId);
    }
    if (delta !== 0) return delta;
  }
  const kindDelta = ACTION_KIND_RANK[left.action.kind] - ACTION_KIND_RANK[right.action.kind];
  if (kindDelta !== 0) return kindDelta;
  return compareByCodePoint(actionKey(left.action), actionKey(right.action));
}

/** Candidates in the contract's order. Never sorts its argument in place. */
export function rankOptionCandidates(
  candidates: readonly OptionCandidate[],
): readonly OptionCandidate[] {
  return candidates.slice().sort(compareOptionCandidates);
}

/* ── Applying the policies ───────────────────────────────────────── */

/** An option candidate the policy removed, and the code it removed it under. */
export interface PolicyRejection {
  readonly candidate: OptionCandidate;
  readonly code: ExclusionReasonCode;
  readonly detail: string;
}

export interface PolicyOutcome {
  readonly offered: readonly OptionCandidate[];
  readonly rejected: readonly PolicyRejection[];
}

/**
 * The risk gate. Runs first, and can empty the offer.
 *
 * Both rules report `INSUFFICIENT_EVIDENCE` rather than inventing a code: the
 * taxonomy has one for "this candidate is unsupported" and using `LOWER_RANKED`
 * for it would tell a user their option lost a comparison it never entered.
 *
 * Order within the result is the ranked order of the input, so the caller does
 * not have to re-sort and cannot re-sort differently.
 */
export function applyRiskPolicy(ranked: readonly OptionCandidate[]): PolicyOutcome {
  const offered: OptionCandidate[] = [];
  const rejected: PolicyRejection[] = [];
  for (let index = 0; index < ranked.length; index += 1) {
    const candidate = ranked[index];
    if (candidate.supportCodes.length < RECOMMENDATION_RISK_POLICY.minSupportReasons) {
      rejected.push({
        candidate,
        code: 'INSUFFICIENT_EVIDENCE',
        detail: `candidate #${candidate.canonicalIndex} carries no supporting reason, against a floor of ${RECOMMENDATION_RISK_POLICY.minSupportReasons}`,
      });
      continue;
    }
    if (candidate.confidence < RECOMMENDATION_RISK_POLICY.minOfferConfidence) {
      rejected.push({
        candidate,
        code: 'INSUFFICIENT_EVIDENCE',
        detail: `candidate #${candidate.canonicalIndex} reaches ${candidate.confidence.toFixed(3)} confidence, under the offer floor of ${RECOMMENDATION_RISK_POLICY.minOfferConfidence}`,
      });
      continue;
    }
    offered.push(candidate);
  }
  return { offered, rejected };
}

/**
 * The diversity gate and the cap. Runs on what the risk gate left.
 *
 * The two quotas are applied before the cap so that the cap trims a list that is
 * already varied — trimming first would let three options about one commitment
 * fill the offer and then be reduced to one, discarding the second-best
 * commitment entirely and reporting it as `OPTION_CAP_REACHED`, which is not
 * what happened to it.
 *
 * `LOWER_RANKED` for a quota and `OPTION_CAP_REACHED` for the cap, deliberately
 * distinct: "something about the same commitment scored higher" and "the offer
 * was already full" are different things to tell a user, and the taxonomy has a
 * code for each precisely so an implementation does not have to pick one.
 */
export function applyDiversityPolicy(ranked: readonly OptionCandidate[]): PolicyOutcome {
  const offered: OptionCandidate[] = [];
  const rejected: PolicyRejection[] = [];
  const perCommitment = new Map<string, number>();
  const perKind = new Map<string, number>();

  for (let index = 0; index < ranked.length; index += 1) {
    const candidate = ranked[index];
    const commitmentCount = perCommitment.get(candidate.commitmentId) || 0;
    if (commitmentCount >= RECOMMENDATION_DIVERSITY_POLICY.maxOptionsPerCommitment) {
      rejected.push({
        candidate,
        code: 'LOWER_RANKED',
        detail: `candidate #${candidate.canonicalIndex} is a further action on a commitment already represented, against a quota of ${RECOMMENDATION_DIVERSITY_POLICY.maxOptionsPerCommitment}`,
      });
      continue;
    }
    const kindCount = perKind.get(candidate.action.kind) || 0;
    if (kindCount >= RECOMMENDATION_DIVERSITY_POLICY.maxOptionsPerActionKind) {
      rejected.push({
        candidate,
        code: 'LOWER_RANKED',
        detail: `candidate #${candidate.canonicalIndex} repeats an action kind already offered ${RECOMMENDATION_DIVERSITY_POLICY.maxOptionsPerActionKind} times`,
      });
      continue;
    }
    if (offered.length >= RECOMMENDATION_DIVERSITY_POLICY.maxOptions) {
      rejected.push({
        candidate,
        code: 'OPTION_CAP_REACHED',
        detail: `candidate #${candidate.canonicalIndex} fell outside the cap of ${RECOMMENDATION_DIVERSITY_POLICY.maxOptions} offered options`,
      });
      continue;
    }
    perCommitment.set(candidate.commitmentId, commitmentCount + 1);
    perKind.set(candidate.action.kind, kindCount + 1);
    offered.push(candidate);
  }
  return { offered, rejected };
}

/**
 * Does the strongest surviving option clear the lead floor?
 *
 * Asked about the *lead* rather than about the average, because the lead is what
 * the product presents as "do this next" and the alternatives are context for
 * it. An offer whose lead is weak is not improved by having two more weak
 * options beside it.
 */
export function leadClearsRiskFloor(offered: readonly OptionCandidate[]): boolean {
  return offered.length > 0 && offered[0].confidence >= RECOMMENDATION_RISK_POLICY.minLeadConfidence;
}
