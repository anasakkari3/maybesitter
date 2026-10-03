/**
 * The week ahead, from the account (UC-2.R3 #173).
 *
 * The claim under test is the one the screen changed to make: every cell in
 * the strip is a day we have real data for. A cell we cannot fill is not
 * drawn empty — it is not drawn.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { StyleSheet, Text } from 'react-native';
import { AppProvider, useApp } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import type { AuthUser } from '../../auth/types';
import { CalendarScreen, stripFadeFor } from '../CalendarScreen';
import type { Commitment } from '../../api/schemas/common';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CIVIL_ZONE, civilDate, dayKey, formatDate, shiftDayKey } from '../../i18n/format';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import ar from '../../i18n/locales/ar.json';
import en from '../../i18n/locales/en.json';

import * as commitmentEndpoints from '../../api/endpoints/commitments';
import * as planEndpoints from '../../api/endpoints/plans';
import * as trustEndpoints from '../../api/endpoints/trust';
import * as busyCalendar from '../../features/calendar/useBusyCalendar';
import { queryKeys } from '../../api/queries';
import { savedWeekResponseSchema, type SavedWeek } from '../../api/schemas/plan';
import savedWeekFixture from '../../api/__fixtures__/plan.weekSaved.json';
import planWithProposal from '../../api/__fixtures__/plan.withProposal.json';
import { HOUR_HEIGHT } from '../../features/calendar/dayTimeline';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'cal-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

/** The zone the app reports; the strip must be built in it, not in UTC. */
const ZONE = 'Asia/Jerusalem';
const TODAY_KEY = dayKey(new Date(), ZONE);

jest.mock('../../i18n/timezone', () => ({
  ...(jest.requireActual('../../i18n/timezone') as object),
  useTimeZone: () => 'Asia/Jerusalem',
}));

/** Noon local on the day `offset` days from today, as an instant. */
function onDay(offset: number, hour = 12): string {
  const key = shiftDayKey(TODAY_KEY, offset);
  // Jerusalem is +02/+03; noon local is safely inside the same UTC day.
  return `${key}T${String(hour - 3).padStart(2, '0')}:00:00.000Z`;
}

function item(id: string, dueAt: string | null, extra: Partial<Commitment> = {}): Commitment {
  return {
    id,
    kind: 'task',
    title: id,
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: dueAt ? 'due_by' : 'unscheduled', dueAt, remindAt: null, timezone: ZONE },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: onDay(0), updatedAt: onDay(0), confirmedAt: onDay(0),
    completedAt: null, droppedAt: null,
    ...extra,
  } as Commitment;
}

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  savedWeek = { today: TODAY_KEY, saved: [] };
  jest.spyOn(planEndpoints, 'getSavedWeek').mockImplementation(async () => savedWeek);
  // No plan for today unless a case says so: no proposal card.
  jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue(null);
});

/** What `GET /api/mobile/plans/week` answers in each case; nothing saved unless a case says so. */
let savedWeek: SavedWeek;

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function show(today: Commitment[], upcoming: Commitment[]) {
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: today } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: upcoming } as never);
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}><CalendarScreen /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId(`calendar-day-${TODAY_KEY}`)).not.toBeNull());
  return view;
}

describe('the strip', () => {
  it('starts at today and runs seven days forward', async () => {
    await show([], []);
    const expected = Array.from({ length: 7 }, (_, n) => `calendar-day-${shiftDayKey(TODAY_KEY, n)}`);
    expect(screen.getAllByTestId(/^calendar-day-\d/).map((n) => n.props.testID)).toEqual(expected);
  });

  it('draws no day before today, because nothing can fill one', async () => {
    // `upcoming` is "a later local day than today" and there is no endpoint for
    // the past. An empty Monday cell would say "nothing was on" when the truth
    // is "nobody asked".
    await show([], []);
    expect(screen.queryByTestId(`calendar-day-${shiftDayKey(TODAY_KEY, -1)}`)).toBeNull();
  });

  it('has no busy hatch and no legend for one', async () => {
    // No /api/mobile route returns calendar busy time. The legend would be
    // explaining a mark that never appears.
    await show([], []);
    expect(screen.queryByText(en.legendBusy)).toBeNull();
    expect(screen.queryByText(en.legendCommit)).not.toBeNull();
  });

  it('marks the days that have something on them', async () => {
    await show([item('t', onDay(0))], [item('u', onDay(2))]);
    expect(screen.queryAllByTestId(`calendar-bar-${TODAY_KEY}`)).toHaveLength(1);
    expect(screen.queryAllByTestId(`calendar-bar-${shiftDayKey(TODAY_KEY, 2)}`)).toHaveLength(1);
    expect(screen.queryAllByTestId(`calendar-bar-${shiftDayKey(TODAY_KEY, 1)}`)).toHaveLength(0);
  });

  it('shows at most three bars, however full the day is', async () => {
    await show([], [item('a', onDay(1, 9)), item('b', onDay(1, 10)), item('c', onDay(1, 11)), item('d', onDay(1, 13))]);
    expect(screen.queryAllByTestId(`calendar-bar-${shiftDayKey(TODAY_KEY, 1)}`)).toHaveLength(3);
  });
});

