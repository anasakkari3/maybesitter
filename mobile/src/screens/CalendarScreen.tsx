import { importantDeadline } from '../features/today/dayContext';
import { DeadlineContext } from '../features/today/DeadlineContext';
import React, { useMemo, useState } from 'react';
import { RefreshControl, View } from 'react-native';
import { useLayoutMode, useTextScale } from '../theme/textScale';
import { useApp } from '../state/AppContext';
import { useTimeZone } from '../i18n/timezone';
import { CIVIL_ZONE, civilDate, dayKey, formatDate, formatDayRange, formatRelativeDay, formatTime, formatTimeRange } from '../i18n/format';
import { fill, ltr } from '../i18n/strings';
import { drawnAt, drawnClockAt, dueAsideText, savedPlacements } from '../features/plan/savedPlacement';
import { useSavedWeek, useToday, useTrust, useUpcoming } from '../api/queries';
import { useBusyBlocks } from '../features/calendar/useBusyCalendar';
import { useConflictBusyBlocks } from '../features/google/useGoogle';
import type { DeviceBusyBlock } from '../features/calendar/busyBlocks';
import { Notice } from '../ui/chrome';
import { Screen, ScreenScroll } from '../ui/screen';
import { ChevronIcon, SettingsIcon } from '../ui/icons';
import { QueryBoundary } from '../api/ui/QueryBoundary';
import { groupUpcoming, toViewModel, type CommitmentView } from '../features/commitments/model';
import { rowAccessibilityLabel } from '../features/commitments/accessibility';
import { STRIP_DAYS, weekStripKeys } from '../features/commitments/weekStrip';
import { Btn, Txt } from '../ui/primitives';
import { DirectionalScrollRow } from '../ui/directionalScroll';
import { ReferenceCard, ReferenceHeader, ReferenceIcon, useReferencePalette } from '../ui/referenceDesign';
import { busyBlockPrepTarget } from '../features/meetings/prepTargets';
import { occurrencesByDay, useWeeklyOccurrences } from '../features/weeklyBlocks/occurrences';
import { hideWeeklyDuplicates } from '../features/weeklyBlocks/weeklyDeviceEvents';
import { useWeeklyEventIds } from '../features/weeklyBlocks/useWeeklyBlockDeviceSync';
import { WeeklyOccurrenceRow } from '../features/weeklyBlocks/WeeklyOccurrenceRow';

/**
 * The week ahead, from the account (UC-2.R3, #173).
 *
 * ── Seven days forward, not a Sunday-to-Saturday week ────────────
 *
 * The round-1 design drew a calendar week with today somewhere in the middle,
 * and the seed filled the days before it. There is no endpoint for those: the
 * mobile API has `today` and `upcoming`, and `upcoming` is defined as "a later
 * local day than today". Drawing Monday and Tuesday as empty cells would say
 * "nothing was on" when the truth is "nobody asked", which is the more
 * damaging of the two for a product whose whole claim is that it remembers.
 *
 * So the strip starts at today. Every cell shown is a cell we have real data
 * for.
 *
 * ── The busy hatch, from the phone's own calendar (Round 2, Phase G) ──
 *
 * The second bar per day and the hatched rows in the day's list are the busy
 * times the phone's calendar reports — the same cache Today's conflict chips
 * read (UC-3.2, #186). Times only, never titles. When the calendar is not
 * connected the strip shows only commitments and a line says so, with the way
 * to connect it beside it: one Calendar, and its configuration where
 * configuration lives.
 *
 * ── Days, in the timezone the app told the server about ──────────
 *
 * Both queries are keyed by timezone and the server groups by local day, so
 * the strip does too. Cells are day *keys* — calendar arithmetic with no time
 * in it — which is why a DST change cannot shorten a day here.
 *
 * ── Steps saved from the week view (CL5b, I4) ─────────────────────
 *
 * A step the person saved for a day from «خطّط أسبوعي» is drawn on that day,
 * at the time the saved day holds it — not on its due date, and not on today
 * where an undated commitment otherwise sits. The saved days come from their
 * stored plans (`GET /api/mobile/plans/week`); if that read fails, the strip
 * draws commitments where they are due, as it did before.
 */
