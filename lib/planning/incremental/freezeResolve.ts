/**
 * Freeze, re-solve, validate, diff — and escalate (#524, slices 2–3).
 *
 * Slice 1 answered *which* blocks a patch may touch. This answers what happens
 * next: the untouchable ones are pinned where they sit, the canonical solver is
 * asked to place only the rest, the two halves are joined back into one
 * complete plan, and that plan is compared with the base through the canonical
 * `PlanDiff`. Slice 3 added steps 7–8: when the first impacted set has no
 * feasible patch, the neighborhood is widened deterministically (see
 * `neighborhoodExpansion.ts`) and re-solved, one ring at a time, and only the
 * exhaustion of that ladder escalates to a full canonical replan.
 *
 * Pure, like everything else under `lib/planning/`: no clock, no randomness, no
 * persistence. Every instant, id and generation number arrives as an argument,
 * which is what makes the frozen invariant assertable rather than hopeful.
 *
 * ── The solver is called, never changed ────────────────────────────
 *
 * Nothing here re-implements placement. The entire mechanism is *input
 * shaping*: a frozen block becomes a blocking `FixedEvent` and its item is
 * withheld from `items`, so `schedulePlan` is not asked where it goes and
 * cannot move it. That is the difference between freezing a block and hoping a
 * solver leaves it alone, and it is why the invariant holds by construction for
 * the solver's half of the work rather than by a post-hoc repair.
 *
 * ── Only flexible blocks are frozen, and that is not an optimisation ──
 *
 * A `fixed` block *already is* a `FixedEvent` in the constraints — `blocks.ts`
 * mints one block per sourced fixed event and never asks the solver to place
 * it. Freezing it again would enter the same interval twice and the request
 * would validate as `FIXED_EVENT_CONFLICT`: the plan would report the user in
 * two places at once, at a position nobody moved. So the freeze covers exactly
 * the frozen blocks the solver would otherwise have been free to move.
 *
 * ── A frozen block is pinned by its *reserved* interval ────────────
 *
 * `PlannedItem` carries both the effort (`interval`) and the effort plus its
 * buffers (`reservedInterval`), and the conflict checks compare the reserved
 * one. Freezing only the effort would leave a frozen item's recovery time open
 * for the solver to fill, which is not what the base plan said — the buffer is
 * protected time, and an incremental patch that quietly reclaimed it would
 * "differ by user content from the canonical source". The identity assertion
 * below is on both.
 *
 * ── Why the merge prefers the solver's answer ──────────────────────
 *
 * The complete plan is assembled by taking the solver's placement for an item
 * when it produced one, and the base plan's placement otherwise. The obvious
 * alternative — copy every frozen placement across unconditionally — would make
 * the byte-identical assertion *vacuously true*: it would be asserting that a
 * value this module had just copied equals itself, and it would pass just as
 * happily if a frozen item had leaked into the solve and been moved. Preferring
 * the solver's answer keeps the assertion live, which is the only reason it is
 * worth running. `tests/planning/incrementalFreezeResolve.test.ts` breaks
 * exactly that leak and watches this fail.
 *
 * ── What this module does not do ───────────────────────────────────
 *
 *  - **The stale-generation guard.** `baseGeneration` and `resultGeneration`
 *    are recorded faithfully, and nothing here checks them against a stored
 *    plan: this module computes a patch, it does not apply one. The guard
 *    lives beside the persistence boundary — `replaceStoredPlanIfBaseMatches`
 *    in `planStore.ts`, driven by `applyIncrementalPlanPatch` in
 *    `lib/services/dailyPlan/incrementalPlanApply.ts` — with the input-digest
 *    check the issue pairs it with.
 */