describe('the open day', () => {
  it('opens on today', async () => {
    await show([item('mine', onDay(0))], [item('later', onDay(3))]);
    expect(screen.queryByTestId('calendar-item-mine')).not.toBeNull();
    expect(screen.queryByTestId('calendar-item-later')).toBeNull();
    expect(screen.queryByText(en.today)).not.toBeNull();
  });

  it('switches when another day is tapped', async () => {
    await show([item('mine', onDay(0))], [item('later', onDay(3))]);
    await fireEvent.press(screen.getByTestId(`calendar-day-${shiftDayKey(TODAY_KEY, 3)}`));
    await waitFor(() => expect(screen.queryByTestId('calendar-item-later')).not.toBeNull());
    expect(screen.queryByTestId('calendar-item-mine')).toBeNull();
  });

  /** Stands in for «شوف يومي» / "see all" (`go`) and for the tab bar (`switchTab`). */
  function Nav() {
    const { actions } = useApp();
    return (
      <>
        <Text testID="nav-go-calendar" onPress={() => actions.go('calendar')}>go</Text>
        <Text testID="nav-tab-calendar" onPress={() => actions.switchTab('calendar')}>tab</Text>
      </>
    );
  }

  async function showWithNav(today: Commitment[], upcoming: Commitment[]) {
    jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: today } as never);
    jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: upcoming } as never);
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <AuthProvider repository={repository} isDevBundle={false}>
            <QueryClientProvider client={client}><CalendarScreen /><Nav /></QueryClientProvider>
          </AuthProvider>
        </AppProvider>
      </SafeAreaProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId(`calendar-day-${TODAY_KEY}`)).not.toBeNull());
  }

  it('opens on today when «شوف يومي» asks for the calendar, whatever day was left open (UAT r6 N-e)', async () => {
    // A day tapped earlier in the session is app state; «شوف يومي» used to
    // open the calendar on it — tomorrow, in the round-6 run — rather than on
    // the day it names.
    await showWithNav([item('mine', onDay(0))], [item('later', onDay(1))]);
    await fireEvent.press(screen.getByTestId(`calendar-day-${shiftDayKey(TODAY_KEY, 1)}`));
    await waitFor(() => expect(screen.queryByTestId('calendar-item-later')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('nav-go-calendar'));
    await waitFor(() => expect(screen.queryByTestId('calendar-item-mine')).not.toBeNull());
    expect(screen.queryByTestId('calendar-item-later')).toBeNull();
    expect(screen.getByTestId(`calendar-day-${TODAY_KEY}`).props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('calendar-selected-day').props.children).toBe(en.today);
  });

  it('keeps the day it was left on when only the tab is switched back to', async () => {
    // The tab bar keeps every stack where it was left (`switchTab`); the open
    // day is part of that.
    await showWithNav([item('mine', onDay(0))], [item('later', onDay(1))]);
    await fireEvent.press(screen.getByTestId(`calendar-day-${shiftDayKey(TODAY_KEY, 1)}`));
    await waitFor(() => expect(screen.queryByTestId('calendar-item-later')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('nav-tab-calendar'));
    expect(screen.queryByTestId('calendar-item-later')).not.toBeNull();
    expect(screen.queryByTestId('calendar-item-mine')).toBeNull();
  });

  it('says a day is free rather than showing nothing at all', async () => {
    await show([], []);
    expect(screen.queryByTestId('calendar-day-free')).not.toBeNull();
  });

  it('keeps an undated item on today, where the server puts it', async () => {
    // `listUpcomingRanked` excludes undated items: they have no later day to be
    // on. They must not disappear from the calendar entirely.
    await show([item('someday', null)], []);
    expect(screen.getByTestId('calendar-time-someday').props.children).toBe(en.noTimeYet);
  });
});

