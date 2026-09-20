/**
 * Schedule block reconciliation (Launch S3, issue #521): the one-way
 * projection that gives a scheduled piece of work a stable identity.
 *
 *     domain source → ScheduleBlock → PlanningItem / FixedEvent
 *                   → schedulePlan → placement applied back to the same block
 *
 * The block contract and its identity scheme are documented in
 * `src/contracts/v1/scheduleBlockContracts.ts`; this module is the machinery
 * that keeps a stored set of blocks honest against a solver run. It is pure in
 * the same sense the scheduler is: no clock, no randomness, no persistence, so
 * an identical replay produces identical blocks — which is the issue's first
 * acceptance criterion, and is only testable under that rule.
 *
 * Four properties are structural:
 *
 *  1. **Identity is derived, never assigned.** `scheduleBlockId` is a pure
 *     function of the source occurrence. Reconciliation therefore has no
 *     matching pass that could mismatch: a regeneration, a move, a constraint
 *     update or a duration update rebuilds the block from the same occurrence
 *     and arrives at the same id. What `previous` is for is *provenance*, not
 *     identity — see property 4.
 *
 *  2. **The mapping is checked, not assumed.** The issue contracts three
 *     invariants — every scheduled or unscheduled item maps to exactly one
 *     block, no orphan blocks, no duplicate blocks for one occurrence — and
 *     each is enforced here by throwing `ScheduleBlockIntegrityError`. A
 *     violation is a bug in the planner or in the adapter that built the
 *     source map, and the repo's reading of that situation is already set by
 *     `computePlanQualityMetrics`: a self-contradicting plan has no meaningful
 *     derived data, so it is refused rather than published.
 *
 *  3. **Fixed blocks are observed, not placed.** A fixed event with a source is
 *     work the user pinned to an instant; it enters the constraints as a
 *     blocking event and never as a movable item. Its block records that
 *     interval as `currentInterval` — the solver's only involvement is
 *     respecting it. A fixed event *without* a source (a busy calendar entry)
 *     is an obstacle, not a block: it is nobody's work, and giving it a
 *     schedule identity would invent an occurrence that does not exist.
 *
 *  4. **`previous` carries provenance forward, never placement.** When a new
 *     plan leaves a block unscheduled, `currentInterval` becomes null — the
 *     plan's answer is the answer — but `lastPlacedBy` and
 *     `lastPlanGeneration` keep describing the last placement that happened.
 *     A block whose occurrence no longer exists is dropped: carrying it forward
 *     would be an orphan, and "no orphan block" is contracted. `previous` is
 *     read only where its `scopeId` is the scope being reconciled — ids are
 *     unique inside a scope, not across accounts, so the join is on the pair.
 */

import type {
  Instant,
  Plan,
  PlannedItem,
  PlanningConstraints,
  TimeInterval,
} from '../../../src/contracts/v1/planningContracts';
import {
  scheduleBlockId,
  type ScheduleBlock,
  type ScheduleBlockSource,
} from '../../../src/contracts/v1/scheduleBlockContracts';
import { compareByCodePoint } from '../shared/compare';
import { intervalMinutes, isPositiveInterval, toEpochMs } from '../shared/time';

/**
 * Where each solver entity's occurrence lives, supplied by the caller.
 *
 * Keyed by the solver's own ids — `itemId` for movable items, `eventId` for
 * fixed events — because those are the ids the plan speaks. A fixed event
 * absent from `fixedEvents` is an obstacle (property 3), not a block.
 *
 * The map is the adapter's claim about its own construction. This module does
 * not know what a commitment is; the daily-plan adapter
 * (`buildDailyPlan.dailyPlanScheduleSources`) does, and states it here.
 */
export interface ScheduleBlockSources {
  readonly items: ReadonlyMap<string, ScheduleBlockSource>;
  readonly fixedEvents: ReadonlyMap<string, ScheduleBlockSource>;
}

/**
 * A broken block↔plan mapping. Thrown, never returned: the invariants it
 * reports are the issue's acceptance criteria, and a plan that breaks them has
 * no honest block set to persist.
 */
export class ScheduleBlockIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleBlockIntegrityError';
  }
}

function fail(message: string): never {
  throw new ScheduleBlockIntegrityError(message);
}

function sourceKey(source: ScheduleBlockSource): string {
  return `${source.kind}${source.id}`;
}

