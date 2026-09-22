/**
 * Protected-flexible placement (Launch S3, issue #522): keeping a position the
 * user chose, without pretending that keeping it is a hard constraint.
 *
 * `ScheduleBlock` (#521) gave a scheduled piece of work a stable identity, and
 * its author left the seam this module fills: `mobility` says whether the
 * solver is asked where a block goes, `lastPlacedBy` says who put it where it
 * sits, and a *protection* is the contract addition that says whose decision
 * that position is. Nothing below reworks the reconciler, and there is still
 * exactly one planner.
 *
 * ── Protection is not priority ─────────────────────────────────────
 *
 * The two are read by different machinery on purpose, and this module never
 * looks at `PlanningItem.priority`:
 *
 *   - **priority** orders candidates inside a tier (`comparePlanOrder`, over
 *     `PLAN_ORDERING_KEYS`). It answers "what matters most".
 *   - **protection** decides the tier (`compareProtectionRetention`) and, with
 *     a bound, narrows the legal window. It answers "whose decision is this
 *     position".
 *
 * So a `Nice` gym block the user dragged to 07:00 is placed before a `Must`
 * task that has never been placed at all, and the `Must` task fills in around
 * it. That reads backwards until you notice what each statement is about: the
 * `Must` is more important, and the 07:00 is not the planner's to give away.
 *
 * ── The decision hierarchy, and where each tier lives ───────────────
 *
 * The issue states five tiers in order. Four of them already existed; this
 * module adds the fourth and touches nothing above it:
 *
 *  1. **Hard constraints** — working windows, blocking fixed events, the
 *     horizon. `schedulePlan`'s free runs. Untouched: a newly added meeting
 *     therefore beats protected gym time, because the gym block is never
 *     offered a run the meeting occupies.
 *  2. **Explicit user max-shift bounds** — `protectedStartBoundsMs` below,
 *     narrowing the legal start window before any run is examined. Above
 *     deadlines because it can refuse a placement a deadline would allow, and
 *     it does so by making the window empty rather than by outranking anything
 *     at selection time.
 *  3. **Deadlines and dependencies** — `startBounds` and the prerequisite
 *     floor in `schedulePlan`. Untouched.
 *  4. **Protected-placement retention** — `compareProtectionRetention` (which
 *     candidate is considered first) and `retainedStartMs` (where a protected
 *     candidate is tried first). This is an *objective*: it decides who gets
 *     the choice of a free run, never whether a run is legal.
 *  5. **The existing priority/order policy** — `comparePlanOrder`, unchanged
 *     and still the tie-break inside each tier.
 *
 * Tiers 2 and 4 are the two places a defect here would be invisible, and each
 * has a test that fails when that exact line is broken: a bound that is checked
 * but not enforced places work outside it silently, and a retention tier that
 * compares equal produces a perfectly valid plan that simply churns.
 *
 * ── Buffers are untouched ──────────────────────────────────────────
 *
 * `bufferBeforeMinutes` / `bufferAfterMinutes` protect the time *around* an
 * item and travel with it wherever it goes. This module reads neither, widens
 * neither, and measures its bound on the effort start — the instant the user
 * sees — so that a buffer edit is not a shift and a shift is not a buffer.
 *
 * Pure, like everything else under `lib/planning/`: no clock, no randomness, no
 * persistence, so a replay of the same request retains the same placements.
 */

import type {
  PlacementProtection,
  PlanningConstraints,
  PlanningItem,
  TimeInterval,
} from '../../../src/contracts/v1/planningContracts';
import {
  ownershipOf,
  type ScheduleBlock,
} from '../../../src/contracts/v1/scheduleBlockContracts';
import { toEpochMs } from '../shared/time';

/** The one ownership that makes a placement an objective. */
export const PROTECTED_OWNERSHIP = 'protected_flexible' as const;

/** A protection, normalised: `undefined` and `null` are the same absence. */
export function protectionOf(
  carrier: { readonly protection?: PlacementProtection | null },
): PlacementProtection | null {
  return carrier.protection ?? null;
}

/** Whether this item's position is the user's (or a policy's) decision. */
export function isProtected(
  carrier: { readonly protection?: PlacementProtection | null },
): boolean {
  return protectionOf(carrier)?.ownership === PROTECTED_OWNERSHIP;
}

