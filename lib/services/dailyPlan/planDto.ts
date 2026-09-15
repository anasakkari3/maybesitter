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
import type { UnscheduledItem } from '../../../src/contracts/v1/planningContracts';
import { effectiveSchedule } from './planActions';
import type { StoredDailyPlan } from './planStore';

export interface PlanItemDto {
  readonly itemId: string;
  readonly title: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface UnplacedItemDto {
  readonly itemId: string;
  readonly title: string | null;
  readonly reasonCode: string;
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
}

export function planToDto(stored: StoredDailyPlan, titles: ReadonlyMap<string, string>): DailyPlanDto {
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
    })),
    unscheduled: stored.plan.unscheduled.map((item: UnscheduledItem) => ({
      itemId: item.itemId,
      title: titles.get(item.itemId) ?? null,
      reasonCode: item.reason.code,
    })),
    edited: stored.edits.moves.length > 0 || stored.edits.removals.length > 0,
  };
}