describe('calendar timeline filters', () => {
  const busyBlock = { nativeId: 'calendar-event', startAt: onDay(0, 12), endAt: onDay(0, 13), allDay: false };
  const trustBody = (calendarConsent: boolean) => ({
    success: true, participantId: USER.uid, trust: { analyticsConsent: false, calendarConsent },
  });

  function connectedCalendar() {
    jest.spyOn(busyCalendar, 'useBusyBlocks').mockReturnValue([busyBlock]);
    jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustBody(true) as never);
  }

  it('filters actual commitments and consented busy blocks without changing the selected day', async () => {
    connectedCalendar();
    await show([item('mine', onDay(0, 10))], []);
    await waitFor(() => expect(screen.queryByTestId('calendar-busy-row')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('calendar-filter-commitment'));
    expect(screen.queryByTestId('calendar-item-mine')).not.toBeNull();
    expect(screen.queryByTestId('calendar-busy-row')).toBeNull();
    expect(screen.getByTestId('calendar-filter-commitment').props.accessibilityState.selected).toBe(true);

    await fireEvent.press(screen.getByTestId('calendar-filter-busy'));
    expect(screen.queryByTestId('calendar-item-mine')).toBeNull();
    expect(screen.queryByTestId('calendar-busy-row')).not.toBeNull();
    expect(screen.getByTestId(`calendar-day-${TODAY_KEY}`).props.accessibilityState.selected).toBe(true);

    await fireEvent.press(screen.getByTestId('calendar-filter-all'));
    expect(screen.queryByTestId('calendar-item-mine')).not.toBeNull();
    expect(screen.queryByTestId('calendar-busy-row')).not.toBeNull();
  });

  it('labels a filtered empty list without claiming that the day has nothing on it', async () => {
    connectedCalendar();
    await show([], []);
    await waitFor(() => expect(screen.queryByTestId('calendar-busy-row')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('calendar-filter-commitment'));
    expect(screen.queryByTestId('calendar-day-free')).toBeNull();
    expect(screen.queryByTestId('calendar-filter-empty')).not.toBeNull();
    expect(screen.getByText(en.referenceCalendarFilterEmpty)).toBeTruthy();
  });

  it('returns to all commitments immediately if consent is revoked while busy is selected', async () => {
    connectedCalendar();
    await show([item('mine', onDay(0))], []);
    await waitFor(() => expect(screen.queryByTestId('calendar-filter-busy')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('calendar-filter-busy'));
    await act(async () => { client.setQueryData(queryKeys.trust(USER.uid), trustBody(false)); });
    await waitFor(() => expect(screen.queryByTestId('calendar-filter-busy')).toBeNull());
    expect(screen.queryByTestId('calendar-busy-row')).toBeNull();
    expect(screen.queryByTestId('calendar-item-mine')).not.toBeNull();
    expect(screen.getByTestId('calendar-filter-all').props.accessibilityState.selected).toBe(true);
  });
});

describe('the week header', () => {
  // UAT 2026-09-26, complaint #16, shot 83: «سبتمبر – 2 أكتوبر 26». The range
  // was wrapped whole in a left-to-right isolate, so the Arabic run inside it
  // reversed around the dash and the first day's number fell off the end.
  const LRI = '\u2066';
  const RLI = '\u2067';
  const FSI = '\u2068';
  const PDI = '\u2069';

  afterEach(async () => { await AsyncStorage.clear(); });

  it('in Arabic, reads first day – last day, each date whole', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
    await show([], []);
    // Stitch: the tab's own name is the page title («الخطة»).
    await waitFor(() => expect(screen.queryByText(ar.tabPlan)).not.toBeNull());
    const first = formatDate(civilDate(TODAY_KEY), 'short', { locale: 'ar', timeZone: CIVIL_ZONE });
    const last = formatDate(civilDate(shiftDayKey(TODAY_KEY, 6)), 'short', { locale: 'ar', timeZone: CIVIL_ZONE });
    const header = screen.getByTestId('calendar-range').props.children as string;
    // Logical order, right-to-left as a whole, each date its own isolate.
    expect(header).toBe(`${RLI}${FSI}${first}${PDI} – ${FSI}${last}${PDI}${PDI}`);
    expect(header.startsWith(LRI)).toBe(false);
  });

  it('in English, stays left-to-right', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
    await show([], []);
    const first = formatDate(civilDate(TODAY_KEY), 'short', { locale: 'en', timeZone: CIVIL_ZONE });
    const last = formatDate(civilDate(shiftDayKey(TODAY_KEY, 6)), 'short', { locale: 'en', timeZone: CIVIL_ZONE });
    expect(screen.getByTestId('calendar-range').props.children)
      .toBe(`${LRI}${FSI}${first}${PDI} – ${FSI}${last}${PDI}${PDI}`);
  });
});

