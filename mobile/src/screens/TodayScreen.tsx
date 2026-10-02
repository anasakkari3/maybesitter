import { dayProgress, importantDeadline, planPreview } from '../features/today/dayContext';
import { DeadlineContext } from '../features/today/DeadlineContext';
import { weekStripKeys } from '../features/commitments/weekStrip';
import React, { useEffect, useMemo, useState } from 'react';
import { RefreshControl, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { isValidTimeZone, useTimeZone } from '../i18n/timezone';
import { dayKey, formatDate, formatRelativeDay, formatTime } from '../i18n/format';
import { fill, ltr, type Lang } from '../i18n/strings';
import { useCategoryPreferences, useCommitmentAction, useNextStep, usePlan, useProfile, useSavedWeek, useToday, useUpcoming } from '../api/queries';
import { quietHoursEndAt } from '../features/today/quietHoursEnd';
import { QueryBoundary } from '../api/ui/QueryBoundary';
import { ForbiddenError } from '../api/errors';
import { groupForToday, toViewModel, type CommitmentView, type TodayGroups } from '../features/commitments/model';
import { CategoryBar } from '../features/commitments/CategoryBar';
import { categoryChipsFor, filterByCategory, type CategoryChip } from '../features/commitments/categoryFilter';
import { rowAccessibilityLabel } from '../features/commitments/accessibility';
import { SwipeableRow, useRowActions } from '../features/commitments/RowActions';
import { postponeTo } from '../features/commitments/postpone';
import { whyFirstLine } from '../features/commitments/whyFirst';
import { NextStepCard } from '../features/nextStep/NextStepCard';
import { ProactiveInboxBanner } from '../features/goals/ProactiveInboxBanner';
import { BusyConflictChip } from '../features/calendar/BusyConflictChip';
import { useBusyBlocks } from '../features/calendar/useBusyCalendar';
import { useConflictBusyBlocks } from '../features/google/useGoogle';
import { busyAt } from '../features/calendar/conflicts';
import type { DeviceBusyBlock } from '../features/calendar/busyBlocks';
import { TodayPlanRow } from '../features/plan/TodayPlanRow';
import { drawnAt, drawnClockAt, drawnWhenLine, dueAsideText, laterWhen, placeView, savedPlacements } from '../features/plan/savedPlacement';
import { composeToday, type Primary } from '../features/today/composeToday';
import { Btn, Txt } from '../ui/primitives';
import { AvatarButton, SectionLabel, Tag, TextLink, priorityTagKind } from '../ui/chrome';
import { CheckIcon } from '../ui/icons';
import { isolateAuto } from '../i18n/bidi';
import { occurrenceCovering, occurrencesAsBusy, useWeeklyOccurrences } from '../features/weeklyBlocks/occurrences';
import { hideWeeklyDuplicates } from '../features/weeklyBlocks/weeklyDeviceEvents';
import { useWeeklyEventIds } from '../features/weeklyBlocks/useWeeklyBlockDeviceSync';
import { WeeklyOccurrenceRow } from '../features/weeklyBlocks/WeeklyOccurrenceRow';
import type { WeeklyBlockOccurrence } from '../api/schemas/weeklyBlocks';
import { Screen, ScreenScroll, TAB_CLEARANCE } from '../ui/screen';
import { ReferenceCard, ReferenceIcon, useReferencePalette } from '../ui/referenceDesign';
import { useLayoutMode } from '../theme/textScale';
import { firstConflict } from '../features/today/todayConflict';
import { ConflictLine, ConflictSheet, useFootballCommitmentIds } from '../features/today/ConflictLine';
import { PostponeSheetFor } from './Sheets';

/**
 * Today (UC-2.R3 #173, ordering from UC-2.8 #169; Round 2, Phase C).
 *
 * ── One answer to "what matters now" ─────────────────────────────
 *
 * The screen reads three server computations — the day's list, the next-step
 * recommendation, and the day's plan — and Round 1 drew them one above the
 * other, each free to name a different thing. `composeToday` reconciles them
 * into one model before anything is drawn: exactly one primary card, the rest
 * of the day with the primary taken out, a plan row that is honest about its
 * state, and a glimpse of what comes later. The layout follows the model; it
 * cannot present two truths because it is handed one.
 *
 * ── A deadline is a point, not a block ───────────────────────────
 *
 * A commitment here names a point: a deadline (`due_by`), or since CL1 a time
 * to be at (`scheduled_event`, for "at 5" with no "by"), both with no end the
 * user gave. So rows show a time, never an extent.
 *
 * ── The groups are the user's answer, and ranking works inside them ──
 *
 * Must, Should and Nice come from the priority the user set. #169's rank
 * orders items *within* a group and never across. Round 2 draws the day as
 * one flat list; the app keeps the three groups — in Round 2's row style,
 * with the importance as a tag — because the order they impose is the user's
 * own and a rank must not be allowed to undo it. Documented deviation.
 *
 * ── One card explains itself ─────────────────────────────────────
 *
 * The primary card, and only when it has a reason worth giving.
 *
 * ── The first screen (Stitch, 2026-10-02) ────────────────────────
 *
 * The conflict line when something clashes, the one next step, and «لازم»,
 * open. «مهم» and «حلو» fold to a line each that names their first item; the
 * plan, the weekly fixed time and what is finished come after. «مش هلّق»
 * asks when (the postpone sheet); the conflict line explains, it never
 * postpones. A football match is drawn with a ball, not a circle to tick.
 */
export function TodayScreen({ tabClearance = TAB_CLEARANCE }: { tabClearance?: number } = {}) {
  const { t, tr, lang, actions } = useApp();
  const p = useReferencePalette();
  const timezone = useTimeZone();
  const today = useToday();
  const next = useNextStep();
  const plan = usePlan(dayKey(new Date(), timezone));
  const upcoming = useUpcoming();
  // Where the saved week days put things (FX1): a row shows that, and its own
  // due beside it, as the Calendar and Details do.
  const savedWeek = useSavedWeek();
  const placements = useMemo(() => savedPlacements(savedWeek.data), [savedWeek.data]);
  // From the local cache (UC-3.2, #186). Today renders before any request has
  // finished, and a chip that arrived after the list would move rows about.
  // The phone's busy time and Google's (CL6a review I1).
  const readBusy = useConflictBusyBlocks(useBusyBlocks());
  // Today's weekly fixed blocks («ثابت أسبوعي»), drawn as fixed time. For the
  // conflict chips they are busy intervals in their own right, and the device
  // event this app wrote for one is dropped so it is not counted twice.
  const weeklyToday = useWeeklyOccurrences([dayKey(new Date(), timezone)], timezone);
  const weeklyEventIds = useWeeklyEventIds();
  const busy = useMemo(
    () => [...hideWeeklyDuplicates(readBusy, weeklyEventIds, weeklyToday), ...occurrencesAsBusy(weeklyToday)],
    [readBusy, weeklyEventIds, weeklyToday],
  );
  const [refreshing, setRefreshing] = useState(false);

  // Off unless the account says otherwise, and off when the preference will not
  // load: a filter bar is not worth an error (#415).
  const preferences = useCategoryPreferences();
  const categories = preferences.data?.categoryPreferences;
  const [chip, setChip] = useState<CategoryChip>('all');
  const showBar = categories?.grouping === true;

  // Chips come from the whole day, not from what is currently shown.
  const chips = useMemo(
    () => categoryChipsFor(today.data?.items ?? [], categories?.enabled ?? []),
    [today.data, categories?.enabled],
  );

  const now = new Date().toISOString();
  const groups: TodayGroups = useMemo(
    () => {
      const items = today.data?.items ?? [];
      const grouped = groupForToday(showBar ? filterByCategory(items, chip) : items, now);
      const place = (views: CommitmentView[]) => views.map((view) => placeView(view, placements));
      return { must: place(grouped.must), should: place(grouped.should), nice: place(grouped.nice), finished: grouped.finished };
    },
    // `now` deliberately excluded: re-grouping on every render would move rows
    // under the user's finger as the clock ticks past a due time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [today.data, showBar, chip, placements],
  );
  const upcomingViews = useMemo(
    () => (upcoming.data?.items ?? []).map((c) => placeView(toViewModel(c, now), placements)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [upcoming.data, placements],
  );

  const model = useMemo(() => composeToday({
    groups,
    next: {
      recommendation: next.data?.recommendation,
      silenced: next.data?.exposure?.allowed === false,
      silencedReason: next.data?.exposure?.reason,
      quietUntil: next.data?.exposure?.until,
      isPending: next.isPending,
      isError: next.isError,
      // A 403 is the route answering, not failing: recommendations are off
      // until the account turns them on, and every account starts that way.
      unavailable: next.error instanceof ForbiddenError,
    },
    plan: { plan: plan.data, isPending: plan.isPending, isError: plan.isError },
    upcoming: upcomingViews,
  }), [groups, next.data, next.isPending, next.isError, next.error, plan.data, plan.isPending, plan.isError, upcomingViews]);

  const byId = useMemo(() => {
    const all = [...groups.must, ...groups.should, ...groups.nice, ...groups.finished];
    return new Map(all.map((c) => [c.id, c]));
  }, [groups]);

  const visibleRecords = showBar ? filterByCategory(today.data?.items ?? [], chip) : today.data?.items ?? [];
  const preview = planPreview(plan.data, visibleRecords, new Date());
  const previewIds = new Set(preview.map(item => item.id));
  const progress = dayProgress(visibleRecords, dayKey(new Date(), timezone), timezone);
  const futureRecords = showBar ? filterByCategory(upcoming.data?.items ?? [], chip) : upcoming.data?.items ?? [];
  const insight = importantDeadline(futureRecords, [weekStripKeys(new Date(), timezone)[1]!], timezone);
  const restGroups = {
    must: model.groups.must.filter(item => !previewIds.has(item.id)),
    should: model.groups.should.filter(item => !previewIds.has(item.id)),
    nice: model.groups.nice.filter(item => !previewIds.has(item.id)),
    finished: model.groups.finished.filter(item => !previewIds.has(item.id)),
  };
  const later = model.later.filter(item => !previewIds.has(item.id) && item.id !== insight?.id);

  const strings = t as unknown as Record<string, string>;

  // Quiet hours end on the profile's clock (FZ2 review M4): said on the
  // phone's, and asked again the moment they end, so a card that says
  // "back at 07:30" does not outlive 07:30 on an open screen. With no
  // profile yet the card says no hour rather than a wrong one.
  const profileZone = useProfile().data?.routine?.timezone;
  // A weekly block's `until` is on the same kind of clock (weekly blocks), and
  // is read the same way when the block itself is not in hand.
  const holdReason = next.data?.exposure?.reason;
  const quietUntil = holdReason === 'quiet_hours' || holdReason === 'weekly_block' ? next.data?.exposure?.until : undefined;
  // The block under way, when the route says one is: its own end is exact.
  const holding = holdReason === 'weekly_block' ? occurrenceCovering(weeklyToday, new Date()) : null;
  const holdingEnd = holding?.endAt;
  const quietEndsAt = useMemo(
    () => (holdingEnd ? new Date(holdingEnd)
      : quietUntil && isValidTimeZone(profileZone) ? quietHoursEndAt(quietUntil, profileZone, new Date()) : null),
    // Recomputed per answer, not per render: `new Date()` is read when the
    // route answered, which is what `until` was true of.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [holdingEnd, quietUntil, profileZone, next.dataUpdatedAt],
  );
  const refetchNext = next.refetch;
  useEffect(() => {
    if (!quietEndsAt) return undefined;
    // Asked once at the end, and once more if that ask fails (review m6), so a
    // dropped request does not leave "back at 07:30" standing after 07:30.
    let retry: ReturnType<typeof setTimeout> | undefined;
    let gone = false;
    const wait = Math.min(Math.max(0, quietEndsAt.getTime() - Date.now()) + QUIET_END_MARGIN_MS, MAX_TIMER_MS);
    const timer = setTimeout(() => {
      void refetchNext().then((result) => {
        if (result.isError && !gone) retry = setTimeout(() => { void refetchNext(); }, QUIET_END_RETRY_MS);
      });
    }, wait);
    return () => { gone = true; clearTimeout(timer); clearTimeout(retry); };
  }, [quietEndsAt, refetchNext]);

  const refresh = () => {
    setRefreshing(true);
    void Promise.all([today.refetch(), next.refetch(), plan.refetch(), upcoming.refetch(), savedWeek.refetch()]).finally(() => setRefreshing(false));
  };

  const conflict = useMemo(
    () => firstConflict([...groups.must, ...groups.should, ...groups.nice], busy),
    [groups, busy],
  );
  const [conflictOpen, setConflictOpen] = useState(false);
  const [postponeId, setPostponeId] = useState<string | null>(null);
  const football = useFootballCommitmentIds();
  const stacked = useLayoutMode() !== 'normal';

  return (
    <Screen style={{ backgroundColor: p.bg }}>
      <ScreenScroll
        testID="today-scroll"
        floating={tabClearance}
        topGap={8}
        gap={16}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={p.ac} />}
      >
        {/* Stitch header: the title and the date at the start, search and the
            avatar (Settings) at the end. */}
        <View style={{ flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'stretch' : 'flex-start', justifyContent: 'space-between', gap: 12, paddingHorizontal: 4 }}>
          <View style={{ flexShrink: 1, gap: 2, alignItems: 'flex-start' }}>
            <Txt role="page" size={28} weight={700} color={p.tx}>{t.todayTitle}</Txt>
            <Txt size={13} weight={500} color={p.mu} testID="today-date">{formatDate(new Date(), 'weekday', { locale: lang, timeZone: timezone })}</Txt>
          </View>
          <View style={{ flexDirection: 'row', gap: 8, alignSelf: stacked ? 'flex-end' : undefined }}>
            <Btn label={t.xSearch} testID="reference-search" onPress={() => actions.go('commitments')} scaleTo={0.94}
              style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln }}>
              <ReferenceIcon name="search" size={20} color={p.mu} />
            </Btn>
            <AvatarButton />
          </View>
        </View>

        {showBar ? <CategoryBar chips={chips} selected={chip} onSelect={setChip} /> : null}

        <QueryBoundary isPending={today.isPending} error={today.error} onRetry={() => void today.refetch()}>
          {model.isEmpty ? (
            // No capture button here: the bar's own «احكيها» is the one way in,
            // and a second one competing with it was the audit's finding.
            <>
              {/* A day with only a fixed block still has the block on it. */}
              <WeeklyToday items={weeklyToday} />
              <EmptyDay />
            </>
          ) : (
            <>
              {/* FIRST SCREEN · the clash (if any), the one next step, «لازم». */}
              {conflict ? <ConflictLine conflict={conflict} onOpen={() => setConflictOpen(true)} /> : null}

              <PrimaryCard primary={model.primary} quietEndsAt={quietEndsAt} holding={holding} lookup={byId} strings={strings} timezone={timezone} lang={lang} busy={busy} onPostpone={setPostponeId} />

              <Txt size={13} color={p.mu} testID="today-count" style={{ paddingHorizontal: 4 }}>
                {progress ? tr('todayProgressCompact', progress) : tr('todayCountOpen', { n: model.openTotal })}
              </Txt>

              <Group kind="must" items={restGroups.must} timezone={timezone} lang={lang} busy={busy} football={football} />

              {/* The plan, always present, always honest. Under «لازم» and
                  above the rest: the items it previews are taken out of those
                  groups, so below them it would land under the finished ones. */}
              <TodayPlanRow row={model.plan} preview={preview} />

              {/* The rest of today, in the user's own groups, folded to one line each. */}
              <Group kind="should" items={restGroups.should} timezone={timezone} lang={lang} busy={busy} football={football} />
              <Group kind="nice" items={restGroups.nice} timezone={timezone} lang={lang} busy={busy} football={football} />

              {/* Fixed today: taken time, not things to do. */}
              <WeeklyToday items={weeklyToday} />

              {restGroups.finished.length > 0 ? <FinishedGroup items={restGroups.finished} /> : null}

              <ProactiveInboxBanner />

              {/* TERTIARY · later */}
              {later.length > 0 ? (
                <View style={{ gap: 6 }}>
                  <SectionLabel testID="today-later-title">{t.todayLaterTitle}</SectionLabel>
                  <ReferenceCard pad={0} style={{ overflow: 'hidden', gap: 0 }} testID="today-later">
                    {later.map((item, index) => (
                      <LaterRow key={item.id} item={item} first={index === 0} timezone={timezone} lang={lang} />
                    ))}
                    <View style={{ paddingHorizontal: 18, paddingVertical: 8, borderTopWidth: 1, borderTopColor: p.ln }}>
                      <TextLink label={t.todayLaterSeeAll} onPress={() => actions.go('calendar')} testID="today-later-all" size={13} />
                    </View>
                  </ReferenceCard>
                </View>
              ) : null}
              {insight ? <DeadlineContext item={insight} /> : null}
            </>
          )}
        </QueryBoundary>

        {/* Your day's context, one quiet link at the end rather than in the header. */}
        <View style={{ alignItems: 'center' }}>
          <TextLink label={t.xAssistant} onPress={() => actions.go('contextualAssistant')} testID="today-assistant" size={13} />
        </View>
      </ScreenScroll>

      <ConflictSheet conflict={conflictOpen ? conflict : null} onClose={() => setConflictOpen(false)} />
      <PostponeSheetFor commitmentId={postponeId} onClose={() => setPostponeId(null)} />
    </Screen>
  );
}

