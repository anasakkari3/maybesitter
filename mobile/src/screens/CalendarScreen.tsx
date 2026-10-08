import { importantDeadline } from '../features/today/dayContext';
import { DeadlineContext } from '../features/today/DeadlineContext';
import React, { useMemo, useState } from 'react';
import { RefreshControl, View } from 'react-native';
import { calendarReadEnabled } from '../config/env';
import { useBusyBlocks, useDeviceBusy } from '../features/calendar/useBusyCalendar';
import { useGoogleBusyRead } from '../features/google/useGoogle';
import { dayBounds, dayWindow, freeMinutes, occupancyOf, type Interval } from '../features/calendar/freeTime';
import { dayFree, googleCovers, googleWindowIsNormal, knownTime, type DayFree, type FreeSources } from '../features/calendar/freeReadiness';
import { WIDER_DAYS, probeRange, useDaysFrom, useLocalToday, usePlanSnapshot, useServerBusy } from '../features/calendar/usePlanFreeTime';
import { FreeList, FreeStateLine, gapLength } from '../features/calendar/FreeTimeRows';
import { WiderView, type WiderCell } from '../features/calendar/WiderView';
import { LiveRegion } from '../ui/liveRegion';
import { useAnnounceOnIos } from '../ui/announce';
import { useLayoutMode } from '../theme/textScale';
import { useApp } from '../state/AppContext';
import { useTimeZone } from '../i18n/timezone';
import { CIVIL_ZONE, civilDate, dayKey, formatDate, formatDayRange, formatRelativeDay, formatTimeRange } from '../i18n/format';
import { isolateAuto } from '../i18n/bidi';
import { fill } from '../i18n/strings';
import { dueAsideText, placeView, savedPlacements } from '../features/plan/savedPlacement';
import { usePlan, useProfile, useSavedWeek, useToday, useTrust, useUid, useUpcoming } from '../api/queries';
import type { PendingPlanProposal } from '../api/schemas/plan';
import type { DeviceBusyBlock } from '../features/calendar/busyBlocks';
import { busyAt, chipBlock } from '../features/calendar/conflicts';
import { dayLoad, type DayLoad } from '../features/calendar/dayTimeline';
import { DayAgenda, DayTimeline, UntimedSection, type PlanRow } from '../features/calendar/PlanDay';
import { AvatarButton, Notice, ScreenHeader } from '../ui/chrome';
import { CountChip } from '../ui/hub';
import { Screen, ScreenScroll, TAB_CLEARANCE } from '../ui/screen';
import { SettingsIcon } from '../ui/icons';
import { QueryBoundary } from '../api/ui/QueryBoundary';
import { toViewModel, type CommitmentView } from '../features/commitments/model';
import { STRIP_DAYS } from '../features/commitments/weekStrip';
import { Btn, Txt } from '../ui/primitives';
import { DirectionalScrollRow } from '../ui/directionalScroll';
import { ReferenceIcon, useReferencePalette } from '../ui/referenceDesign';
import { busyBlockPrepTarget } from '../features/meetings/prepTargets';
import { occurrencesByDay, useWeeklyOccurrencesState } from '../features/weeklyBlocks/occurrences';
import { hideWeeklyDuplicates } from '../features/weeklyBlocks/weeklyDeviceEvents';
import { useWeeklyEventIds } from '../features/weeklyBlocks/useWeeklyBlockDeviceSync';
import { patchReasonKey } from '../features/product/ControlScreens';

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
 * The busy dot per day and the hatched blocks on the day are the busy times
 * the phone's calendar reports — the same cache Today's conflict chips read
 * (UC-3.2, #186). Times only, never titles: a block says «مشغول (من التقويم)». When the calendar is not
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
 *
 * ── The Stitch Plan tab (2026-10-02, `02-plan`) ──────────────────
 *
 * A word under each day says how full it is, from what is on it (`dayLoad`).
 * The filters really filter the day. The day is drawn on equal hours: busy
 * time and weekly fixed time as tall as they last, commitments as markers at
 * their time — never a duration nobody gave (`dayTimeline.ts`). What has no
 * hour is listed under it, «التزامات بلا وقت». A pending change to today's
 * plan shows as a proposal that only opens the review: nothing moves until
 * the person accepts it there.
 */
export function CalendarScreen({ tabClearance = TAB_CLEARANCE }: { tabClearance?: number } = {}) {
  const { s, t, tr, lang, actions } = useApp();
  const p = useReferencePalette();
  const uid = useUid();
  const timezone = useTimeZone();
  const stacked = useLayoutMode() !== 'normal';
  // The local day, moving at midnight while the tab stays open, and one
  // reference instant for both lists per day (M4A-R2-008).
  const todayKey = useLocalToday(timezone);
  const snapshot = usePlanSnapshot(uid, timezone, todayKey);
  const today = useToday({ referenceTime: snapshot.referenceTime });
  const upcoming = useUpcoming({ referenceTime: snapshot.referenceTime });
  const savedWeek = useSavedWeek();
  const trust = useTrust();
  const deviceBusy = useDeviceBusy();
  const google = useGoogleBusyRead();
  const calendarConnected = trust.data?.trust.calendarConsent === true;
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<'all' | 'commitment' | 'busy' | 'free'>('all');
  const [widerOpen, setWiderOpen] = useState(false);
  // «مش هلّق» on a proposal: out of the way for now, answered nowhere.
  const [laterProposal, setLaterProposal] = useState<string | null>(null);
  // Where the scrolling strip is: it opens at its end (today) until scrolled.
  const [strip, setStrip] = useState<{ offset: number | null; content: number; viewport: number }>({ offset: null, content: 0, viewport: 0 });
  const stripFade = stripFadeFor(strip.offset ?? strip.content - strip.viewport, strip.content, strip.viewport);

  const now = new Date();
  const nowMs = now.getTime();
  const keys = useDaysFrom(todayKey, STRIP_DAYS);
  const widerKeys = useDaysFrom(todayKey, WIDER_DAYS);
  // Today's plan, for a pending change to it (#523): the same query Today reads.
  const plan = usePlan(todayKey);
  const proposal = plan.data?.proposal ?? null;

  // The free-time probe (M4a): the server's busy read. Until it answers 200
  // the tab is exactly what it was, and nothing more is read for free time.
  const range = useMemo(() => probeRange(todayKey, timezone), [todayKey, timezone]);
  const probe = useServerBusy(range);
  const free = probe.available;
  const profile = useProfile({ enabled: free });

  // The selected day: a date the person chose, or today (M4A-R2-006).
  const selectedKey = s.selDate ?? todayKey;
  const beyondStrip = !keys.includes(selectedKey);

  // Weekly fixed blocks («ثابت أسبوعي») on the days drawn, with their titles:
  // the strip's seven, or — with free time on — the four weeks the wider view
  // and its days need (M4A-R4-002), read with the probe's span so opening the
  // view waits for nothing. The device event this app wrote for one — and the
  // same interval come back through another phone or Google — is the block
  // drawn twice, so it leaves the busy rows (`hideWeeklyDuplicates`).
  const weeklyState = useWeeklyOccurrencesState(free ? widerKeys : keys, timezone);
  const weekly = weeklyState.items;
  const weeklyEventIds = useWeeklyEventIds();
  // The blocks through `useBusyBlocks` (the one seam every screen reads them
  // by); the envelope's coverage and state through `useDeviceBusy`.
  const deviceBlocks = useBusyBlocks();
  const googleBlocks = google.on ? google.query.data?.blocks : undefined;
  // Google Calendar's busy time (CL6a) beside the phone's.
  const readBusy = useMemo(() => [...deviceBlocks, ...(googleBlocks ?? [])], [deviceBlocks, googleBlocks]);
  const busy = useMemo(() => hideWeeklyDuplicates(readBusy, weeklyEventIds, weekly), [readBusy, weeklyEventIds, weekly]);
  const weeklyByDay = useMemo(() => occurrencesByDay(weekly, timezone), [weekly, timezone]);

  // One effective placement decides a commitment's day, its order, the day's
  // counts and what it occupies (M4A-R5-002): a saved week slot, else its
  // postponement, else its own time. Today and Upcoming are merged, never
  // laid over one another. An undated item, and work rolled over from an
  // earlier day, stays on today.
  const byDay = useMemo(() => {
    const placements = savedPlacements(savedWeek.data);
    const map = new Map<string, CommitmentView[]>();
    const seen = new Set<string>();
    for (const item of [...(today.data?.items ?? []), ...(upcoming.data?.items ?? [])]) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const view = placeView(toViewModel(item, snapshot.referenceTime), placements);
      if (view.status !== 'active') continue;
      const key = placements.get(view.id)?.date ?? effectiveDay(view, todayKey, timezone);
      map.set(key, [...(map.get(key) ?? []), view]);
    }
    for (const views of map.values()) views.sort((a, b) => clockMs(a) - clockMs(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return map;
  }, [today.data, upcoming.data, savedWeek.data, timezone, todayKey, snapshot.referenceTime]);
  const weekHasMust = keys.some((key) => (byDay.get(key) ?? []).some((item) => item.importance === 'must'));

  const busyByDay = useMemo(() => {
    const map = new Map<string, DeviceBusyBlock[]>();
    for (const block of busy) {
      const key = dayKey(new Date(block.startAt), timezone);
      map.set(key, [...(map.get(key) ?? []), block]);
    }
    return map;
  }, [busy, timezone]);

  // ── Free time (M4a R003/R004) ──────────────────────────────────
  const deviceApplicable = calendarReadEnabled() && calendarConnected;
  const serverBusy = probe.query.data;
  const sources: FreeSources = useMemo(() => ({
    pending: trust.isPending || (deviceApplicable && deviceBusy.isPending) || google.status.isPending
      || (google.on && google.query.isPending) || savedWeek.isPending || profile.isPending || weeklyState.isPending,
    failed: trust.isError || (deviceApplicable && deviceBusy.isError) || google.status.isError
      || (google.on && google.query.isError) || savedWeek.isError || profile.isError || weeklyState.isError,
    range: { start: Date.parse(range.from), end: Date.parse(range.to) },
    device: { applicable: deviceApplicable, coverage: intervalOf(deviceBusy.data?.coverage?.startAt, deviceBusy.data?.coverage?.endAt) },
    google: { connected: google.on, coverage: intervalOf(google.query.data?.windowStart, google.query.data?.windowEnd) },
    server: {
      feedsOk: (serverBusy?.sources ?? []).every((source) => source.status === 'ok' && source.windowStart !== null && source.windowEnd !== null),
      icsWindows: (serverBusy?.sources ?? []).flatMap((source) => {
        const window = intervalOf(source.windowStart, source.windowEnd);
        return window ? [window] : [];
      }),
      cutoff: serverBusy && !serverBusy.complete ? (serverBusy.cutoff ? Date.parse(serverBusy.cutoff) : Date.parse(range.from)) : null,
      unknown: (serverBusy?.unknownRanges ?? []).flatMap((unknown) => {
        const window = intervalOf(unknown.from, unknown.to);
        return window ? [window] : [];
      }),
    },
  }), [trust.isPending, trust.isError, deviceApplicable, deviceBusy.isPending, deviceBusy.isError, deviceBusy.data,
    google.status.isPending, google.status.isError, google.on, google.query.isPending, google.query.isError, google.query.data,
    savedWeek.isPending, savedWeek.isError, profile.isPending, profile.isError, weeklyState.isPending, weeklyState.isError,
    range, serverBusy]);
  const known = useMemo(() => knownTime(sources), [sources]);
  // Everything that occupies time, from every source, on every day drawn.
  const occupied = useMemo(() => {
    const list: Interval[] = [];
    for (const views of byDay.values()) {
      for (const view of views) {
        const interval = occupancyOf({
          kind: view.timeKind ?? null, dueAt: view.dueAt ?? null, remindAt: view.remindAt ?? null, endAt: view.endAt ?? null,
          allDay: view.allDay === true, postponedUntil: view.postponedUntil ?? null,
          saved: view.plannedAt ? { startsAt: view.plannedAt, endsAt: view.plannedEnd ?? null } : null,
        });
        if (interval) list.push(interval);
      }
    }
    const timed = (block: { startAt: string; endAt: string; allDay: boolean }) => {
      const interval = intervalOf(block.startAt, block.endAt);
      if (interval && !block.allDay) list.push(interval);
    };
    if (deviceApplicable) deviceBlocks.forEach(timed);
    (googleBlocks ?? []).forEach(timed);
    (serverBusy?.blocks ?? []).forEach(timed);
    for (const occurrence of weekly) timed({ startAt: occurrence.startAt, endAt: occurrence.endAt, allDay: false });
    return list;
  }, [byDay, deviceApplicable, deviceBlocks, googleBlocks, serverBusy, weekly]);
  const sleep = profile.data?.routine?.sleepWindow ?? null;
  const freeOn = (key: string): DayFree => dayFree(sources, known, occupied, key, timezone, sleep, nowMs);
  const selectedFree = free ? freeOn(selectedKey) : null;
  // VoiceOver has no live regions: the unknown line is said once when it comes.
  useAnnounceOnIos(selectedFree && (selectedFree.state === 'unknown' || selectedFree.state === 'partial') ? t.yFreeUnknown : null);

  const selected = byDay.get(selectedKey) ?? [];
  const selectedBusy = calendarConnected ? (busyByDay.get(selectedKey) ?? []) : [];
  // Context should add something beyond the selected day’s list.
  const weekInsight = importantDeadline([...(today.data?.items ?? []), ...(upcoming.data?.items ?? [])], keys.filter(key => key !== selectedKey), timezone);
  // «موعدها بكرا · 15:00» beside a step a saved day put elsewhere, as Today says it.
  const dueAsideFor = (item: CommitmentView): string | null => dueAsideText(item, t.plannedDueAside, lang, timezone);
  // Commitments, busy blocks and the day's large free stretches in one list,
  // in time order; an undated commitment sorts last.
  const dayRows: PlanRow[] = [
    ...selected.map((item): PlanRow => {
      const clock = effectiveClock(item);
      // Work that rolled over from an earlier day keeps its own hour, which is
      // not an hour of this day: it is listed with its day, not drawn here.
      const offDay = clock !== null && dayKey(new Date(clock), timezone) !== selectedKey;
      const conflict = clock && !offDay ? chipBlock(busyAt(clock, selectedBusy)) : null;
      return { kind: 'commitment', key: `c-${item.id}`, at: clock ? Date.parse(clock) : Number.POSITIVE_INFINITY, item, clock, offDay, due: dueAsideFor(item), conflict };
    }),
    ...selectedBusy.map((block): PlanRow => ({ kind: 'busy', key: `busy-${block.nativeId}-${block.startAt}`, at: Date.parse(block.startAt), block, prep: busyBlockPrepTarget(block, now) })),
    ...(weeklyByDay.get(selectedKey) ?? []).map((occurrence): PlanRow => ({ kind: 'weekly', key: `weekly-${occurrence.weeklyBlockId}-${occurrence.startAt}`, at: Date.parse(occurrence.startAt), occurrence })),
  ].sort((a, b) => a.at - b.at);
  // In «الكل», a free stretch of an hour or more is a quiet row between the
  // items around it (M4A-R9-001).
  const quietGaps: PlanRow[] = selectedFree && selectedFree.state !== 'loading'
    ? selectedFree.gaps.filter((gap) => gap.end - gap.start >= 60 * 60_000)
      .map((gap): PlanRow => ({ kind: 'gap', key: `gap-${gap.start}`, at: gap.start, gap }))
    : [];
  // Before M4a, and whenever the probe is not answering 200: «مشغول», for
  // the phone calendar's blocks and the weekly fixed time. With free time on
  // it becomes «فاضي» (owner D3).
  const busyFilterShown = !free && (calendarConnected || weekly.length > 0);
  const shownFilter = filter === 'busy' && !busyFilterShown ? 'all'
    : filter === 'free' && !free ? 'all'
      : filter;
  const visibleRows = shownFilter === 'free' ? [] : [...dayRows, ...(shownFilter === 'all' ? quietGaps : [])]
    .filter(row => shownFilter === 'all'
      || (shownFilter === 'busy' ? row.kind === 'busy' || row.kind === 'weekly' : row.kind === shownFilter))
    .sort((a, b) => a.at - b.at);
  // Where each visible row goes: an hour on the timeline, the all-day lane
  // above it, or «التزامات بلا وقت» under it.
  const untimed = visibleRows.filter((row): row is Extract<PlanRow, { kind: 'commitment' }> => row.kind === 'commitment' && (row.clock === null || row.offDay));
  const allDay = visibleRows.filter(row => row.kind === 'busy' && row.block.allDay);
  const timed = visibleRows.filter(row => !untimed.includes(row as never) && !allDay.includes(row));
  // With many points at nearby hours, the proportional timeline makes narrow
  // overlapping cards. The ordered agenda keeps every row readable.
  const crowdedDay = timed.filter(row => row.kind === 'commitment').length > 7;
  const loadOf = (key: string) => dayLoad(
    (byDay.get(key)?.length ?? 0)
    + (calendarConnected ? (busyByDay.get(key)?.length ?? 0) : 0)
    + (weeklyByDay.get(key)?.length ?? 0),
  );
  const loadWord = (load: DayLoad) => load === 'light' ? t.loadLight : load === 'normal' ? t.loadNormal : t.loadFull;

  // The 4-week view's cells (R004): their counts, their free time, and where
  // Google's window stops.
  const widerCells: WiderCell[] = free && widerOpen ? widerKeys.map((key) => {
    const day = dayBounds(key, timezone);
    const window = dayWindow(key, timezone, sleep);
    return {
      key,
      count: byDay.get(key)?.length ?? 0,
      free: freeOn(key),
      googleUncovered: google.on && !googleCovers(sources.google.coverage, key, timezone, nowMs),
      windowMinutes: freeMinutes(window.map((piece) => ({ start: Math.max(piece.start, day.start), end: Math.min(piece.end, day.end) }))),
    };
  }) : [];
  const firstUncovered = widerCells.findIndex((cell) => cell.googleUncovered);
  const googleNote = firstUncovered >= 0
    ? { index: firstUncovered, normal: googleWindowIsNormal(sources.google.coverage) }
    : null;

  const pick = (key: string) => actions.setSelDate(key === todayKey ? null : key);
  const refresh = () => {
    setRefreshing(true);
    // A fresh instant for both lists, and the probe asked again (M4A-R11-003).
    snapshot.rotate();
    void Promise.all([savedWeek.refetch(), plan.refetch(), probe.query.refetch()]).finally(() => setRefreshing(false));
  };

  const range7 = formatDayRange(keys[0]!, keys[STRIP_DAYS - 1]!, { locale: lang });

  return (
    <Screen style={{ backgroundColor: p.bg }}>
      <ScreenScroll
        testID="calendar-scroll"
        floating={tabClearance}
        topGap={8}
        gap={14}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={p.ac} />}
      >
        <ScreenHeader
          brand={false}
          eyebrow={stacked ? undefined : range7}
          eyebrowTestID={stacked ? undefined : 'calendar-range'}
          title={t.tabPlan}
          end={(
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Btn label={t.xSearch} testID="calendar-search" onPress={() => actions.go('commitments')} scaleTo={0.94}
                style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: p.ln, backgroundColor: p.sf }}>
                <ReferenceIcon name="search" size={22} color={p.tx} />
              </Btn>
              <AvatarButton />
            </View>
          )}
        />
        {/* The week planner and the calendar's settings: one row that wraps
            only when it must (UAT 2026-09-30, u52). */}
        <View testID="calendar-header-actions" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <Btn label={t.weekTitle} onPress={() => actions.go('weekPlan')} testID="calendar-plan-week"
            style={{ minHeight: 44, flexShrink: 1, paddingVertical: 9, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: p.lnStrong, backgroundColor: p.sf, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ReferenceIcon name="calendar" size={18} color={p.acd} />
            <Txt size={14} weight={600} color={p.tx} style={{ flexShrink: 1 }}>{t.weekTitle}</Txt>
          </Btn>
          <Btn label={t.calendarSettingsBtn} onPress={() => actions.go('calendarSettings')} testID="calendar-settings" hitSlop={8}
            style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, alignItems: 'center', justifyContent: 'center' }}>
            <SettingsIcon color={p.mu} knob={p.sf} />
          </Btn>
        </View>
        {trust.data && !calendarConnected ? (
          <Notice
            text={t.calendarNotConnected}
            testID="calendar-not-connected"
            style={{ paddingVertical: 7, paddingHorizontal: 12 }}
          />
        ) : null}

        <QueryBoundary
          isPending={today.isPending || upcoming.isPending}
          error={today.error ?? upcoming.error}
          onRetry={() => { void today.refetch(); void upcoming.refetch(); }}
        >
          <View testID="calendar-week-card" style={{ gap: 10 }}>
            {/* The first queried day reads first in each language; never invent past days. */}
            {/* Stacked, the strip scrolls: Android fades only an edge that has
                more days behind it, so the row says it moves (u54) without
                dimming the day that sits at an edge. React Native's fade does
                not follow the scroll by itself, so this does. */}
            <DirectionalScrollRow testID="calendar-week-strip" showsHorizontalScrollIndicator={stacked}
              fadingEdgeLength={stacked ? stripFade : 0} scrollEventThrottle={32}
              onLayout={(event) => { const viewport = event.nativeEvent.layout.width; setStrip((was) => was.viewport === viewport ? was : { ...was, viewport }); }}
              onContentSizeChange={(content) => setStrip((was) => was.content === content ? was : { offset: null, content, viewport: was.viewport })}
              onScroll={stacked ? (event) => {
                const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
                const next = stripFadeFor(contentOffset.x, contentSize.width, layoutMeasurement.width);
                if (next.start !== stripFade.start || next.end !== stripFade.end) {
                  setStrip({ offset: contentOffset.x, content: contentSize.width, viewport: layoutMeasurement.width });
                }
              } : undefined}
              contentContainerStyle={{ flexGrow: 1, gap: 6, paddingBottom: stacked ? 12 : 0 }} itemStyle={stacked ? undefined : { flex: 1 }}>
              {keys.map((key) => {
                const load = loadOf(key);
                return (
                  <DayCell key={key} dayKey={key} isToday={key === todayKey} selected={key === selectedKey}
                    items={byDay.get(key) ?? []}
                    busy={(calendarConnected ? (busyByDay.get(key)?.length ?? 0) : 0) + (weeklyByDay.get(key)?.length ?? 0)}
                    load={load} loadLabel={calendarConnected ? loadWord(load) : t.loadUnknown} complete={calendarConnected}
                    onPress={() => pick(key)} />
                );
              })}
            </DirectionalScrollRow>
            {free && !widerOpen ? (
              <Btn testID="calendar-wider-open" label={t.yWiderOpen} onPress={() => setWiderOpen(true)} scaleTo={0.97}
                style={{ alignSelf: 'flex-start', minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: p.ln, backgroundColor: p.sf }}>
                <ReferenceIcon name="calendar" size={16} color={p.acd} />
                <Txt size={14} weight={600} color={p.tx}>{t.yWiderOpen}</Txt>
              </Btn>
            ) : null}
          </View>

          {free && widerOpen ? (
            <WiderView cells={widerCells} todayKey={todayKey} selectedKey={selectedKey} googleNote={googleNote}
              onPick={(key) => { pick(key); setWiderOpen(false); }} onClose={() => setWiderOpen(false)} />
          ) : null}

          {free || busyFilterShown ? <DirectionalScrollRow showsHorizontalScrollIndicator={stacked} contentContainerStyle={{ gap: 8, paddingVertical: 2 }}>
            {([
              { id: 'all', label: t.catAll, dot: p.wm },
              { id: 'commitment', label: t.xCommitments, dot: p.ac },
              ...(free ? [{ id: 'free', label: t.yFilterFree, dot: p.success }] : []),
              ...(busyFilterShown ? [{ id: 'busy', label: t.calendarBusyLegend, dot: p.mu }] : []),
            ] as const).map(option => {
              const on = shownFilter === option.id;
              return <Btn key={option.id} testID={`calendar-filter-${option.id}`} label={option.label}
                accessibilityState={{ selected: on }} onPress={() => setFilter(option.id as 'all' | 'commitment' | 'busy' | 'free')}
                style={{ minHeight: 44, borderRadius: 999, borderWidth: 1, borderColor: on ? p.lnStrong : p.ln, backgroundColor: on ? p.sf2 : p.sf, paddingVertical: 9, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View accessible={false} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: option.dot }} />
                <Txt size={14} weight={on ? 700 : 500} color={on ? p.tx : p.mu}>{option.label}</Txt>
              </Btn>;
            })}
          </DirectionalScrollRow> : null}

          {proposal && laterProposal !== proposal.proposalId ? (
            <ProposalCard
              proposal={proposal}
              zone={plan.data?.timezone ?? timezone}
              onReview={() => actions.go('patchReview')}
              onLater={() => setLaterProposal(proposal.proposalId)}
            />
          ) : null}

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8, paddingHorizontal: 4 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, flexShrink: 1 }}>
              <ReferenceIcon name="clock" size={20} color={p.wm} />
              <Txt role="section" size={17} weight={700} color={p.tx} testID="calendar-selected-day" style={{ flexShrink: 1 }}>
                {formatRelativeDay(civilDate(selectedKey), { locale: lang, timeZone: CIVIL_ZONE, now: civilDate(todayKey) })}
              </Txt>
              {!stacked ? <CalendarLegend color={p.ac} label={t.legendCommit} /> : null}
              {/* A must draws in the coral; keep its key beside the selected
                  day instead of spending a full row below the week strip. */}
              {!stacked && weekHasMust ? <CalendarLegend color={p.acd} label={t.todayGroupMust} testID="calendar-legend-must" /> : null}
              {!stacked && (calendarConnected || weekly.length > 0) ? <CalendarLegend color={p.mu} label={t.calendarBusyLegend} /> : null}
            </View>
            <View style={{ paddingVertical: 5, paddingHorizontal: 12, borderWidth: 1, borderColor: p.ln, backgroundColor: p.sf, borderRadius: 999 }}>
              <Txt size={13} color={p.mu} testID="calendar-selected-load">
                {selectedFree?.state === 'full' && shownFilter === 'free' && selectedFree.totalMinutes !== null
                  ? fill(t.yGapRow, { range: '', length: gapLength(selectedFree.totalMinutes, t, tr) }).trim()
                  : loadWord(loadOf(selectedKey))}
              </Txt>
            </View>
          </View>
          {beyondStrip ? (
            <Btn testID="calendar-back-today" label={t.yBackToToday} onPress={() => actions.setSelDate(null)} scaleTo={0.97}
              style={{ alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: p.lnStrong, backgroundColor: p.sf }}>
              <Txt size={14} weight={600} color={p.tx}>{t.yBackToToday}</Txt>
            </Btn>
          ) : null}

          {/* Mounted for the screen's life so the change is announced (M4A-REV-005). */}
          <LiveRegion>
            {selectedFree && selectedFree.state !== 'full' ? <FreeStateLine state={selectedFree.state} /> : null}
          </LiveRegion>
          {selectedFree?.state === 'full' && selectedFree.totalMinutes !== null ? (
            <View testID={`calendar-free-total-${selectedKey}`} accessible={false} style={{ height: 0 }} />
          ) : null}

          {shownFilter === 'free' && selectedFree ? (
            <FreeList day={selectedKey} gaps={selectedFree.state === 'loading' ? [] : selectedFree.gaps} state={selectedFree.state} empty={dayRows.length === 0} />
          ) : (
            <>
              {allDay.length > 0 ? <DayAgenda rows={allDay} day={selectedKey} /> : null}
              {timed.length > 0
                ? (stacked || crowdedDay ? <DayAgenda rows={timed} day={selectedKey} /> : <DayTimeline rows={timed} day={selectedKey} nowIso={selectedKey === todayKey ? now.toISOString() : null} />)
                : null}
              {visibleRows.length === 0 ? (
                <View style={{ paddingVertical: 24, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: p.ln, backgroundColor: p.sf }} testID={dayRows.length === 0 ? 'calendar-day-free' : 'calendar-filter-empty'}>
                  <Txt size={15} color={p.mu} align="center">{dayRows.length === 0 ? (selectedFree?.state === 'full' ? t.yDayAllFree : t.dayFree) : t.referenceCalendarFilterEmpty}</Txt>
                </View>
              ) : null}
              {untimed.length > 0 ? <UntimedSection rows={untimed} title={t.calendarUntimedTitle} /> : null}
            </>
          )}
          {weekInsight ? <DeadlineContext item={weekInsight} weekly /> : null}
        </QueryBoundary>
      </ScreenScroll>
    </Screen>
  );
}

