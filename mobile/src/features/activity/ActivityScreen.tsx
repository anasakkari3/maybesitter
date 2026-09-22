import React, { useEffect, useMemo } from 'react';
import { RefreshControl, SectionList, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../../state/AppContext';
import { isolateAuto } from '../../i18n/bidi';
import { CIVIL_ZONE, civilDate, dayKey, formatDate, formatRelativeDay, formatTime } from '../../i18n/format';
import type { Locale } from '../../i18n/locale';
import { fill } from '../../i18n/strings';
import { useTimeZone } from '../../i18n/timezone';
import { Card, Txt } from '../../ui/primitives';
import { ScreenIn } from '../../ui/motion';
import { SettingsHeader } from '../settings/SettingsChrome';
import { useActivity, useWeeklySummary } from '../../api/queries';
import { knownActivityKind, type ActivityItem } from '../../api/schemas/activity';
import type { Strings } from '../../i18n/strings';
import { namedMoments } from './moments';
import { WeekCard } from './WeekCard';

/**
 * What this account actually did (UC-3.15, #201).
 *
 * ── Server data only ─────────────────────────────────────────────
 *
 * There is no local activity store and nothing is merged by id. The retired
 * Flutter client kept its own list and reconciled it with the server's, and
 * its repository was a mock that seeded three invented events — "Completed
 * 'Check water filter'" — which closed-test users would have read as their
 * own. Everything here came from `/api/mobile/activity`.
 *
 * ── Text, not a new icon set ─────────────────────────────────────
 *
 * #201 describes icons ported from the Flutter mapping. That design system is
 * superseded (AGENTS.md §2), so each entry is named in words with the one
 * teal accent the current design has. Inventing seven glyphs outside the
 * design source of truth is a design decision this screen does not own.
 *
 * ── Reached from Settings ────────────────────────────────────────
 *
 * Not a fifth tab. The tab bar is Today · Calendar · Say it · Settings and
 * changing it is a design decision, not an implementation detail of this
 * issue.
 */

const KIND_KEY: Record<string, keyof Strings> = {
  captured: 'activityKindCaptured',
  confirmed: 'activityKindConfirmed',
  completed: 'activityKindCompleted',
  postponed: 'activityKindPostponed',
  dropped: 'activityKindDropped',
  // Read from #194's plan ledger by the server.
  plan_accepted: 'activityKindPlanAccepted',
  // No producer yet: #200. Present so it lands additively.
  reminder_acknowledged: 'activityKindReminderAcknowledged',
};

interface DaySection {
  title: string;
  data: ActivityItem[];
}

/**
 * The flat, newest-first list, cut into local days.
 *
 * By day *key* in the account's zone, not by elapsed hours: 23:30 and 00:30
 * are different days, and grouping by a 24-hour bucket would put them together
 * for anybody whose evening runs past midnight.
 */
export function groupByDay(items: readonly ActivityItem[], timeZone: string): DaySection[] {
  const sections: DaySection[] = [];
  for (const item of items) {
    const key = dayKey(new Date(item.at), timeZone);
    const current = sections[sections.length - 1];
    if (current && current.title === key) current.data.push(item);
    else sections.push({ title: key, data: [item] });
  }
  return sections;
}

/**
 * The words above a day's entries.
 *
 * Both sides are civil dates read in the civil zone, which is the same pairing
 * the calendar uses. Letting `formatRelativeDay` fall back to the real clock
 * would compare the user's *local* day against the *UTC* day, so between local
 * midnight and UTC midnight — every night in Asia/Jerusalem, every evening in
 * New York — today's entries would be headed "Tomorrow" or "Yesterday".
 */
export function dayHeading(key: string, todayKey: string, locale: Locale): string {
  return formatRelativeDay(civilDate(key), { locale, timeZone: CIVIL_ZONE, now: civilDate(todayKey) });
}

/**
 * "Your plan for Monday, Sep 14" — the day an accepted plan was for.
 *
 * `planDate` is a civil date the server read in the account's zone, not an
 * instant, so it is printed in the civil zone. Formatting it in the device
 * zone would slide it a day for anyone west of UTC.
 */
export function planLine(planDate: string, locale: Locale, t: Strings): string {
  return fill(t.activityPlanFor, { date: formatDate(civilDate(planDate), 'weekday', { locale, timeZone: CIVIL_ZONE }) });
}

export function ActivityScreen({ onBack }: { onBack: () => void }) {
  const { t, p, lang } = useApp();
  const insets = useSafeAreaInsets();
  const timeZone = useTimeZone();
  const history = useActivity();
  const summary = useWeeklySummary();

  const items = useMemo(
    () => (history.data?.pages ?? []).flatMap(page => page.items),
    [history.data],
  );
  const sections = useMemo(() => groupByDay(items, timeZone), [items, timeZone]);
  // The user's own day, so a heading says "today" when it is still today for
  // them rather than when it is still today in UTC.
  const todayKey = dayKey(new Date(), timeZone);
  const moments = useMemo(
    () => namedMoments(summary.data?.moments ?? [], t),
    [summary.data, t],
  );

  const unreachable = history.isError || summary.isError;

  /*
   * A page of the log can hold nothing a person is shown.
   *
   * The server reads events and keeps only the allowlisted ones, so a page can
   * come back empty while the history continues below it. `onEndReached` never
   * fires on a list with no rows, so without this the screen would settle on
   * "nothing here yet" over a history that exists — the one thing its own empty
   * copy must never say wrongly. It stops when the server says the log is
   * exhausted, which is the same thing that stops the scroll.
   */
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = history;
  useEffect(() => {
    if (items.length === 0 && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [items.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <SectionList
        testID="activity-list"
        sections={sections}
        keyExtractor={item => item.id}
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 60, gap: 14 }}
        refreshControl={(
          <RefreshControl
            refreshing={history.isRefetching && !history.isFetchingNextPage}
            onRefresh={() => { void history.refetch(); void summary.refetch(); }}
          />
        )}
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
        }}
        ListHeaderComponent={(
          <View style={{ gap: 14 }}>
            <SettingsHeader title={t.activityTitle} onBack={onBack} />
            {unreachable ? (
              <Card pad={18}>
                <Txt size={14} color={p.mu} lh={1.5} testID="activity-unavailable">{t.activityUnavailable}</Txt>
              </Card>
            ) : null}
            {summary.data ? <WeekCard summary={summary.data} /> : null}
            {moments.length > 0 ? (
              <View style={{ gap: 8 }}>
                <Txt size={13} weight={600} color={p.mu} style={{ paddingHorizontal: 4 }}>
                  {t.activityMomentsTitle}
                </Txt>
                <Card pad={0} style={{ overflow: 'hidden' }} testID="activity-moments">
                  {moments.map(({ moment, label }, index) => (
                    <View
                      key={moment.id}
                      testID={`activity-moment-${moment.id}`}
                      style={{
                        paddingHorizontal: 18, paddingVertical: 12, gap: 4,
                        borderTopWidth: index === 0 ? 0 : 1, borderTopColor: p.ln,
                      }}
                    >
                      <Txt size={15}>{label}</Txt>
                      <Txt size={13} color={p.mu} latin>
                        {formatRelativeDay(new Date(moment.reachedAt), { locale: lang, timeZone })}
                      </Txt>
                    </View>
                  ))}
                </Card>
              </View>
            ) : null}
            {sections.length > 0 ? (
              <Txt size={13} weight={600} color={p.mu} style={{ paddingHorizontal: 4, paddingTop: 6 }}>
                {t.activityHistoryTitle}
              </Txt>
            ) : null}
          </View>
        )}
        ListEmptyComponent={
          // Only once an answer has arrived. A "nothing here" shown while the
          // first page is still in flight tells a returning user their history
          // is gone.
          history.data !== undefined && !unreachable && !hasNextPage ? (
            <Card pad={18}>
              <Txt size={14} color={p.mu} lh={1.5} testID="activity-empty">{t.activityEmpty}</Txt>
            </Card>
          ) : null
        }
        renderSectionHeader={({ section }) => (
          <Txt size={13} weight={600} color={p.mu} style={{ paddingHorizontal: 4, paddingTop: 10 }}>
            {dayHeading(section.title, todayKey, lang)}
          </Txt>
        )}
        renderItem={({ item }) => <ActivityRow item={item} timeZone={timeZone} />}
      />
    </ScreenIn>
  );
}

