/**
 * Leaving the account leaves nothing of it on the phone (closure CL4).
 *
 * The place reminders keep commitment titles and pins on the device, which
 * is only acceptable because every sign-out takes them away again: the OS
 * stops watching the regions, a ring deferred by quiet hours is cancelled,
 * both stores are removed, and the in-memory places are forgotten. This mounts
 * the real `PlaceRemindersMount`, lets it arm a real region, and signs out by
 * every route the app has — the button, account deletion, an expired session
 * and a revoked account — checking each of those four effects.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider, useAuth } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetBeforeSignOutForTests, runBeforeSignOut } from '../../../auth/beforeSignOut';
import { resetAuthForTests, setAuthRepository, signOutExpired, signOutForbidden } from '../../../api/auth';
import type { AuthUser, SignOutReason } from '../../../auth/types';
import type { Commitment } from '../../../api/schemas/common';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as reminderEndpoints from '../../../api/endpoints/reminders';
import { ARMED_KEY, placesStorageKey, savePlaces, type Place } from '../../../lib/deviceSettings/placeReminders';
import { PLACE_REMINDER_TASK, regionIdentifier } from '../placeReminderEngine';
import { PlaceRemindersMount } from '../PlaceRemindersMount';
import { HOME_ID, placesSnapshot, resetPlacesStoreForTests } from '../placesStore';

const mockLocation = { started: false };
jest.mock('expo-location', () => ({
  __esModule: true,
  Accuracy: { Balanced: 3 },
  getForegroundPermissionsAsync: async () => ({ granted: true, status: 'granted' }),
  getBackgroundPermissionsAsync: async () => ({ granted: true, status: 'granted' }),
  requestForegroundPermissionsAsync: async () => ({ granted: true, status: 'granted' }),
  requestBackgroundPermissionsAsync: async () => ({ granted: true, status: 'granted' }),
  getCurrentPositionAsync: async () => ({ coords: { latitude: 32.0853, longitude: 34.7818 } }),
  startGeofencingAsync: jest.fn(async () => { mockLocation.started = true; }),
  stopGeofencingAsync: jest.fn(async () => { mockLocation.started = false; }),
  hasStartedGeofencingAsync: async () => mockLocation.started,
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Location = require('expo-location') as { startGeofencingAsync: jest.Mock; stopGeofencingAsync: jest.Mock };

const USER: AuthUser = { uid: 'leaving-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };
const HOME: Place = { id: HOME_ID, kind: 'home', label: 'Home', latitude: 32.0853, longitude: 34.7818, updatedAt: '2026-09-20T08:00:00.000Z' };

function watched(): Commitment {
  return {
    id: 'c1', kind: 'task', title: 'Buy bread', description: null, person: null, status: 'active',
    priority: { level: 'normal', source: 'inferred', pressureAllowed: false, pressureLevel: 'none' },
    category: null, categorySource: 'inferred',
    timeSpec: { kind: 'unscheduled', dueAt: null, endAt: null, remindAt: null, allDay: false, timezone: 'UTC' },
    currentAckState: 'not_seen', postponedUntil: null,
    createdAt: '2026-09-20T08:00:00.000Z', updatedAt: '2026-09-20T08:00:00.000Z',
    confirmedAt: '2026-09-20T08:00:00.000Z', completedAt: null, droppedAt: null,
    locationTrigger: { kind: 'arrive', placeId: HOME_ID, label: 'Home' },
  } as Commitment;
}

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

/** One pressable per reason the provider can be asked for, like the sign-out button and the deletion flow. */
function Harness() {
  const { signOut } = useAuth();
  return (
    <>
      <Text testID="sign-out-user" onPress={() => void signOut({ reason: 'user' })}>out</Text>
      <Text testID="sign-out-deleted" onPress={() => void signOut({ reason: 'deleted' })}>deleted</Text>
    </>
  );
}

function pressSignOut(reason: SignOutReason): Promise<void> {
  return act(async () => {
    screen.getByTestId(`sign-out-${reason}`).props.onPress();
  });
}

async function mountArmed() {
  const view = await render(
    <AppProvider>
      <AuthProvider repository={repository} isDevBundle={false}>
        <QueryClientProvider client={client}>
          <PlaceRemindersMount />
          <Harness />
        </QueryClientProvider>
      </AuthProvider>
    </AppProvider>,
  );
  // The mount armed the region for real: this is what sign-out has to undo.
  await waitFor(() => expect(Location.startGeofencingAsync).toHaveBeenCalledWith(PLACE_REMINDER_TASK, [expect.objectContaining({ identifier: regionIdentifier('c1') })]));
  await waitFor(async () => expect(await AsyncStorage.getItem(ARMED_KEY)).toContain('Buy bread'));
  expect(placesSnapshot(USER.uid).loaded).toBe(true);
  return view;
}

beforeEach(async () => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  await AsyncStorage.clear();
  resetPlacesStoreForTests();
  resetBeforeSignOutForTests();
  mockLocation.started = false;
  Location.startGeofencingAsync.mockClear();
  Location.stopGeofencingAsync.mockClear();
  await savePlaces(USER.uid, [HOME]);
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [watched()] });
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] });
  jest.spyOn(reminderEndpoints, 'getReminderSettings').mockRejectedValue(new Error('offline'));
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  resetBeforeSignOutForTests();
  jest.restoreAllMocks();
});

const ROUTES: readonly [string, () => Promise<void>][] = [
  ['the sign-out button', () => pressSignOut('user')],
  ['account deletion', () => pressSignOut('deleted')],
  ['an expired session', () => act(() => signOutExpired())],
  ['a revoked account', () => act(() => signOutForbidden('revoked'))],
];

describe.each(ROUTES)('signing out through %s', (_name, signOut) => {
  it('stops the watch, cancels a deferred ring, removes both stores and forgets the places', async () => {
    const cancel = jest.spyOn(Notifications, 'cancelScheduledNotificationAsync');
    await mountArmed();

    await signOut();

    expect(Location.stopGeofencingAsync).toHaveBeenCalledWith(PLACE_REMINDER_TASK);
    expect(mockLocation.started).toBe(false);
    expect(cancel).toHaveBeenCalledWith(regionIdentifier('c1'));
    expect(await AsyncStorage.getItem(ARMED_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(placesStorageKey(USER.uid))).toBeNull();
    expect(placesSnapshot(USER.uid)).toEqual({ loaded: false, places: [], removed: [] });
  });
});

describe('the sign-out hook', () => {
  it('goes away with the mount, so a later session does not run it twice', async () => {
    const view = await mountArmed();
    await view.unmount();
    await runBeforeSignOut('user');
    expect(Location.stopGeofencingAsync).not.toHaveBeenCalled();
  });
});