/** The instant a commitment occupies the clock at: a saved slot, its postponement, or its own hour (never an all-day midnight). */
function effectiveClock(view: CommitmentView): string | null {
  return view.plannedAt ?? view.postponedUntil ?? (view.allDay ? null : view.shownAt);
}

function clockMs(view: CommitmentView): number {
  const clock = effectiveClock(view);
  return clock ? Date.parse(clock) : Number.POSITIVE_INFINITY;
}

/** The local day a commitment is on (M4A-R5-002): its postponement or its own time; never before today. */
function effectiveDay(view: CommitmentView, todayKey: string, timeZone: string): string {
  const at = view.postponedUntil ?? view.shownAt;
  if (!at) return todayKey;
  const key = dayKey(new Date(at), timeZone);
  return key < todayKey ? todayKey : key;
}

function intervalOf(start: string | null | undefined, end: string | null | undefined): Interval | null {
  if (!start || !end) return null;
  const a = Date.parse(start);
  const b = Date.parse(end);
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? { start: a, end: b } : null;
}

/**
 * A pending change to today's plan (#523), as Stitch draws a proposal: what
 * would move, from when to when, and why — then «راجع التغييرات», which only
 * opens the review where it is accepted or declined, and «مش هلّق», which
 * puts the card away and answers nothing. It always says nothing has changed.
 */