export function CalendarScreen({ tabClearance = 130 }: { tabClearance?: number } = {}) {
  const { s, t, lang, rtl, actions } = useApp();
  const p = useReferencePalette();
  const timezone = useTimeZone();
  const stacked = useLayoutMode() !== 'normal';
  const today = useToday();
  const upcoming = useUpcoming();
  const savedWeek = useSavedWeek();
  const trust = useTrust();
  // Google Calendar's busy time (CL6a) beside the phone's; see `useConflictBusyBlocks`.
  const readBusy = useConflictBusyBlocks(useBusyBlocks());
  const calendarConnected = trust.data?.trust.calendarConsent === true;
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<'all' | 'commitment' | 'busy'>('all');

  const now = new Date();
  const todayKey = dayKey(now, timezone);
  const keys = useMemo(() => weekStripKeys(now, timezone), [todayKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Weekly fixed blocks («ثابت أسبوعي») on the strip's days, with their titles.
  // The device event this app wrote for one — and the same interval come back
  // through another phone or Google — is the block drawn twice, so it leaves
  // the busy rows (`hideWeeklyDuplicates`).
  const weekly = useWeeklyOccurrences(keys, timezone);
  const weeklyEventIds = useWeeklyEventIds();
  const busy = useMemo(() => hideWeeklyDuplicates(readBusy, weeklyEventIds, weekly), [readBusy, weeklyEventIds, weekly]);
  const weeklyByDay = useMemo(() => occurrencesByDay(weekly, timezone), [weekly, timezone]);

  const byDay = useMemo(() => {
    const map = new Map<string, CommitmentView[]>();
    // Today comes from its own query: `upcoming` deliberately excludes it, and
    // an undated item lives on today, which is why today is not just day zero
    // of the upcoming grouping.
    map.set(todayKey, (today.data?.items ?? [])
      .map((item) => toViewModel(item, now.toISOString()))
      .filter((view) => view.status === 'active'));
    for (const day of groupUpcoming(upcoming.data?.items ?? [], now.toISOString(), timezone)) {
      map.set(day.key, day.items);
    }
    // A saved week step moves to the day it was saved for, at its saved time;
    // its own due stays on the view, and the row says it when they differ (FX1).
    const savedOn = savedPlacements(savedWeek.data);
    if (savedOn.size > 0) {
      const moved: [string, CommitmentView][] = [];
      for (const [key, views] of Array.from(map)) {
        map.set(key, views.filter((view) => {
          const saved = savedOn.get(view.id);
          if (!saved) return true;
          moved.push([saved.date, { ...view, plannedAt: saved.startsAt }]);
          return false;
        }));
      }
      const at = (view: CommitmentView) => { const drawn = drawnAt(view); return drawn ? Date.parse(drawn) : Infinity; };
      for (const [date, view] of moved) {
        map.set(date, [...(map.get(date) ?? []), view].sort((a, b) => at(a) - at(b)));
      }
    }
    return map;
    // `now` excluded on purpose: re-deriving every render would move rows under
    // the user's finger as the clock ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today.data, upcoming.data, savedWeek.data, timezone, todayKey]);
  const weekHasMust = keys.some((key) => (byDay.get(key) ?? []).some((item) => item.importance === 'must'));

  const busyByDay = useMemo(() => {
    const map = new Map<string, DeviceBusyBlock[]>();
    for (const block of busy) {
      const key = dayKey(new Date(block.startAt), timezone);
      map.set(key, [...(map.get(key) ?? []), block]);
    }
    return map;
  }, [busy, timezone]);

  const selectedKey = keys[Math.min(Math.max(s.selDay, 0), STRIP_DAYS - 1)] ?? todayKey;
  // Context should add something beyond the selected day’s list.
  const weekInsight = importantDeadline([...(today.data?.items ?? []), ...(upcoming.data?.items ?? [])], keys.filter(key => key !== selectedKey), timezone);
  const selected = byDay.get(selectedKey) ?? [];
  const selectedBusy = calendarConnected ? (busyByDay.get(selectedKey) ?? []) : [];
  // Commitments and busy blocks in one list, in time order; an undated
  // commitment sorts last.
  const dayRows = [
    ...selected.map((item) => ({ kind: 'commitment' as const, at: drawnAt(item) ? Date.parse(drawnAt(item)!) : Number.POSITIVE_INFINITY, item })),
    ...selectedBusy.map((block) => ({ kind: 'busy' as const, at: Date.parse(block.startAt), block })),
    ...(weeklyByDay.get(selectedKey) ?? []).map((occurrence) => ({ kind: 'weekly' as const, at: Date.parse(occurrence.startAt), occurrence })),
  ].sort((a, b) => a.at - b.at);
  // A disconnected calendar must not leave the screen on a now-hidden filter.
  // Weekly fixed blocks («ثابت أسبوعي») are taken time too, so they sit under «busy».
  const busyFilterShown = calendarConnected || weekly.length > 0;
  const shownFilter = filter === 'busy' && !busyFilterShown ? 'all' : filter;
  const visibleRows = dayRows.filter(row => shownFilter === 'all'
    || (shownFilter === 'busy' ? row.kind === 'busy' || row.kind === 'weekly' : row.kind === shownFilter));
  const load = selected.length === 0 ? t.loadLight : selected.length < 3 ? t.loadNormal : t.loadFull;

  const refresh = () => {
    setRefreshing(true);
    void Promise.all([today.refetch(), upcoming.refetch(), savedWeek.refetch()]).finally(() => setRefreshing(false));
  };

  const range = formatDayRange(keys[0]!, keys[STRIP_DAYS - 1]!, { locale: lang });
  // «موعدها بكرا · 15:00» beside a step a saved day put elsewhere, as Today says it.
  const dueAsideFor = (item: CommitmentView): string | null => dueAsideText(item, t.plannedDueAside, lang, timezone);

  return (
    <Screen style={{ backgroundColor: p.bg }}>
      <ScreenScroll
        testID="calendar-scroll"
        bottom={tabClearance}
        topGap={8}
        gap={14}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={p.ac} />}
      >
        <ReferenceHeader
          eyebrow={range}
          eyebrowTestID="calendar-range"
          title={t.calendarTitle}
          subtitle={t.referenceWeekSubtitle}
          end={(
            // One row that wraps only when it must: at text size 1.3 a column
            // put the plan pill and its settings button on separate lines
            // with room to spare beside them (UAT 2026-09-30, u52).
            <View testID="calendar-header-actions" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, flexShrink: 1 }}>
              <Btn label={t.weekTitle} onPress={() => actions.go('weekPlan')} testID="calendar-plan-week"
                style={{ minHeight: 44, flexShrink: 1, paddingVertical: 9, paddingHorizontal: 13, borderRadius: 999, borderWidth: 1, borderColor: p.lnStrong, backgroundColor: p.sf2, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <CalendarGlyph color={p.ac} />
                <Txt size={13} weight={600} color={p.tx} style={{ flexShrink: 1 }}>{t.weekTitle}</Txt>
              </Btn>
              <Btn label={t.calendarSettingsBtn} onPress={() => actions.go('calendarSettings')} testID="calendar-settings" hitSlop={8}
                style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, alignItems: 'center', justifyContent: 'center' }}>
                <SettingsIcon color={p.mu} knob={p.sf} />
              </Btn>
            </View>
          )}
        />
        {trust.data && !calendarConnected ? (
          <Notice text={t.calendarNotConnected} action={t.calendarSettingsBtn} onAction={() => actions.go('calendarSettings')} testID="calendar-not-connected" />
        ) : null}

        <QueryBoundary
          isPending={today.isPending || upcoming.isPending}
          error={today.error ?? upcoming.error}
          onRetry={() => { void today.refetch(); void upcoming.refetch(); }}
        >
          <ReferenceCard pad={8} testID="calendar-week-card" style={{ gap: 0 }}>
            {/* The first queried day reads first in each language; never invent past days. */}
            {/* Stacked, the strip scrolls: Android fades the edge that has
                more days behind it, so the row says it moves (u54). */}
            <DirectionalScrollRow testID="calendar-week-strip" showsHorizontalScrollIndicator={stacked} fadingEdgeLength={stacked ? 32 : 0}
              contentContainerStyle={{ flexGrow: 1, gap: 2 }} itemStyle={stacked ? undefined : { flex: 1 }}>
              {keys.map((key, offset) => (
                <DayCell key={key} dayKey={key} isToday={key === todayKey} selected={key === selectedKey}
                  items={byDay.get(key) ?? []}
                  busy={(calendarConnected ? (busyByDay.get(key)?.length ?? 0) : 0) + (weeklyByDay.get(key)?.length ?? 0)}
                  onPress={() => actions.setSelDay(offset)} />
              ))}
            </DirectionalScrollRow>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16, paddingTop: 13, paddingBottom: 7, paddingHorizontal: 8 }}>
              <CalendarLegend color={p.ac} label={t.legendCommit} />
              {/* A must draws in warm sand (bar, dot, time); the legend says so
                  whenever the week has one (UAT 2026-09-30, u35/u39). */}
              {weekHasMust ? <CalendarLegend color={p.wm} label={t.todayGroupMust} testID="calendar-legend-must" /> : null}
              {calendarConnected || weekly.length > 0 ? <CalendarLegend color={p.mu} label={t.calendarBusyLegend} /> : null}
            </View>
          </ReferenceCard>

          <ReferenceCard pad={12} testID="calendar-agenda" style={{ gap: 0 }}>
            <View style={{ flexDirection: stacked ? 'column' : 'row', justifyContent: 'space-between', alignItems: stacked ? 'flex-start' : 'center', gap: 8, paddingBottom: 14 }}>
              <Txt size={17} weight={600} color={p.tx} testID="calendar-selected-day" style={{ flexShrink: 1 }}>
                {formatRelativeDay(civilDate(selectedKey), { locale: lang, timeZone: CIVIL_ZONE, now: civilDate(todayKey) })}
              </Txt>
              <View style={{ paddingVertical: 5, paddingHorizontal: 12, borderWidth: 1, borderColor: p.ln, backgroundColor: p.sf, borderRadius: 999 }}>
                <Txt size={12} color={p.mu}>{load}</Txt>
              </View>
            </View>
            <View style={{ gap: 6 }}>
              {visibleRows.map((row) => row.kind === 'weekly' ? (
                <WeeklyOccurrenceRow
                  key={`weekly-${row.occurrence.weeklyBlockId}-${row.occurrence.startAt}`}
                  occurrence={row.occurrence}
                  testID={`calendar-weekly-${row.occurrence.weeklyBlockId}`}
                />
              ) : row.kind === 'busy' ? ((block, prep) => (
                <View key={`busy-${block.nativeId}-${block.startAt}`} testID="calendar-busy-row"
                  style={{ flexDirection: stacked ? 'column' : 'row', alignItems: 'stretch', gap: 8 }}>
                  {!block.allDay ? (
                    <View style={stacked ? { alignItems: 'flex-start' } : { width: 48, paddingTop: 14 }}>
                      <Txt size={12} color={p.mu} latin>{ltr(formatTime(new Date(block.startAt), { locale: lang, timeZone: timezone }))}</Txt>
                    </View>
                  ) : !stacked ? <View style={{ width: 48 }} /> : null}
                  <View accessible={false} style={stacked ? { height: 3, borderRadius: 2, backgroundColor: p.mu } : { width: 3, borderRadius: 2, backgroundColor: p.mu }} />
                  <View style={{ flex: stacked ? undefined : 1, gap: 7, borderRadius: 14, paddingVertical: 11, paddingHorizontal: 12, backgroundColor: p.hatch, borderWidth: 1, borderStyle: 'dashed', borderColor: p.lnStrong, alignItems: 'flex-start' }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <CalendarGlyph color={p.mu} />
                      <Txt size={14} color={p.mu} style={{ flexShrink: 1 }}>{t.calendarBusyLegend}</Txt>
                    </View>
                    {!block.allDay ? <Txt size={12} color={p.mu} latin>{formatTimeRange(new Date(block.startAt), new Date(block.endAt), { locale: lang, timeZone: timezone })}</Txt> : null}
                    {/* A busy block contains no title. This opens the existing preparation sheet. */}
                    {prep ? (
                      <Btn testID="calendar-busy-prepare"
                        label={fill(t.xPrepareFor, { time: ltr(formatTime(new Date(block.startAt), { locale: lang, timeZone: timezone })) })}
                        onPress={() => actions.openMeetingPrep(prep)} scaleTo={0.97}
                        style={{ minHeight: 44, justifyContent: 'center', backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14 }}>
                        <Txt size={13} weight={600} color={p.tx}>{t.xPrepare}</Txt>
                      </Btn>
                    ) : null}
                  </View>
                </View>
              ))(row.block, busyBlockPrepTarget(row.block, now)) : ((item, drawn, due) => (
                <Btn key={item.id} testID={`calendar-item-${item.id}`}
                  label={`${rowAccessibilityLabel(item, t, drawn ? ltr(formatTime(new Date(drawn), { locale: lang, timeZone: timezone })) : null)}${due ? `, ${due}` : ''}`}
                  onPress={() => actions.openDetail(item.id)} scaleTo={0.98}
                  style={{ flexDirection: stacked ? 'column' : 'row', alignItems: 'stretch', gap: 8, minHeight: 52 }}>
                  <View style={stacked ? { alignItems: 'flex-start' } : { width: 48, paddingTop: 14 }}>
                    <Txt size={12} color={item.importance === 'must' ? p.wm : p.mu} latin testID={`calendar-time-${item.id}`}>
                      {drawn ? ltr(formatTime(new Date(drawn), { locale: lang, timeZone: timezone })) : t.noTimeYet}
                    </Txt>
                  </View>
                  <View accessible={false} style={stacked
                    ? { height: 3, borderRadius: 2, backgroundColor: item.importance === 'must' ? p.wm : p.ac }
                    : { width: 3, borderRadius: 2, backgroundColor: item.importance === 'must' ? p.wm : p.ac }} />
                  <View style={{ flex: stacked ? undefined : 1, backgroundColor: item.importance === 'must' ? p.wms : p.sf, borderWidth: 1, borderColor: p.ln, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 9 }}>
                    <CalendarGlyph color={item.importance === 'must' ? p.wm : p.ac} />
                    <View style={{ flex: 1, gap: 3, alignItems: 'flex-start' }}>
                      <Txt size={15} weight={500} color={p.tx}>{item.title}</Txt>
                      {due ? <Txt size={12} color={p.mu} testID={`calendar-due-${item.id}`}>{due}</Txt> : null}
                    </View>
                  </View>
                </Btn>
              ))(row.item, drawnClockAt(row.item), dueAsideFor(row.item)))}
              {visibleRows.length === 0 ? (
                <View style={{ paddingVertical: 24, paddingHorizontal: 12 }} testID={dayRows.length === 0 ? 'calendar-day-free' : 'calendar-filter-empty'}>
                  <Txt size={14} color={p.mu} align="center">{dayRows.length === 0 ? t.dayFree : t.referenceCalendarFilterEmpty}</Txt>
                </View>
              ) : null}
            </View>
          </ReferenceCard>

          <DirectionalScrollRow showsHorizontalScrollIndicator={stacked} contentContainerStyle={{ gap: 8, paddingVertical: 2 }}>
            {([
              { id: 'all', label: t.catAll, dot: null },
              { id: 'commitment', label: t.xCommitments, dot: p.ac },
              ...(busyFilterShown ? [{ id: 'busy', label: t.calendarBusyLegend, dot: p.mu }] : []),
            ] as const).map(option => {
              const selected = shownFilter === option.id;
              return <Btn key={option.id} testID={`calendar-filter-${option.id}`} label={option.label}
                accessibilityState={{ selected }} onPress={() => setFilter(option.id as 'all' | 'commitment' | 'busy')}
                style={{ minHeight: 44, borderRadius: 999, borderWidth: 1, borderColor: selected ? p.ink : p.lnStrong, backgroundColor: selected ? p.ink : p.sf, paddingVertical: 9, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                {option.dot ? <View accessible={false} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: option.dot }} /> : null}
                <Txt size={13} weight={500} color={selected ? p.onInk : p.tx}>{option.label}</Txt>
              </Btn>;
            })}
          </DirectionalScrollRow>
          {weekInsight ? <DeadlineContext item={weekInsight} weekly /> : null}
        </QueryBoundary>

        <ReferenceCard tone="waiting" pad={0}>
          <Btn testID="calendar-patch" label={`${t.xPatch}. ${t.xPatchBody}`} onPress={() => actions.go('patchReview')}
            style={{ minHeight: 80, padding: 16, gap: 13, flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'flex-start' : 'center' }}>
            <CalendarGlyph color={p.ac} spark />
            <View style={{ flex: stacked ? undefined : 1, gap: 3, alignItems: 'flex-start' }}>
              <Txt size={15} weight={600} color={p.tx}>{t.xPatch}</Txt>
              <Txt size={12} color={p.mu}>{t.xPatchBody}</Txt>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderColor: p.lnStrong, borderRadius: 999, paddingVertical: 10, paddingHorizontal: 12 }}>
              <Txt size={13} weight={600} color={p.tx}>{t.reviewTitle}</Txt>
              <ChevronIcon color={p.mu} rtl={rtl} />
            </View>
          </Btn>
        </ReferenceCard>
        <ReferenceCard pad={0} style={{ gap: 0 }}>
          <CalendarShortcut id="calendar-commitments" title={t.xCommitments} body={t.xCurrentHorizon} onPress={() => actions.go('commitments')} />
          <View style={{ height: 1, marginHorizontal: 16, backgroundColor: p.ln }} />
          <CalendarShortcut id="calendar-seeds" title={t.seedsOpen} body={t.seedsNotCommitment} onPress={() => actions.go('seeds')} spark />
        </ReferenceCard>
      </ScreenScroll>
    </Screen>
  );
}