describe('failure', () => {
  it('offers a retry when either query fails, rather than half a week', async () => {
    jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
    jest.spyOn(commitmentEndpoints, 'listUpcoming').mockRejectedValue(new Error('offline'));
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <AuthProvider repository={repository} isDevBundle={false}>
            <QueryClientProvider client={client}><CalendarScreen /></QueryClientProvider>
          </AuthProvider>
        </AppProvider>
      </SafeAreaProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId('query-loading')).toBeNull());
    expect(screen.queryByTestId(`calendar-day-${TODAY_KEY}`)).toBeNull();
  });
});

describe('weekly planning mode (CL5b)', () => {
  /**
   * The recorded saved-week answer (`plan.weekSaved.json`, from the real
   * route), moved onto this strip's dates: its one saved day becomes the day
   * after tomorrow, and its step one of the commitments below.
   */
  function savedOn(offset: number, itemId: string, hour: number): SavedWeek {
    const recorded = savedWeekResponseSchema.parse(savedWeekFixture);
    const day = recorded.saved[0]!;
    const at = onDay(offset, hour);
    return {
      today: TODAY_KEY,
      saved: [{ ...day, date: shiftDayKey(TODAY_KEY, offset), items: [{ ...day.items[0]!, itemId, startsAt: at, endsAt: at }] }],
    };
  }

  it('draws a saved week step on the day it was saved for, not on today (I4)', async () => {
    // Undated, so the server lists it on today; the person saved it for the day after tomorrow.
    savedWeek = savedOn(2, 'someday', 10);
    await show([item('someday', null)], []);
    await waitFor(() => expect(screen.queryAllByTestId(`calendar-bar-${shiftDayKey(TODAY_KEY, 2)}`)).toHaveLength(1));
    expect(screen.queryAllByTestId(`calendar-bar-${TODAY_KEY}`)).toHaveLength(0);
    expect(screen.queryByTestId('calendar-item-someday')).toBeNull();

    await fireEvent.press(screen.getByTestId(`calendar-day-${shiftDayKey(TODAY_KEY, 2)}`));
    await waitFor(() => expect(screen.queryByTestId('calendar-item-someday')).not.toBeNull());
    // At the time the saved day holds it, not "no time yet".
    expect(screen.getByTestId('calendar-time-someday').props.children).not.toBe(en.noTimeYet);
  });

  it('draws a saved week step on its saved day, not on its due date (I4)', async () => {
    savedWeek = savedOn(1, 'report', 9);
    await show([], [item('report', onDay(5))]);
    await waitFor(() => expect(screen.queryAllByTestId(`calendar-bar-${shiftDayKey(TODAY_KEY, 1)}`)).toHaveLength(1));
    expect(screen.queryAllByTestId(`calendar-bar-${shiftDayKey(TODAY_KEY, 5)}`)).toHaveLength(0);
  });

  function Probe() {
    const { s } = useApp();
    return <Text testID="probe-screen">{s.screen}</Text>;
  }

  it('is reached from the Calendar tab\'s header, labelled in words', async () => {
    jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
    jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <AuthProvider repository={repository} isDevBundle={false}>
            <QueryClientProvider client={client}><CalendarScreen /><Probe /></QueryClientProvider>
          </AuthProvider>
        </AppProvider>
      </SafeAreaProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId(`calendar-day-${TODAY_KEY}`)).not.toBeNull());
    const entry = screen.getByTestId('calendar-plan-week');
    expect(entry.props.accessibilityRole).toBe('button');
    expect(screen.getByText(en.weekTitle)).toBeTruthy();
    await fireEvent.press(entry);
    expect(screen.getByTestId('probe-screen').props.children).toBe('weekPlan');
  });
});