import {
  INCREMENTAL_PLAN_PATCH_SCHEMA_VERSION,
  type IncrementalPatchMode,
  type IncrementalPlanPatch,
} from '../../../src/contracts/v1/incrementalReplanContracts';
import type {
  FixedEvent,
  Plan,
  PlannedItem,
  PlanningConfig,
  PlanningConstraints,
  PlanningReason,
  UnscheduledItem,
} from '../../../src/contracts/v1/planningContracts';
import type { ScheduleBlock } from '../../../src/contracts/v1/scheduleBlockContracts';
import { schedulePlan } from '../scheduler/scheduler';
import { diffPlans } from '../scheduler/diff';
import { planningInputDigest } from '../scheduler/digest';
import { validateConstraints } from '../constraints/validator';
import { compareByCodePoint } from '../shared/compare';
import { toEpochMs } from '../shared/time';
import type { ImpactClosure } from './impactClosure';
import {
  computeCapacityRing,
  computeConflictSet,
  flexibleItemIdOf,
} from './neighborhoodExpansion';

export class IncrementalReplanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncrementalReplanError';
  }
}

/**
 * Why a patch escalated past `incremental`.
 *
 * Three codes, because three are what the escalation ladder can tell apart.
 * A code no code path emits is a taxonomy that reads as complete and is not,
 * so nothing else is declared: each code below names a state this pipeline
 * genuinely reaches, and the tests name the fixture that reaches it.
 */
export const FALLBACK_REASONS = Object.freeze({
  /**
   * The frozen blocks plus the changed constraints do not form a request the
   * planner can answer at all, and no frozen block is implicated in the
   * contradiction — most often two of the request's *own* events overlapping.
   * When a frozen block is implicated, step 7 unfreezes it instead; this code
   * is what remains when that set is empty.
   */
  frozenConstraintsInvalid: 'FROZEN_CONSTRAINTS_INVALID',
  /**
   * The impacted set could not be placed in the room the frozen blocks left,
   * and the neighborhood had nothing to widen into — no frozen block touches
   * the impacted frontier. Widening was impossible, not merely unsuccessful.
   */
  impactedSetInfeasible: 'IMPACTED_SET_INFEASIBLE',
  /**
   * Step 7 ran: the neighborhood was widened at least once, the widened set
   * still could not be placed, and the ring had finally come back empty.
   * The distinction from `IMPACTED_SET_INFEASIBLE` is the audit trail — "we
   * tried to keep this local and the locality ran out", not "there was never
   * anything local to try".
   */
  expandedSetInfeasible: 'EXPANDED_SET_INFEASIBLE',
} as const);

export type FallbackReason = (typeof FALLBACK_REASONS)[keyof typeof FALLBACK_REASONS];

export interface FreezeResolveInput {
  /** The plan being patched, and the request that produced it. */
  readonly basePlan: Plan;
  /** The blocks of `basePlan`, as `reconcileScheduleBlocks` projected them. */
  readonly baseBlocks: readonly ScheduleBlock[];
  /** Slice 1's partition of `baseBlocks`. */
  readonly closure: ImpactClosure;
  /**
   * The constraints a *full* replan would use: the base request with whatever
   * changed already applied — a new fixed event added, an item's duration or
   * deadline edited, a removed source dropped.
   *
   * The changes arrive already applied rather than as a delta this module
   * re-derives, for the reason slice 1 does not re-derive its causes either:
   * the producer knows what changed, and a second derivation is a second
   * opinion that can disagree.
   */
  readonly nextConstraints: PlanningConstraints;
  readonly config: PlanningConfig;
  readonly baseGeneration: number;
  readonly resultGeneration: number;
  /** The normalized `PlanningStateChange` ids that triggered this. Ids only. */
  readonly causeChangeIds: readonly string[];
}

export interface FreezeResolveResult {
  readonly patch: IncrementalPlanPatch;
  /**
   * The complete plan the patch describes — every item the request holds,
   * whether the solver placed it this run or it was frozen where it was.
   *
   * Returned beside the patch rather than inside it because
   * `IncrementalPlanPatch` carries a diff, not a plan; the caller that applies
   * the patch is the one that needs the plan, and slice 1's contract is
   * deliberately not widened to hold one.
   */
  readonly plan: Plan;
  /**
   * The static findings over the request that was actually solved. Empty on a
   * clean incremental patch.
   */
  readonly validation: readonly PlanningReason[];
}

/** The item id a block stands for, or null for a block with no item behind it. */
const itemIdOf = flexibleItemIdOf;

