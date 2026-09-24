/**
 * The plan as the React Native client reads it (UC-3.10a, #194; rendered by #195).
 *
 * Item ids joined to titles here rather than stored joined, because the
 * commitment is the canonical owner of its own title: a plan that carried a
 * copy would go on showing yesterday's wording after the user renamed
 * something, and a reader could not tell which of the two was true.
 *
 * A title that has gone — the commitment was deleted after the plan was built —
 * comes back as null rather than as an empty string, so the client can say "this
 * is no longer on your list" instead of rendering a blank row.
 */
import type { PlanItemChange, PlanningItem, TimeInterval, UnscheduledItem } from '../../../src/contracts/v1/planningContracts';
import { ownershipOf } from '../../../src/contracts/v1/scheduleBlockContracts';
import { withinMaxShift } from '../../planning/scheduler';
import { toEpochMs } from '../../planning/shared/time';
import { effectiveSchedule, planUnderKeptRemovals } from './planActions';
import { pendingProposalOf, type StoredDailyPlan, type StoredPlanProposal } from './planStore';

export interface PlanItemDto {
  readonly itemId: string;
  readonly title: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  /**
   * The block this row is, so the client can name it (#521, #522).
   *
   * Without it the protect mutation is unreachable: `protections` below lists
   * only what is *already* protected, so a screen looking at an ordinary row
   * had no id to send and the first protection could never be made. The
   * alternative — letting the client re-derive `scheduleBlockId` — would put a
   * second copy of a server identity scheme in the app, which is how the two
   * start disagreeing.
   *
   * Null only for a plan document written before blocks existed (#521), where
   * there is no block to name and protection is therefore unavailable.
   */
  readonly blockId: string | null;
}

export interface UnplacedItemDto {
  readonly itemId: string;
  readonly title: string | null;
  readonly reasonCode: string;
  /**
   * The block this row is, on the same terms as `PlanItemDto.blockId`.
   *
   * An unplaced item still has a block — that is #521's whole point, and it is
   * why a protected block that could not be placed keeps its protection. The
   * user releasing a bound that made their day infeasible
   * (`PROTECTED_SHIFT_EXCEEDED`) is doing it from this row, so this row needs
   * the id.
   */
  readonly blockId: string | null;
}

/**
 * One block's protection, as the client reads it (#522).
 *
 * A separate list rather than four more fields on `PlanItemDto`, because a
 * protection is a fact about a *block* — it survives the block going
 * unplaced, and `scheduled` does not — and because the client names a block by
 * `blockId` when it asks to change one. Unprotected blocks are absent: the list
 * is what is protected, not a row per block with a boolean.
 */
export interface BlockProtectionDto {
  readonly blockId: string;
  readonly itemId: string;
  readonly ownership: 'protected_flexible';
  readonly origin: string;
  readonly preferredInterval: TimeInterval | null;
  readonly maxShiftMinutes: number | null;
}

export interface DailyPlanDto {
  readonly date: string;
  readonly timezone: string;
  readonly status: StoredDailyPlan['status'];
  readonly generation: number;
  readonly inputDigest: string;
  readonly generatedAt: string;
  readonly acceptedAt: string | null;
  readonly explanation: { readonly text: string; readonly locale: string; readonly source: string };
  readonly scheduled: readonly PlanItemDto[];
  readonly unscheduled: readonly UnplacedItemDto[];
  /** True once the user has moved or removed something. */
  readonly edited: boolean;
  /** The blocks whose position is the user's (or a policy's) decision (#522). */
  readonly protections: readonly BlockProtectionDto[];
}

export function planToDto(stored: StoredDailyPlan, titles: ReadonlyMap<string, string>): DailyPlanDto {
  // Indexed once. `blockId` is needed on every scheduled and unscheduled row,
  // and a find() per row would be quadratic over a day that can hold dozens.
  const blockByItemId = new Map((stored.blocks ?? [])
    .filter((block) => block.mobility !== 'fixed')
    .map((block) => [block.source.id, block.blockId] as const));
  return {
    date: stored.date,
    timezone: stored.timezone,
    status: stored.status,
    generation: stored.generation,
    inputDigest: stored.inputDigest,
    generatedAt: stored.generatedAt,
    acceptedAt: stored.acceptedAt,
    explanation: {
      text: stored.explanation.text,
      locale: stored.explanation.locale,
      source: stored.explanation.source,
    },
    scheduled: effectiveSchedule(stored).map((item) => ({
      itemId: item.itemId,
      title: titles.get(item.itemId) ?? null,
      startsAt: item.interval.startsAt,
      endsAt: item.interval.endsAt,
      blockId: blockByItemId.get(item.itemId) ?? null,
    })),
    unscheduled: stored.plan.unscheduled.map((item: UnscheduledItem) => ({
      itemId: item.itemId,
      title: titles.get(item.itemId) ?? null,
      reasonCode: item.reason.code,
      blockId: blockByItemId.get(item.itemId) ?? null,
    })),
    edited: stored.edits.moves.length > 0 || stored.edits.removals.length > 0,
    // `?? []` for a document written before blocks existed (#521): no blocks
    // means nothing has been protected, which is what it means.
    protections: (stored.blocks ?? []).flatMap((block) => {
      const protection = block.protection ?? null;
      if (protection === null || ownershipOf(block) !== 'protected_flexible') return [];
      return [{
        blockId: block.blockId,
        itemId: block.source.id,
        ownership: 'protected_flexible' as const,
        origin: protection.origin,
        preferredInterval: protection.preferredInterval,
        maxShiftMinutes: protection.maxShiftMinutes,
      }];
    }),
  };
}

