import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { QueryBoundary } from '../../api/ui/QueryBoundary';
import { formatDate, formatTime } from '../../i18n/format';
import { useTimeZone } from '../../i18n/timezone';
import { AvatarButton, ScreenHeader, TextLink } from '../../ui/chrome';
import { HubHeading, HubRow } from '../../ui/hub';
import { Card, Txt } from '../../ui/primitives';
import { Screen, ScreenScroll, TAB_CLEARANCE } from '../../ui/screen';
import { ServerToggle } from '../settings/ServerToggle';
import { AvailabilityBadge } from '../../ui/product';
import { monitorTitleFor } from '../product/WatcherScreens';
import { useBackgroundActivity, useSetBackgroundActivityPaused } from '../product/useWatchers';
import { IntelligencePanel } from '../goals/IntelligencePanel';
import { useIntelligenceDecided } from '../../api/queries';
import { AvoidKeyboard } from '../../ui/keyboard';

/**
 * «يتابع لك» (Stitch redesign, 2026-10-02): what the assistant noticed, what it
 * is asking, and what it keeps an eye on.
 *
 *   Noticed, asked, suggested  the proactive loop's own review panel
 *     (`IntelligencePanel`), actionable here: each suggestion with its
 *     evidence, accept / not for me / edit, answers to questions, and
 *     «هذا اقتراح. لم يتغيّر أي شيء بعد.». Nothing is saved without a tap.
 *     What is waiting is read first; fresh suggestions are asked for in the
 *     background as a visit, within the phone's and the server's limits
 *     (review of 2026-10-03: the hub used to only read, and its cards led to
 *     a panel production never showed). A decision refreshes Today, «أشيائي»
 *     and the plan. Edit fields stay above the keyboard (`AvoidKeyboard`).
 *   Watches  the background monitors with their last check, each opening
 *     Background activity; «تابعلي هالإشي» opens the builder.
 *   «شو بيعرف» opens Knows; the pause switch is Background activity's own.
 *
 * Nothing is invented: a loop switched off on the server and an empty watch
 * list say so, without an error to retry.
 */
export function WatchingScreen({ tabClearance = TAB_CLEARANCE }: { tabClearance?: number } = {}) {
  const { t, p, lang, actions } = useApp();
  const zone = useTimeZone();
  const activity = useBackgroundActivity();
  const setPaused = useSetBackgroundActivityPaused();
  const decided = useIntelligenceDecided();
  const monitors = activity.data?.monitors ?? [];

  const instant = (value: string | null) => value
    ? `${formatDate(new Date(value), 'short', { locale: lang, timeZone: zone })} · ${formatTime(new Date(value), { locale: lang, timeZone: zone })}`
    : t.xNotObserved;

  return (
    <Screen testID="watching-root">
      <AvoidKeyboard testID="watching-kav">
      <ScreenScroll testID="watching-scroll" floating={tabClearance} gap={12} topGap={8} keyboardShouldPersistTaps="handled">
        <ScreenHeader brand={false} title={t.tabWatching} end={<AvatarButton />} />
        <Txt role="supporting" color={p.mu}>{t.watchingBody}</Txt>
        <HubRow testID="watching-knows" icon="person" title={t.knowsTitle} onPress={() => actions.go('knows')} />

        <IntelligencePanel
          autoGenerate
          onChanged={decided}
          whenOff={<Txt role="supporting" color={p.mu} testID="watching-nothing">{t.watchingNothing}</Txt>}
        />

        <HubHeading title={t.watchingWatches} icon="eye" count={activity.data ? monitors.length : undefined} testID="watching-watches"
          end={<TextLink label={t.xWatch} testID="watching-add" onPress={() => actions.go('watchBuilder')} />} />
        <QueryBoundary isPending={activity.isPending} error={activity.error} onRetry={() => void activity.refetch()}>
          {monitors.length === 0 ? <Txt role="supporting" color={p.mu} testID="watching-no-watches">{t.xNoWatches}</Txt> : null}
          <View style={{ gap: 10 }}>
            {monitors.map(monitor => (
              <HubRow
                key={monitor.monitorId}
                testID={`watching-watch-${monitor.watcherId ?? monitor.monitorId}`}
                icon="eye"
                tone={monitor.status === 'active' ? 'success' : monitor.status === 'paused' ? 'neutral' : 'attention'}
                title={monitorTitleFor(t, monitor.label, monitor.title)}
                sub={`${t.xLastChecked}: ${instant(monitor.lastCheckedAt)}`}
                badge={<WatchState status={monitor.status} id={monitor.watcherId ?? monitor.monitorId} />}
                onPress={() => actions.go('backgroundActivity')}
              />
            ))}
          </View>
          <Txt role="supporting" color={p.mu}>{t.xWatchLimits}</Txt>
        </QueryBoundary>

        {activity.data && monitors.length > 0 ? (
          <Card pad={0} style={{ paddingHorizontal: 16 }}>
            <ServerToggle title={t.watchingPauseAll} testID="watching-pause" value={activity.data.paused} onChange={async paused => {
              await setPaused.mutateAsync(paused);
              return true;
            }} />
          </Card>
        ) : null}
      </ScreenScroll>
      </AvoidKeyboard>
    </Screen>
  );
}

/**
 * A watch's state in words, as Background activity says it: running,
 * retrying (the next try is already scheduled), paused, or in the way.
 */
function WatchState({ status, id }: { status: string; id: string }) {
  const { t, p } = useApp();
  if (status === 'retrying') return <Txt size={13} weight={600} color={p.wm} testID={`watching-state-${id}`}>{t.xFootballRetrying}</Txt>;
  const badge = status === 'needs_reauth' ? 'NEEDS_REAUTH' as const
    : status === 'blocked_permission' || status === 'error' ? 'BLOCKED' as const
    : status === 'active' ? 'LIVE' as const : null;
  return badge
    ? <AvailabilityBadge status={badge} testID={`watching-state-${id}`} />
    : <Txt size={13} weight={600} color={p.wm} testID={`watching-state-${id}`}>{t.xPaused}</Txt>;
}
