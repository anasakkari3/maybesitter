import React, { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { useTimeZone } from '../i18n/timezone';
import { formatDate, formatTime } from '../i18n/format';
import { ltr, type Lang } from '../i18n/strings';
import { useCommitmentAction, useToday } from '../api/queries';
import { QueryBoundary } from '../api/ui/QueryBoundary';
import { groupForToday, topItemFor, type CommitmentView, type TodayGroups } from '../features/commitments/model';
import { rowAccessibilityLabel } from '../features/commitments/accessibility';
import { SwipeableRow, useRowActions } from '../features/commitments/RowActions';
import { postponeTo } from '../features/commitments/postpone';
import { whyFirstLine } from '../features/commitments/whyFirst';
import { NextStepCard } from '../features/nextStep/NextStepCard';
import { BusyConflictChip } from '../features/calendar/BusyConflictChip';
import { useBusyBlocks } from '../features/calendar/useBusyCalendar';
import { busyAt } from '../features/calendar/conflicts';
import type { DeviceBusyBlock } from '../features/calendar/busyBlocks';
import { Btn, Card, Pill, Txt } from '../ui/primitives';
import { CheckIcon, Glow } from '../ui/icons';
import { ScreenIn } from '../ui/motion';

/**
 * Today, from the account (UC-2.R3 #173, ordering from UC-2.8 #169).
 *
 * ── A deadline is a point, not a block ───────────────────────────
 *
 * The round-1 design drew each commitment as a block on a timeline, sized by a
 * `dur` field the design prototype invented. The domain has no such field, and
 * checking why is the whole story: `mapExtractionToCommand.ts` only ever emits
 * `due_by` or `unscheduled`, and nothing in the product creates a
 * `scheduled_event`. Every commitment here is a *deadline*.
 *
 * So they are drawn as marks at their time rather than as blocks with extent.
 * Nothing is invented, and the screen stops implying the user said how long
 * something would take when they only said when it was due. Calendar busy
 * blocks genuinely do have a duration and will be drawn with one when the S3
 * calendar work lands.
 *
 * ── The groups are the user's answer, and ranking works inside them ──
 *
 * Must, Should and Nice come from the priority the user set. #169's rank
 * orders items *within* a group and never across, so an estimate can never
 * lift a Nice above a Must. `groupForToday` owns that rule and is tested
 * separately from this screen.
 *
 * ── One card explains itself ─────────────────────────────────────
 *
 * The first open item in the first non-empty group, and only when it has a
 * reason worth giving. Every card explaining itself is no explanation at all.
 */
export function TodayScreen() {
  const { t, tr, p, lang, actions } = useApp();
  const insets = useSafeAreaInsets();
  const timezone = useTimeZone();
  const today = useToday();
  // From the local cache (UC-3.2, #186). Today renders before any request has
  // finished, and a chip that arrived after the list would move rows about.
  const busy = useBusyBlocks();
  const [refreshing, setRefreshing] = useState(false);

  const now = new Date().toISOString();
  const groups: TodayGroups = useMemo(
    () => groupForToday(today.data?.items ?? [], now),
    // `now` deliberately excluded: re-grouping on every render would move rows
    // under the user's finger as the clock ticks past a due time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [today.data],
  );
  const top = topItemFor(groups);
  const strings = t as unknown as Record<string, string>;
  const why = top ? whyFirstLine(top.reasonCodes, strings) : null;

  const open = groups.must.length + groups.should.length + groups.nice.length;
  const isEmpty = open === 0 && groups.finished.length === 0;

  const refresh = () => {
    setRefreshing(true);
    void today.refetch().finally(() => setRefreshing(false));
  };

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <View pointerEvents="none" style={{ position: 'absolute', top: -120, end: -80 }}>
        <Glow color={p.acs} />
      </View>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 130, gap: 14 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={p.ac} />}
      >
        <View style={{ gap: 2 }}>
          <Txt size={13} color={p.mu} testID="today-date">
            {formatDate(new Date(), 'weekday', { locale: lang, timeZone: timezone })}
          </Txt>
          <Txt size={28} weight={600} lh={1.3}>{t.todayTitle}</Txt>
        </View>

        {/* Above the groups, and outside Today's own boundary: a next step
            that fails to load must not take the day's list down with it. */}
        <NextStepCard />

        <QueryBoundary isPending={today.isPending} error={today.error} onRetry={() => void today.refetch()}>
          {isEmpty ? (
            <View style={{ marginTop: 80, alignItems: 'center', gap: 14, paddingHorizontal: 20 }}>
              <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: p.acs }} />
              <Txt size={20} weight={600} align="center">{t.emptyTitle}</Txt>
              <Txt size={14} color={p.mu} align="center">{t.emptyBody}</Txt>
              <Pill label={t.sayIt} onPress={actions.goCapture} style={{ marginTop: 6, paddingHorizontal: 26 }} />
            </View>
          ) : (
            <>
              <Txt size={13} color={p.mu} testID="today-count">
                {tr('todayCountOpen', { n: open })}
              </Txt>

              {(['must', 'should', 'nice'] as const).map((key) => (
                <Group
                  key={key}
                  title={strings[GROUP_TITLE[key]]!}
                  testID={`today-group-${key}`}
                  items={groups[key]}
                  topId={top?.id ?? null}
                  why={why}
                  timezone={timezone}
                  lang={lang}
                  busy={busy}
                />
              ))}

              {groups.finished.length > 0 ? (
                <FinishedGroup items={groups.finished} />
              ) : null}
            </>
          )}
        </QueryBoundary>
      </ScrollView>
    </ScreenIn>
  );
}

