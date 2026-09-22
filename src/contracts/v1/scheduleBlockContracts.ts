/**
 * Schedule block contracts (Launch S3, issue #521): a stable identity for a
 * scheduled piece of work, above the solver.
 *
 * Sprint 07 shipped the planning vocabulary — `PlanningItem`, `FixedEvent`,
 * `Plan`, `PlanDiff`, `churnMinutes` — and none of it answers the question this
 * contract exists for: "is the 'Study statistics — 60m' sitting at 14:00 in
 * today's regenerated plan the *same* work that sat at 09:00 in this morning's
 * plan?" A `Plan` is a proposal about time, rebuilt wholesale on every
 * regeneration; nothing in it distinguishes "the same logical occurrence,
 * moved" from "an unrelated piece of work that happens to share a title". The
 * scheduler's `itemId` comes close, and in the daily-plan adapter it *is* the
 * commitment id — but that identity is implicit, adapter-private, and lost the
 * moment a second source kind (a habit occurrence, a goal step) needs its own
 * namespacing. `ScheduleBlock` makes the identity explicit, typed and
 * persisted. It replaces none of the Sprint 07 vocabulary: `PlanDiff` remains
 * the canonical diff, and there is still exactly one planner.
 *
 * ── The identity scheme ────────────────────────────────────────────
 *
 * A block's identity is the identity of the **logical occurrence** it carries:
 * the pair `(scopeId, source)`. `scopeId` is the planning scope (the daily
 * plan's `${uid}:${date}`); `source` names the domain occurrence — its kind and
 * the id of the commitment, habit occurrence, goal step or manual entry the
 * block was projected from. `blockId` is derived, never minted:
 *
 *     blockId = `block:${source.kind}:${source.id}`
 *
 * Three properties fall out of derivation, and each is one of the issue's
 * acceptance criteria:
 *
 *  1. **Stability is free.** A regeneration, a manual move, a constraint update
 *     and a duration update all rebuild the block from the same `(scopeId,
 *     source)` pair, so they all arrive at the same `blockId`. There is no
 *     matching pass that could mismatch, no stored id that could drift from the
 *     occurrence it names, and no clock or random source that could make a
 *     replay disagree with the original — the same rule
 *     `PLANNING_PERSISTENCE_POLICY.noAmbientClock` puts on the scheduler.
 *  2. **Identity changes only when the occurrence does.** A new commitment, a
 *     habit's *next* occurrence, a different day: each is a different `source`
 *     or a different `scopeId`, and so a different block. Two occurrences can
 *     never share a `blockId` either — a duplicate source inside one scope is
 *     rejected by the reconciler rather than silently merged.
 *  3. **Uniqueness is scoped, not global.** `blockId` is unique within its
 *     scope, which is where blocks live (inside the day-scoped plan document).
 *     The globally unique name of a block is the pair `(scopeId, blockId)`;
 *     embedding the scope in the id would repeat the uid and date into every
 *     block of a document whose path already states both.
 *
 * ── The one-way projection ─────────────────────────────────────────
 *
 *     domain source → ScheduleBlock → PlanningItem / FixedEvent
 *                   → schedulePlan → placement applied back to the same block
 *
 * The block sits *above* the solver. The daily-plan adapter projects its
 * commitments into items and fixed events exactly as before; the reconciler
 * (`lib/planning/scheduler/blocks.ts`) then projects one block per solver
 * entity, applies the plan's placements back onto those blocks, and checks the
 * mapping the issue contracts: every scheduled or unscheduled item maps to
 * exactly one block, no block exists without a solver entity behind it (no
 * orphans), and no occurrence produces two blocks (no duplicates). A violation
 * is a planner bug and is thrown, not reported — the same reading
 * `computePlanQualityMetrics` gives a self-contradicting plan.
 *
 * ── Mobility ───────────────────────────────────────────────────────
 *
 * A `fixed` block is work pinned to an instant by its source (a commitment with
 * a scheduled time). It enters the constraints as a blocking `FixedEvent`,
 * never as a movable `PlanningItem` — the solver is not asked where it goes,
 * because the user already said. Its `currentInterval` is the source's
 * interval, and the solver merely respects it. A `flexible` block is everything
 * the solver *is* asked to place.
 *
 * ── What a move means ──────────────────────────────────────────────
 *
 * `currentInterval` is where the block sits now; `lastPlacedBy` says who put it
 * there; `lastPlanGeneration` says which generation of the plan did. When the
 * user drags a block, the edit writes the new interval onto the *block* — the
 * plan layer's own state — and the source commitment is never touched
 * (`PLANNING_PERSISTENCE_POLICY.originalCommitmentRemainsCanonical`). A block
 * the current plan does not place has `currentInterval: null`, and its
 * `lastPlacedBy` / `lastPlanGeneration` keep describing the last placement that
 * did happen: provenance, not a current claim.
 *
 * ── What a block never carries ─────────────────────────────────────
 *
 * No title and no user text. The commitment remains the canonical owner of its
 * own words (`planDto` joins titles at read time for the same reason), so a
 * block stores the source id and nothing else — the issue's "do not copy more
 * user text than existing Plan persistence already needs". Persisted blocks add
 * ids, kinds, minutes and instants to the plan document, all of which the
 * stored request already carries.
 */

