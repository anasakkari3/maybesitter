/**
 * The week ahead, from the account (UC-2.R3 #173).
 *
 * The claim under test is the one the screen changed to make: every cell in
 * the strip is a day we have real data for. A cell we cannot fill is not
 * drawn empty — it is not drawn.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { Text } from 'react-native';
import { AppProvider, useApp } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import type { AuthUser } from '../../auth/types';
import { CalendarScreen } from '../CalendarScreen';
import type { Commitment } from '../../api/schemas/common';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CIVIL_ZONE, civilDate, dayKey, formatDate, shiftDayKey } from '../../i18n/format';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import ar from '../../i18n/locales/ar.json';
import en from '../../i18n/locales/en.json';

import * as commitmentEndpoints from '../../api/endpoints/commitments';
import * as planEndpoints from '../../api/endpoints/plans';
import { savedWeekResponseSchema, type SavedWeek } from '../../api/schemas/plan';
import savedWeekFixture from '../../api/__fixtures__/plan.weekSaved.json';

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
    await waitFor(() => expect(screen.queryByText(ar.calendarTitle)).not.toBeNull());
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
