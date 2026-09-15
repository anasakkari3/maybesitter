import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Card, Txt } from '../../ui/primitives';
import type { WeeklySummary } from '../../api/schemas/activity';

/**
 * The week, in three positive counts (UC-3.15, #201).
 *
 * ── What is deliberately absent ──────────────────────────────────
 *
 * No streak, no percentage, no "you missed N", no badge that can be lost, no
 * comparison with last week. #201 decided this surface is not gamified, and
 * the absence is the feature: a number that can go down is a number the
 * product uses to push, and this screen exists so somebody can notice progress
 * without being ranked.
 *
 * ── A week with nothing in it ────────────────────────────────────
 *
 * All three zero renders one line — "A quiet week. That's okay." — and not
 * three zeroes. "0 completed" is a scoreboard reading, and the person most
 * likely to be looking at it is the person who had the hardest week.
 */
export function WeekCard({ summary }: { summary: WeeklySummary }) {
  const { t, tr, p } = useApp();
  const quiet = summary.completedCount === 0 && summary.plannedDaysCount === 0 && summary.keptCount === 0;

  return (
    <Card pad={18} style={{ gap: 10 }} testID="activity-week">
      <Txt size={13} weight={600} color={p.mu}>{t.activityWeekTitle}</Txt>
      {quiet ? (
        <Txt size={15} lh={1.5} testID="activity-week-quiet">{t.activityWeekQuiet}</Txt>
      ) : (
        <View style={{ gap: 6 }}>
          {/* `tr`, not `fill`: these are ICU plurals, and Arabic has six
              categories that a placeholder substitution cannot inflect. */}
          <Txt size={15} lh={1.5} testID="activity-week-done">
            {tr('activityWeekDone', { n: summary.completedCount })}
          </Txt>
          <Txt size={15} lh={1.5} testID="activity-week-planned">
            {tr('activityWeekPlanned', { n: summary.plannedDaysCount })}
          </Txt>
          <Txt size={15} lh={1.5} testID="activity-week-kept">
            {tr('activityWeekKept', { n: summary.keptCount })}
          </Txt>
        </View>
      )}
    </Card>
  );
}