function CalendarGlyph({ color, spark = false }: { color: string; spark?: boolean }) {
  return <ReferenceIcon name={spark ? 'sparkles' : 'calendar'} size={20} color={color} />;
}

function CalendarLegend({ color, label, testID }: { color: string; label: string; testID?: string }) {
  const p = useReferencePalette();
  return <View testID={testID} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
    <View accessible={false} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
    <Txt size={11} color={p.mu}>{label}</Txt>
  </View>;
}

function CalendarShortcut({ id, title, body, onPress, spark = false }: { id: string; title: string; body: string; onPress: () => void; spark?: boolean }) {
  const { rtl } = useApp();
  const p = useReferencePalette();
  const stacked = useLayoutMode() !== 'normal';
  return <Btn testID={id} label={`${title}. ${body}`} onPress={onPress}
    style={{ minHeight: 64, padding: 16, gap: 12, flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'flex-start' : 'center' }}>
    <CalendarGlyph color={p.ac} spark={spark} />
    <View style={{ flex: stacked ? undefined : 1, gap: 3, alignItems: 'flex-start' }}>
      <Txt size={14} weight={600} color={p.tx}>{title}</Txt>
      <Txt size={12} color={p.mu}>{body}</Txt>
    </View>
    {!stacked ? <ChevronIcon color={p.mu} rtl={rtl} /> : null}
  </Btn>;
}