/*
 * UAT 2026-09-30 (u35, u39): Dentist, a must, drew a warm-sand bar and dot in
 * the strip, and the legend named only «التزام» and «مشغول» — a colour no
 * label explained. The legend names it, with the existing «لازم» copy.
 */
describe('the legend names the must colour', () => {
  it('a week with a must shows the must entry', async () => {
    await show([], [item('Dentist', onDay(1, 17), { priority: { level: 'high', source: 'user', pressureAllowed: false, pressureLevel: 'none' } } as Partial<Commitment>)]);
    await waitFor(() => expect(screen.queryByTestId('calendar-legend-must')).not.toBeNull());
    expect(screen.getByText(en.todayGroupMust)).toBeTruthy();
  });

  it('a week without one does not', async () => {
    await show([], [item('Call mom', onDay(2, 18))]);
    await waitFor(() => expect(screen.queryByText(en.legendCommit)).not.toBeNull());
    expect(screen.queryByTestId('calendar-legend-must')).toBeNull();
  });
});

/*
 * u54: at text size 1.3 the strip scrolls with no sign that it does. React
 * Native's Android fade is drawn at a constant strength on both edges, which
 * dimmed today's cell at the end the strip opens on; the fade follows the
 * scroll instead (LTR space: start = left, where the far days are).
 */
describe('the week strip fades only an edge with days behind it', () => {
  it('opened at the end: the start edge fades, today\'s edge does not', () => {
    expect(stripFadeFor(300, 700, 400)).toEqual({ start: 32, end: 0 });
  });
  it('scrolled to the far days: only the end fades', () => {
    expect(stripFadeFor(0, 700, 400)).toEqual({ start: 0, end: 32 });
  });
  it('in between: both', () => {
    expect(stripFadeFor(150, 700, 400)).toEqual({ start: 32, end: 32 });
  });
});

/*
 * The Stitch Plan tab (02-plan): a load word per day, a proportional day, and
 * «التزامات بلا وقت» under it; busy time says it is busy and nothing else.
 */
