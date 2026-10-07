import React from 'react';
import { View } from 'react-native';
import { useUpcomingPlans } from '../../api/queries';
import { isolateAuto } from '../../i18n/bidi';
import { fill } from '../../i18n/strings';
import { useApp } from '../../state/AppContext';
import { Btn, Txt } from '../../ui/primitives';
import { ReferenceCard, useReferencePalette } from '../../ui/referenceDesign';
import { PlanFlowView } from './PlanFlow';
import type { PlanRecovery } from './planFailures';
import { useGoalPlanFlow } from './useGoalPlanFlow';

/** What Today's card can do for a plan failure: show the goal (what was saved, or the new goal), or the goals list. */
const CARD_RECOVERIES: readonly PlanRecovery[] = ['see_saved', 'open_new_goal', 'back_to_goals'];

/**
 * «أسبوع 3 قرّب: حطّلها وقت» on Today (M3A-012, -033).
 *
 * A plan's steps after day 14 keep their week and get no time until that
 * week is near. Nothing in the background places them: the person does,
 * from this card, through the same times → confirm screens, against the
 * calendar as it is then. One card at a time — the first the server lists —
 * so Today never fills with plan reminders. Off, or failing, it shows nothing.
 */
export function UpcomingPlanCard() {
  const { t, tr, actions } = useApp();
  const p = useReferencePalette();
  const upcoming = useUpcomingPlans();
  const flow = useGoalPlanFlow();
  const first = upcoming.data?.[0];
  const open = flow.state.goalId !== null;
  const onRecover = (recovery: PlanRecovery | 'open_today', detail: { currentGoalId?: string | undefined }) => {
    if (recovery === 'open_new_goal' && detail.currentGoalId) return actions.openGoal(detail.currentGoalId);
    if (recovery === 'see_saved' && flow.state.goalId) return actions.openGoal(flow.state.goalId);
    if (recovery === 'back_to_goals') { flow.reset(); return actions.go('goalExecution'); }
    return flow.reset();
  };
  if (!first && !open) return null;
  return <View style={{ gap: 10 }}>
    {first && !open ? <Btn
      testID="plan-upcoming-card"
      label={`${fill(t.xPlanUpcomingTitle, { n: first.weekIndex })}. ${tr('xPlanUpcomingBodyN', { n: first.stepCount, goal: isolateAuto(first.goalTitle) })} ${t.xPlanUpcomingCta}`}
      onPress={() => flow.laterWeek(first.goalId, first.planId, first.weekIndex)}
      style={{ borderRadius: 20 }}
    >
      <ReferenceCard pad={18}>
        <Txt size={15} weight={600}>{fill(t.xPlanUpcomingTitle, { n: first.weekIndex })}</Txt>
        <Txt size={14} color={p.mu}>{tr('xPlanUpcomingBodyN', { n: first.stepCount, goal: isolateAuto(first.goalTitle) })}</Txt>
        <Txt size={14} weight={600} color={p.ac}>{t.xPlanUpcomingCta}</Txt>
      </ReferenceCard>
    </Btn> : null}
    {open ? <ReferenceCard pad={18}><PlanFlowView flow={flow} onRecover={onRecover} hostRecoveries={CARD_RECOVERIES} /></ReferenceCard> : null}
  </View>;
}