function ProposalCard({ proposal, zone, onReview, onLater }: {
  proposal: PendingPlanProposal;
  zone: string;
  onReview: () => void;
  onLater: () => void;
}) {
  const { t, lang, rtl } = useApp();
  const p = useReferencePalette();
  const stacked = useLayoutMode() !== 'normal';
  const changes = proposal.changes.filter(change => change.kind !== 'unchanged');
  const range = (interval: { startsAt: string; endsAt: string } | null) => interval
    ? formatTimeRange(new Date(interval.startsAt), new Date(interval.endsAt), { locale: lang, timeZone: zone })
    : t.xNotSet;
  return (
    <View testID="calendar-proposal" style={{ borderRadius: 20, borderWidth: 1, borderColor: p.prop, backgroundColor: p.sf, padding: 18, gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <ReferenceIcon name="sparkles" size={18} color={p.wm} />
        <Txt size={14} weight={700} color={p.wm} style={{ flexShrink: 1 }}>{t.weekProposal}</Txt>
        <CountChip count={changes.length} testID="calendar-proposal-count" />
      </View>
      <Txt size={15} color={p.mu} lh={1.5}>{t[patchReasonKey(proposal.reason)]}</Txt>
      {changes.slice(0, 3).map(change => (
        <View key={`${change.kind}-${change.itemId}`} style={{ gap: 4, alignItems: 'flex-start' }}>
          <Txt size={16} weight={700} color={p.tx}>{change.title ? isolateAuto(change.title) : t.planRemovedItem}</Txt>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, borderRadius: 12, borderWidth: 1, borderColor: p.ln, backgroundColor: p.bg, paddingVertical: 6, paddingHorizontal: 10 }}>
            <Txt size={13} color={p.mu}>{`${t.xBefore}: ${range(change.from)}`}</Txt>
            <Txt size={13} weight={700} color={p.wm}>{rtl ? '←' : '→'}</Txt>
            <Txt size={13} weight={600} color={p.tx}>{`${t.xAfter}: ${change.kind === 'removed' && change.to === null ? t.xUnplaced : range(change.to)}`}</Txt>
          </View>
        </View>
      ))}
      <View style={{ flexDirection: stacked ? 'column' : 'row', gap: 10, marginTop: 2 }}>
        <Btn testID="calendar-patch" label={`${t.xPatch}. ${t.xPatchBody}`} onPress={onReview} scaleTo={0.97}
          style={{ flex: stacked ? undefined : 1, minHeight: 48, borderRadius: 999, backgroundColor: p.ac, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 }}>
          <Txt size={15} weight={700} color={p.onAccent} align="center">{t.xPatch}</Txt>
        </Btn>
        <Btn testID="calendar-proposal-later" label={t.notNow} onPress={onLater} scaleTo={0.97}
          style={{ minHeight: 48, borderRadius: 999, borderWidth: 1, borderColor: p.lnStrong, backgroundColor: p.sf, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 }}>
          <Txt size={15} weight={600} color={p.tx} align="center">{t.notNow}</Txt>
        </Btn>
      </View>
      <Txt size={13} color={p.mu} align="center" testID="calendar-proposal-note">{t.suggestionNote}</Txt>
    </View>
  );
}