function sameInterval(
  left: { startsAt: string; endsAt: string },
  right: { startsAt: string; endsAt: string },
): boolean {
  // As instants, not as strings — `09:00:00Z` and `09:00:00.000Z` are one
  // moment, and a plan round-tripped through another serialiser must not read
  // as having moved by zero minutes. `diffPlans` compares the same way.
  return toEpochMs(left.startsAt) === toEpochMs(right.startsAt)
    && toEpochMs(left.endsAt) === toEpochMs(right.endsAt);
}

/**
 * The frozen blocks, as blocking fixed events at their exact current placement.
 *
 * Temporary by construction: they exist in the `PlanningConstraints` handed to
 * this one solve and are never returned to the caller as part of the request,
 * so nothing can persist them as real fixed events. The `frozen:` prefix on the
 * id is what keeps them distinguishable from the request's own events if one
 * ever does reach a reader.
 *
 * A frozen block the base plan never placed contributes nothing: it has no
 * position to hold, and inventing one would pin work at a time no plan ever
 * chose. It stays unscheduled through the merge instead.
 */
export function freezeBlocksAsFixedEvents(
  frozenBlockIds: readonly string[],
  blockById: ReadonlyMap<string, ScheduleBlock>,
  basePlacements: ReadonlyMap<string, PlannedItem>,
): FixedEvent[] {
  const events: FixedEvent[] = [];
  for (const blockId of frozenBlockIds) {
    const block = blockById.get(blockId);
    if (block === undefined) {
      throw new IncrementalReplanError(`frozen block '${blockId}' is not a block of this plan`);
    }
    // A fixed block is already a fixed event in the request — see the header —
    // and is skipped twice over, deliberately. The explicit `null` test states
    // the intent; the placement lookup below independently enforces it,
    // because a fixed event is never in `plan.scheduled` and so has no
    // placement to freeze. Either line alone is sufficient today, which is why
    // removing one leaves the suite green: what the test pins is the property,
    // not which line delivers it.
    const itemId = itemIdOf(block);
    if (itemId === null) continue;
    // Nothing to hold: an unplaced block has no position, and inventing one
    // would pin work at a time no plan ever chose.
    const placed = basePlacements.get(itemId);
    if (placed === undefined) continue;
    events.push({
      eventId: `frozen:${blockId}`,
      // The reserved span, so the buffers a frozen item was given stay its own.
      interval: { startsAt: placed.reservedInterval.startsAt, endsAt: placed.reservedInterval.endsAt },
      sourceCommitmentId: null,
      blocking: true,
    });
  }
  return events;
}

/**
 * The complete plan: what the solver just decided, plus what it was never asked.
 *
 * `scheduled` and `unscheduled` must together cover every item of the request
 * exactly once — the `Plan` contract says so, and an incremental result that
 * quietly dropped the frozen half would satisfy every per-item assertion while
 * describing a day that is missing most of itself.
 *
 * The solver's answer wins wherever it gave one. See the header for why that
 * matters more than it looks: it is what keeps the frozen assertion from
 * asserting a copy against itself.
 */
