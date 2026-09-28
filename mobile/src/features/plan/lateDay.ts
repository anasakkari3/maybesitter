import type { DailyPlan, PlanItem } from '../../api/schemas/plan';
import { dayKey } from '../../i18n/format';

/**
 * The two readings the plan screen makes of a day that is running out (L5).
 *
 * Pure, and handed the clock, so the tests do not depend on when they run.
 */

/** The calendar date after a `YYYY-MM-DD`. Civil arithmetic, no zone. */
export function dayAfter(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/**
 * Whether the plan is today's, in its own zone, and the day's working hours
 * are already over.
 *
 * A plan built after them places nothing — there is no time left to place
 * into — and an empty list there reads as "nothing to do", which is not what
 * happened. `workingEndsAt` is the server's (the end of the last working
 * window); a server that does not send it gets the old screen.
 */
export function workingHoursOver(plan: Pick<DailyPlan, 'date' | 'timezone' | 'workingEndsAt'>, now: Date): boolean {
  if (!plan.workingEndsAt) return false;
  if (plan.date !== dayKey(now, plan.timezone)) return false;
  return now.getTime() >= Date.parse(plan.workingEndsAt);
}

export type PlanRow =
  | { readonly kind: 'planned'; readonly item: PlanItem }
  | { readonly kind: 'fixed'; readonly item: PlanItem };

/**
 * The day in time order: what the planner placed and what is pinned to a time,
 * interleaved. On a tie the placed item comes first, which is the order the
 * server lists them in.
 */
export function planRows(plan: Pick<DailyPlan, 'scheduled' | 'fixed'>): PlanRow[] {
  const rows: PlanRow[] = [
    ...plan.scheduled.map(item => ({ kind: 'planned' as const, item })),
    ...(plan.fixed ?? []).map(item => ({ kind: 'fixed' as const, item })),
  ];
  return rows.sort((left, right) => Date.parse(left.item.startsAt) - Date.parse(right.item.startsAt));
}