/* ── The pending proposal (#523) ─────────────────────────────────── */

/**
 * One row of the proposed patch's diff, with the title joined on.
 *
 * `PlanItemChange` is a discriminated union of five shapes with different
 * keys; this is the same five, flattened to one row with a null where a
 * variant has no such field. Flattened rather than passed through, because
 * `PlanDiff` is a server contract that a client would otherwise have to
 * re-model as five branches, and because a title has to be joined in — the
 * diff, like the plan, stores item ids and nothing the commitment owns.
 *
 * **Nothing is filtered.** `unchanged` rows are carried too: what a review
 * surface shows is a product decision, and a DTO that dropped them would have
 * made it here, invisibly, for every client.
 */
export interface PlanProposalChangeDto {
  readonly kind: PlanItemChange['kind'];
  readonly itemId: string;
  readonly title: string | null;
  /** Where it was: `removed`, `moved`. Null for the other three. */
  readonly from: TimeInterval | null;
  /** Where it would go: `added`, `moved`, and `unchanged`'s `at`. */
  readonly to: TimeInterval | null;
  /** How far it would move, in minutes. `moved` only. */
  readonly shiftMinutes: number | null;
  /** `reason_changed` only: the code it was unplaceable for, and the new one. */
  readonly fromReasonCode: string | null;
  readonly toReasonCode: string | null;
}

/**
 * The patch continuous replanning is offering, as the client reads it.
 *
 * A sibling of `plan` on the response rather than a field inside
 * `DailyPlanDto`, and deliberately: `DailyPlanDto` is *the plan in force*, and
 * a proposal nested inside it would read as part of it. It is on the same
 * response — not a second endpoint — because it is a property of the plan
 * being shown, and a second round trip would be a spinner every review screen
 * had to design around.
 *
 * `scheduled` and `unscheduled` are the whole day the patch would install, as
 * the person would see it (their removals kept off it, #610), so a client can
 * render the proposed day beside the current one without replaying the diff
 * itself. `changes` is what moved between them.
 */
/**
 * What the patch would do to one block the user protected (#522, #523).
 *
 * Without this the review surface is physically unable to say "this moves an
 * hour you protected": `planToDto.protections` describes the plan *in force*,
 * and a proposal is a different placement of the same blocks. A person asked
 * to approve a patch that overrides their own declaration, on a screen that
 * cannot show them it does, has not consented to it.
 *
 * `overridden` is decided by the scheduler's own `withinMaxShift`, given the
 * real `PlanningItem` from the stored request with the block's *current*
 * protection substituted — never by a second copy of that arithmetic here, and
 * never by the client. The protection lives on the block (the protect mutation
 * writes there), while the bound's semantics live in the solver; this joins the
 * two rather than restating either.
 *
 * A protected block the patch leaves unscheduled is `overridden` with a null
 * `proposedInterval`: taking the placement away entirely is the strongest
 * override there is, not the absence of one.
 */
export interface ProposedProtectionDto {
  readonly blockId: string;
  readonly itemId: string;
  readonly title: string | null;
  readonly origin: string;
  /** What the user declared they wanted kept. */
  readonly preferredInterval: TimeInterval | null;
  readonly maxShiftMinutes: number | null;
  /** Where the patch would put it; null when the patch leaves it unplaced. */
  readonly proposedInterval: TimeInterval | null;
  readonly overridden: boolean;
}

export interface PendingPlanProposalDto {
  readonly proposalId: string;
  readonly proposedAt: string;
  /** The generation this patches. Equal to the plan's own, by construction. */
  readonly baseGeneration: number;
  /** Why the policy layer staged this instead of applying it. */
  readonly reason: string;
  readonly userControlMode: string;
  /** The changes whose own impact produced this offer (#527, AC 2). */
  readonly causeChangeIds: readonly string[];
  readonly scheduled: readonly PlanItemDto[];
  readonly unscheduled: readonly UnplacedItemDto[];
  readonly changes: readonly PlanProposalChangeDto[];
  /**
   * Every protected block, and what the patch would do to it. Unprotected
   * blocks are absent, on the same terms as `DailyPlanDto.protections`.
   */
  readonly protections: readonly ProposedProtectionDto[];
}