const GROUP_TITLE = {
  must: 'todayGroupMust',
  should: 'todayGroupShould',
  nice: 'todayGroupNice',
} as const;

/** A beat after quiet hours end, so the route asked again is already past them. */
const QUIET_END_MARGIN_MS = 2_000;
/** How long before the one retry, when the ask at the end fails. */
const QUIET_END_RETRY_MS = 30_000;
/** setTimeout's ceiling (about 24.8 days). */
const MAX_TIMER_MS = 2_147_483_647;

/** Today's weekly fixed blocks («ثابت اليوم»), folded to one line that names them; open, in time order. */
function WeeklyToday({ items }: { items: readonly WeeklyBlockOccurrence[] }) {
  const { t, lang } = useApp();
  const p = useReferencePalette();
  const timezone = useTimeZone();
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const sorted = [...items].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  const summary = sorted
    .map((o) => `${o.title} ${ltr(formatTime(new Date(o.startAt), { locale: lang, timeZone: timezone }))}`)
    .join(' · ');
  return (
    <View style={{ gap: 8, backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 4 }} testID="today-weekly">
      <Btn
        testID="today-weekly-toggle"
        label={`${t.wbTodayTitle}: ${summary}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        scaleTo={0.99}
        style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10 }}
      >
        <ReferenceIcon name="repeat" size={18} color={p.mu} />
        <Txt size={13} color={p.mu} style={{ flex: 1 }}>
          <Txt size={13} weight={600} color={p.mu} testID="today-weekly-title">{t.wbTodayTitle}</Txt>
          {': '}
          <Txt size={13} weight={600} color={p.tx}>{summary}</Txt>
        </Txt>
        <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}><ReferenceIcon name="chevron-down" size={18} color={p.mu} /></View>
      </Btn>
      {open ? (
        <View style={{ gap: 8, paddingBottom: 10 }}>
          {sorted.map((occurrence) => (
            <WeeklyOccurrenceRow
              key={`${occurrence.weeklyBlockId}-${occurrence.startAt}`}
              occurrence={occurrence}
              testID={`today-weekly-${occurrence.weeklyBlockId}`}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** The calm empty day (Stitch `01c`): a quiet mark, the title, one sentence. */
function EmptyDay() {
  const { t } = useApp();
  const p = useReferencePalette();
  return (
    <View testID="today-empty" style={{ alignItems: 'center', gap: 12, paddingTop: 40, paddingHorizontal: 24 }}>
      <View accessible={false} style={{ width: 136, height: 136, borderRadius: 28, borderWidth: 1, borderColor: p.ln, backgroundColor: p.sf, alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
        <View style={{ width: 92, height: 92, borderRadius: 20, borderWidth: 1, borderColor: p.heroEdge, backgroundColor: p.sf2, alignItems: 'center', justifyContent: 'center', gap: 8, transform: [{ rotate: '-3deg' }] }}>
          <View style={{ width: 40, height: 6, borderRadius: 3, backgroundColor: p.acs }} />
          <View style={{ width: 56, height: 6, borderRadius: 3, backgroundColor: p.ln }} />
          <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 1, borderColor: p.ac, alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: p.ac }} />
          </View>
        </View>
      </View>
      <Txt role="section" size={24} weight={700} align="center">{t.emptyTitle}</Txt>
      <Txt size={15} color={p.mu} align="center" lh={1.6} style={{ maxWidth: 320 }}>{t.emptyBody}</Txt>
    </View>
  );
}

/** A card on Today: the surface, the hairline, radius 20 (Stitch). */
const cardStyle = (p: ReturnType<typeof useReferencePalette>) => ({
  backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, borderRadius: 20, padding: 18, gap: 10,
});

function PrimaryCard({ primary, quietEndsAt, holding, lookup, strings, timezone, lang, busy, onPostpone }: {
  primary: Primary;
  /** When quiet hours (or a weekly block) end, as an instant; null until it is known on which clock. */
  quietEndsAt: Date | null;
  /** The weekly block under way, when the route went quiet for one and it is in hand. */
  holding: WeeklyBlockOccurrence | null;
  lookup: ReadonlyMap<string, CommitmentView>;
  strings: Record<string, string>;
  timezone: string;
  lang: Lang;
  busy: readonly DeviceBusyBlock[];
  onPostpone: (id: string) => void;
}) {
  const { t, actions } = useApp();
  const p = useReferencePalette();
  switch (primary.kind) {
    case 'quiet':
      // Three different silences (UAT round 3, N12). Only quiet mode is a
      // switch the person turned on, so only it points at Trust; quiet hours
      // end by themselves and point at where they are set; the operator's
      // pause offers nothing to switch.
      return (
        <View style={cardStyle(p)} testID="today-quiet">
          <Txt size={13} weight={600} color={p.mu}>{t.nextStepLabel}</Txt>
          <Txt size={15} lh={1.5}>
            {primary.why === 'mode' ? t.todayQuietModeOn
              : primary.why === 'paused' ? t.todayNextPaused
                : primary.why === 'block' ? weeklyHoldLine(t, holding, quietEndsAt, lang, timezone)
                  : quietEndsAt ? fill(t.todayQuietHoursUntil, { time: ltr(formatTime(quietEndsAt, { locale: lang, timeZone: timezone })) }) : t.todayQuietHours}
          </Txt>
          {primary.why === 'mode' ? (
            <TextLink label={t.sTrust} onPress={() => actions.go('trust')} testID="today-quiet-trust" />
          ) : null}
          {primary.why === 'hours' ? (
            <TextLink label={t.notifQuietTitle} onPress={() => actions.go('notificationsSettings')} testID="today-quiet-hours" />
          ) : null}
          {primary.why === 'block' ? (
            <TextLink label={t.wbTitle} onPress={() => actions.go('weeklyBlocks')} testID="today-quiet-weekly" />
          ) : null}
        </View>
      );
    case 'allDone':
      return (
        <View style={[cardStyle(p), { alignItems: 'center', padding: 22 }]} testID="today-all-done">
          <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: p.successSoft, alignItems: 'center', justifyContent: 'center' }}>
            <CheckIcon size={22} color={p.success} />
          </View>
          <Txt size={20} weight={600} align="center">{t.todayAllDoneTitle}</Txt>
          <Txt size={14} color={p.mu} align="center">{t.todayAllDoneBody}</Txt>
        </View>
      );
    case 'next':
      return <NextStepCard lookup={lookup} />;
    case 'fallback':
      return <FallbackCard item={primary.item} strings={strings} timezone={timezone} lang={lang} busy={busy} onPostpone={onPostpone} />;
    case 'none':
      return null;
  }
}

/**
 * «هلّق وقت تدريب. بنرجع نقترح الساعة 16:00.» — the block's own title and end
 * when it is in hand; the generic line, with the route's `until`, when it is
 * not; and no hour at all rather than a wrong one.
 */
function weeklyHoldLine(
  t: ReturnType<typeof useApp>['t'],
  holding: WeeklyBlockOccurrence | null,
  endsAt: Date | null,
  lang: Lang,
  timezone: string,
): string {
  if (!endsAt) return t.wbNextNowNoTime;
  const time = ltr(formatTime(endsAt, { locale: lang, timeZone: timezone }));
  return holding ? fill(t.wbNextNow, { title: isolateAuto(holding.title), time }) : fill(t.wbNextNowGeneric, { time });
}

/**
 * The list's own top item, as the primary when there is no recommendation to
 * show. It explains itself with the ranking's reasons (#169) — the one place
 * a "why first" line appears — and offers two answers: «خلصتها» completes it,
 * «مش هلّق» asks when to bring it back (the postpone sheet). There is no
 * «بلّش فيها» here: starting is an answer to a proposal, and this is not one.
 */
function FallbackCard({ item, strings, timezone, lang, busy, onPostpone }: {
  item: CommitmentView;
  strings: Record<string, string>;
  timezone: string;
  lang: Lang;
  busy: readonly DeviceBusyBlock[];
  onPostpone: (id: string) => void;
}) {
  const { t, actions } = useApp();
  const p = useReferencePalette();
  const act = useCommitmentAction();
  const stacked = useLayoutMode() !== 'normal';
  const why = whyFirstLine(item.reasonCodes, strings);
  const drawn = drawnClockAt(item);
  const line = drawnWhenLine(item, lang, timezone);
  const when = line?.text ?? t.noTimeYet;
  const aside = dueAsideText(item, t.plannedDueAside, lang, timezone);
  return (
    <View
      testID="today-primary"
      style={{
        gap: 12, padding: 18, borderRadius: 22, borderWidth: 1, borderColor: p.heroEdge, backgroundColor: p.sf,
        shadowColor: p.ac, shadowOpacity: p.shadow ? 0.12 : 0.22, shadowRadius: 22, shadowOffset: { width: 0, height: 8 }, elevation: 4,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: p.acs, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 12 }}>
          <View accessible={false} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p.ac }} />
          <Txt size={13} weight={600} color={p.acd}>{t.nextStepLabel}</Txt>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', flexShrink: 1 }}>
          <Tag kind={priorityTagKind(item.importance)} label={importanceLabel(item, t)} />
          <Txt size={13} weight={500} color={p.mu} latin={!line?.dated} testID={`today-time-${item.id}`}>{when}</Txt>
        </View>
      </View>
      <Btn
        testID={`today-item-${item.id}`}
        label={`${rowAccessibilityLabel(item, t, line?.text ?? null)}${aside ? `, ${aside}` : ''}`}
        onPress={() => actions.openDetail(item.id)}
        scaleTo={0.99}
        style={{ alignItems: 'flex-start', gap: 4 }}
      >
        <Txt role="section" size={20} weight={700} color={p.tx}>{item.title}</Txt>
        {!item.importanceIsStated && item.importance === 'must' ? (
          <Txt size={13} color={p.mu} testID={`today-estimated-${item.id}`}>{t.todayEstimatedMark}</Txt>
        ) : null}
        {aside ? <Txt size={13} color={p.mu} testID={`today-due-${item.id}`}>{aside}</Txt> : null}
      </Btn>
      {why ? <Txt size={15} color={p.mu} lh={1.6} testID="today-why-first">{why}</Txt> : null}
      <BusyConflictChip blocks={drawn ? busyAt(drawn, busy) : []} testID={`today-busy-${item.id}`} />
      <View style={{ flexDirection: stacked ? 'column' : 'row', gap: 8, borderTopWidth: 1, borderTopColor: p.ln, paddingTop: 12 }}>
        <Btn testID={`today-primary-complete`} label={t.nextStepDone} onPress={() => act.mutate({ id: item.id, action: 'complete' })}
          style={{ ...(stacked ? {} : { flex: 1 }), minHeight: 48, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 999, backgroundColor: p.ac, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center' }}>
          <CheckIcon size={16} color={p.onAccent} />
          <Txt size={15} weight={600} color={p.onAccent}>{t.nextStepDone}</Txt>
        </Btn>
        <Btn testID={`today-primary-postpone`} label={t.notNow} onPress={() => onPostpone(item.id)}
          style={{ minHeight: 48, paddingVertical: 10, paddingHorizontal: 18, borderRadius: 999, borderWidth: 1, borderColor: p.ln, backgroundColor: p.sf2, alignItems: 'center', justifyContent: 'center' }}>
          <Txt size={14} weight={500} color={p.mu}>{t.notNow}</Txt>
        </Btn>
      </View>
    </View>
  );
}

function importanceLabel(item: CommitmentView, t: ReturnType<typeof useApp>['t']): string {
  return item.importance === 'must' ? t.todayGroupMust : item.importance === 'should' ? t.todayGroupShould : t.todayGroupNice;
}

/** The colour a row's time is drawn in: its importance's own, from the contrast-tested pairs. */
function importanceInk(importance: CommitmentView['importance'], p: ReturnType<typeof useReferencePalette>): string {
  return importance === 'must' ? p.acd : importance === 'should' ? p.wm : p.success;
}

/**
 * One importance group (Stitch). «لازم» is always open: it is part of the
 * first screen. «مهم» and «حلو» fold to one line — their chip, the first
 * item and its time, and how many more — and open on a tap.
 */
function Group({ kind, items, timezone, lang, busy, football }: {
  kind: 'must' | 'should' | 'nice';
  items: CommitmentView[];
  timezone: string;
  lang: Lang;
  busy: readonly DeviceBusyBlock[];
  football: ReadonlySet<string>;
}) {
  const { t, tr } = useApp();
  const p = useReferencePalette();
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const title = (t as unknown as Record<string, string>)[GROUP_TITLE[kind]]!;
  const rows = items.map((item, index) => (
    <Row key={item.id} item={item} first={index === 0} timezone={timezone} lang={lang} busy={busy} football={football.has(item.id)} />
  ));

  if (kind === 'must') {
    return (
      <View style={{ gap: 10 }} testID="today-group-must">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 }}>
          <Tag kind="must" label={title} />
          <Txt size={13} weight={500} color={p.mu}>{tr('todayCountOpen', { n: items.length })}</Txt>
        </View>
        {rows}
      </View>
    );
  }

  const first = items[0]!;
  const firstWhen = drawnWhenLine(first, lang, timezone)?.text;
  const preview = `· ${first.title}${firstWhen ? ` ${firstWhen}` : ''}${items.length > 1 ? ` ${isolateAuto(`+${items.length - 1}`)}` : ''}`;
  return (
    <View style={{ gap: 10 }} testID={`today-group-${kind}`}>
      <Btn
        testID={`today-group-${kind}-toggle`}
        label={`${title}, ${tr('todayCountOpen', { n: items.length })}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        scaleTo={0.99}
        style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 16, backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln }}
      >
        <Tag kind={priorityTagKind(kind)} label={title} />
        <Txt size={13} weight={500} color={p.mu} style={{ flex: 1 }} testID={`today-group-${kind}-preview`}>{preview}</Txt>
        <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}><ReferenceIcon name="chevron-down" size={18} color={p.mu} /></View>
      </Btn>
      {open ? rows : null}
    </View>
  );
}