/**
 * Which edges of the scrolling week strip fade, in the ScrollView's own
 * left-to-right space (`DirectionalScrollRow` lays it out LTR under RTL too):
 * `start` is the left edge. An edge fades only while days hide behind it.
 */
export function stripFadeFor(offset: number, content: number, viewport: number): { start: number; end: number } {
  const FADE = 32;
  return { start: offset > 1 ? FADE : 0, end: offset < content - viewport - 1 ? FADE : 0 };
}

function CalendarLegend({ color, label, testID }: { color: string; label: string; testID?: string }) {
  const p = useReferencePalette();
  return <View testID={testID} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
    <View accessible={false} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
    <Txt size={13} color={p.mu}>{label}</Txt>
  </View>;
}

/**
 * One day of the strip (Stitch): its weekday, its number, and one word for
 * how full it is. The dots under the word are the shape of the day — up to
 * three commitments and one for busy time — not a count to read.
 */
function DayCell({
  dayKey: key, isToday, selected, items, busy, load, loadLabel, complete, onPress,
}: {
  dayKey: string;
  isToday: boolean;
  selected: boolean;
  items: CommitmentView[];
  /** How many busy blocks the phone's calendar has that day; one dot when any. */
  busy: number;
  load: DayLoad;
  loadLabel: string;
  complete: boolean;
  onPress: () => void;
}) {
  const { lang } = useApp();
  const p = useReferencePalette();
  const stacked = useLayoutMode() !== 'normal';
  const date = civilDate(key);
  const options = { locale: lang, timeZone: CIVIL_ZONE } as const;
  const loadColor = complete ? (load === 'full' ? p.acd : load === 'light' ? p.success : p.mu) : p.mu;

  return (
    <Btn
      testID={`calendar-day-${key}`}
      onPress={onPress}
      label={`${formatDate(date, 'weekday', options)} ${formatDate(date, 'dayNumber', options)}, ${loadLabel}`}
      accessibilityState={{ selected }}
      scaleTo={0.94}
      style={{
        ...(stacked ? { width: 88 } : { flex: 1 }), minWidth: 44, minHeight: stacked ? 60 : 64,
        alignItems: 'center', gap: 1, paddingTop: stacked ? 6 : 8, paddingBottom: stacked ? 5 : 7, paddingHorizontal: 2, borderRadius: 16,
        backgroundColor: selected ? p.sf2 : p.sf, borderWidth: 1, borderColor: selected ? p.heroEdge : 'transparent',
      }}
    >
      <Txt size={12} weight={isToday ? 700 : 400} color={isToday ? p.wm : p.mu} align="center" lines={1}>{formatDate(date, 'weekdayShort', options)}</Txt>
      {/* `latin`: Noto Kufi's line box clips digits in a box this tight. */}
      <Txt size={16} weight={700} align="center" color={p.tx} lh={1.25} latin>
        {formatDate(date, 'dayNumber', options)}
      </Txt>
      {!stacked ? <Txt size={12} weight={load === 'normal' ? 400 : 700} color={loadColor} align="center" lines={1} testID={`calendar-load-${key}`}>{loadLabel}</Txt> : null}
      <View accessible={false} style={{ flexDirection: 'row', gap: 3, minHeight: 5, marginTop: 3 }}>
        {/* Three dots at most: a fourth would make a busy day unreadable, and
            the count is not the point — the shape of the week is. */}
        {items.slice(0, 3).map((item) => (
          <View key={item.id} testID={`calendar-bar-${key}`}
            style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: item.importance === 'must' ? p.acd : p.ac }} />
        ))}
        {busy > 0 ? <View testID={`calendar-busy-bar-${key}`} style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: p.mu }} /> : null}
      </View>
    </Btn>
  );
}
