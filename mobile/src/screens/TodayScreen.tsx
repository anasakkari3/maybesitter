import { dayProgress, importantDeadline, planPreview } from '../features/today/dayContext';
import { DeadlineContext } from '../features/today/DeadlineContext';
import { weekStripKeys } from '../features/commitments/weekStrip';
import React, { useMemo, useState } from 'react';
import { RefreshControl, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useTimeZone } from '../i18n/timezone';
import { dayKey, formatDate, formatRelativeDay, formatTime } from '../i18n/format';
import { ltr, type Lang } from '../i18n/strings';
import { useCategoryPreferences, useCommitmentAction, useNextStep, usePlan, useToday, useUpcoming } from '../api/queries';
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
import { BusyConflictChip } from '../features/calendar/BusyConflictChip';
import { useBusyBlocks } from '../features/calendar/useBusyCalendar';
import { busyAt } from '../features/calendar/conflicts';
import type { DeviceBusyBlock } from '../features/calendar/busyBlocks';
import { TodayPlanRow } from '../features/plan/TodayPlanRow';
import { composeToday, type Primary } from '../features/today/composeToday';
import { Btn, Card, Txt } from '../ui/primitives';
import { ActionRow, EmptyState, ScreenHeader, SectionLabel, Tag, TextLink } from '../ui/chrome';
import { CheckIcon, Glow } from '../ui/icons';
import { Screen, ScreenScroll } from '../ui/screen';

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
 * Every commitment here is a *deadline* (`mapExtractionToCommand.ts` only
 * ever emits `due_by` or `unscheduled`), so rows show a time, never an extent.
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
 */