function Row({ item, timezone, lang, busy, football }: {
  item: CommitmentView;
  first: boolean;
  timezone: string;
  lang: Lang;
  busy: readonly DeviceBusyBlock[];
  /** A match (football): a ball where the completion circle would be. */
  football: boolean;
}) {
  const { t, actions } = useApp();
  const p = useReferencePalette();
  const act = useCommitmentAction();

  /**
   * Done and "not now", from the row (UC-2.R3 #173 steps 3, 8). Both are real
   * transitions on the actions route: `complete` closes the commitment and
   * `postpone` moves it an hour, the same default the details sheet uses.
   */
  const rowActions = useRowActions(item, {
    complete: () => act.mutate({ id: item.id, action: 'complete' }),
    postpone: () => act.mutate({ id: item.id, action: 'postpone', postponedUntil: postponeTo('oneHour', new Date(), timezone) }),
  });
  const drawn = drawnClockAt(item);
  const line = drawnWhenLine(item, lang, timezone);
  const when = line?.text ?? t.noTimeYet;
  const aside = dueAsideText(item, t.plannedDueAside, lang, timezone);
  const ink = importanceInk(item.importance, p);

  return (
    <SwipeableRow actions={rowActions} testID={`today-swipe-${item.id}`}>
      <Btn
        testID={`today-item-${item.id}`}
        accessibilityActions={rowActions.map(({ name, label }) => ({ name, label }))}
        onAccessibilityAction={(event) => {
          rowActions.find((action) => action.name === event.nativeEvent.actionName)?.run();
        }}
        label={`${rowAccessibilityLabel(item, t, line?.text ?? null)}${aside ? `, ${aside}` : ''}${football ? `, ${t.todayFootballMark}` : ''}`}
        onPress={() => actions.openDetail(item.id)}
        scaleTo={0.98}
        style={{
          flexDirection: 'row', alignItems: 'center', gap: 8,
          paddingVertical: 10, paddingStart: 6, paddingEnd: 14, minHeight: 68,
          borderWidth: 1, borderColor: p.ln, borderRadius: 20, backgroundColor: p.sf,
        }}
      >
        {football ? (
          // A match is not ticked off; it is time that is taken.
          <View accessible={false} testID={`today-football-${item.id}`} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: p.successSoft, alignItems: 'center', justifyContent: 'center' }}>
              <ReferenceIcon name="football" size={18} color={p.success} />
            </View>
          </View>
        ) : (
          // The circle is the row's own done affordance; the swipe and the
          // assistive action do the same thing. 44 × 44 to press, 22 to see.
          <Btn label={t.doneS} testID={`today-row-done-${item.id}`} onPress={() => act.mutate({ id: item.id, action: 'complete' })}
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: p.lnStrong }} />
          </Btn>
        )}
        <View style={{ flex: 1, gap: 4, alignItems: 'flex-start' }}>
          <Txt size={15} weight={600} color={p.tx}>{item.title}</Txt>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {/* A deadline is a point in time, so it reads as one. There is no
                "overdue": a time that has passed is drawn like any other. */}
            <Txt size={13} weight={500} color={ink} latin={!line?.dated} testID={`today-time-${item.id}`}>{when}</Txt>
            {/* The importance was read off their words, not stated by them (#169). */}
            {!item.importanceIsStated && item.importance === 'must' ? (
              <Txt size={13} color={p.mu} testID={`today-estimated-${item.id}`}>{`· ${t.todayEstimatedMark}`}</Txt>
            ) : null}
            <Txt size={13} color={p.mu}>·</Txt>
            <Tag kind={priorityTagKind(item.importance)} label={importanceLabel(item, t)} />
          </View>
          {aside ? <Txt size={13} color={p.mu} testID={`today-due-${item.id}`}>{aside}</Txt> : null}
          {/* What else is happening then (UC-3.2, #186): a muted note, never a
              warning, never something that stops the row being opened. */}
          <BusyConflictChip blocks={drawn ? busyAt(drawn, busy) : []} testID={`today-busy-${item.id}`} />
        </View>
      </Btn>
    </SwipeableRow>
  );
}