function ActivityRow({ item, timeZone }: { item: ActivityItem; timeZone: string }) {
  const { t, p, lang } = useApp();
  // A kind this build has no words for is skipped rather than printed as its
  // own enum — a later backend may add one, and an older build must degrade
  // to "not shown" rather than to its enum.
  if (!knownActivityKind(item.kind)) return null;
  const key = KIND_KEY[item.kind];
  const kindLabel = key ? (t[key] as unknown as string) : '';
  if (!kindLabel) return null;

  const moved = item.detail?.postponedUntil;
  // An accepted plan is about a day, not a commitment. Its null title is not a
  // deletion, so it must never fall through to "an item you removed".
  const isPlan = item.kind === 'plan_accepted';
  const planDate = isPlan ? item.detail?.planDate : undefined;

  return (
    <Card pad={14} style={{ gap: 4 }} testID={`activity-item-${item.kind}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: item.kind === 'completed' ? p.ac : p.mu }} />
        <Txt size={13} color={p.mu}>{kindLabel}</Txt>
        <Txt size={13} color={p.mu} latin style={{ marginStart: 'auto' }}>
          {formatTime(new Date(item.at), { locale: lang, timeZone })}
        </Txt>
      </View>
      {/* The title is the user's own words in whatever language they wrote
          them in, so it is isolated rather than trusted to sit in the line. */}
      {isPlan ? (
        planDate ? <Txt size={15} testID="activity-plan-date">{planLine(planDate, lang, t)}</Txt> : null
      ) : (
        <Txt size={15}>
          {item.commitmentTitle ? isolateAuto(item.commitmentTitle) : t.activityRemovedItem}
        </Txt>
      )}
      {moved ? (
        <Txt size={13} color={p.mu}>
          {fill(t.activityMovedTo, { date: formatRelativeDay(new Date(moved), { locale: lang, timeZone }) })}
        </Txt>
      ) : null}
    </Card>
  );
}


/** The user-facing line for an activity kind, or null for one this build has no words for. */
export function activityKindLabel(kind: string, t: Strings): string | null {
  const key = (KIND_KEY as Record<string, keyof Strings | undefined>)[kind];
  const value = key ? t[key] : null;
  return typeof value === 'string' ? value : null;
}