export function TodayScreen({ tabClearance = 130 }: { tabClearance?: number } = {}) {
  const { t, tr, p, lang, actions } = useApp();
  const timezone = useTimeZone();
  const today = useToday();
  const next = useNextStep();
  const plan = usePlan(dayKey(new Date(), timezone));
  const upcoming = useUpcoming();
  // From the local cache (UC-3.2, #186). Today renders before any request has
  // finished, and a chip that arrived after the list would move rows about.
  const busy = useBusyBlocks();
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
      return groupForToday(showBar ? filterByCategory(items, chip) : items, now);
    },
    // `now` deliberately excluded: re-grouping on every render would move rows
    // under the user's finger as the clock ticks past a due time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [today.data, showBar, chip],
  );
  const upcomingViews = useMemo(
    () => (upcoming.data?.items ?? []).map((c) => toViewModel(c, now)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [upcoming.data],
  );

  const model = useMemo(() => composeToday({
    groups,
    next: {
      recommendation: next.data?.recommendation,
      silenced: next.data?.exposure?.allowed === false,
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
  const preview = planPreview(plan.data, visibleRecords);
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
  const hasRest = Object.values(restGroups).some(items => items.length > 0);

  const refresh = () => {
    setRefreshing(true);
    void Promise.all([today.refetch(), next.refetch(), plan.refetch(), upcoming.refetch()]).finally(() => setRefreshing(false));
  };

  return (
    <Screen
      decoration={(
        <View pointerEvents="none" style={{ position: 'absolute', top: -120, end: -80 }}>
          <Glow color={p.acs} />
        </View>
      )}
    >
      <ScreenScroll
        testID="today-scroll"
        bottom={tabClearance}
        topGap={8}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={p.ac} />}
      >
        <ScreenHeader
          eyebrow={formatDate(new Date(), 'weekday', { locale: lang, timeZone: timezone })}
          eyebrowTestID="today-date"
          title={t.todayTitle}
          end={<TextLink label={t.xAssistant} onPress={() => actions.go('contextualAssistant')} testID="today-assistant" />}
        />

        {showBar ? <CategoryBar chips={chips} selected={chip} onSelect={setChip} /> : null}

        <QueryBoundary isPending={today.isPending} error={today.error} onRetry={() => void today.refetch()}>
          {model.isEmpty ? (
            // No capture button here: the bar's own «احكيها» is the one way in,
            // and a second one competing with it was the audit's finding.
            <EmptyState title={t.emptyTitle} body={t.emptyBody} testID="today-empty" />
          ) : (
            <>
              <Txt size={13} color={p.mu} testID="today-count">
                {progress ? tr('todayProgressCompact', progress) : tr('todayCountOpen', { n: model.openTotal })}
              </Txt>

              {/* PRIMARY · what matters now */}
              <PrimaryCard primary={model.primary} lookup={byId} strings={strings} timezone={timezone} lang={lang} busy={busy} />

              {/* SECONDARY · the plan, always present, always honest */}
              <TodayPlanRow row={model.plan} preview={preview} />

              {/* The rest of today, in the user's own groups */}
              {hasRest ? <SectionLabel testID="today-rest-title">{t.todayRestTitle}</SectionLabel> : null}
              {(['must', 'should', 'nice'] as const).map((key) => (
                <Group
                  key={key}
                  title={strings[GROUP_TITLE[key]]!}
                  testID={`today-group-${key}`}
                  items={restGroups[key]}
                  timezone={timezone}
                  lang={lang}
                  busy={busy}
                />
              ))}
              {restGroups.finished.length > 0 ? <FinishedGroup items={restGroups.finished} /> : null}

              {/* TERTIARY · later */}
              {later.length > 0 ? (
                <View style={{ gap: 6 }}>
                  <SectionLabel testID="today-later-title">{t.todayLaterTitle}</SectionLabel>
                  <Card pad={0} style={{ overflow: 'hidden' }} testID="today-later">
                    {later.map((item, index) => (
                      <LaterRow key={item.id} item={item} first={index === 0} timezone={timezone} lang={lang} />
                    ))}
                    <View style={{ paddingHorizontal: 18, paddingVertical: 8, borderTopWidth: 1, borderTopColor: p.ln }}>
                      <TextLink label={t.todayLaterSeeAll} onPress={() => actions.go('calendar')} testID="today-later-all" size={13} />
                    </View>
                  </Card>
                </View>
              ) : null}
              {insight ? <DeadlineContext item={insight} /> : null}
            </>
          )}
        </QueryBoundary>
      </ScreenScroll>
    </Screen>
  );
}

const GROUP_TITLE = {
  must: 'todayGroupMust',
  should: 'todayGroupShould',
  nice: 'todayGroupNice',
} as const;

/** Exactly one of these renders. See `composeToday`. */
function PrimaryCard({ primary, lookup, strings, timezone, lang, busy }: {
  primary: Primary;
  lookup: ReadonlyMap<string, CommitmentView>;
  strings: Record<string, string>;
  timezone: string;
  lang: Lang;
  busy: readonly DeviceBusyBlock[];
}) {
  const { t, p, actions } = useApp();
  switch (primary.kind) {
    case 'quiet':
      return (
        <Card pad={18} style={{ gap: 8 }} testID="today-quiet">
          <Txt size={13} weight={600} color={p.mu}>{t.nextStepLabel}</Txt>
          <Txt size={15} lh={1.5}>{t.todayQuietModeOn}</Txt>
          <TextLink label={t.sTrust} onPress={() => actions.go('trust')} testID="today-quiet-trust" />
        </Card>
      );
    case 'allDone':
      return (
        <Card pad={22} style={{ alignItems: 'center', gap: 10 }} testID="today-all-done">
          <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: p.success, alignItems: 'center', justifyContent: 'center' }}>
            <CheckIcon size={22} color={p.onSuccess} />
          </View>
          <Txt size={20} weight={600} align="center">{t.todayAllDoneTitle}</Txt>
          <Txt size={14} color={p.mu} align="center">{t.todayAllDoneBody}</Txt>
        </Card>
      );
    case 'next':
      return <NextStepCard lookup={lookup} />;
    case 'fallback':
      return <FallbackCard item={primary.item} strings={strings} timezone={timezone} lang={lang} busy={busy} />;
    case 'none':
      return null;
  }
}

/**
 * The list's own top item, as the primary when there is no recommendation to
 * show. It explains itself with the ranking's reasons (#169) — the one place
 * a "why first" line appears — and offers the same two answers a row does.
 */
function FallbackCard({ item, strings, timezone, lang, busy }: {
  item: CommitmentView;
  strings: Record<string, string>;
  timezone: string;
  lang: Lang;
  busy: readonly DeviceBusyBlock[];
}) {
  const { t, p, actions } = useApp();
  const act = useCommitmentAction();
  const why = whyFirstLine(item.reasonCodes, strings);
  const when = item.shownAt ? ltr(formatTime(new Date(item.shownAt), { locale: lang, timeZone: timezone })) : t.noTimeYet;
  const impLabel = item.importance === 'must' ? t.todayGroupMust : item.importance === 'should' ? t.todayGroupShould : t.todayGroupNice;
  return (
    <Card focus pad={22} style={{ gap: 16, borderStartWidth: 3, borderStartColor: item.importance === 'must' ? p.wm : p.lnStrong }} testID="today-primary">
      <Txt size={13} weight={600} color={p.mu}>{t.nextStepLabel}</Txt>
      <Btn
        testID={`today-item-${item.id}`}
        label={rowAccessibilityLabel(item, t, item.shownAt ? when : null)}
        onPress={() => actions.openDetail(item.id)}
        scaleTo={0.99}
        style={{ alignItems: 'flex-start', gap: 4 }}
      >
        <Txt role="section">{item.title}</Txt>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Txt size={14} color={p.mu} latin testID={`today-time-${item.id}`}>{when}</Txt>
          <Txt size={14} color={p.mu}>·</Txt>
          <Tag kind={item.importance === 'must' ? 'must' : 'should'} label={impLabel} />
          {!item.importanceIsStated && item.importance === 'must' ? (
            <Txt size={12} color={p.mu} testID={`today-estimated-${item.id}`}>{t.todayEstimatedMark}</Txt>
          ) : null}
        </View>
      </Btn>
      <BusyConflictChip blocks={item.shownAt ? busyAt(item.shownAt, busy) : []} testID={`today-busy-${item.id}`} />
      {why ? <Txt role="supporting" color={p.mu} testID="today-why-first">{why}</Txt> : null}
      <ActionRow>
        <Btn testID={`today-primary-complete`} label={t.doneS} onPress={() => act.mutate({ id: item.id, action: 'complete' })} style={{ minHeight: 48, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 16, backgroundColor: p.ac, alignItems: 'center', justifyContent: 'center' }}>
          <Txt size={15} weight={600} color={p.onAccent}>{t.doneS}</Txt>
        </Btn>
        <Btn testID={`today-primary-postpone`} label={t.nextStepDefer} onPress={() => act.mutate({ id: item.id, action: 'postpone', postponedUntil: postponeTo('oneHour', new Date(), timezone) })} style={{ minHeight: 48, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 16, backgroundColor: p.sf2, alignItems: 'center', justifyContent: 'center' }}>
          <Txt size={15} weight={500}>{t.nextStepDefer}</Txt>
        </Btn>
      </ActionRow>
    </Card>
  );
}

function Group({ title, items, timezone, lang, testID, busy }: {
  title: string;
  items: CommitmentView[];
  timezone: string;
  lang: Lang;
  testID: string;
  busy: readonly DeviceBusyBlock[];
}) {
  const { p } = useApp();
  if (items.length === 0) return null;
  return (
    <Card pad={0} style={{ overflow: 'hidden' }} testID={testID}>
      <View style={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: 6 }}>
        <Txt size={13} weight={600} color={p.mu}>{title}</Txt>
      </View>
      {items.map((item, index) => (
        <Row key={item.id} item={item} first={index === 0} timezone={timezone} lang={lang} busy={busy} />
      ))}
    </Card>
  );
}

