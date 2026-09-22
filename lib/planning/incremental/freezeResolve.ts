/**
 * Freeze, re-solve, validate, diff (#524, slice 2): steps 3–6.
 *
 * Slice 1 answered *which* blocks a patch may touch. This answers what happens
 * next: the untouchable ones are pinned where they sit, the canonical solver is
 * asked to place only the rest, the two halves are joined back into one
 * complete plan, and that plan is compared with the base through the canonical
 * `PlanDiff`. Steps 7 and 8 — widening the neighborhood before giving up, and
 * the fallback taxonomy that would go with it — are deliberately absent; see
 * "What this slice does not do" below.
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
 * ── What this slice does not do ────────────────────────────────────
 *
 *  - **Step 7, the smart expansion.** When the impacted set alone cannot be
 *    placed, the issue says to widen the neighborhood and try again before
 *    escalating. This slice does not: it goes straight to `full_fallback`. The
 *    blunt escalation is correct but pessimistic — it regenerates a whole day
 *    where a slightly wider patch would have done — and `expanded_incremental`
 *    is consequently a mode this module never returns.
 *  - **Step 8's reason taxonomy.** `FALLBACK_REASONS` below is the two cases
 *    this pipeline can actually distinguish today, not a vocabulary for the
 *    escalation ladder that does not exist yet.
 *  - **The stale-generation guard.** `baseGeneration` and `resultGeneration`
 *    are recorded faithfully, and nothing here checks them against a stored
 *    plan: this module computes a patch, it does not apply one. The guard
 *    belongs beside `replaceStoredPlan`, with the input-digest check the issue
 *    pairs it with.
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

export class IncrementalReplanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncrementalReplanError';
  }
}

/**
 * Why a patch escalated past `incremental`.
 *
 * Two codes, because two are what this pipeline can tell apart. The issue's
 * step 7 would add at least one more — "the widened set was still infeasible" —
 * and it is deliberately absent rather than declared-and-unreachable: a code no
 * code path emits is a taxonomy that reads as complete and is not.
 */
export const FALLBACK_REASONS = Object.freeze({
  /**
   * The frozen blocks plus the changed constraints do not form a request the
   * planner can answer at all — most often a new blocking event landing on top
   * of a block the closure did not impact, which is a statement that the user
   * is in two places at once.
   */
  frozenConstraintsInvalid: 'FROZEN_CONSTRAINTS_INVALID',
  /**
   * The impacted set could not be placed in the room the frozen blocks left.
   * The blunt escalation: step 7 would widen the neighborhood here instead.
   */
  impactedSetInfeasible: 'IMPACTED_SET_INFEASIBLE',
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
function itemIdOf(block: ScheduleBlock): string | null {
  // `blocks.ts`: the v1 adapter's `itemId` *is* the source id, and only a
  // flexible block is something the solver was asked to place.
  return block.mobility === 'flexible' ? block.source.id : null;
}

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
 * Steps 3–6, in order, with the blunt escalation in place of steps 7–8.
 *
 * Freeze the unaffected, re-solve the impacted, assemble the complete plan,
 * validate it, diff it against the base. Every exit is a patch: there is no
 * path through this function that returns a plan without saying how it was
 * produced and what it changed.
 */
export function planIncrementalPatch(input: FreezeResolveInput): FreezeResolveResult {
  const { basePlan, baseBlocks, closure, nextConstraints, config } = input;

  const blockById = new Map(baseBlocks.map((block) => [block.blockId, block] as const));
  if (blockById.size !== baseBlocks.length) {
    throw new IncrementalReplanError('the block set contains a duplicate blockId');
  }
  const basePlacements = new Map(basePlan.scheduled.map((entry) => [entry.itemId, entry] as const));

  const impactedItemIds = new Set<string>();
  for (const blockId of closure.impactedBlockIds) {
    const block = blockById.get(blockId);
    if (block === undefined) {
      throw new IncrementalReplanError(`impacted block '${blockId}' is not a block of this plan`);
    }
    const itemId = itemIdOf(block);
    if (itemId !== null) impactedItemIds.add(itemId);
  }

  // ── Step 3: freeze ──
  const frozenEvents = freezeBlocksAsFixedEvents(closure.frozenBlockIds, blockById, basePlacements);
  const frozenItemIds = new Set(
    closure.frozenBlockIds
      .map((blockId) => itemIdOf(blockById.get(blockId) as ScheduleBlock))
      .filter((itemId): itemId is string => itemId !== null),
  );

  // ── Step 4: re-solve, and only the impacted items ──
  //
  // The withheld items are the mechanism. A frozen item is not in `items`, so
  // there is no question for the solver to answer about it and no answer it
  // could give.
  const narrowed: PlanningConstraints = {
    ...nextConstraints,
    fixedEvents: [...nextConstraints.fixedEvents, ...frozenEvents],
    items: nextConstraints.items.filter((item) => impactedItemIds.has(item.itemId)),
  };

  // ── Step 5: validate ──
  //
  // The repo's existing static validator, over the request that was actually
  // solved — not a second validator written here. A finding at this level means
  // the frozen set and the change cannot coexist, which no amount of re-solving
  // the impacted items will fix.
  const validation = validateConstraints(narrowed, config);
  if (validation.length > 0) {
    return fullFallback(input, FALLBACK_REASONS.frozenConstraintsInvalid, validation);
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
  // base plan no longer has one. An item that was already unplaced and still is
  // has not regressed — the patch did not take anything away from the user, and
  // escalating to a full regeneration over it would churn the whole day to
  // change nothing.
  const regressed = Array.from(impactedItemIds)
    .filter((itemId) => basePlacements.has(itemId)
      && !merged.scheduled.some((entry) => entry.itemId === itemId))
    .sort(compareByCodePoint);
  if (regressed.length > 0) {
    return fullFallback(input, FALLBACK_REASONS.impactedSetInfeasible, validation);
  }

  // ── Step 6: the canonical diff ──
  return {
    plan: merged,
    validation,
    patch: buildPatch(input, {
      impactedBlockIds: closure.impactedBlockIds,
      frozenBlockIds: closure.frozenBlockIds,
      diff: diffPlans(basePlan, merged),
      mode: 'incremental',
      fallbackReason: null,
    }),
  };
}
