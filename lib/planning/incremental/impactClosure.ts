/**
 * The impact closure (#524, slice 1): steps 1–2 of the issue's algorithm.
 *
 * Given the current plan's blocks and a statement of what directly changed,
 * answer exactly which blocks a patch may touch (`impactedBlockIds`) and
 * which it must not (`frozenBlockIds`). Pure in the scheduler's sense: no
 * clock, no randomness, no persistence, no solver — the same inputs always
 * produce the same partition, which is what makes the frozen invariant
 * testable at all.
 *
 * ── Step 1: direct impact ──────────────────────────────────────────
 *
 * Two ways in:
 *
 *  - `changedBlockIds` — the caller states that a block's own definition
 *    moved: its duration, deadline, availability window, dependencies, or its
 *    source was removed. Which of the issue's seven causes produced the id is
 *    the producer's knowledge (#523's evaluator and the adapters); the closure
 *    deliberately does not re-derive it.
 *  - `changedFixedEvents` — new or moved blocking events. Every block whose
 *    current placement overlaps one is directly impacted, whatever its kind:
 *    a flexible block must move, and a fixed block is now double-booked —
 *    both are facts a patch must reckon with. A non-blocking event is nobody's
 *    obstacle and impacts nothing. An unplaced block (`currentInterval:
 *    null`) overlaps nothing and is not displaced by an event; if it matters,
 *    it matters through its own id.
 *
 * ── Step 2: expansion through hard dependency edges ────────────────
 *
 * A successor joins the closure when its validity depends on the moved item:
 * `temporal` edges always, `resource` edges only when the plan was built with
 * `resourceDependenciesOrder` — the same partition of the dependency
 * vocabulary the three Sprint 07 tracks derived, because an edge that forces
 * no order cannot invalidate a placement by moving. Expansion is transitive
 * (a successor's successors are exposed to the same invalidation) and
 * cycle-safe by construction (a visited set; a temporal cycle is already
 * `CYCLIC_DEPENDENCY` upstream).
 *
 * Predecessors are *not* pulled in. The issue's language is successors, and
 * it is the right call: a predecessor's own placement bounds do not mention
 * its successor, so a successor that grew does not invalidate where the
 * predecessor sits. If a predecessor must genuinely move, the follow-up's
 * step-7 neighborhood expansion is the mechanism that widens the closure —
 * deterministically, and on infeasibility, not on suspicion.
 *
 * ── The partition is the contract ──────────────────────────────────
 *
 * `impactedBlockIds ∪ frozenBlockIds` is exactly the plan's blocks, disjoint,
 * each sorted by `blockId`. "Nothing unaffected is missed, nothing affected
 * is left out" is not a property a caller re-checks; it is how the result is
 * built.
 */

import type {
  FixedEvent,
  PlanningDependencyKind,
  PlanningItem,
} from '../../../src/contracts/v1/planningContracts';
import type { ScheduleBlock } from '../../../src/contracts/v1/scheduleBlockContracts';
import { compareByCodePoint } from '../shared/compare';
import { intervalsOverlap } from '../shared/time';

export class ImpactClosureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImpactClosureError';
  }
}

function fail(message: string): never {
  throw new ImpactClosureError(message);
}

export interface ImpactClosureInput {
  /**
   * The current plan's blocks — the set being partitioned. All of one scope;
   * a mixed-scope set is a caller bug the function cannot see, because ids
   * are unique within a scope and meaningless across one.
   */
  readonly blocks: readonly ScheduleBlock[];
  /**
   * The items the current plan answers (`StoredDailyPlan.constraints.items`).
   * The dependency graph lives here and nowhere else: a block carries no
   * edges, so a closure computed without the items could not expand.
   */
  readonly items: readonly PlanningItem[];
  /**
   * Ids of blocks whose own definition changed. Every id must name a block in
   * `blocks`: an id that names nothing is a caller bug, and a closure that
   * silently ignored it would freeze a change that was stated — thrown, not
   * absorbed, for the same reason a self-contradicting plan is refused.
   */
  readonly changedBlockIds: readonly string[];
  /** New or moved fixed events. Blocking ones displace whatever they overlap. */
  readonly changedFixedEvents?: readonly FixedEvent[];
  /**
   * The plan's `PlanningConfig.resourceDependenciesOrder`: whether `resource`
   * edges forced ordering in the plan being patched. Default false, the v1
   * default — an edge that forced no order in the base plan cannot invalidate
   * a placement in it.
   */
  readonly resourceDependenciesOrder?: boolean;
}