function Row({ item, first, timezone, lang, busy }: {
  item: CommitmentView;
  first: boolean;
  timezone: string;
  lang: Lang;
  busy: readonly DeviceBusyBlock[];
}) {
  const { t, p, actions } = useApp();
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
        label={rowAccessibilityLabel(item, t, item.shownAt ? when : null)}
        onPress={() => actions.openDetail(item.id)}
        scaleTo={0.98}
        style={{
          flexDirection: 'row', alignItems: 'center', gap: 12,
          paddingVertical: 10, paddingHorizontal: 18, minHeight: 56,
          borderTopWidth: first ? 0 : 1, borderTopColor: p.ln,
        }}
      >
        {/* The circle is the row's own done affordance in Round 2; the swipe
            and the assistive action do the same thing. */}
        <Btn label={t.doneS} testID={`today-row-done-${item.id}`} onPress={() => act.mutate({ id: item.id, action: 'complete' })} hitSlop={8}
          style={{ width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: p.lnStrong, alignItems: 'center', justifyContent: 'center' }}>
          <View />
        </Btn>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt size={15}>{item.title}</Txt>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {/* A deadline is a point in time, so it reads as one. There is no
                "overdue": a time that has passed is shown in the accent, not in
                a warning colour, because a missed thing is not a failure state. */}
            <Txt size={12} color={p.mu} latin testID={`today-time-${item.id}`}>{when}</Txt>
            {/* The importance was read off their words, not stated by them (#169). */}
            {!item.importanceIsStated && item.importance === 'must' ? (
              <Txt size={12} color={p.mu} testID={`today-estimated-${item.id}`}>{`· ${t.todayEstimatedMark}`}</Txt>
            ) : null}
          </View>
          {/* What else is happening then (UC-3.2, #186): a muted note, never a
              warning, never something that stops the row being opened. */}
          <BusyConflictChip blocks={item.shownAt ? busyAt(item.shownAt, busy) : []} testID={`today-busy-${item.id}`} />
        </View>
      </Btn>
    </SwipeableRow>
  );
}