export function mergeResolvedWithFrozen(
  basePlan: Plan,
  resolved: Plan,
  nextConstraints: PlanningConstraints,
  config: PlanningConfig,
): Plan {
  const resolvedScheduled = new Map(resolved.scheduled.map((entry) => [entry.itemId, entry] as const));
  const resolvedUnscheduled = new Map(resolved.unscheduled.map((entry) => [entry.itemId, entry] as const));
  const baseScheduled = new Map(basePlan.scheduled.map((entry) => [entry.itemId, entry] as const));
  const baseUnscheduled = new Map(basePlan.unscheduled.map((entry) => [entry.itemId, entry] as const));

  const scheduled: PlannedItem[] = [];
  const unscheduled: UnscheduledItem[] = [];
  for (const item of nextConstraints.items) {
    const fromSolver = resolvedScheduled.get(item.itemId);
    if (fromSolver !== undefined) {
      scheduled.push(fromSolver);
      continue;
    }
    const solverRefused = resolvedUnscheduled.get(item.itemId);
    if (solverRefused !== undefined) {
      unscheduled.push(solverRefused);
      continue;
    }
    // Not in this solve at all: a frozen item. It keeps exactly the answer the
    // base plan gave about it, including "not placed, for this reason".
    const held = baseScheduled.get(item.itemId);
    if (held !== undefined) {
      scheduled.push(held);
      continue;
    }
    const refusedBefore = baseUnscheduled.get(item.itemId);
    unscheduled.push(refusedBefore ?? {
      itemId: item.itemId,
      // An item in neither plan is new work nobody solved — which can only
      // happen if the caller added an item and froze it, i.e. left it out of
      // the closure. Reported rather than dropped: `Plan` promises to cover
      // every item, and silence here is an item that vanishes from the day.
      reason: {
        code: 'NO_FEASIBLE_SLOT',
        itemId: item.itemId,
        detail: 'the item was neither re-solved nor present in the base plan',
      },
    });
  }

  // Sorted the way `schedulePlan` sorts its own output, so a merged plan and a
  // regenerated one are comparable structures rather than the same content in
  // two orders.
  scheduled.sort((left, right) => {
    const byStart = toEpochMs(left.interval.startsAt) - toEpochMs(right.interval.startsAt);
    return byStart !== 0 ? byStart : compareByCodePoint(left.itemId, right.itemId);
  });
  unscheduled.sort((left, right) => compareByCodePoint(left.itemId, right.itemId));

  return {
    version: basePlan.version,
    schema: basePlan.schema,
    scopeId: nextConstraints.scopeId,
    horizon: nextConstraints.horizon,
    scheduled,
    unscheduled,
    // The findings the solve itself reported. The frozen half contributed no
    // new ones: nothing was asked about it this run.
    constraintReasons: resolved.constraintReasons,
    // The digest of the *whole* request, not of the narrowed one the solver
    // saw. It is what makes this plan comparable with a full regeneration of
    // the same inputs, which is exactly the comparison `PlanDiff.sameInputDigest`
    // exists to make honest.
    inputDigest: planningInputDigest(nextConstraints, config),
  };
}

/**
 * Which frozen items moved, if any.
 *
 * The issue's invariant, checked against the assembled plan rather than
 * against the mechanism that is supposed to deliver it. It should always be
 * empty: the items are withheld from the solve and their intervals are
 * blocking events. It is checked anyway because "should be empty by
 * construction" is what every invariant says right up until a refactor gives
 * the solver a way back in — and this is the cheapest place to find out.
 */
export function frozenPlacementDrift(
  basePlan: Plan,
  mergedPlan: Plan,
  frozenItemIds: ReadonlySet<string>,
): string[] {
  const before = new Map(basePlan.scheduled.map((entry) => [entry.itemId, entry] as const));
  const after = new Map(mergedPlan.scheduled.map((entry) => [entry.itemId, entry] as const));
  const drifted: string[] = [];
  for (const itemId of Array.from(frozenItemIds).sort(compareByCodePoint)) {
    const was = before.get(itemId);
    const now = after.get(itemId);
    if (was === undefined && now === undefined) continue;
    if (was === undefined || now === undefined) {
      // Placed-to-unplaced or the reverse is a move of the starkest kind.
      drifted.push(itemId);
      continue;
    }
    if (!sameInterval(was.interval, now.interval)
      || !sameInterval(was.reservedInterval, now.reservedInterval)) {
      drifted.push(itemId);
    }
  }
  return drifted;
}

/** The blunt escalation: regenerate the whole day, and say so. */
function fullFallback(
  input: FreezeResolveInput,
  reason: FallbackReason,
  validation: readonly PlanningReason[],
): FreezeResolveResult {
  const plan = schedulePlan(input.nextConstraints, input.config);
  return {
    plan,
    validation,
    patch: buildPatch(input, {
      // Nothing was frozen, so nothing is impacted in the incremental sense —
      // the solver was asked about every block. The contract's own reading.
      impactedBlockIds: input.baseBlocks.map((block) => block.blockId).sort(compareByCodePoint),
      frozenBlockIds: [],
      diff: diffPlans(input.basePlan, plan),
      mode: 'full_fallback',
      fallbackReason: reason,
    }),
  };
}