describe('the day on equal hours (Stitch)', () => {
  const trustBody = { success: true, participantId: USER.uid, trust: { analyticsConsent: false, calendarConsent: true } };
  function connected(blocks: { nativeId: string; startAt: string; endAt: string; allDay: boolean }[]) {
    jest.spyOn(busyCalendar, 'useBusyBlocks').mockReturnValue(blocks);
    jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustBody as never);
  }

  it('says how full each day is, from what is on it', async () => {
    connected([]);
    await show([], [item('a', onDay(1, 9)), item('b', onDay(1, 10)), item('c', onDay(1, 11)), item('d', onDay(2, 9))]);
    await waitFor(() => expect(screen.getByTestId(`calendar-load-${shiftDayKey(TODAY_KEY, 1)}`).props.children).toBe(en.loadFull));
    expect(screen.getByTestId(`calendar-load-${shiftDayKey(TODAY_KEY, 2)}`).props.children).toBe(en.loadNormal);
    expect(screen.getByTestId(`calendar-load-${TODAY_KEY}`).props.children).toBe(en.loadLight);
    expect(screen.getByTestId(`calendar-day-${shiftDayKey(TODAY_KEY, 1)}`).props.accessibilityLabel).toContain(en.loadFull);
  });

  it('does not claim a light day when the calendar is disconnected', async () => {
    await show([], []);
    await waitFor(() => expect(screen.getByTestId(`calendar-load-${TODAY_KEY}`).props.children).toBe(en.loadUnknown));
  });

  it('draws busy time exactly as tall as it lasts, as busy and nothing more', async () => {
    connected([{ nativeId: 'evt-1', startAt: onDay(0, 14), endAt: onDay(0, 16), allDay: false }]);
    await show([], []);
    const block = await screen.findByTestId('calendar-busy-row');
    expect(StyleSheet.flatten(block.props.style).height).toBe(2 * HOUR_HEIGHT);
    expect(screen.getByText(en.legendBusy)).toBeTruthy();
    expect(screen.queryByTestId('calendar-timeline')).not.toBeNull();
  });

  it('draws a commitment as a marker at its time, never with a length', async () => {
    await show([item('mine', onDay(0, 17))], []);
    const card = await screen.findByTestId('calendar-item-mine');
    expect(StyleSheet.flatten(card.props.style).height).toBeUndefined();
    expect(screen.queryByTestId('calendar-untimed')).toBeNull();
  });

  it('lists what has no hour under the timeline, not on it', async () => {
    await show([item('someday', null), item('mine', onDay(0, 17))], []);
    const untimed = await screen.findByTestId('calendar-untimed');
    expect(screen.getByText(en.calendarUntimedTitle)).toBeTruthy();
    expect(screen.getByTestId('calendar-untimed-count').props.children).toBe('1');
    expect(within(untimed).queryByTestId('calendar-item-someday')).not.toBeNull();
    expect(within(untimed).queryByTestId('calendar-item-mine')).toBeNull();
    expect(within(screen.getByTestId('calendar-timeline')).queryByTestId('calendar-item-someday')).toBeNull();
  });

  it('keeps work rolled over from yesterday off today\'s hours, and says its day', async () => {
    // The server lists yesterday's still-active work on today (the overdue
    // rule, #383); its 09:00 is yesterday's, not an hour of today.
    await show([item('old', onDay(-1, 9)), item('mine', onDay(0, 17))], []);
    const untimed = await screen.findByTestId('calendar-untimed');
    expect(within(untimed).queryByTestId('calendar-item-old')).not.toBeNull();
    expect(within(screen.getByTestId('calendar-timeline')).queryByTestId('calendar-item-old')).toBeNull();
    expect(String(screen.getByTestId('calendar-time-old').props.children)).toContain(en.yesterday);
  });

  it('says when a commitment falls inside busy time, in the existing words', async () => {
    connected([{ nativeId: 'evt-1', startAt: onDay(0, 16), endAt: onDay(0, 18), allDay: false }]);
    await show([item('mine', onDay(0, 17))], []);
    await waitFor(() => expect(screen.queryByTestId('calendar-conflict-mine')).not.toBeNull());
    expect(screen.getByTestId('calendar-item-mine').props.accessibilityLabel).toContain('Overlaps a calendar event');
  });
});

describe('a pending change to today\'s plan (Stitch proposal)', () => {
  function Probe() {
    const { s } = useApp();
    return <Text testID="probe-screen">{s.screen}</Text>;
  }

  async function showWithProposal() {
    jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue({ ...planWithProposal.plan, proposal: planWithProposal.proposal } as never);
    const act = jest.spyOn(planEndpoints, 'actOnPlan');
    jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
    jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <AuthProvider repository={repository} isDevBundle={false}>
            <QueryClientProvider client={client}><CalendarScreen /><Probe /></QueryClientProvider>
          </AuthProvider>
        </AppProvider>
      </SafeAreaProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId('calendar-proposal')).not.toBeNull());
    return act;
  }

  it('shows what would move and says nothing has changed', async () => {
    const act = await showWithProposal();
    expect(screen.getByText(/Write the summary/)).toBeTruthy();
    expect(screen.getByTestId('calendar-proposal-note').props.children).toBe(en.suggestionNote);
    expect(act).not.toHaveBeenCalled();
  });

  it('opens the review, where it is accepted or declined, and accepts nothing itself', async () => {
    const act = await showWithProposal();
    await fireEvent.press(screen.getByTestId('calendar-patch'));
    expect(screen.getByTestId('probe-screen').props.children).toBe('patchReview');
    expect(act).not.toHaveBeenCalled();
  });

  it('«not now» puts it away and answers nothing', async () => {
    const act = await showWithProposal();
    await fireEvent.press(screen.getByTestId('calendar-proposal-later'));
    expect(screen.queryByTestId('calendar-proposal')).toBeNull();
    expect(act).not.toHaveBeenCalled();
  });

  it('is not drawn when nothing is pending', async () => {
    await show([], []);
    expect(screen.queryByTestId('calendar-proposal')).toBeNull();
    expect(screen.queryByTestId('calendar-patch')).toBeNull();
  });
});
