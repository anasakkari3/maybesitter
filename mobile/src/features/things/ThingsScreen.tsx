import React, { useState } from 'react';
import { FlatList, TextInput, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useHabits, useMemory, useSeeds, useToday, useUpcoming } from '../../api/queries';
import { QueryBoundary } from '../../api/ui/QueryBoundary';
import { formatDate, formatTime } from '../../i18n/format';
import { isolateAuto } from '../../i18n/bidi';
import { fill } from '../../i18n/strings';
import { useTimeZone } from '../../i18n/timezone';
import { toViewModel, type CommitmentView } from '../commitments/model';
import { uniqueCommitments } from '../product/ContextScreens';
import { AvatarButton, ScreenHeader, Tag, priorityTagKind } from '../../ui/chrome';
import { HubHeading, HubRow } from '../../ui/hub';
import { Btn, Txt } from '../../ui/primitives';
import { ReferenceIcon } from '../../ui/referenceIcons';
import { ChevronIcon } from '../../ui/icons';
import { Screen, ScreenScroll, TAB_CLEARANCE, FLOATING_GAP } from '../../ui/screen';
import { AvoidKeyboard, useSoftKeyboardShown } from '../../ui/keyboard';

/** Seeds that are still something the person is weighing up. */
const LIVE_SEED = new Set(['open', 'snoozed', 'waiting']);
const RECENT = 5;

/**
 * «أشيائي» (Stitch redesign, 2026-10-02): the hub for everything the person
 * has kept. Four entries — Commitments, Goals, Habits, «عم تفكّر فيه» — each
 * opening the screen that already owns it, and «آخر ما حفظته», the last few
 * commitments saved. Nothing here writes; every row opens an existing screen.
 *
 * The search looks through what this screen already has loaded — commitment
 * titles, goals, habits and ideas — and opens the match where it lives.
 */
