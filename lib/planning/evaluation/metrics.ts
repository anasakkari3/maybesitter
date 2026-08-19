/**
 * Plan quality metrics (Sprint 07, issue #31).
 *
 * ── A plan is data here, never a call ───────────────────────────────
 *
 * `computePlanQualityMetrics` takes a `Plan`. It does not build one, and this
 * module imports nothing under `lib/planning/scheduler/`. That is what lets a
 * metric be pinned to an exact number in a test whose fixture is a literal, and
 * what stops "the placement rate" from quietly meaning "whatever the current
 * scheduler does". The same separation Sprint 06 drew between the evaluator and
 * the engine it scores.
 *
 * ── Every empty denominator has a stated answer ─────────────────────
 *
 * Three of these figures divide, and each division has a case with nothing
 * underneath it. The contract fixes all three, and each fixes a wrong answer
 * that a reader would take as a bad result:
 *
 *  - `placementRate` over zero items is **1**. A planner asked to place nothing
 *    placed everything it was asked to. Zero would read as total failure.
 *  - `churnMinutes` with no previous plan is **0**, not null. A metric that is
 *    sometimes absent forces every consumer to branch, and "nothing moved" is
 *    the honest reading of a first run.
 *  - `utilization` over zero available minutes is **0**.
 *
 * This is a deliberate departure from `lib/decomposition/evaluation/metrics.ts`,
 * where a ratio over zero is `null`. There the question is "how good was the
 * decomposer", and no data must not be rendered as a bad score. Here the
 * contract states each figure's total, and a `PlanQualityMetrics` with nullable
 * numbers would push a branch into every caller for cases that have a correct
 * answer. The difference is written down because the two conventions live in
 * one repository and the next reader will otherwise assume one of them is a
 * mistake.
 *
 * ── Churn is movement, not change ───────────────────────────────────
 *
 * `churnMinutes` sums `|Δ startsAt|` over items scheduled in **both** plans,
 * measured on `interval` rather than `reservedInterval`. Items added, removed
 * or still unscheduled contribute nothing. Counting an appearance as a shift of
 * its own length would make a first run of ten items look like maximal churn —
 * the one run in which nothing could possibly have moved — and counting a
 * widened buffer would make every buffer edit read as a rescheduling.
 *
 * ── Nothing is clamped ──────────────────────────────────────────────
 *
 * A utilization above 1 means the plan reserved more time than the constraints
 * offered. That is a planner bug, and clamping it to 1 would render it as a
 * full week.
 *
 * No clock, no randomness: the same plans in produce the same metrics out, and
 * `unscheduledByReason` is built in contract order so two runs serialise
 * identically.
 */
import {
  ATTEMPT_INFEASIBILITY_CODES,
  STATIC_INFEASIBILITY_CODES,
  type Plan,
  type PlanQualityMetrics,
  type PlanningReasonCode,
} from '../../../src/contracts/v1/planningContracts';
import { minutesBetween, intervalMinutes } from '../shared/time';

/**
 * The canonical order reason codes are counted in.
 *
 * Built from the contract's two frozen partitions rather than written out, so a
 * code added there cannot go missing from a report by omission here.
 */
const REASON_CODE_ORDER: readonly PlanningReasonCode[] = Object.freeze(
  (STATIC_INFEASIBILITY_CODES as readonly PlanningReasonCode[])
    .concat(ATTEMPT_INFEASIBILITY_CODES as readonly PlanningReasonCode[]),
);

export interface PlanQualityInput {
  readonly plan: Plan;
  /** The plan this one replaced, if any. Absent and null both mean "first run". */
  readonly previousPlan?: Plan | null;
  /**
   * Working minutes the constraints offered, from `FeasibilityVerdict`.
   *
   * Required rather than derived: a `Plan` does not carry its own capacity, and
   * a utilization computed against a denominator this module guessed would be a
   * number with no stated meaning. The oracle already computes it, from the
   * constraints the plan was produced from.
   */
  readonly availableMinutes: number;
}