function DayCell({
  dayKey: key, isToday, selected, items, busy, onPress,
}: {
  dayKey: string;
  isToday: boolean;
  selected: boolean;
  items: CommitmentView[];
  /** How many busy blocks the phone's calendar has that day; one hatched bar when any. */
  busy: number;
  onPress: () => void;
}) {
  const { lang } = useApp();
  const p = useReferencePalette();
  const scale = useTextScale();
  const stacked = useLayoutMode() !== 'normal';
  const date = civilDate(key);
  const options = { locale: lang, timeZone: CIVIL_ZONE } as const;

  return (
    <Btn
      testID={`calendar-day-${key}`}
      onPress={onPress}
      label={`${formatDate(date, 'weekday', options)} ${formatDate(date, 'dayNumber', options)}`}
      accessibilityState={{ selected }}
      scaleTo={0.94}
      style={{ ...(stacked ? { width: 62 * scale } : { flex: 1 }), minWidth: 44, alignItems: 'center', gap: 2, paddingTop: 7, paddingBottom: 8, paddingHorizontal: 3, borderRadius: 15, backgroundColor: selected ? p.sf2 : 'transparent', minHeight: 100 }}
    >
      <Txt size={11} color={selected ? p.tx : p.mu} align="center" lines={1}>{formatDate(date, 'weekdayShort', options)}</Txt>
      <View style={{ minWidth: 36 * scale, minHeight: 36 * scale, borderRadius: 18 * scale, alignItems: 'center', justifyContent: 'center', backgroundColor: selected ? p.ac : 'transparent', borderWidth: isToday && !selected ? 1 : 0, borderColor: p.lnStrong }}>
        {/* `latin`: Noto Naskh's line box clips digits in a box this tight. */}
        <Txt size={16} weight={600} align="center" color={selected ? p.onAccent : p.tx} lh={1.25} latin>
          {formatDate(date, 'dayNumber', options)}
        </Txt>
      </View>
      <View accessible={false} style={{ alignSelf: 'stretch', gap: 3, marginTop: 6, paddingHorizontal: 4, minHeight: 18 }}>
        {/* Three bars at most: a fourth would make a busy day unreadable, and
            the count is not the point — the shape of the week is. */}
        {items.slice(0, 3).map((item) => (
          <View
            key={item.id}
            testID={`calendar-bar-${key}`}
            style={{ height: 3, borderRadius: 2, backgroundColor: item.importance === 'must' ? p.wm : p.ac }}
          />
        ))}
        {busy > 0 ? <View testID={`calendar-busy-bar-${key}`} style={{ height: 3, borderRadius: 2, backgroundColor: p.mu }} /> : null}
        <View style={{ flexDirection: 'row', gap: 3 }}>
          {items.slice(0, 3).map(item => <View key={item.id} style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: item.importance === 'must' ? p.wm : p.ac }} />)}
        </View>
      </View>
    </Btn>
  );
}
