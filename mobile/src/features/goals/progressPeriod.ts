import { civilDate, dayKey, shiftDayKey } from '../../i18n/format';
import type { Lang } from '../../i18n/strings';
import type { GoalProgressPeriod } from '../../api/schemas/goals';

/** Match the product's locale week without asking the server to infer a period. */
export function currentGoalProgressPeriod(now: Date, timeZone: string, lang: Lang): GoalProgressPeriod {
  const today = dayKey(now, timeZone);
  const weekday = civilDate(today).getUTCDay();
  const weekStartsOn = lang === 'en' ? 1 : 0;
  const daysSinceStart = (weekday - weekStartsOn + 7) % 7;
  const fromLocalDate = shiftDayKey(today, -daysSinceStart);
  return { fromLocalDate, toLocalDate: shiftDayKey(fromLocalDate, 6) };
}