export interface ImpactClosure {
  /** Direct impact ∪ dependency-successor expansion. Sorted by blockId. */
  readonly impactedBlockIds: readonly string[];
  /** Everything else: byte-identical placement, per the issue's invariant. */
  readonly frozenBlockIds: readonly string[];
}

/**
 * The dependency kinds that forced ordering in the base plan — the only
 * edges a moved item can invalidate a successor through.
 */
function hardDependencyKinds(resourceDependenciesOrder: boolean): ReadonlySet<PlanningDependencyKind> {
  return resourceDependenciesOrder
    ? new Set<PlanningDependencyKind>(['temporal', 'resource'])
    : new Set<PlanningDependencyKind>(['temporal']);
}

export function computeImpactClosure(input: ImpactClosureInput): ImpactClosure {
  const { blocks, items, changedBlockIds } = input;
  const changedFixedEvents = input.changedFixedEvents ?? [];
  const hardKinds = hardDependencyKinds(input.resourceDependenciesOrder ?? false);

  const blockById = new Map(blocks.map((block) => [block.blockId, block] as const));
  if (blockById.size !== blocks.length) {
    // The block contract derives ids, so a duplicate is an integrity failure
    // upstream; partitioning a set with a colliding identity would freeze or
    // impact two occurrences under one name.
    fail('the block set contains a duplicate blockId');
  }

  // ── Step 1: direct impact ──
  const impacted = new Set<string>();
  for (const blockId of changedBlockIds) {
    if (!blockById.has(blockId)) {
      fail(`changed block '${blockId}' is not a block of this plan`);
    }
    impacted.add(blockId);
  }
  for (const event of changedFixedEvents) {
    if (!event.blocking) continue;
    for (const block of blocks) {
      if (block.currentInterval !== null && intervalsOverlap(block.currentInterval, event.interval)) {
        impacted.add(block.blockId);
      }
    }
  }

  // ── Step 2: expansion through hard dependency edges ──
  //
  // The graph is over item ids; blocks join it on `source.id`, the adapter's
  // documented correspondence (`blocks.ts`: the v1 item id *is* the source
  // id). A block with no item behind it — a fixed one — has no successors to
  // expose, and an edge naming an item with no block has nothing to pull in.
  const blockIdByItemId = new Map<string, string>();
  const itemIdByBlockId = new Map<string, string>();
  for (const block of blocks) {
    if (block.mobility !== 'flexible') continue;
    blockIdByItemId.set(block.source.id, block.blockId);
    itemIdByBlockId.set(block.blockId, block.source.id);
  }
  const successorsOf = new Map<string, string[]>();
  for (const item of items) {
    for (const edge of item.dependsOn) {
      if (!hardKinds.has(edge.kind)) continue;
      const successors = successorsOf.get(edge.dependsOnItemId) ?? [];
      successors.push(item.itemId);
      successorsOf.set(edge.dependsOnItemId, successors);
    }
  }

  const impactedItemIds = new Set<string>();
  const queue: string[] = [];
  for (const blockId of Array.from(impacted)) {
    const itemId = itemIdByBlockId.get(blockId);
    if (itemId !== undefined) queue.push(itemId);
  }
  while (queue.length > 0) {
    const itemId = queue.shift() as string;
    for (const successorId of successorsOf.get(itemId) ?? []) {
      if (impactedItemIds.has(successorId)) continue;
      impactedItemIds.add(successorId);
      const successorBlockId = blockIdByItemId.get(successorId);
      if (successorBlockId !== undefined && !impacted.has(successorBlockId)) {
        impacted.add(successorBlockId);
        queue.push(successorId);
      }
    }
  }

  // ── The partition ──
  const impactedBlockIds = Array.from(impacted).sort(compareByCodePoint);
  const frozenBlockIds = blocks
    .map((block) => block.blockId)
    .filter((blockId) => !impacted.has(blockId))
    .sort(compareByCodePoint);
  return Object.freeze({
    impactedBlockIds: Object.freeze(impactedBlockIds),
    frozenBlockIds: Object.freeze(frozenBlockIds),
  });
}