const GROUP_TITLE = {
  must: 'todayGroupMust',
  should: 'todayGroupShould',
  nice: 'todayGroupNice',
} as const;

function Group({
  title, items, topId, why, timezone, lang, testID, busy,
}: {
  title: string;
  items: CommitmentView[];
  topId: string | null;
  why: string | null;
  timezone: string;
  lang: Lang;
  testID: string;
  busy: readonly DeviceBusyBlock[];
}) {
  const { p } = useApp();
  if (items.length === 0) return null;

  return (
    <Card pad={0} style={{ overflow: 'hidden' }} testID={testID}>
      <View style={{ paddingHorizontal: 18, paddingTop: 16, paddingBottom: 8 }}>
        <Txt size={13} weight={600} color={p.mu}>{title}</Txt>
      </View>
      {items.map((item, index) => (
        <Row
          key={item.id}
          item={item}
          why={item.id === topId ? why : null}
          first={index === 0}
          timezone={timezone}
          lang={lang}
          busy={busy}
        />
      ))}
    </Card>
  );
}

function Row({
  item, why, first, timezone, lang, busy,
}: {
  item: CommitmentView;
  why: string | null;
  first: boolean;
  timezone: string;
  lang: Lang;
  busy: readonly DeviceBusyBlock[];
}) {
  const { t, p, actions } = useApp();
  const act = useCommitmentAction();

  /**
   * Done and "not now", from the row (UC-2.R3 #173 steps 3, 8).
   *
   * Both are real transitions on the actions route, not a toast: `complete`
   * closes the commitment and `postpone` moves it an hour, the same default the
   * details sheet uses when the user does not name a time.
   */
  const rowActions = useRowActions(item, {
    complete: () => act.mutate({ id: item.id, action: 'complete' }),
    postpone: () => act.mutate({
      id: item.id,
      action: 'postpone',
      postponedUntil: postponeTo('oneHour', new Date(), timezone),
    }),
  });
  const when = item.shownAt
    ? ltr(formatTime(new Date(item.shownAt), { locale: lang, timeZone: timezone }))
    : t.noTimeYet;

  return (
    <SwipeableRow actions={rowActions} testID={`today-swipe-${item.id}`}>
    <Btn
      testID={`today-item-${item.id}`}
      accessibilityActions={rowActions.map(({ name, label }) => ({ name, label }))}
      onAccessibilityAction={(event) => {
        rowActions.find((action) => action.name === event.nativeEvent.actionName)?.run();
      }}
      // Title, importance, time and status — everything the row shows. See
      // accessibility.ts on why this is not a second set of copy.
      label={rowAccessibilityLabel(item, t, item.shownAt ? when : null)}
      onPress={() => actions.openDetail(item.id)}
      scaleTo={0.98}
      style={{
        paddingVertical: 14, paddingHorizontal: 18, gap: 4,
        alignItems: 'flex-start',
        borderTopWidth: first ? 0 : 1, borderTopColor: p.ln,
      }}
    >
      <Txt size={15}>{item.title}</Txt>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {/* A deadline is a point in time, so it reads as one. There is no
            "overdue": a time that has passed is shown in the accent, not in a
            warning colour, because a missed thing is not a failure state. */}
        <Txt size={12} color={item.isPast ? p.ac : p.mu} latin testID={`today-time-${item.id}`}>{when}</Txt>
        {/* The importance was read off their words, not stated by them (#169). */}
        {!item.importanceIsStated && item.importance === 'must' ? (
          <Txt size={12} color={p.mu} testID={`today-estimated-${item.id}`}>{t.todayEstimatedMark}</Txt>
        ) : null}
      </View>
      {/* What else is happening then (UC-3.2, #186). A note in the muted
          colour, under the time it is about — never a warning, and never
          something that stops the row being opened or completed. */}
      <BusyConflictChip
        blocks={item.shownAt ? busyAt(item.shownAt, busy) : []}
        testID={`today-busy-${item.id}`}
      />
      {why ? (
        <Txt size={12} color={p.ac} testID="today-why-first">{why}</Txt>
      ) : null}
    </Btn>
    </SwipeableRow>
  );
}

