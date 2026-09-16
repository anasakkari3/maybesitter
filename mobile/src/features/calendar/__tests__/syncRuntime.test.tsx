/**
 * The two promises the sync makes about when it runs at all (UC-3.1, #185).
 *
 * ── One pass at a time, for the whole process ────────────────────
 *
 * The hook is mounted twice on purpose: once by `DeviceCalendarSyncHost` in
 * `Root`, so a confirm on Today reaches the calendar, and once by the calendar
 * settings screen, so picking a calendar runs a pass at once. Two instances
 * each guarding themselves with their own flag would both read "no link" for
 * the same commitment and both create an event — and the server's refusal of
 * the second claim arrives *after* the duplicate is already in somebody's
 * calendar, because the event is written before the claim is made.
 *
 * So the flag is module-level, and this is the test that says so: with the two
 * hooks mounted the way the app mounts them, exactly one event is created.
 * Turning `passInFlight` into a `useRef` makes this red and nothing else does.
 *
 * ── A build with the feature off writes nothing ──────────────────
 *
 * `EXPO_PUBLIC_FEATURE_CALENDAR_WRITE` is false in production until this has
 * been through QA on a device (#185 step 8), so "this build touches no
 * calendar" has to be a property of the code and not of which screens somebody
 * happens to open. The check lives in `runNow`, the one place a pass is ever
 * started — and what is asserted below is that the OS is not so much as *asked*
 * about the permission, because a calendar prompt on a build that writes
 * nothing is a worse breach of that promise than the event would have been.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import type { Commitment } from '../../../api/schemas/common';
import * as calendarEndpoints from '../../../api/endpoints/calendar';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import { deviceCalendar } from '../deviceCalendar';
import { resetWriterIdCache, saveChosenCalendarId } from '../../../lib/deviceSettings/calendarDevice';
import { resetCalendarSyncForTests, useDeviceCalendarSync } from '../useDeviceCalendarSync';
import { useToday, useUpcoming } from '../../../api/queries';

const USER: AuthUser = {
  uid: 'calendar-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

/**
 * A commitment due a long way from any boundary, derived from the clock this
 * test is running on rather than written down: a literal here would one day be
 * a time in the past, and the confirm path refuses those.
 */
function dated(): Commitment {
  const dueAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  return {
    id: 'cmt-1',
    kind: 'task',
    title: 'Dentist',
    description: null,
    person: null,
    status: 'active',
    category: null,
    categorySource: 'inferred',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt, endAt: null, remindAt: null, allDay: false, timezone: 'Asia/Jerusalem' },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
    completedAt: null,
    droppedAt: null,
    deviceCalendarLink: null,
  };
}

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

/** The two mount points, in one tree, exactly as `Root` and Settings do it. */
function TwoMounts() {
  const today = useToday();
  const upcoming = useUpcoming();
  useDeviceCalendarSync([today.data, upcoming.data]);
  useDeviceCalendarSync([today.data, upcoming.data]);
  return null;
}

beforeEach(async () => {
  process.env.EXPO_PUBLIC_FEATURE_CALENDAR_WRITE = 'true';
  onlineManager.setOnline(true);
  resetWriterIdCache();
  resetCalendarSyncForTests();
  await saveChosenCalendarId('cal-1');
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [dated()], calendarOrphans: [] });
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] });
  jest.spyOn(calendarEndpoints, 'getCalendarSettings')
    .mockResolvedValue({ calendarSettings: { writeTarget: 'device' } });
  jest.spyOn(calendarEndpoints, 'putDeviceCalendarLink').mockResolvedValue(undefined as never);
  jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('granted');
});

afterEach(async () => {
  cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  await saveChosenCalendarId(null);
  resetAuthForTests();
  resetCalendarSyncForTests();
  jest.restoreAllMocks();
  delete process.env.EXPO_PUBLIC_FEATURE_CALENDAR_WRITE;
});

async function mount() {
  return render(
    <AppProvider>
      <AuthProvider repository={repository} isDevBundle={false}>
        <QueryClientProvider client={client}>
          <TwoMounts />
        </QueryClientProvider>
      </AuthProvider>
    </AppProvider>,
  );
}

describe('two mounted syncs', () => {
  it('write one event between them, not one each', async () => {
    const create = jest.spyOn(deviceCalendar, 'createEvent').mockResolvedValue('evt-1');
    await mount();
    await waitFor(() => expect(create).toHaveBeenCalled());
    // Settling: a second pass, if one were going to run, has every chance to.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(create).toHaveBeenCalledTimes(1);
    expect(calendarEndpoints.putDeviceCalendarLink).toHaveBeenCalledTimes(1);
  });
});

describe('a build with the calendar feature off', () => {
  it('writes no event and never asks the OS about the permission', async () => {
    delete process.env.EXPO_PUBLIC_FEATURE_CALENDAR_WRITE;
    const create = jest.spyOn(deviceCalendar, 'createEvent').mockResolvedValue('evt-1');
    await mount();
    // The lists still load — the app works normally, it just writes no events.
    await waitFor(() => expect(commitmentEndpoints.listToday).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(create).not.toHaveBeenCalled();
    expect(deviceCalendar.getAccess).not.toHaveBeenCalled();
    expect(calendarEndpoints.putDeviceCalendarLink).not.toHaveBeenCalled();
  });
});