/** One flexible block per item, before the plan's placement is applied. */
function blockForItem(
  scopeId: string,
  item: PlanningConstraints['items'][number],
  source: ScheduleBlockSource,
  generation: number,
): ScheduleBlock {
  return {
    blockId: scheduleBlockId(source),
    scopeId,
    source,
    mobility: 'flexible',
    // `unknown` effort is reported, never placed, and its block says 0 — the
    // contract states this reading where the type is declared.
    durationMinutes: item.effort.kind === 'known' ? item.effort.minutes : 0,
    placement: {
      earliestStartAt: item.earliestStartAt,
      latestEndAt: item.deadlineAt,
      preferredWindows: [],
    },
    currentInterval: null,
    lastPlacedBy: 'planner',
    lastPlanGeneration: generation,
  };
}

/** One fixed block per sourced fixed event. Property 3: observed, not placed. */
function blockForFixedEvent(
  scopeId: string,
  event: PlanningConstraints['fixedEvents'][number],
  source: ScheduleBlockSource,
  generation: number,
): ScheduleBlock {
  return {
    blockId: scheduleBlockId(source),
    scopeId,
    source,
    mobility: 'fixed',
    durationMinutes: Math.max(0, intervalMinutes(event.interval)),
    placement: {
      earliestStartAt: event.interval.startsAt,
      latestEndAt: event.interval.endsAt,
      preferredWindows: [],
    },
    currentInterval: event.interval,
    lastPlacedBy: 'planner',
    lastPlanGeneration: generation,
  };
}

export interface ReconcileScheduleBlocksArgs {
  readonly constraints: PlanningConstraints;
  readonly plan: Plan;
  /** The generation of the plan being reconciled (1 for a first build). */
  readonly generation: number;
  readonly sources: ScheduleBlockSources;
  /** The previous generation's blocks, when regenerating. Property 4. */
  readonly previous?: readonly ScheduleBlock[] | null;
}

/**
 * Projects the blocks for one plan and checks the contracted mapping.
 *
 * The result is sorted by `blockId` so that serialisation is a function of the
 * content alone — the same determinism rule `Plan` follows.
 */
export function reconcileScheduleBlocks(args: ReconcileScheduleBlocksArgs): ScheduleBlock[] {
  const { constraints, plan, generation, sources } = args;
  const previous = args.previous ?? [];

  const placements = new Map<string, TimeInterval>(
    plan.scheduled.map((entry) => [entry.itemId, entry.interval] as const),
  );
  const unscheduled = new Set(plan.unscheduled.map((entry) => entry.itemId));

  const blocks: ScheduleBlock[] = [];
  const seenSources = new Set<string>();
  const claimSource = (source: ScheduleBlockSource): void => {
    const key = sourceKey(source);
    if (seenSources.has(key)) {
      // The "no duplicate block for the same occurrence" criterion. Ids are
      // derived, so two entities mapping to one source would produce two
      // blocks with one identity — the failure this contract exists against.
      fail(`two solver entities claim the same schedule source ${key}`);
    }
    seenSources.add(key);
  };

  for (const event of constraints.fixedEvents) {
    const source = sources.fixedEvents.get(event.eventId);
    if (source === undefined) continue;
    // A malformed interval is a constraint defect the plan already reports
    // (INVALID_INTERVAL); it is not a placement and gets no block to misstate.
    if (!isPositiveInterval(event.interval)) continue;
    claimSource(source);
    blocks.push(blockForFixedEvent(constraints.scopeId, event, source, generation));
  }

  // Scoped before it is indexed. `blockId` is unique *within* a scope — the
  // contract says so, and deliberately: embedding the uid and the date in every
  // id would repeat a path the document already states. The consequence is that
  // two accounts holding the same commitment id hold the same `blockId`, so a
  // `previous` set from another scope would match here and carry one account's
  // provenance into another's plan. The globally unique name of a block is the
  // pair `(scopeId, blockId)`, and this is the one place that pair is joined on.
  const previousById = new Map(previous
    .filter((block) => block.scopeId === constraints.scopeId)
    .map((block) => [block.blockId, block] as const));

  for (const item of constraints.items) {
    const source = sources.items.get(item.itemId);
    if (source === undefined) {
      // "Every scheduled/unscheduled planner item maps to exactly one block":
      // an item the adapter declined to source could never have one.
      fail('a planning item has no schedule source');
    }
    claimSource(source);

    const placed = placements.get(item.itemId);
    const isUnscheduled = unscheduled.has(item.itemId);
    // The plan must account for every item exactly once — the same partition
    // `Plan` contracts. Checked here because the block set is persisted: a
    // plan that skipped an item would otherwise be stored as a block set that
    // simply never mentions it.
    if ((placed === undefined) === !isUnscheduled) {
      fail('a planning item is not in exactly one of the plan\'s scheduled and unscheduled lists');
    }

    let block = blockForItem(constraints.scopeId, item, source, generation);
    if (placed !== undefined) {
      block = { ...block, currentInterval: placed };
    } else {
      const prior = previousById.get(block.blockId);
      if (prior !== undefined) {
        // Property 4: provenance of the last real placement survives; the
        // placement itself does not — the current plan does not place it.
        block = {
          ...block,
          lastPlacedBy: prior.lastPlacedBy,
          lastPlanGeneration: prior.lastPlanGeneration,
        };
      }
    }
    blocks.push(block);
  }

  // The other direction of "no orphan": a placement or an unscheduled entry
  // naming no item of this request would produce a block for an occurrence
  // that does not exist here.
  const knownItemIds = new Set(constraints.items.map((item) => item.itemId));
  const reported = Array.from(placements.keys()).concat(Array.from(unscheduled));
  for (const itemId of reported) {
    if (!knownItemIds.has(itemId)) {
      fail('the plan reports an item the request does not contain');
    }
  }

  blocks.sort((left, right) => compareByCodePoint(left.blockId, right.blockId));
  return blocks;
}

