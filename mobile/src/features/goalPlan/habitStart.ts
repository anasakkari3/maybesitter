import type { GoalPlanPhase } from '../../api/schemas/goalPlan';

/**
 * When a habit's week begins, as the times stage must say it (#751, SIM-A4).
 *
 * A habit's line is its weekdays and a time: «خميس، جمعة، سبت · 08:00». For a
 * habit in the plan's second week that reads as this week's Friday, where the
 * person may well have something at eight, and looks like a clash that is not
 * one. So a habit whose week has not begun says when it does.
 *
 * The week is found the way the server places it (`datesFor`,
 * goalPlanService): a week phase starts `(index − 1) × 7` days after the
 * plan's anchor; a day phase belongs to the week its day falls in.
 */
export type HabitStart =
  | { kind: 'now' }
  | { kind: 'next_week' }
  | { kind: 'date'; key: string };

const DAY_MS = 86_400_000;

function addDays(key: string, days: number): string | null {
  const start = Date.parse(`${key}T00:00:00Z`);
  return Number.isFinite(start) ? new Date(start + days * DAY_MS).toISOString().slice(0, 10) : null;
}

export function habitStart(phase: GoalPlanPhase | null | undefined, anchorKey: string, todayKey: string): HabitStart {
  if (!phase) return { kind: 'now' };
  const offset = phase.unit === 'week' ? (phase.index - 1) * 7 : Math.floor((phase.index - 1) / 7) * 7;
  const key = addDays(anchorKey, offset);
  const today = Date.parse(`${todayKey}T00:00:00Z`);
  if (key === null || !Number.isFinite(today)) return { kind: 'now' };
  const ahead = Math.round((Date.parse(`${key}T00:00:00Z`) - today) / DAY_MS);
  if (ahead <= 0) return { kind: 'now' };
  // Within the coming seven days is «من الأسبوع الجاي» (the owner's words,
  // 2026-10-09); further out, the words would be wrong, so the date is said.
  return ahead <= 7 ? { kind: 'next_week' } : { kind: 'date', key };
}