import { MODULE_CONTRACT_VERSION } from './moduleContracts';
import type {
  Instant,
  PlacementProtection,
  TimeInterval,
  TimeOwnership,
} from './planningContracts';

/**
 * Re-exported so a block-facing caller names protection from the module that
 * owns blocks. The types themselves live in `planningContracts` because the
 * *solver* reads them — a `PlanningItem` carries one — and a contract the
 * scheduler must import cannot sit downstream of the block layer.
 */
export type { PlacementProtection, ProtectionOrigin, TimeOwnership } from './planningContracts';

export const SCHEDULE_BLOCK_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;
export const SCHEDULE_BLOCK_SCHEMA_VERSION = 'schedule-block-v1' as const;

/**
 * What kind of domain occurrence a block carries.
 *
 * `commitment` is the only kind today's adapter produces. The other three are
 * in the contract now because the identity scheme names them: a habit's
 * occurrence and a goal's step must not be squeezed into `commitment` the day
 * they arrive, because an id that means two things is an identity scheme that
 * means nothing.
 */
export type ScheduleSourceKind =
  | 'commitment'
  | 'habit_occurrence'
  | 'goal_step'
  | 'manual';

/**
 * The occurrence a block is the schedule identity of.
 *
 * `id` is the identifier in the source kind's own namespace — a commitment id
 * for `commitment`, and for the later kinds whatever that module calls one
 * logical occurrence. In the v1 adapter the solver's `itemId` *is* this id,
 * which is what lets a plan edit name an item and land on exactly one block.
 */
export interface ScheduleBlockSource {
  readonly kind: ScheduleSourceKind;
  readonly id: string;
}

/**
 * `fixed`: the source pinned the time, the solver is bypassed. See the header.
 *
 * Two values, still. `TimeOwnership` (#522) has three, and the third
 * — `protected_flexible` — is a *refinement* of `flexible`, not a fourth kind
 * of block: a protected block is one the solver is asked to place, under an
 * objective and possibly a bound. So mobility keeps answering the question it
 * was written for ("is the solver asked where this goes?"), `protection`
 * answers "and whose decision is the answer", and `ownershipOf` below is the
 * one place the two are combined. Widening this union instead would have made
 * every existing `mobility !== 'flexible'` read — there are several, including
 * the one in `applyEditsToBlocks` that decides what a user may drag — silently
 * exclude exactly the blocks this track is about.
 */
export type ScheduleBlockMobility = 'fixed' | 'flexible';