function LaterRow({ item, first, timezone, lang }: { item: CommitmentView; first: boolean; timezone: string; lang: Lang }) {
  const { t, p, actions } = useApp();
  const when = item.shownAt
    ? `${formatRelativeDay(new Date(item.shownAt), { locale: lang, timeZone: timezone })} · ${ltr(formatTime(new Date(item.shownAt), { locale: lang, timeZone: timezone }))}`
    : t.noTimeYet;
  const returnWhen = item.postponedUntil
    ? `${t.postponeReturn} ${formatRelativeDay(new Date(item.postponedUntil), { locale: lang, timeZone: timezone })} · ${ltr(formatTime(new Date(item.postponedUntil), { locale: lang, timeZone: timezone }))}`
    : null;
  return (
    <Btn
      testID={`today-later-${item.id}`}
      label={`${rowAccessibilityLabel(item, t, item.shownAt ? when : null)}${returnWhen ? `, ${returnWhen}` : ''}`}
      onPress={() => actions.openDetail(item.id)}
      scaleTo={0.98}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 18, minHeight: 56, borderTopWidth: first ? 0 : 1, borderTopColor: p.ln }}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: item.importance === 'must' ? p.wm : p.lnStrong }} />
      <View style={{ flex: 1, gap: 2 }}>
        <Txt size={15}>{item.title}</Txt>
        <Txt size={12} color={p.mu}>{when}</Txt>
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
  const { t, p, actions } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <Card pad={0} style={{ overflow: 'hidden' }} testID="today-group-finished">
      <Btn
        testID="today-finished-toggle"
        accessibilityState={{ expanded: open }}
        label={t.todayGroupFinished}
        onPress={() => setOpen(!open)}
        scaleTo={0.99}
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 18, minHeight: 48 }}
      >
        <Txt size={13} weight={600} color={p.mu}>{`${t.todayGroupFinished} · ${items.length}`}</Txt>
        <Txt size={13} color={p.mu}>{open ? t.todayHideFinished : t.todayShowFinished}</Txt>
      </Btn>
      {open ? items.map((item) => (
        <Btn
          key={item.id}
          testID={`today-finished-${item.id}`}
          label={item.title}
          onPress={() => actions.openDetail(item.id)}
          scaleTo={0.98}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 18, borderTopWidth: 1, borderTopColor: p.ln, minHeight: 48 }}
        >
          <View style={{
            width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
            backgroundColor: item.status === 'done' ? p.success : 'transparent',
            borderWidth: item.status === 'done' ? 0 : 2, borderColor: p.lnStrong,
          }}>
            {item.status === 'done' ? <CheckIcon color={p.onSuccess} /> : null}
          </View>
          <Txt size={15} color={p.mu} style={{ flex: 1, textDecorationLine: 'line-through' }}>{item.title}</Txt>
          <Txt size={12} color={p.mu}>{item.status === 'done' ? t.doneS : t.dropped}</Txt>
        </Btn>
      )) : null}
    </Card>
  );
}
