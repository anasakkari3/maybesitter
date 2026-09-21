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
import type { TimeInterval, UnscheduledItem } from '../../../src/contracts/v1/planningContracts';
import { ownershipOf } from '../../../src/contracts/v1/scheduleBlockContracts';
import { effectiveSchedule } from './planActions';
import type { StoredDailyPlan } from './planStore';

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
