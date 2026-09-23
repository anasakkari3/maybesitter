import type { PlanPreviewItem } from '../today/dayContext';
import { ltr } from '../../i18n/strings';
import React from 'react';
import { View } from 'react-native';
import { useLayoutMode } from '../../theme/textScale';
import { CalendarIcon, CheckIcon } from '../../ui/icons';
import { useApp } from '../../state/AppContext';
import { useTimeZone } from '../../i18n/timezone';
import { dayKey, formatTime } from '../../i18n/format';
import { usePlan } from '../../api/queries';
import { Btn, Txt } from '../../ui/primitives';
import type { PlanRow as PlanRowModel } from '../today/composeToday';

/**
 * The way into today's plan from Today (UC-3.10b #195; Round 2, Phase C).
 *
 * ── It is always there, and it is honest ─────────────────────────
 *
 * Round 1's card appeared only when a plan existed and vanished while
 * loading, on failure, and after "not today". A plan that failed to load was
 * indistinguishable from no plan. Round 2 makes this a row that says which of
 * six things is true — loading, failed, none, proposed, accepted, dismissed —
 * so the screen cannot imply a state it does not know.
 *
 * ── A proposal looks like a proposal ─────────────────────────────
 *
 * The dashed edge in the proposal colour is the same promise the next-step
 * card makes: nothing has been written. An accepted plan has a solid card and
 * the accent on its icon.
 *
 * ── A dismissed plan stays dismissed ─────────────────────────────
 *
 * "Not today" is an answer. The row does not come back offering to make a new
 * one — that would be this app asking twice. It says the plan was left aside
 * and still opens it, because the answer can be changed; it is never pushed.
 *
 * ── The date is the device's day, the times are the plan's ───────
 *
 * This row means "the plan for the day I am in", so it asks with the device's
 * zone. Once opened, `PlanScreen` reads every time in the plan's own zone.
 */
export function TodayPlanRow({ row, preview = [] }: { row: PlanRowModel; preview?: readonly PlanPreviewItem[] }) {
  const { t, tr, p, lang, actions } = useApp();
  const timezone = useTimeZone();
  const stacked = useLayoutMode() !== 'normal';
  const date = dayKey(new Date(), timezone);
  const query = usePlan(date);

  const proposed = row.kind === 'proposed';
  const accepted = row.kind === 'accepted';
  const title = row.kind === 'proposed' ? t.planRowProposal
    : row.kind === 'none' ? t.planRowNone
    : t.planTitle;
  const sub = row.kind === 'loading' ? t.planRowLoading
    : row.kind === 'error' ? t.planRowFailed
    : row.kind === 'none' ? t.planRowNoneSub
    : row.kind === 'dismissed' ? t.planRowDismissedSub
    : row.kind === 'proposed' ? t.planRowProposalSub
    : tr('planCardPlaced', { n: row.placed });
  const cta = row.kind === 'error' ? t.errorsRetry
    : row.kind === 'none' ? t.planRowMake
    : row.kind === 'loading' ? null
    : t.planRowOpen;
  const onPress = row.kind === 'error' ? () => void query.refetch()
    : row.kind === 'loading' ? undefined
    : () => actions.openPlan(date);

  const stateLabels = { done: t.planPreviewDone, next: t.planPreviewNext, planned: t.planPreviewPlanned, proposed: t.planPreviewProposed };
  const timeOf = (item: PlanPreviewItem) => ltr(formatTime(new Date(item.startsAt), { locale: lang, timeZone: query.data?.timezone ?? timezone }));
  const description = preview.map(item => `${item.title}, ${timeOf(item)}, ${stateLabels[item.state]}`).join('. ');

  return (
    <Btn
      label={`${title}. ${sub}${description ? `. ${description}` : ''}`}
      testID="today-plan-card"
      onPress={onPress}
      disabled={!onPress}
      scaleTo={0.98}
      style={{
        flexDirection: 'column', alignItems: 'stretch', gap: 12, minHeight: 56,
        backgroundColor: p.sf, borderRadius: 20, paddingVertical: 12, paddingHorizontal: 14,
        borderWidth: 1, borderColor: proposed ? p.prop : p.ln, borderStyle: proposed ? 'dashed' : 'solid',
      }}
    >
      <View style={{ flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'flex-start' : 'center', gap: 12 }}>
        <View style={{ width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: accepted ? p.acs : p.sf2 }}>
          <CalendarIcon color={accepted ? p.acd : p.mu} />
        </View>
        <View style={{ ...(stacked ? {} : { flex: 1 }), gap: 4 }}>
          <Txt size={15} weight={600} testID="today-plan-title">{title}</Txt>
          <Txt role="supporting" color={p.mu} testID="today-plan-summary">{sub}</Txt>
        </View>
        {cta ? <Txt size={13} weight={600} color={p.acd} testID="today-plan-open">{cta}</Txt> : null}
      </View>
      {preview.length > 0 ? (
        <View testID="today-plan-preview">
          {preview.map(item => (
            <View key={item.id} testID={`today-plan-preview-${item.id}`} style={{ paddingVertical: 10, borderTopWidth: 1, borderTopColor: p.ln, gap: 4, alignItems: 'flex-start' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                {item.state === 'done' ? <CheckIcon size={16} color={p.acd} /> : null}
                <Txt role="body" style={{ flex: 1 }} color={item.state === 'done' ? p.mu : p.tx}>{item.title}</Txt>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                <Txt role="supporting" color={p.mu}>{timeOf(item)}</Txt>
                <Txt role="supporting" color={item.state === 'done' ? p.acd : p.mu}>{stateLabels[item.state]}</Txt>
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </Btn>
  );
}
