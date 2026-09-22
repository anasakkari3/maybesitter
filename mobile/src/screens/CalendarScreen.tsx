import React, { useMemo, useState } from 'react';
import { RefreshControl, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useTimeZone } from '../i18n/timezone';
import { CIVIL_ZONE, civilDate, dayKey, formatDate, formatRelativeDay, formatTime } from '../i18n/format';
import { ltr } from '../i18n/strings';
import { useToday, useTrust, useUpcoming } from '../api/queries';
import { useBusyBlocks } from '../features/calendar/useBusyCalendar';
import type { DeviceBusyBlock } from '../features/calendar/busyBlocks';
import { ScreenHeader, Notice, EmptyState } from '../ui/chrome';
import { Screen, ScreenScroll } from '../ui/screen';
import { SettingsIcon } from '../ui/icons';
import { QueryBoundary } from '../api/ui/QueryBoundary';
import { groupUpcoming, toViewModel, type CommitmentView } from '../features/commitments/model';
import { rowAccessibilityLabel } from '../features/commitments/accessibility';
import { STRIP_DAYS, weekStripKeys } from '../features/commitments/weekStrip';
import { Btn, Card, Txt } from '../ui/primitives';
import { cardShadow } from '../theme/tokens';

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
 */
export function CalendarScreen() {
  const { s, t, p, lang, actions } = useApp();
  const timezone = useTimeZone();
  const today = useToday();
  const upcoming = useUpcoming();
  const trust = useTrust();
  const busy = useBusyBlocks();
  const calendarConnected = trust.data?.trust.calendarConsent === true;
  const [refreshing, setRefreshing] = useState(false);

  const now = new Date();
  const todayKey = dayKey(now, timezone);
  const keys = useMemo(() => weekStripKeys(now, timezone), [todayKey]); // eslint-disable-line react-hooks/exhaustive-deps

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
    return map;
    // `now` excluded on purpose: re-deriving every render would move rows under
    // the user's finger as the clock ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today.data, upcoming.data, timezone, todayKey]);

  const busyByDay = useMemo(() => {
    const map = new Map<string, DeviceBusyBlock[]>();
    for (const block of busy) {
      const key = dayKey(new Date(block.startAt), timezone);
      map.set(key, [...(map.get(key) ?? []), block]);
    }
    return map;
  }, [busy, timezone]);

  const selectedKey = keys[Math.min(Math.max(s.selDay, 0), STRIP_DAYS - 1)] ?? todayKey;
  const selected = byDay.get(selectedKey) ?? [];
  const selectedBusy = calendarConnected ? (busyByDay.get(selectedKey) ?? []) : [];
  // Commitments and busy blocks in one list, in time order; an undated
  // commitment sorts last.
  const dayRows = [
    ...selected.map((item) => ({ kind: 'commitment' as const, at: item.shownAt ? Date.parse(item.shownAt) : Number.POSITIVE_INFINITY, item })),
    ...selectedBusy.map((block) => ({ kind: 'busy' as const, at: Date.parse(block.startAt), block })),
  ].sort((a, b) => a.at - b.at);
  const load = selected.length === 0 ? t.loadLight : selected.length < 3 ? t.loadNormal : t.loadFull;

  const refresh = () => {
    setRefreshing(true);
    void Promise.all([today.refetch(), upcoming.refetch()]).finally(() => setRefreshing(false));
  };

  const range = `${formatDate(civilDate(keys[0]!), 'short', { locale: lang, timeZone: CIVIL_ZONE })} – ${
    formatDate(civilDate(keys[STRIP_DAYS - 1]!), 'short', { locale: lang, timeZone: CIVIL_ZONE })}`;

  return (
    <Screen>
      <ScreenScroll
        bottom={130}
        topGap={8}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={p.ac} />}
      >
        <ScreenHeader
          eyebrow={ltr(range)}
          eyebrowTestID="calendar-range"
          title={t.calendarTitle}
          end={(
            <Btn label={t.calendarSettingsBtn} onPress={() => actions.go('calendarSettings')} testID="calendar-settings" style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, alignItems: 'center', justifyContent: 'center' }}>
              <SettingsIcon color={p.mu} knob={p.sf} />
            </Btn>
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
          <Card pad={0} style={{ paddingVertical: 14, paddingHorizontal: 10 }}>
            <View style={{ flexDirection: 'row', gap: 4 }}>
              {keys.map((key, offset) => (
                <DayCell
                  key={key}
                  dayKey={key}
                  isToday={key === todayKey}
                  selected={key === selectedKey}
                  items={byDay.get(key) ?? []}
                  busy={calendarConnected ? (busyByDay.get(key)?.length ?? 0) : 0}
                  onPress={() => actions.setSelDay(offset)}
                />
              ))}
            </View>
            <View style={{ flexDirection: 'row', gap: 14, paddingTop: 12, paddingHorizontal: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <View style={{ width: 14, height: 4, borderRadius: 2, backgroundColor: p.ac }} />
                <Txt size={11} color={p.mu}>{t.legendCommit}</Txt>
              </View>
              {calendarConnected ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <View style={{ width: 14, height: 4, borderRadius: 2, backgroundColor: p.hatch }} />
                  <Txt size={11} color={p.mu}>{t.calendarBusyLegend}</Txt>
                </View>
              ) : null}
            </View>
          </Card>

          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingTop: 4, paddingHorizontal: 4 }}>
            <Txt size={16} weight={600} testID="calendar-selected-day">
              {formatRelativeDay(civilDate(selectedKey), {
                locale: lang, timeZone: CIVIL_ZONE, now: civilDate(todayKey),
              })}
            </Txt>
            <Txt size={12} color={p.mu}>{load}</Txt>
          </View>

          <View style={{ gap: 8 }}>
            {dayRows.map((row) => row.kind === 'busy' ? (
              <View key={`busy-${row.block.nativeId}`} testID="calendar-busy-row" style={{ flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 16, backgroundColor: p.hatch, borderWidth: 1, borderStyle: 'dashed', borderColor: p.lnStrong }}>
                <Txt size={14} color={p.mu} style={{ flex: 1 }}>{t.calendarBusyLegend}</Txt>
                <Txt size={12} color={p.mu} latin>
                  {row.block.allDay ? '' : ltr(`${formatTime(new Date(row.block.startAt), { locale: lang, timeZone: timezone })}–${formatTime(new Date(row.block.endAt), { locale: lang, timeZone: timezone })}`)}
                </Txt>
              </View>
            ) : ((item) => (
              <Btn
                key={item.id}
                testID={`calendar-item-${item.id}`}
                label={rowAccessibilityLabel(item, t, item.shownAt
                  ? ltr(formatTime(new Date(item.shownAt), { locale: lang, timeZone: timezone }))
                  : null)}
                onPress={() => actions.openDetail(item.id)}
                scaleTo={0.98}
                style={[{ backgroundColor: p.sf, borderRadius: 18, paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }, cardShadow(p)]}
              >
                <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: item.importance === 'must' ? p.wm : p.ac }} />
                <Txt size={15} style={{ flex: 1 }}>{item.title}</Txt>
                <Txt size={12} color={p.mu} latin testID={`calendar-time-${item.id}`}>
                  {item.shownAt
                    ? ltr(formatTime(new Date(item.shownAt), { locale: lang, timeZone: timezone }))
                    : t.noTimeYet}
                </Txt>
              </Btn>
            ))(row.item))}
            {dayRows.length === 0 ? (
              <View style={{ padding: 18, backgroundColor: p.sf, borderRadius: 18 }} testID="calendar-day-free">
                <Txt size={14} color={p.mu} align="center">{t.dayFree}</Txt>
              </View>
            ) : null}
          </View>
        </QueryBoundary>
      </ScreenScroll>
    </Screen>
  );
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
  const { p, lang } = useApp();
  const date = civilDate(key);
  const options = { locale: lang, timeZone: CIVIL_ZONE } as const;

  return (
    <Btn
      testID={`calendar-day-${key}`}
      onPress={onPress}
      label={formatDate(date, 'weekday', options)}
      scaleTo={0.94}
      style={{ flex: 1, alignItems: 'center', gap: 2, paddingTop: 8, paddingBottom: 10, paddingHorizontal: 4, borderRadius: 16, backgroundColor: selected ? p.sf2 : 'transparent', minHeight: 88 }}
    >
      <Txt size={11} color={p.mu} align="center" lines={1}>{formatDate(date, 'weekdayShort', options)}</Txt>
      <View style={{ width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: isToday ? p.ac : 'transparent' }}>
        {/* `latin`: Noto Naskh's line box clips digits in a box this tight. */}
        <Txt size={16} weight={600} align="center" color={isToday ? p.onAccent : p.tx} lh={1.25} latin>
          {formatDate(date, 'dayNumber', options)}
        </Txt>
      </View>
      <View style={{ alignSelf: 'stretch', gap: 3, marginTop: 6 }}>
        {/* Three bars at most: a fourth would make a busy day unreadable, and
            the count is not the point — the shape of the week is. */}
        {items.slice(0, 3).map((item) => (
          <View
            key={item.id}
            testID={`calendar-bar-${key}`}
            style={{ height: 4, borderRadius: 2, backgroundColor: item.importance === 'must' ? p.wm : p.ac, opacity: 0.9 }}
          />
        ))}
        {busy > 0 ? <View testID={`calendar-busy-bar-${key}`} style={{ height: 4, borderRadius: 2, backgroundColor: p.hatch }} /> : null}
      </View>
    </Btn>
  );
}
