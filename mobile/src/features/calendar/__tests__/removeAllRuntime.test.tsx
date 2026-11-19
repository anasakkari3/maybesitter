/**
 * «شيل المواعيد اللي MaybeSitter ضافها» in the running hook (review of #870).
 *
 * Two ways the button undid itself:
 *
 *   With «حطّ التزاماتي بتقويمي» still on, the removal invalidated the lists,
 *   the links came back null, the fingerprint changed and the next pass wrote
 *   every event again a few seconds later. The owner's decision: the button
 *   turns the switch off first, then removes.
 *
 *   Pressed while a pass was between writing an event and claiming it, the
 *   sweep removed the event and the claim landed afterwards, naming an event
 *   that was gone — which the next pass records as deleted by hand, for ever.
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
import type { Commitment, DeviceCalendarLink } from '../../../api/schemas/common';
import type { CalendarWriteTarget } from '../../../api/schemas/calendar';
import * as calendarEndpoints from '../../../api/endpoints/calendar';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import { deviceCalendar } from '../deviceCalendar';
import { draftFor } from '../eventDraft';
import { resetWriterIdCache, resolveWriterId, saveChosenCalendarId } from '../../../lib/deviceSettings/calendarDevice';
import { resetCalendarSyncForTests, useDeviceCalendarSync, type CalendarSyncState } from '../useDeviceCalendarSync';
import { useToday, useUpcoming } from '../../../api/queries';

const USER: AuthUser = {
  uid: 'remove-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};
const ZONE = 'Asia/Jerusalem';

function dated(link: DeviceCalendarLink | null): Commitment {
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
    timeSpec: { kind: 'due_by', dueAt, endAt: null, remindAt: null, allDay: false, timezone: ZONE },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
    completedAt: null,
    droppedAt: null,
    deviceCalendarLink: link,
  };
}

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;
let hook: CalendarSyncState | null = null;
/** What the server holds, so every refetch answers from it. */
let serverTarget: CalendarWriteTarget = 'device';
let serverLink: DeviceCalendarLink | null = null;
/** What the phone's calendar holds: id → address. */
let phone = new Map<string, string>();

function Host() {
  const today = useToday();
  const upcoming = useUpcoming();
  hook = useDeviceCalendarSync([today.data, upcoming.data]);
  return null;
}

beforeEach(async () => {
  process.env.EXPO_PUBLIC_FEATURE_CALENDAR_WRITE = 'true';
  onlineManager.setOnline(true);
  resetWriterIdCache();
  resetCalendarSyncForTests();
  await saveChosenCalendarId(USER.uid, 'cal-1');
  serverTarget = 'device';
  serverLink = null;
  phone = new Map();
  hook = null;
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(commitmentEndpoints, 'listToday').mockImplementation(async () => ({ items: [dated(serverLink)], calendarOrphans: [] }));
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] });
  jest.spyOn(calendarEndpoints, 'getCalendarSettings').mockImplementation(async () => ({ calendarSettings: { writeTarget: serverTarget } }));
  jest.spyOn(calendarEndpoints, 'putCalendarWriteTarget').mockImplementation(async (target) => {
    serverTarget = target;
    return { calendarSettings: { writeTarget: target } };
  });
  jest.spyOn(calendarEndpoints, 'deleteDeviceCalendarLink').mockImplementation(async () => {
    serverLink = null;
    return { deleted: true };
  });
  jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('granted');
  jest.spyOn(deviceCalendar, 'eventExists').mockImplementation(async (id) => phone.has(id));
  jest.spyOn(deviceCalendar, 'updateEvent').mockResolvedValue(undefined);
  jest.spyOn(deviceCalendar, 'deleteEvent').mockImplementation(async (id) => { phone.delete(id); });
  jest.spyOn(deviceCalendar as Required<typeof deviceCalendar>, 'findOwnEvents')
    .mockImplementation(async () => [...phone.entries()].map(([id, url]) => ({ id, url })));
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

async function mount() {
  return render(
    <AppProvider>
      <AuthProvider repository={repository} isDevBundle={false}>
        <QueryClientProvider client={client}>
          <Host />
        </QueryClientProvider>
      </AuthProvider>
    </AppProvider>,
  );
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

describe('the button with «حطّ التزاماتي بتقويمي» on', () => {
  it('turns writing off, and nothing is written back after the lists refresh', async () => {
    const writerId = await resolveWriterId();
    const url = draftFor(dated(null), ZONE)!.url!;
    phone.set('evt-1', url);
    serverLink = {
      writerId, calendarId: 'cal-1', eventId: 'evt-1',
      contentHash: draftFor(dated(null), ZONE)!.contentHash, state: 'linked', writtenAt: new Date().toISOString(),
    };
    const create = jest.spyOn(deviceCalendar, 'createEvent').mockImplementation(async () => {
      phone.set('evt-again', url);
      return 'evt-again';
    });
    jest.spyOn(calendarEndpoints, 'putDeviceCalendarLink').mockResolvedValue(undefined as never);
    await mount();
    await waitFor(() => expect(hook).not.toBeNull());
    await waitFor(() => expect(commitmentEndpoints.listToday).toHaveBeenCalled());
    await settle();

    const result = await hook!.removeAll();
    expect(result.removed).toBe(1);
    expect(calendarEndpoints.putCalendarWriteTarget).toHaveBeenCalledWith('off', expect.anything());
    // The refresh the removal asked for, and a pass after it.
    await client.invalidateQueries();
    await settle();
    await hook!.runNow();
    await settle();
    expect(create).not.toHaveBeenCalled();
    expect(phone.size).toBe(0);
  });
});

describe('the button pressed while a pass is claiming an event', () => {
  it('waits for the claim, then removes the event and forgets the link', async () => {
    const url = draftFor(dated(null), ZONE)!.url!;
    const order: string[] = [];
    let releaseClaim: () => void = () => undefined;
    jest.spyOn(deviceCalendar, 'createEvent').mockImplementation(async () => {
      phone.set('evt-1', url);
      order.push('created');
      return 'evt-1';
    });
    jest.spyOn(calendarEndpoints, 'putDeviceCalendarLink').mockImplementation(async (_id, link) => {
      await new Promise<void>((resolve) => { releaseClaim = resolve; });
      serverLink = { ...link, writtenAt: new Date().toISOString() };
      order.push('claimed');
      return { deviceCalendarLink: serverLink };
    });
    (deviceCalendar.deleteEvent as jest.MockedFunction<typeof deviceCalendar.deleteEvent>)
      .mockImplementation(async (id) => { order.push(`deleted:${id}`); phone.delete(id); });
    await mount();
    await waitFor(() => expect(order).toContain('created'));
    // The pass is between the write and the claim. The button is pressed now.
    const removing = hook!.removeAll();
    await settle();
    releaseClaim();
    await removing;
    expect(order.indexOf('claimed')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('deleted:evt-1')).toBeGreaterThan(order.indexOf('claimed'));
    expect(phone.size).toBe(0);
    // No link left naming an event that is gone.
    expect(serverLink).toBeNull();
  });
});