export function ThingsScreen({ tabClearance = TAB_CLEARANCE }: { tabClearance?: number } = {}) {
  const { t, p, rtl, lang, actions } = useApp();
  const zone = useTimeZone();
  const today = useToday();
  const upcoming = useUpcoming();
  const memory = useMemory();
  const habits = useHabits();
  const seeds = useSeeds();
  const [search, setSearch] = useState('');
  const keyboardShown = useSoftKeyboardShown();

  const now = new Date().toISOString();
  const records = uniqueCommitments([...(today.data?.items ?? []), ...(upcoming.data?.items ?? [])]);
  const views = records.map(record => ({ record, view: toViewModel(record, now) })).filter(({ view }) => view.status !== 'dropped');
  const active = views.filter(({ view }) => view.status === 'active');
  const timed = active.filter(({ view }) => view.shownAt !== null).length;
  const commitmentsLoaded = today.data !== undefined && upcoming.data !== undefined;

  const goals = memory.data?.items.filter(item => item.kind === 'goal') ?? [];
  const habitItems = (habits.data ?? []).filter(habit => habit.status !== 'archived');
  const seedItems = (seeds.data?.items ?? []).filter(seed => LIVE_SEED.has(seed.status));
  const recent = [...views].sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt)).slice(0, RECENT);

  const needle = search.trim().toLocaleLowerCase(lang);
  const matches = (text: string) => text.toLocaleLowerCase(lang).includes(needle);
  const titlesOf = (items: readonly string[]) => items.slice(0, 2).map(isolateAuto).join(' · ');

  const whenOf = (view: CommitmentView) => view.shownAt
    ? `${formatDate(new Date(view.shownAt), 'short', { locale: lang, timeZone: zone })}${view.allDay ? '' : ` · ${formatTime(new Date(view.shownAt), { locale: lang, timeZone: zone })}`}`
    : t.xUntimed;
  const impLabel = (view: CommitmentView) => view.importance === 'must' ? t.todayGroupMust : view.importance === 'should' ? t.todayGroupShould : t.todayGroupNice;
  const results = needle.length === 0 ? [] : [
    ...views.filter(({ view }) => matches(view.title)).map(({ view }) => ({ kind: 'commitment' as const, id: view.id, view })),
    ...goals.filter(goal => matches(goal.content)).map(goal => ({ kind: 'goal' as const, id: goal.id, goal })),
    ...habitItems.filter(habit => matches(habit.title)).map(habit => ({ kind: 'habit' as const, id: habit.habitId, habit })),
    ...seedItems.filter(seed => matches(seed.summary)).map(seed => ({ kind: 'seed' as const, id: seed.seedId, seed })),
  ];

  return (
    <Screen testID="things-root" pinned={<View style={{ gap: 10 }}>
        {keyboardShown ? null : <ScreenHeader brand={false} title={t.tabThings} end={<AvatarButton />} />}
        <View style={{ minHeight: 48, borderRadius: 16, borderWidth: 1, borderColor: p.ln, backgroundColor: p.sf, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 8 }}>
          <ReferenceIcon name="search" size={20} color={p.mu} />
          <TextInput
            testID="things-search"
            accessibilityLabel={t.thingsSearch}
            placeholder={t.thingsSearch}
            placeholderTextColor={p.mu}
            value={search}
            onChangeText={setSearch}
            autoCorrect={false}
            style={{ flex: 1, minHeight: 44, paddingVertical: 0, fontSize: 14, color: p.tx, textAlign: rtl ? 'right' : 'left', writingDirection: rtl ? 'rtl' : 'ltr' }}
          />
        </View>
    </View>}>
      {needle.length > 0 ? (
        <AvoidKeyboard>
          <View testID="things-results" style={{ flex: 1 }}>
            <FlatList testID="things-results-list" data={results} keyExtractor={item => `${item.kind}-${item.id}`}
              style={{ flex: 1, marginBottom: Math.max(0, tabClearance - FLOATING_GAP) }}
              contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: FLOATING_GAP, gap: 10 }}
              keyboardShouldPersistTaps="handled" initialNumToRender={10} maxToRenderPerBatch={10} windowSize={7}
              ListEmptyComponent={<Txt role="supporting" color={p.mu} testID="things-no-results">{t.xNoResults}</Txt>}
              renderItem={({ item }) => item.kind === 'commitment'
                ? <SavedRow view={item.view} when={whenOf(item.view)} imp={impLabel(item.view)} onPress={() => actions.openDetail(item.id)} />
                : item.kind === 'goal'
                  ? <HubRow testID={`things-result-goal-${item.id}`} icon="flag" tone="attention" title={isolateAuto(item.goal.content)} sub={t.thingsGoals} onPress={() => actions.openGoal(item.id)} />
                  : item.kind === 'habit'
                    ? <HubRow testID={`things-result-habit-${item.id}`} icon="repeat" tone="success" title={isolateAuto(item.habit.title)} sub={t.thingsHabits} onPress={() => actions.go('habitDetail')} />
                    : <HubRow testID={`things-result-seed-${item.id}`} icon="bulb" title={isolateAuto(item.seed.summary)} sub={t.thingsIdeas} onPress={() => actions.go('seeds')} />}
            />
          </View>
        </AvoidKeyboard>
      ) : (
        <ScreenScroll testID="things-scroll" floating={tabClearance} gap={12} topGap={8} keyboardShouldPersistTaps="handled">
            <View style={{ gap: 10 }}>
              <HubRow testID="things-commitments" icon="clipboard" tone="accent" title={t.xCommitments}
                sub={commitmentsLoaded && timed !== active.length ? fill(t.thingsCommitmentsSub, { timed, untimed: active.length - timed }) : undefined}
                count={commitmentsLoaded ? active.length : undefined}
                onPress={() => actions.go('commitments')} />
              <HubRow testID="things-goals" icon="flag" tone="attention" title={t.thingsGoals}
                sub={memory.data && goals.length > 0 ? titlesOf(goals.map(goal => goal.content)) : undefined}
                count={memory.data ? goals.length : undefined}
                onPress={() => actions.go('goalExecution')} />
              <HubRow testID="things-habits" icon="repeat" tone="success" title={t.thingsHabits}
                sub={habits.data && habitItems.length > 0 ? titlesOf(habitItems.map(habit => habit.title)) : undefined}
                count={habits.data ? habitItems.length : undefined}
                onPress={() => actions.go('habitDetail')} />
              <HubRow testID="things-ideas" icon="bulb" title={t.thingsIdeas} sub={seedItems.length > 0 ? t.thingsIdeasSub : undefined}
                count={seeds.data ? seedItems.length : undefined}
                onPress={() => actions.go('seeds')} />
            </View>

            <HubHeading title={t.thingsRecent} testID="things-recent-title" />
            <QueryBoundary isPending={today.isPending || upcoming.isPending} error={today.error ?? upcoming.error}
              onRetry={() => { void today.refetch(); void upcoming.refetch(); }}>
              {recent.length === 0
                ? <Txt role="supporting" color={p.mu} testID="things-recent-empty">{t.thingsRecentEmpty}</Txt>
                : <View style={{ gap: 10 }}>
                  {recent.map(({ view }) => (
                    <SavedRow key={view.id} view={view} when={whenOf(view)} imp={impLabel(view)} onPress={() => actions.openDetail(view.id)} />
                  ))}
                </View>}
            </QueryBoundary>
        </ScreenScroll>
      )}
    </Screen>
  );
}

/** One saved commitment: title, when, its importance chip. Opens Details. */
function SavedRow({ view, when, imp, onPress }: { view: CommitmentView; when: string; imp: string; onPress: () => void }) {
  const { t, p, rtl } = useApp();
  const done = view.status === 'done';
  return (
    <Btn
      testID={`things-recent-${view.id}`}
      label={[view.title, when, done ? t.xDone : imp].join('. ')}
      onPress={onPress}
      scaleTo={0.985}
      style={{ minHeight: 56, borderRadius: 16, borderWidth: 1, borderColor: p.ln, backgroundColor: p.sf, paddingVertical: 8, paddingHorizontal: 12, gap: 10, flexDirection: 'row', alignItems: 'center' }}
    >
      <View style={{ flex: 1, gap: 4, alignItems: 'flex-start' }}>
        <Txt size={15} weight={600} lines={2}>{isolateAuto(view.title)}</Txt>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <Txt size={13} color={p.mu}>{when}</Txt>
          {done ? <Tag kind="saved" label={t.xDone} /> : <Tag kind={priorityTagKind(view.importance)} label={imp} />}
        </View>
      </View>
      <ChevronIcon color={p.mu} rtl={rtl} />
    </Btn>
  );
}