function LaterRow({ item, first, timezone, lang }: { item: CommitmentView; first: boolean; timezone: string; lang: Lang }) {
  const { t, actions } = useApp();
  const p = useReferencePalette();
  // Its day is said even when it has no hour (an all-day deadline, FX3).
  const drawn = drawnAt(item);
  const when = laterWhen(item, lang, timezone, t.noTimeYet);
  const aside = dueAsideText(item, t.plannedDueAside, lang, timezone);
  const returnWhen = item.postponedUntil
    ? `${t.postponeReturn} ${formatRelativeDay(new Date(item.postponedUntil), { locale: lang, timeZone: timezone })} · ${ltr(formatTime(new Date(item.postponedUntil), { locale: lang, timeZone: timezone }))}`
    : null;
  return (
    <Btn
      testID={`today-later-${item.id}`}
      label={`${rowAccessibilityLabel(item, t, drawn ? when : null)}${aside ? `, ${aside}` : ''}${returnWhen ? `, ${returnWhen}` : ''}`}
      onPress={() => actions.openDetail(item.id)}
      scaleTo={0.98}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 18, minHeight: 56, borderTopWidth: first ? 0 : 1, borderTopColor: p.ln }}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: item.importance === 'must' ? p.wm : p.lnStrong }} />
      {/* Start-aligned by the column, not by textAlign alone: a Latin title
          ("Dentist") in the Arabic layout starts beside the dot (u32). */}
      <View style={{ flex: 1, gap: 2, alignItems: 'flex-start' }}>
        <Txt size={15}>{item.title}</Txt>
        <Txt size={12} color={p.mu} testID={`today-later-when-${item.id}`}>{when}</Txt>
        {aside ? <Txt size={12} color={p.mu} testID={`today-later-due-${item.id}`}>{aside}</Txt> : null}
        {returnWhen ? <Txt size={12} color={p.mu} testID={`today-postponed-${item.id}`}>{returnWhen}</Txt> : null}
      </View>
    </Btn>
  );
}

