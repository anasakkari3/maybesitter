/**
 * What «شيل المواعيد اللي MaybeSitter ضافها» says afterwards (second review of
 * #870). It said «انشالت» whenever the phone had not refused permission — with
 * events left behind, and «ما تغيّر إشي» after writing had already been turned
 * off. Each line here is the one that is true for what happened.
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
import type { Commitment } from '../../../api/schemas/common';
import { NetworkError } from '../../../api/errors';
import en from '../../../i18n/locales/en.json';
import { CalendarSettingsScreen } from '../CalendarSettingsScreen';
import * as calendarEndpoints from '../../../api/endpoints/calendar';
import * as m5aEndpoints from '../../../api/endpoints/m5a';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import { deviceCalendar, DeviceCalendarError } from '../../calendar/deviceCalendar';
import { draftFor } from '../../calendar/eventDraft';
import { resetWriterIdCache, resolveWriterId, saveChosenCalendarId } from '../../../lib/deviceSettings/calendarDevice';
import { resetCalendarSyncForTests } from '../../calendar/useDeviceCalendarSync';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'remove-outcome-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};
const ZONE = 'Asia/Jerusalem';
const strings = en as unknown as Record<string, string>;

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function settings(writeTarget: 'off' | 'device') {
  return { success: true as const, calendarSettings: { writeTarget, updatedAt: null } };
}

function dated(): Commitment {
  const dueAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  return {
    id: 'cmt-1', kind: 'task', title: 'Dentist', description: null, person: null, status: 'active',
    category: null, categorySource: 'inferred',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt, endAt: null, remindAt: null, allDay: false, timezone: ZONE },
    currentAckState: 'not_seen', postponedUntil: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), confirmedAt: new Date().toISOString(),
    completedAt: null, droppedAt: null, deviceCalendarLink: null,
  };
}

/** One commitment whose event this phone wrote and linked. */
async function oneLinked() {
  const writerId = await resolveWriterId();
  const draft = draftFor(dated(), ZONE)!;
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({
    items: [{
      ...dated(),
      deviceCalendarLink: {
        writerId, calendarId: 'cal-1', eventId: 'evt-1', contentHash: draft.contentHash,
        state: 'linked', writtenAt: new Date().toISOString(),
      },
    }],
    calendarOrphans: [],
  });
}

beforeEach(async () => {
  process.env.EXPO_PUBLIC_FEATURE_CALENDAR_WRITE = 'true';
  onlineManager.setOnline(true);
  resetWriterIdCache();
  resetCalendarSyncForTests();
  await saveChosenCalendarId(USER.uid, 'cal-1');
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(m5aEndpoints, 'getM5aCapabilities').mockResolvedValue({ success: true, calendarChoice: false, emailSources: false });
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [], calendarOrphans: [] });
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] });
  jest.spyOn(calendarEndpoints, 'getCalendarSettings').mockResolvedValue(settings('device'));
  jest.spyOn(calendarEndpoints, 'putCalendarWriteTarget').mockResolvedValue(settings('off'));
  jest.spyOn(calendarEndpoints, 'deleteDeviceCalendarLink').mockResolvedValue({ deleted: true });
  jest.spyOn(deviceCalendar, 'listWritableCalendars').mockResolvedValue([]);
  jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('granted');
  jest.spyOn(deviceCalendar, 'eventExists').mockResolvedValue(true);
  jest.spyOn(deviceCalendar, 'deleteEvent').mockResolvedValue(undefined);
  jest.spyOn(deviceCalendar as Required<typeof deviceCalendar>, 'findOwnEvents').mockResolvedValue([]);
});

afterEach(async () => {
  await cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  await saveChosenCalendarId(USER.uid, null);
  resetAuthForTests();
  resetCalendarSyncForTests();
  jest.restoreAllMocks();
  delete process.env.EXPO_PUBLIC_FEATURE_CALENDAR_WRITE;
});

async function pressRemove() {
  await render(
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
  await waitFor(() => expect(screen.queryByTestId('calendar-remove-all')).not.toBeNull());
  await waitFor(() => expect(commitmentEndpoints.listToday).toHaveBeenCalled());
  await new Promise(resolve => setTimeout(resolve, 20));
  await fireEvent.press(screen.getByTestId('calendar-remove-all'));
}

describe('what the button says', () => {
  it('says it removed them when it did', async () => {
    await oneLinked();
    await pressRemove();
    await waitFor(() => expect(screen.getByTestId('calendar-removed-count')).toHaveTextContent(strings.calendarRemoveDone!));
    expect(screen.queryByTestId('calendar-remove-failed')).toBeNull();
  });

  it('says some could not be removed when one was left', async () => {
    await oneLinked();
    jest.spyOn(deviceCalendar, 'deleteEvent').mockRejectedValue(new DeviceCalendarError('unavailable', 'busy'));
    await pressRemove();
    await waitFor(() => expect(screen.getByTestId('calendar-removed-count')).toHaveTextContent(strings.calendarRemovePartial!));
  });

  it('says it found nothing when there was nothing of ours', async () => {
    await pressRemove();
    await waitFor(() => expect(screen.getByTestId('calendar-removed-count')).toHaveTextContent(strings.calendarRemoveNone!));
  });

  it('says nothing changed when writing could not be turned off', async () => {
    await oneLinked();
    jest.spyOn(calendarEndpoints, 'putCalendarWriteTarget').mockRejectedValue(new NetworkError('offline'));
    await pressRemove();
    await waitFor(() => expect(screen.getByTestId('calendar-remove-failed')).toHaveTextContent(strings.trustActionFailed!));
    expect(deviceCalendar.deleteEvent).not.toHaveBeenCalled();
    expect(screen.queryByTestId('calendar-removed-count')).toBeNull();
  });

  it('says writing is off but the removal did not finish when it failed afterwards', async () => {
    await oneLinked();
    // Writing off is saved; the removal then fails on the phone.
    jest.spyOn(deviceCalendar, 'getAccess').mockImplementation(async () => {
      if ((calendarEndpoints.putCalendarWriteTarget as jest.Mock).mock.calls.length > 0) {
        throw new Error('the calendar went away');
      }
      return 'granted';
    });
    await pressRemove();
    await waitFor(() => expect(screen.getByTestId('calendar-remove-failed')).toHaveTextContent(strings.calendarRemoveIncomplete!));
  });
});