/**
 * Done and dropped, collapsed.
 *
 * No time on these rows, and so no timezone or locale: when a thing was due
 * stopped mattering the moment it was resolved.
 *
 * Both are finished and both collapse, but they are not the same thing and the
 * row says which: «أسقطه بوعي» carries the same weight as «تمّت» in this
 * product, and folding a deliberate drop into "done" would erase a decision
 * the user made on purpose.
 */
function FinishedGroup({ items }: { items: CommitmentView[] }) {
  const { t, p, actions } = useApp();
  const [open, setOpen] = useState(false);

  return (
    <Card pad={0} style={{ overflow: 'hidden' }} testID="today-group-finished">
      <Btn
        testID="today-finished-toggle"
        label={t.todayGroupFinished}
        onPress={() => setOpen(!open)}
        scaleTo={0.99}
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 16, paddingHorizontal: 18 }}
      >
        <Txt size={13} weight={600} color={p.mu}>{t.todayGroupFinished}</Txt>
        <Txt size={13} color={p.mu} latin>{String(items.length)}</Txt>
      </Btn>
      {open ? items.map((item) => (
        <Btn
          key={item.id}
          testID={`today-finished-${item.id}`}
          label={item.title}
          onPress={() => actions.openDetail(item.id)}
          scaleTo={0.98}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 18, borderTopWidth: 1, borderTopColor: p.ln }}
        >
          <View style={{
            width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
            backgroundColor: item.status === 'done' ? p.ac : 'transparent',
            borderWidth: item.status === 'done' ? 0 : 2, borderColor: p.ln,
          }}>
            {item.status === 'done' ? <CheckIcon color={p.onAccent} /> : null}
          </View>
          <Txt size={14} color={p.mu} style={{ flex: 1, textDecorationLine: 'line-through' }}>{item.title}</Txt>
          <Txt size={12} color={p.mu}>{item.status === 'done' ? t.doneS : t.dropped}</Txt>
        </Btn>
      )) : null}
    </Card>
  );
}