/**
 * Done and dropped, collapsed. No time on these rows: when a thing was due
 * stopped mattering the moment it was resolved. Both are finished and both
 * collapse, but the row says which: «أسقطه بوعي» carries the same weight as
 * «تمّت», and folding a deliberate drop into "done" would erase a decision.
 */
function FinishedGroup({ items }: { items: CommitmentView[] }) {
  const { t, actions } = useApp();
  const p = useReferencePalette();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: p.ln, paddingTop: 4, gap: 8 }} testID="today-group-finished">
      <Btn
        testID="today-finished-toggle"
        accessibilityState={{ expanded: open }}
        label={`${t.todayGroupFinished} (${items.length})`}
        onPress={() => setOpen(!open)}
        scaleTo={0.99}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, paddingHorizontal: 4 }}
      >
        <ReferenceIcon name="check" size={18} color={p.success} />
        <Txt size={14} weight={600} color={p.tx} style={{ flex: 1 }}>{`${t.todayGroupFinished} (${items.length})`}</Txt>
        <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}><ReferenceIcon name="chevron-down" size={18} color={p.mu} /></View>
      </Btn>
      {open ? items.map((item) => (
        <Btn
          key={item.id}
          testID={`today-finished-${item.id}`}
          label={item.title}
          onPress={() => actions.openDetail(item.id)}
          scaleTo={0.98}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1, borderColor: p.ln, backgroundColor: p.sf, minHeight: 48 }}
        >
          <View style={{
            width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
            backgroundColor: item.status === 'done' ? p.successSoft : 'transparent',
            borderWidth: item.status === 'done' ? 0 : 2, borderColor: p.lnStrong,
          }}>
            {item.status === 'done' ? <CheckIcon color={p.success} /> : null}
          </View>
          <Txt size={14} color={p.mu} style={{ flex: 1, textDecorationLine: 'line-through' }}>{item.title}</Txt>
          <Txt size={13} weight={600} color={item.status === 'done' ? p.success : p.mu}>{item.status === 'done' ? t.doneS : t.dropped}</Txt>
        </Btn>
      )) : null}
    </View>
  );
}
