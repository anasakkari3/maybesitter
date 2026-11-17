/**
 * Lecture times added from a syllabus can be seen and removed (QA audit
 * CXA10.3 / CA10.4).
 *
 * «أضف أوقات المحاضرات» on a reviewed syllabus writes sixteen weeks of busy
 * time. Before this the app never called `deleteManualBusy`, so an accidental
 * add could not be undone. Settings → Calendar now lists what was added, and
 * each one is removed after a confirm. The review screen's two new refusals
 * (consent off, too many added) are mapped to their own words.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { CalendarSettingsScreen } from '../CalendarSettingsScreen';
import * as calendarEndpoints from '../../../api/endpoints/calendar';
import * as m5aEndpoints from '../../../api/endpoints/m5a';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import { deviceCalendar } from '../../calendar/deviceCalendar';
import { resetWriterIdCache } from '../../../lib/deviceSettings/calendarDevice';
import { resetCalendarSyncForTests } from '../../calendar/useDeviceCalendarSync';
import { ConflictError, ForbiddenError, NetworkError, ValidationError } from '../../../api/errors';
import { manualBusyFailureKey } from '../../calendar/manualLectures';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'lecture-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

const SOURCE = {
  sourceId: 'manual-p1', proposalId: 'p1', addedAt: '2026-11-10T09:00:00.000Z',
  windowStart: '2026-11-09T22:00:00.000Z', windowEnd: '2027-03-01T22:00:00.000Z',
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(() => {
  onlineManager.setOnline(true);
  resetWriterIdCache();
  resetCalendarSyncForTests();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(m5aEndpoints, 'getM5aCapabilities').mockResolvedValue({ success: true, calendarChoice: false, emailSources: false });
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] });
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] });
  jest.spyOn(calendarEndpoints, 'getCalendarSettings').mockResolvedValue({ calendarSettings: { writeTarget: 'off' } });
  jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('granted');
  jest.spyOn(deviceCalendar, 'listWritableCalendars').mockResolvedValue([]);
});

afterEach(async () => {
  await cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function show() {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <CalendarSettingsScreen onBack={() => {}} />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

describe('lecture times added from a syllabus', () => {
  it('are listed, and removed only after the person confirms', async () => {
    const list = jest.spyOn(calendarEndpoints, 'listManualBusy')
      .mockResolvedValueOnce({ success: true, sources: [SOURCE] })
      .mockResolvedValue({ success: true, sources: [] });
    const remove = jest.spyOn(calendarEndpoints, 'deleteManualBusy')
      .mockResolvedValue({ success: true, sourceId: 'manual-p1', deleted: 32 });
    await show();
    await waitFor(() => expect(screen.queryByTestId('calendar-lecture-times-manual-p1')).not.toBeNull());

    await fireEvent.press(screen.getByTestId('calendar-lecture-remove-manual-p1'));
    expect(remove).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('calendar-lecture-remove-dialog')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('calendar-lecture-remove-confirm'));

    await waitFor(() => expect(remove).toHaveBeenCalledWith('p1', expect.anything()));
    await waitFor(() => expect(screen.queryByTestId('calendar-lecture-times-manual-p1')).toBeNull());
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the row and says so when the removal fails', async () => {
    jest.spyOn(calendarEndpoints, 'listManualBusy').mockResolvedValue({ success: true, sources: [SOURCE] });
    jest.spyOn(calendarEndpoints, 'deleteManualBusy').mockRejectedValue(new NetworkError('offline'));
    await show();
    await waitFor(() => expect(screen.queryByTestId('calendar-lecture-times-manual-p1')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('calendar-lecture-remove-manual-p1'));
    await waitFor(() => expect(screen.queryByTestId('calendar-lecture-remove-dialog')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('calendar-lecture-remove-confirm'));
    await waitFor(() => expect(screen.queryByTestId('calendar-lecture-remove-failed')).not.toBeNull());
    expect(screen.queryByTestId('calendar-lecture-times-manual-p1')).not.toBeNull();
  });

  it('draws nothing when nothing was added', async () => {
    jest.spyOn(calendarEndpoints, 'listManualBusy').mockResolvedValue({ success: true, sources: [] });
    await show();
    await waitFor(() => expect(calendarEndpoints.listManualBusy).toHaveBeenCalled());
    expect(screen.queryByTestId('calendar-lecture-times')).toBeNull();
  });
});

describe('review of wave B8: rows that can be told apart', () => {
  it('numbers the rows and makes the title a header', async () => {
    jest.spyOn(calendarEndpoints, 'listManualBusy').mockResolvedValue({
      success: true,
      sources: [SOURCE, { ...SOURCE, sourceId: 'manual-p2', proposalId: 'p2' }],
    });
    await show();
    await waitFor(() => expect(screen.queryByTestId('calendar-lecture-times-manual-p2')).not.toBeNull());
    const text = (id: string) => [screen.getByTestId(id).props.children].flat().join('');
    expect(text('calendar-lecture-times-label-manual-p1')).toMatch(/^Set 1 · /);
    expect(text('calendar-lecture-times-label-manual-p2')).toMatch(/^Set 2 · /);
    expect(screen.getByTestId('calendar-lecture-times-title').props.accessibilityRole).toBe('header');
    expect(screen.getByTestId('calendar-lecture-remove-manual-p2').props.accessibilityLabel).toContain('2');
  });
});

describe('the review screen says why adding lecture times was refused', () => {
  it('maps consent-off, the limit and anything else to their own words', () => {
    expect(manualBusyFailureKey(new ForbiddenError('x', 'calendar_consent_required'))).toBe('syllabusLecturesNeedCalendar');
    expect(manualBusyFailureKey(new ConflictError('manual_busy_limit'))).toBe('syllabusLecturesLimit');
    expect(manualBusyFailureKey(new NetworkError('offline'))).toBe('syllabusLecturesFailed');
    expect(manualBusyFailureKey(new ValidationError('x', 'too_many_sessions'))).toBe('syllabusLecturesTooMany');
  });
});