/**
 * The effort start this item is protecting, in epoch milliseconds.
 *
 * Null when the item is not protected, or is protected but has never been
 * placed (`preferredInterval: null`) — a habit policy can declare an occurrence
 * protected before the planner has ever scheduled it, and such an item has
 * nothing to retain yet. It is still protected: it simply neither retains nor
 * releases until it has a first placement to keep.
 */
export function retainedStartMs(item: PlanningItem): number | null {
  const protection = protectionOf(item);
  if (protection === null || protection.ownership !== PROTECTED_OWNERSHIP) return null;
  const preferred = protection.preferredInterval;
  if (preferred === null) return null;
  const ms = toEpochMs(preferred.startsAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The window of effort starts an explicit max-shift bound allows.
 *
 * Null means "this item states no bound", which is not the same as "any start
 * is fine": an unbounded protected item still has its placement retained as an
 * objective (tier 4), it simply never earns `PROTECTED_SHIFT_EXCEEDED`.
 *
 * A bound that arithmetic cannot use — negative, `NaN`, infinite-by-way-of-a-
 * bad-preference — returns an **empty** window rather than no window. That is
 * the direction `EFFORT_NOT_POSITIVE`'s ruling settled for buffers: a value the
 * caller supplied is reported, never silently repaired, and repairing this one
 * is the dangerous half (a discarded bound turns "do not move this" into "move
 * it anywhere" and the plan looks fine). The report is
 * `PROTECTED_SHIFT_EXCEEDED`, which is exactly true of it.
 */
export function protectedStartBoundsMs(
  item: PlanningItem,
): { readonly earliestMs: number; readonly latestMs: number } | null {
  const protection = protectionOf(item);
  if (protection === null || protection.ownership !== PROTECTED_OWNERSHIP) return null;
  const { maxShiftMinutes } = protection;
  if (maxShiftMinutes === null) return null;

  const anchorMs = retainedStartMs(item);
  if (anchorMs === null) {
    // A bound with nothing to measure from. It constrains nothing, and turning
    // it into an empty window would refuse an item whose protection is a
    // standing policy rather than a claim about a placement.
    return null;
  }
  if (!Number.isFinite(maxShiftMinutes) || maxShiftMinutes < 0) {
    return { earliestMs: 1, latestMs: 0 };
  }
  const spanMs = maxShiftMinutes * 60_000;
  return { earliestMs: anchorMs - spanMs, latestMs: anchorMs + spanMs };
}

/**
 * Whether a start honours the item's max-shift bound.
 *
 * The same arithmetic as `protectedStartBoundsMs`, asked about one instant.
 * Exported because "never silently exceeded" is a claim about the *output*, and
 * a test that re-derived the bound from the protection would be re-deriving the
 * thing it is checking.
 */
export function withinMaxShift(item: PlanningItem, startMs: number): boolean {
  const bounds = protectedStartBoundsMs(item);
  if (bounds === null) return true;
  return startMs >= bounds.earliestMs && startMs <= bounds.latestMs;
}

/**
 * Tier 4: which of two candidates is considered first.
 *
 * A protected item with a placement to keep sorts ahead of everything else, so
 * that in a greedy placement it gets the choice of a free run and ordinary
 * flexible work fills in around it — "the planner moves ordinary flexible work
 * before moving a feasible protected block", expressed as the order two
 * candidates are offered the day.
 *
 * It returns 0 for every other pair, including two protected items, so
 * `comparePlanOrder` (tier 5, priority and deadline) decides everything this
 * does not. That is what keeps protection from leaking into the ordering the
 * contract froze: `PLAN_ORDERING_KEYS` is unchanged, the final plan is still
 * sorted by it, and this comparator exists only where candidates are chosen.
 */
export function compareProtectionRetention(left: PlanningItem, right: PlanningItem): number {
  const leftRetains = retainedStartMs(left) !== null ? 0 : 1;
  const rightRetains = retainedStartMs(right) !== null ? 0 : 1;
  return leftRetains - rightRetains;
}

/**
 * How far a placement moved from what it was protecting, in minutes.
 *
 * Zero when there is nothing to compare, and never negative: direction is not
 * the question, distance is. Rounded the way `minutesBetween` rounds, so a
 * sub-minute difference does not read as a shift of zero when it is one.
 */
export function protectedShiftMinutes(
  item: PlanningItem,
  placedStart: string | null,
): number {
  const anchorMs = retainedStartMs(item);
  if (anchorMs === null || placedStart === null) return 0;
  return Math.abs(toEpochMs(placedStart) - anchorMs) / 60_000;
}

/**
 * The protection an item carries after the user successfully moves it.
 *
 * The issue's rule: "if the user manually moves a protected block, the
 * successful move becomes the new preferred placement". *Successful* is the
 * load-bearing word and is decided elsewhere — `validateEdit` refuses a move
 * that breaks the plan's own constraints, and a refused edit never reaches
 * here. A protected block whose move was refused keeps the preference it had,
 * because nothing happened.
 *
 * `maxShiftMinutes` is carried through unchanged and re-anchored on the new
 * preference, which is the only reading that does not either forget the bound
 * or measure it from a placement the user has replaced. `origin` is likewise
 * kept: a habit policy's protection that the user then dragged is still the
 * habit's protection, now preferring where the person put it.
 *
 * An unprotected block is returned untouched. Moving something is not a
 * declaration that it should never move again — that declaration is the
 * protection mutation on the Plan boundary, which a person makes deliberately.
 */
export function protectionAfterMove(
  protection: PlacementProtection | null | undefined,
  interval: TimeInterval,
): PlacementProtection | null {
  const current = protection ?? null;
  if (current === null || current.ownership !== PROTECTED_OWNERSHIP) return current;
  return { ...current, preferredInterval: { startsAt: interval.startsAt, endsAt: interval.endsAt } };
}

/**
 * Carries the protections recorded on one generation's blocks into the next
 * generation's planning request.
 *
 * This is the round trip that makes protection survive a regeneration at all.
 * A protection is declared on a *block* — that is the plan layer's own state,
 * the thing the API mutation names and the thing persistence keeps — and the
 * solver reads a `PlanningItem`. Without this projection the next morning's
 * plan would be built from commitments that have never heard of it, and every
 * protected placement would quietly become ordinary flexible work.
 *
 * Shaped after `projectReadinessIntoPlanningConstraints`, and for the same
 * reason: a pure constraints-to-constraints function keeps the solver's input
 * one object that a test can construct by hand, instead of a second channel the
 * scheduler has to consult.
 *
 * **Scoped before it is indexed**, exactly as `reconcileScheduleBlocks` joins
 * provenance. `blockId` is unique inside a scope and not across accounts, so
 * two accounts holding the same commitment id hold the same block id — an
 * unfiltered join would carry one person's protected hour into another
 * person's day. The join is on the pair `(scopeId, blockId)`.
 *
 * **The seam for #520.** Nothing here knows what a habit is. A block whose
 * source kind is `habit_occurrence` and whose protection says
 * `origin: 'habit_policy'` flows through this function unchanged, so the habit
 * adapter's whole job is to produce blocks carrying the protection its
 * `HabitDefinition.flexibility` implies. No change to this module, the
 * scheduler, or the contract is needed for that.
 */
export function projectBlockProtectionIntoPlanningConstraints(
  constraints: PlanningConstraints,
  blocks: readonly ScheduleBlock[] | null | undefined,
): PlanningConstraints {
  const previous = blocks ?? [];
  if (previous.length === 0 || constraints.items.length === 0) return constraints;

  const bySourceId = new Map<string, PlacementProtection>();
  for (const block of previous) {
    if (block.scopeId !== constraints.scopeId) continue;
    // A fixed block's position is its source's, not a protection's; carrying one
    // forward would describe a placement the solver is never asked about.
    if (ownershipOf(block) !== PROTECTED_OWNERSHIP) continue;
    const protection = protectionOf(block);
    if (protection === null) continue;
    bySourceId.set(block.source.id, protection);
  }
  if (bySourceId.size === 0) return constraints;

  return {
    ...constraints,
    items: constraints.items.map((item) => {
      // An item that already states its own protection keeps it: the adapter
      // that built this request is closer to the source than a stored block
      // from the previous generation is.
      if (protectionOf(item) !== null) return item;
      const protection = bySourceId.get(item.itemId);
      return protection === undefined ? item : { ...item, protection };
    }),
  };
}