function proposalChangeDto(change: PlanItemChange, titles: ReadonlyMap<string, string>): PlanProposalChangeDto {
  const row = change as {
    from?: TimeInterval | string;
    to?: TimeInterval | string;
    at?: TimeInterval;
    shiftMinutes?: number;
  };
  const interval = (value: TimeInterval | string | undefined): TimeInterval | null =>
    (typeof value === 'object' && value !== null ? value : null);
  const code = (value: TimeInterval | string | undefined): string | null =>
    (typeof value === 'string' ? value : null);
  return {
    kind: change.kind,
    itemId: change.itemId,
    title: titles.get(change.itemId) ?? null,
    from: interval(row.from),
    to: interval(row.to) ?? row.at ?? null,
    shiftMinutes: row.shiftMinutes ?? null,
    fromReasonCode: code(row.from),
    toReasonCode: code(row.to),
  };
}

/**
 * The proposal the client may act on, or null.
 *
 * Pure and synchronous, like `planToDto`, and reading the same document: the
 * proposal lives on the plan, so exposing it needs no second read and the
 * route can assemble both keys from one `readStoredPlan`.
 *
 * `pendingProposalOf` is what decides whether there is one — a patch whose
 * base no longer matches the document is withheld here rather than shown with
 * a flag, because a client handed a proposal will offer a button for it, and
 * the button would install a plan solved against a state that is gone.
 */
export function pendingProposalToDto(
  stored: StoredDailyPlan,
  titles: ReadonlyMap<string, string>,
): PendingPlanProposalDto | null {
  const proposal = pendingProposalOf(stored);
  if (proposal === null) return null;
  // The day the patch would produce, as accepting it installs it: the
  // person's removals stay off it (#610). `changes` is the diff of that same
  // visible day, so the two agree on which items the offer is about.
  const proposedDay = planUnderKeptRemovals(proposal.plan, stored.edits.removals);

  const blockByItemId = new Map((stored.blocks ?? [])
    .filter((block) => block.mobility !== 'fixed')
    .map((block) => [block.source.id, block.blockId] as const));

  return {
    proposalId: proposal.proposalId,
    proposedAt: proposal.proposedAt,
    baseGeneration: proposal.baseGeneration,
    reason: proposal.reason,
    userControlMode: proposal.userControlMode,
    causeChangeIds: [...proposal.causeChangeIds],
    scheduled: proposedDay.scheduled.map((item) => ({
      itemId: item.itemId,
      title: titles.get(item.itemId) ?? null,
      startsAt: item.interval.startsAt,
      endsAt: item.interval.endsAt,
      blockId: blockByItemId.get(item.itemId) ?? null,
    })),
    unscheduled: proposedDay.unscheduled.map((item: UnscheduledItem) => ({
      itemId: item.itemId,
      title: titles.get(item.itemId) ?? null,
      reasonCode: item.reason.code,
      blockId: blockByItemId.get(item.itemId) ?? null,
    })),
    changes: proposal.diff.changes.map((change) => proposalChangeDto(change, titles)),
    protections: proposedProtections(stored, proposal.plan, titles),
  };
}

function proposedProtections(
  stored: StoredDailyPlan,
  plan: StoredPlanProposal['plan'],
  titles: ReadonlyMap<string, string>,
): ProposedProtectionDto[] {
  const placed = new Map(plan.scheduled.map((item) => [item.itemId, item.interval] as const));
  // The solver's own view of each item, as the stored request holds it. The
  // protection is taken from the block instead, because the protect mutation
  // writes there and the request may be a generation behind it.
  const itemById = new Map(stored.constraints.items.map((item) => [item.itemId, item] as const));

  return (stored.blocks ?? []).flatMap((block) => {
    const protection = block.protection ?? null;
    if (protection === null || ownershipOf(block) !== 'protected_flexible') return [];
    const proposedInterval = placed.get(block.source.id) ?? null;
    const item = itemById.get(block.source.id);
    const overridden = proposedInterval === null
      || item === undefined
      || !withinMaxShift({ ...item, protection } satisfies PlanningItem, toEpochMs(proposedInterval.startsAt));
    return [{
      blockId: block.blockId,
      itemId: block.source.id,
      title: titles.get(block.source.id) ?? null,
      origin: protection.origin,
      preferredInterval: protection.preferredInterval,
      maxShiftMinutes: protection.maxShiftMinutes,
      proposedInterval,
      overridden,
    }];
  });
}