function fail(message: string): never {
  throw new Error(`plan metrics: ${message}`);
}

/**
 * The scheduled start of every item, and a refusal if the plan contradicts itself.
 *
 * `Plan` promises that `scheduled` and `unscheduled` "together cover every input
 * item exactly once". A plan that breaks it does not have a slightly wrong
 * quality score — it has no meaningful one, because the denominator counts an
 * item twice. Refusing is the only reading that does not publish the planner's
 * bug as a quality figure.
 */
function scheduledStarts(plan: Plan): ReadonlyMap<string, string> {
  const starts = new Map<string, string>();
  for (const item of plan.scheduled) {
    if (starts.has(item.itemId)) fail(`plan lists item '${item.itemId}' more than once as scheduled`);
    starts.set(item.itemId, item.interval.startsAt);
  }
  const unscheduledIds = new Set<string>();
  for (const item of plan.unscheduled) {
    if (unscheduledIds.has(item.itemId)) fail(`plan lists item '${item.itemId}' more than once as unscheduled`);
    unscheduledIds.add(item.itemId);
    if (starts.has(item.itemId)) fail(`plan lists item '${item.itemId}' as both scheduled and unscheduled`);
  }
  return starts;
}

export function computePlanQualityMetrics(input: PlanQualityInput): PlanQualityMetrics {
  const { plan, availableMinutes } = input;
  const previousPlan = input.previousPlan ?? null;

  if (!Number.isFinite(availableMinutes) || availableMinutes < 0) {
    fail(`availableMinutes must be a non-negative number, received ${JSON.stringify(availableMinutes)}`);
  }

  const starts = scheduledStarts(plan);
  const scheduledCount = plan.scheduled.length;
  const unscheduledCount = plan.unscheduled.length;
  const totalItems = scheduledCount + unscheduledCount;

  const counts = new Map<PlanningReasonCode, number>();
  for (const item of plan.unscheduled) {
    counts.set(item.reason.code, (counts.get(item.reason.code) ?? 0) + 1);
  }
  const unscheduledByReason: Partial<Record<PlanningReasonCode, number>> = {};
  for (const code of REASON_CODE_ORDER) {
    const count = counts.get(code);
    // Absent, not zero. A code that did not occur is not a measurement of zero
    // occurrences, and listing every code at zero buries the ones that happened.
    if (count !== undefined) unscheduledByReason[code] = count;
  }
  // A code outside both partitions would otherwise vanish from the report. It
  // cannot arise from the contract's own union, but a plan is data supplied by a
  // caller, and silently dropping a row from a count is the failure this whole
  // module is trying not to have.
  counts.forEach((count, code) => {
    if (!REASON_CODE_ORDER.includes(code)) unscheduledByReason[code] = count;
  });

  let churnMinutes = 0;
  if (previousPlan !== null) {
    const previousStarts = scheduledStarts(previousPlan);
    // Iterated over the previous plan's scheduled list, in its own order, and
    // summed — the result is order-independent because addition is, and pulling
    // from a map keyed by item id keeps input array order out of it.
    previousStarts.forEach((previousStart, itemId) => {
      const currentStart = starts.get(itemId);
      if (currentStart === undefined) return;
      churnMinutes += Math.abs(minutesBetween(previousStart, currentStart));
    });
  }

  const reservedMinutes = plan.scheduled.reduce(
    (total, item) => total + Math.max(0, intervalMinutes(item.reservedInterval)),
    0,
  );

  return Object.freeze({
    scheduledCount,
    unscheduledCount,
    placementRate: totalItems === 0 ? 1 : scheduledCount / totalItems,
    churnMinutes,
    unscheduledByReason: Object.freeze(unscheduledByReason),
    utilization: availableMinutes === 0 ? 0 : reservedMinutes / availableMinutes,
  });
}
