import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { QueryBoundary } from '../../api/ui/QueryBoundary';
import { forbiddenReason } from '../../api/ui/userFacingMessage';
import type { IntelligenceSuggestion } from '../../api/schemas/intelligence';
import { formatDate, formatTime } from '../../i18n/format';
import { isolateAuto } from '../../i18n/bidi';
import { useTimeZone } from '../../i18n/timezone';
import { useLayoutMode } from '../../theme/textScale';
import { AvatarButton, ScreenHeader, TextLink } from '../../ui/chrome';
import { HubHeading, HubRow } from '../../ui/hub';
import { Card, Pill, Txt } from '../../ui/primitives';
import { Screen, ScreenScroll, TAB_CLEARANCE } from '../../ui/screen';
import { ServerToggle } from '../settings/ServerToggle';
import { AvailabilityBadge } from '../../ui/product';
import { monitorTitleFor } from '../product/WatcherScreens';
import { useBackgroundActivity, useSetBackgroundActivityPaused } from '../product/useWatchers';
import { useIntelligenceInbox } from './useIntelligenceInbox';

/**
 * «يتابع لك» (Stitch redesign, 2026-10-02): what the assistant noticed, what it
 * is asking, and what it keeps an eye on.
 *
 *   Questions and suggestions  the proactive loop's pending items, read-only.
 *     Answering and deciding stay on the screen that already does both (the
 *     Goals screen's panel); a card here says what is waiting and opens it.
 *     Every suggestion carries «هذا اقتراح. لم يتغيّر أي شيء بعد.».
 *   Watches  the background monitors with their last check, each opening
 *     Background activity; «تابعلي هالإشي» opens the builder.
 *   «شو بيعرف» opens Knows; the pause switch is Background activity's own.
 *
 * Nothing is invented: an empty inbox and no watches say so.
 */
export function WatchingScreen({ tabClearance = TAB_CLEARANCE }: { tabClearance?: number } = {}) {
  const { t, p, lang, actions } = useApp();
  const zone = useTimeZone();
  const inbox = useIntelligenceInbox();
  const activity = useBackgroundActivity();
  const setPaused = useSetBackgroundActivityPaused();

  // The loop switched off on the server is a state, not a failure: the
  // section says there is nothing yet instead of offering a Retry that
  // could not change it.
  const inboxOff = forbiddenReason(inbox.error) !== null;
  const pending = (inbox.data?.suggestions ?? []).filter(item => item.status === 'pending');
  const questions = pending.filter(item => item.kind === 'question');
  const suggestions = pending.filter(item => item.kind !== 'question');
  const monitors = activity.data?.monitors ?? [];

  const instant = (value: string | null) => value
    ? `${formatDate(new Date(value), 'short', { locale: lang, timeZone: zone })} · ${formatTime(new Date(value), { locale: lang, timeZone: zone })}`
    : t.xNotObserved;

  return (
    <Screen testID="watching-root">
      <ScreenScroll testID="watching-scroll" floating={tabClearance} gap={12} topGap={8}>
        <ScreenHeader brand={false} title={t.tabWatching} end={<AvatarButton />} />
        <Txt role="supporting" color={p.mu}>{t.watchingBody}</Txt>

        {inboxOff ? (
          <Txt role="supporting" color={p.mu} testID="watching-nothing">{t.watchingNothing}</Txt>
        ) : (
          <QueryBoundary isPending={inbox.isPending} error={inbox.error} onRetry={() => void inbox.refetch()}>
            {pending.length === 0 ? <Txt role="supporting" color={p.mu} testID="watching-nothing">{t.watchingNothing}</Txt> : null}
            {questions.length > 0 ? <>
              <HubHeading title={t.watchingQuestions} icon="bulb" count={questions.length} testID="watching-questions" />
              {questions.map(item => (
                <InboxCard key={item.id} item={item} action={t.watchingAnswer} onOpen={() => actions.go('goalExecution')} />
              ))}
            </> : null}
            {suggestions.length > 0 ? <>
              <HubHeading title={t.watchingSuggestions} icon="sparkles" count={suggestions.length} testID="watching-suggestions" />
              {suggestions.map(item => (
                <InboxCard key={item.id} item={item} kind={t.weekProposal} action={t.watchingReview} note={t.suggestionNote} onOpen={() => actions.go('goalExecution')} />
              ))}
            </> : null}
          </QueryBoundary>
        )}

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

        <HubRow testID="watching-knows" icon="search" title={t.knowsTitle} onPress={() => actions.go('knows')} />

        {activity.data ? (
          <Card pad={0} style={{ paddingHorizontal: 16 }}>
            <ServerToggle title={t.watchingPauseAll} testID="watching-pause" value={activity.data.paused} onChange={async paused => {
              await setPaused.mutateAsync(paused);
              return true;
            }} />
          </Card>
        ) : null}
      </ScreenScroll>
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

/**
 * One pending question or suggestion (Stitch `05`): what kind it is, its
 * words, why, the way to it, and — under a rule — that nothing has changed.
 */
function InboxCard({ item, kind, action, note, onOpen }: { item: IntelligenceSuggestion; kind?: string; action: string; note?: string; onOpen: () => void }) {
  const { p } = useApp();
  const stacked = useLayoutMode() !== 'normal';
  return (
    <Card testID={`watching-item-${item.id}`} style={{ gap: 10, backgroundColor: p.sf }}>
      {kind ? <Txt size={13} weight={700} color={p.wm}>{kind}</Txt> : null}
      <Txt size={17} weight={700}>{isolateAuto(item.title)}</Txt>
      {item.reason ? <Txt role="supporting" color={p.mu}>{isolateAuto(item.reason)}</Txt> : null}
      <View style={{ flexDirection: stacked ? 'column' : 'row' }}>
        <Pill label={action} onPress={onOpen} testID={`watching-open-${item.id}`} size={15} weight={700} pad={10} style={{ minHeight: 48 }} />
      </View>
      {note ? <Txt size={13} color={p.mu} style={{ borderTopWidth: 1, borderTopColor: p.ln, paddingTop: 10 }}>{note}</Txt> : null}
    </Card>
  );
}