function buildPatch(
  input: FreezeResolveInput,
  parts: {
    impactedBlockIds: readonly string[];
    frozenBlockIds: readonly string[];
    diff: IncrementalPlanPatch['diff'];
    mode: IncrementalPatchMode;
    fallbackReason: string | null;
  },
): IncrementalPlanPatch {
  return Object.freeze({
    schemaVersion: INCREMENTAL_PLAN_PATCH_SCHEMA_VERSION,
    scopeId: input.nextConstraints.scopeId,
    baseGeneration: input.baseGeneration,
    resultGeneration: input.resultGeneration,
    causeChangeIds: Object.freeze([...input.causeChangeIds]),
    impactedBlockIds: Object.freeze([...parts.impactedBlockIds]),
    frozenBlockIds: Object.freeze([...parts.frozenBlockIds]),
    diff: parts.diff,
    mode: parts.mode,
    fallbackReason: parts.fallbackReason,
  });
}

/**
 * One freeze/re-solve/validate pass over one partition.
 *
 * The outcome is a three-way discrimination, because the escalation ladder
 * treats each shape differently: a solved attempt returns a plan, an invalid
 * request widens by the conflict set (or falls back when it is empty), and a
 * regressed one widens by the capacity ring (or falls back when it is empty).
 */
type SolveAttempt =
  | { readonly kind: 'solved'; readonly plan: Plan; readonly validation: readonly PlanningReason[] }
  | { readonly kind: 'invalid'; readonly validation: readonly PlanningReason[] }
  | { readonly kind: 'regressed'; readonly validation: readonly PlanningReason[] };

/**
 * Steps 3–8, in order: freeze the unaffected, re-solve the impacted, assemble,
 * validate, diff — widening the neighborhood on each infeasibility (step 7)
 * and escalating to a full canonical replan only when widening is exhausted
 * (step 8).
 *
 * Every exit is a patch: there is no path through this function that returns a
 * plan without saying how it was produced and what it changed. The mode tells
 * the three exits apart — `incremental` when the first closure solved,
 * `expanded_incremental` when a widened one did, `full_fallback` when nothing
 * short of a regeneration could.
 */
