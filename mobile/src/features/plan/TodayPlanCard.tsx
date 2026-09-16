import React from 'react';
import { useApp } from '../../state/AppContext';
import { useTimeZone } from '../../i18n/timezone';
import { dayKey } from '../../i18n/format';
import { usePlan } from '../../api/queries';
import { Btn, Card, Txt } from '../../ui/primitives';

/**
 * The way into today's plan from Today (UC-3.10b, #195 step 4).
 *
 * ── It appears only when there is something to appear about ──────
 *
 * `usePlan` answers `null` for a day with no plan, and this renders nothing
 * for that — and nothing while it is loading, and nothing when it failed. No
 * skeleton, no error, no Retry. Today's own list is the screen; a card *above*
 * it that spun or apologised would make the plan's problems into the day's,
 * which is the same reasoning `NextStepCard` sits outside Today's boundary
 * for. Somebody with no signal sees the day they came here to read.
 *
 * ── A dismissed plan stays dismissed ─────────────────────────────
 *
 * "Not today" is an answer. Putting the card back at the top of Today after
 * somebody has given it would be this app asking a second time — and this
 * product's whole claim is that it does not nag. The plan is still reachable
 * from Settings and from its own link; what it does not do is come back
 * uninvited.
 *
 * ── The date is the device's day, the times are the plan's ───────
 *
 * This card means "the plan for the day I am in", so it asks with the device's
 * zone. Once opened, `PlanScreen` reads every time in the plan's own zone —
 * the two differ for anyone who has travelled since morning.
 */
export function TodayPlanCard() {
  const { t, tr, p, actions } = useApp();
  const timezone = useTimeZone();
  const date = dayKey(new Date(), timezone);
  const query = usePlan(date);
  const plan = query.data ?? null;

  if (!plan || plan.status === 'dismissed') return null;

  const accepted = plan.status === 'accepted';

  return (
    <Card pad={0} style={{ overflow: 'hidden' }} testID="today-plan-card">
      <Btn
        label={t.planTitle}
        testID="today-plan-open"
        onPress={() => actions.openPlan(date)}
        style={{ paddingHorizontal: 18, paddingVertical: 16, gap: 4, alignItems: 'flex-start' }}
      >
        <Txt size={16} weight={600}>{t.planTitle}</Txt>
        <Txt size={13} color={accepted ? p.ac : p.mu} lh={1.5} testID="today-plan-summary">
          {accepted ? t.planAcceptedStatus : tr('planCardPlaced', { n: plan.scheduled.length })}
        </Txt>
      </Btn>
    </Card>
  );
}