/** Who placed the block where it currently sits. */
export type ScheduleBlockPlacedBy = 'planner' | 'user';

/**
 * The leeway a flexible block gives the solver.
 *
 * `earliestStartAt` / `latestEndAt` are the item's own bounds (its
 * `earliestStartAt` and `deadlineAt`), kept on the block so that a reader can
 * see what room the placement was chosen inside without re-deriving the
 * request. `preferredWindows` is empty in v1 — preferences are constraint-level
 * (the working windows), not item-level — and exists because #521's domain
 * names it; the first adapter that fills it must not need a schema change.
 */
export interface ScheduleBlockPlacement {
  readonly earliestStartAt: Instant | null;
  readonly latestEndAt: Instant | null;
  readonly preferredWindows: readonly TimeInterval[];
}

/**
 * One logical occurrence, as a schedulable thing with a stable identity.
 *
 * The shape is the issue's, field for field. `durationMinutes` is the effort
 * the solver was asked to place; an item whose effort is `unknown` is never
 * placed (`EFFORT_UNKNOWN`), and its block reports `0` — the one case where the
 * honest answer is "no duration exists", documented here rather than invented
 * per call site, because the issue's shape has no `null` for it.
 *
 * `lastPlanGeneration` is the generation of the plan whose placement
 * `currentInterval` (or its absence) reflects: the current generation while the
 * block is placed, and the generation that last placed it once a later plan
 * leaves it unplaced. It is the block-level half of the plan document's
 * generation ancestry (`StoredDailyPlan.replaces` is the document-level half).
 */
export interface ScheduleBlock {
  readonly blockId: string;
  readonly scopeId: string;
  readonly source: ScheduleBlockSource;
  readonly mobility: ScheduleBlockMobility;
  readonly durationMinutes: number;
  readonly placement: ScheduleBlockPlacement;
  /** Where the block sits now; null when the current plan does not place it. */
  readonly currentInterval: TimeInterval | null;
  readonly lastPlacedBy: ScheduleBlockPlacedBy;
  readonly lastPlanGeneration: number;
  /**
   * Whose decision this block's position is (#522).
   *
   * Null for ordinary flexible work and for fixed blocks, which is every block
   * a plan built before this field existed — a stored document without it
   * reads as unprotected, which is what it was. The field is optional in the
   * type for that reason and for that reason only: every producer in this
   * repository writes it explicitly, and a reader treats `undefined` and
   * `null` alike (`ownershipOf`).
   *
   * `mobility` and `lastPlacedBy` are what a protection is usually derived
   * from — a block the *user* last placed is the canonical thing to protect —
   * but neither implies one. Protection is declared, never inferred: inferring
   * it from `lastPlacedBy: 'user'` would pin every block anyone had ever
   * dragged, for ever, with no way to say otherwise.
   */
  readonly protection?: PlacementProtection | null;
}

/**
 * The block's ownership, as the single value #522's contract names.
 *
 * `fixed` wins over anything the protection says: a block the source pinned is
 * not a placement the planner may reconsider, whatever a policy attached to it
 * later. Otherwise the protection speaks, and its absence means `flexible`.
 */
export function ownershipOf(block: Pick<ScheduleBlock, 'mobility' | 'protection'>): TimeOwnership {
  if (block.mobility === 'fixed') return 'fixed';
  return block.protection?.ownership === 'protected_flexible' ? 'protected_flexible' : 'flexible';
}

/**
 * The derived identity of an occurrence, as a pure function. See the header.
 *
 * Lives in the contract file rather than in the reconciler so that a follow-on
 * track (#522, #520) which needs to *name* a block computes the name the same
 * way the track that persists it does — two derivations of one identity is the
 * Sprint 06 gap again, and this scheme exists to close exactly that kind.
 */
export function scheduleBlockId(source: ScheduleBlockSource): string {
  return `block:${source.kind}:${source.id}`;
}
