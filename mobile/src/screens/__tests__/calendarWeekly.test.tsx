/**
 * Weekly fixed blocks on the Calendar tab: the block itself, with its title
 * and hours, as fixed time — and the device event this app wrote for it
 * hidden from the busy rows, so it is not drawn twice.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import type { AuthUser } from '../../auth/types';
import { CalendarScreen } from '../CalendarScreen';
import { dayKey, shiftDayKey } from '../../i18n/format';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import ar from '../../i18n/locales/ar.json';
import { stripIsolates } from '../../i18n/bidi';
import { instantAt } from '../../testing/wallClock';
import { saveWeeklyEventLinks } from '../../lib/deviceSettings/calendarDevice';
import type { DeviceBusyBlock } from '../../features/calendar/busyBlocks';
import * as commitmentEndpoints from '../../api/endpoints/commitments';
import * as planEndpoints from '../../api/endpoints/plans';
import * as trustEndpoints from '../../api/endpoints/trust';
import * as weeklyEndpoints from '../../api/endpoints/weeklyBlocks';

const ZONE = 'Asia/Jerusalem';
jest.mock('../../i18n/timezone', () => ({
  ...(jest.requireActual('../../i18n/timezone') as object),
  useTimeZone: () => 'Asia/Jerusalem',
}));

let mockBusy: DeviceBusyBlock[] = [];
jest.mock('../../features/calendar/useBusyCalendar', () => ({
  ...(jest.requireActual('../../features/calendar/useBusyCalendar') as object),
  useBusyBlocks: () => mockBusy,
}));

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const USER: AuthUser = { uid: 'cal-weekly-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };
const TODAY = dayKey(new Date(), ZONE);
const TOMORROW = shiftDayKey(TODAY, 1);
const at = (key: string, clock: string) => instantAt(`${key}T${clock}:00`, ZONE);

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(async () => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  await AsyncStorage.clear();
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
  jest.spyOn(planEndpoints, 'getSavedWeek').mockResolvedValue({ today: TODAY, saved: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue({ success: true, participantId: USER.uid, trust: { analyticsConsent: false, calendarConsent: true } } as never);
});

afterEach(() => { client.clear(); resetAuthForTests(); jest.restoreAllMocks(); mockBusy = []; });

async function show() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}><CalendarScreen /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId(`calendar-day-${TODAY}`)).not.toBeNull());
}

describe('weekly blocks on the Calendar tab', () => {
  it('draws the block as fixed time with its title and hours, on its own day', async () => {
    const occurrences = jest.spyOn(weeklyEndpoints, 'listWeeklyBlockOccurrences').mockResolvedValue([
      { occurrenceId: 'o1', weeklyBlockId: 'train', title: 'تدريب', startAt: at(TOMORROW, '10:00'), endAt: at(TOMORROW, '16:00') },
    ]);
    await show();
    // Asked for the strip's seven local days.
    await waitFor(() => expect(occurrences).toHaveBeenCalled());
    expect(occurrences.mock.calls[0]![0]).toEqual({ from: at(TODAY, '00:00'), to: at(shiftDayKey(TODAY, 7), '00:00') });
    expect(screen.queryByTestId('calendar-weekly-train')).toBeNull();
    // The day cell carries a bar for it.
    await waitFor(() => expect(screen.queryByTestId(`calendar-busy-bar-${TOMORROW}`)).not.toBeNull());
    await fireEvent.press(screen.getByTestId(`calendar-day-${TOMORROW}`));
    const row = await screen.findByTestId('calendar-weekly-train');
    expect(row.props.accessibilityLabel).toBe(`تدريب، ${ar.wbFixedTag}، من 10:00 لـ 16:00`);
    expect(screen.getByText('تدريب')).toBeTruthy();
    expect(stripIsolates(String(screen.getByTestId('calendar-weekly-train-time').props.children))).toBe('10:00–16:00');
    // Not a to-do: no «تمّت» on it.
    expect(screen.queryByLabelText(ar.doneS)).toBeNull();
    expect(screen.queryByTestId('calendar-day-free')).toBeNull();
  });

  it('hides the device event written for the block, and the same interval from elsewhere, and nothing else', async () => {
    jest.spyOn(weeklyEndpoints, 'listWeeklyBlockOccurrences').mockResolvedValue([
      { occurrenceId: 'o1', weeklyBlockId: 'train', title: 'تدريب', startAt: at(TODAY, '10:00'), endAt: at(TODAY, '16:00') },
    ]);
    await saveWeeklyEventLinks(USER.uid, [{ blockId: 'train', calendarId: 'cal', eventIds: ['evt-own'], contentHash: 'h' }]);
    mockBusy = [
      // This app's own recurring event, at a slightly different instant (another week's copy).
      { nativeId: 'evt-own', startAt: at(TODAY, '10:00'), endAt: at(TODAY, '15:59'), allDay: false },
      // The same block through Google: no id this phone knows, exactly the interval.
      { nativeId: 'google-1', startAt: at(TODAY, '10:00'), endAt: at(TODAY, '16:00'), allDay: false },
      // A real appointment.
      { nativeId: 'dentist', startAt: at(TODAY, '18:00'), endAt: at(TODAY, '18:30'), allDay: false },
    ];
    await show();
    await waitFor(() => expect(screen.queryByTestId('calendar-weekly-train')).not.toBeNull());
    await waitFor(() => expect(screen.getAllByTestId('calendar-busy-row')).toHaveLength(1));
  });
});