/**
 * The edit shape the block layer understands, structurally.
 *
 * Declared here rather than imported from the daily-plan adapter: planning is
 * a leaf (`tests/planning/planningBoundaries.test.ts`), and the adapter's
 * `PlanEdits` satisfies this shape without an import in either direction.
 */
export interface ScheduleBlockEdits {
  readonly moves: readonly { readonly itemId: string; readonly startsAt: Instant; readonly endsAt: Instant }[];
  readonly removals: readonly string[];
}

/**
 * Applies a user's plan edit to the blocks of the plan being edited.
 *
 * The edit is wholesale — the stored `edits` record is replaced, not appended
 * to — so this is a recomputation from the plan and the new edits, not a
 * delta applied to the blocks. For each flexible block whose item the plan
 * placed:
 *
 *  - **moved** → the new interval, `lastPlacedBy: 'user'`;
 *  - **removed** → `currentInterval: null`, `lastPlacedBy: 'user'` — the block
 *    and its identity stay; the user has unplaced it, not deleted it;
 *  - **untouched** → the planner's interval again, `lastPlacedBy: 'planner'`.
 *    An earlier edit that moved it is gone from the new edit set, and the
 *    block must not go on claiming a placement the effective schedule no
 *    longer shows.
 *
 * `lastPlanGeneration` is the generation being edited in all three cases: the
 * placement described is that plan's, whether the planner or the person chose
 * it.
 *
 * The join from an edit's `itemId` to a block is on `source.id`. That is the
 * v1 adapter's construction — its item ids are its commitment ids — and an
 * adapter whose item ids are namespaced differently must resolve through its
 * own source map instead. Blocks whose item the plan did not place cannot be
 * named by an edit (the edit validator refuses them) and pass through
 * unchanged, as do fixed blocks: nobody drags a pinned event in a plan edit.
 */
export function applyEditsToBlocks(
  blocks: readonly ScheduleBlock[],
  scheduled: readonly PlannedItem[],
  edits: ScheduleBlockEdits,
  generation: number,
): ScheduleBlock[] {
  const plannerInterval = new Map(scheduled.map((entry) => [entry.itemId, entry.interval] as const));
  const moved = new Map(edits.moves.map((move) => [move.itemId, move] as const));
  const removed = new Set(edits.removals);

  const next = blocks.map((block) => {
    if (block.mobility !== 'flexible') return block;
    const original = plannerInterval.get(block.source.id);
    if (original === undefined) return block;

    if (removed.has(block.source.id)) {
      return { ...block, currentInterval: null, lastPlacedBy: 'user' as const, lastPlanGeneration: generation };
    }
    const move = moved.get(block.source.id);
    if (move !== undefined) {
      return {
        ...block,
        currentInterval: { startsAt: move.startsAt, endsAt: move.endsAt },
        lastPlacedBy: 'user' as const,
        lastPlanGeneration: generation,
      };
    }
    return { ...block, currentInterval: original, lastPlacedBy: 'planner' as const, lastPlanGeneration: generation };
  });

  next.sort((left, right) => compareByCodePoint(left.blockId, right.blockId));
  return next;
}

/** The identity checks a caller can assert without re-walking the mapping. */
export function blockForSource(
  blocks: readonly ScheduleBlock[],
  source: ScheduleBlockSource,
): ScheduleBlock | null {
  const id = scheduleBlockId(source);
  return blocks.find((block) => block.blockId === id) ?? null;
}

/** Two instants are the same moment, serialisation aside. */
export function sameBlockInterval(left: TimeInterval | null, right: TimeInterval | null): boolean {
  if (left === null || right === null) return left === right;
  return toEpochMs(left.startsAt) === toEpochMs(right.startsAt)
    && toEpochMs(left.endsAt) === toEpochMs(right.endsAt);
}