export function planIncrementalPatch(input: FreezeResolveInput): FreezeResolveResult {
  const { basePlan, baseBlocks, closure, nextConstraints, config } = input;

  const blockById = new Map(baseBlocks.map((block) => [block.blockId, block] as const));
  if (blockById.size !== baseBlocks.length) {
    throw new IncrementalReplanError('the block set contains a duplicate blockId');
  }
  const basePlacements = new Map(basePlan.scheduled.map((entry) => [entry.itemId, entry] as const));

  for (const blockId of [...closure.impactedBlockIds, ...closure.frozenBlockIds]) {
    if (!blockById.has(blockId)) {
      throw new IncrementalReplanError(`block '${blockId}' is not a block of this plan`);
    }
  }

  const attemptSolve = (impactedBlockIds: readonly string[], frozenBlockIds: readonly string[]): SolveAttempt => {
    const impactedItemIds = new Set<string>();
    for (const blockId of impactedBlockIds) {
      const itemId = itemIdOf(blockById.get(blockId) as ScheduleBlock);
      if (itemId !== null) impactedItemIds.add(itemId);
    }

    // ── Step 3: freeze ──
    const frozenEvents = freezeBlocksAsFixedEvents(frozenBlockIds, blockById, basePlacements);
    const frozenItemIds = new Set(
      frozenBlockIds
        .map((blockId) => itemIdOf(blockById.get(blockId) as ScheduleBlock))
        .filter((itemId): itemId is string => itemId !== null),
    );

    // ── Step 4: re-solve, and only the impacted items ──
    //
    // The withheld items are the mechanism. A frozen item is not in `items`,
    // so there is no question for the solver to answer about it and no answer
    // it could give.
    const narrowed: PlanningConstraints = {
      ...nextConstraints,
      fixedEvents: [...nextConstraints.fixedEvents, ...frozenEvents],
      items: nextConstraints.items.filter((item) => impactedItemIds.has(item.itemId)),
    };

    // ── Step 5: validate ──
    //
    // The repo's existing static validator, over the request that was actually
    // solved — not a second validator written here. A finding at this level
    // means the frozen set and the change cannot coexist as written; step 7's
    // conflict set is the attempt to fix exactly that before giving up.
    const validation = validateConstraints(narrowed, config);
    if (validation.length > 0) {
      return { kind: 'invalid', validation };
    }

    const resolved = schedulePlan(narrowed, config);
    const merged = mergeResolvedWithFrozen(basePlan, resolved, nextConstraints, config);

    // The invariant, asserted against the assembled plan. See `frozenPlacementDrift`.
    const drifted = frozenPlacementDrift(basePlan, merged, frozenItemIds);
    if (drifted.length > 0) {
      throw new IncrementalReplanError(
        `frozen blocks moved, which the freeze exists to prevent: ${drifted.join(', ')}`,
      );
    }

    // Infeasible *for the impacted set alone*: an item that had a place in the
    // base plan no longer has one. An item that was already unplaced and still
    // is has not regressed — the patch did not take anything away from the
    // user, and widening the neighborhood over it would churn blocks to change
    // nothing.
    const regressed = Array.from(impactedItemIds)
      .some((itemId) => basePlacements.has(itemId)
        && !merged.scheduled.some((entry) => entry.itemId === itemId));
    if (regressed) {
      return { kind: 'regressed', validation };
    }

    return { kind: 'solved', plan: merged, validation };
  };

  // ── Steps 7–8: the escalation ladder ──
  //
  // Each round either solves, widens, or ends the ladder. Widening always
  // adds at least one block, so the loop is bounded by the block count; the
  // guard against running past it is cheap insurance against a future
  // candidate rule that could select a block already impacted.
  let impactedBlockIds: readonly string[] = closure.impactedBlockIds;
  let frozenBlockIds: readonly string[] = closure.frozenBlockIds;
  let widened = false;
  for (let round = 0; round <= baseBlocks.length; round += 1) {
    const attempt = attemptSolve(impactedBlockIds, frozenBlockIds);

    if (attempt.kind === 'solved') {
      // ── Step 6: the canonical diff ──
      return {
        plan: attempt.plan,
        validation: attempt.validation,
        patch: buildPatch(input, {
          impactedBlockIds,
          frozenBlockIds,
          diff: diffPlans(basePlan, attempt.plan),
          mode: widened ? 'expanded_incremental' : 'incremental',
          fallbackReason: null,
        }),
      };
    }

    // Step 7: widen, deterministically, by the candidate set that matches the
    // failure shape. An empty set is the exhaustion signal for this branch of
    // the ladder.
    const candidates = attempt.kind === 'invalid'
      ? computeConflictSet(
        { impactedBlockIds, frozenBlockIds, blockById, basePlacements },
        nextConstraints.fixedEvents,
      )
      : computeCapacityRing({ impactedBlockIds, frozenBlockIds, blockById, basePlacements });

    if (candidates.length === 0) {
      // Step 8: full canonical replan, with the reason that names the rung
      // the ladder actually stopped at.
      const reason = attempt.kind === 'invalid'
        ? FALLBACK_REASONS.frozenConstraintsInvalid
        : widened ? FALLBACK_REASONS.expandedSetInfeasible : FALLBACK_REASONS.impactedSetInfeasible;
      return fullFallback(input, reason, attempt.validation);
    }

    const grown = new Set([...impactedBlockIds, ...candidates]);
    impactedBlockIds = Array.from(grown).sort(compareByCodePoint);
    frozenBlockIds = frozenBlockIds
      .filter((blockId) => !grown.has(blockId))
      .sort(compareByCodePoint);
    widened = true;
  }

  // Unreachable: each round widens by at least one block and there are
  // `baseBlocks.length` blocks, so the loop solves or falls back first.
  throw new IncrementalReplanError('neighborhood expansion outgrew the plan, which cannot happen');
}
