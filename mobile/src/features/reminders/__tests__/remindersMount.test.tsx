import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider, useAuth } from '../../../auth/AuthProvider';
import { createFakeAuthRepository, type FakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { resetBeforeSignOutForTests } from '../../../auth/beforeSignOut';
import { RemindersMount } from '../RemindersMount';
import * as deviceEndpoints from '../../../api/endpoints/devices';
import * as reminderEndpoints from '../../../api/endpoints/reminders';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as profileEndpoints from '../../../api/endpoints/profile';
import * as notificationsSetup from '../../../notifications/setup';
import * as messaging from '@react-native-firebase/messaging';
import { resetInstallationIdForTests } from '../../../lib/installationId';
import { awarenessStorageKey } from '../../../lib/deviceSettings/awarenessStore';
import type { AuthUser } from '../../../auth/types';
import commitment from '../../../api/__fixtures__/commitments.one.json';
import reminderSettings from '../../../api/__fixtures__/reminders.settingsSaved.json';

/**
 * The wiring (UC-3.11 #196, UC-3.0b #184).
 *
 * Everything below this component is tested on its own: the engine against a
 * fake gateway, the registration against injected dependencies, the store
 * against AsyncStorage. None of that proves anybody *calls* it, and a lane
 * whose whole value is "this happens for the whole signed-in session" cannot
 * leave that to a reading of the file.
 *
 * So the two claims here are the two acceptance criteria phrased as app
 * behaviour: signing in registers this phone, and signing out deletes its
 * device document — before the credential goes.
 */

const USER: AuthUser = {
  uid: 'mount-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

let client: QueryClient;
let repository: FakeAuthRepository;

function SignOutButton() {
  const { signOut } = useAuth();
  return <Text testID="sign-out" onPress={() => void signOut({ reason: 'user' })}>out</Text>;
}

async function mount() {
  return render(
    <AppProvider>
      <AuthProvider repository={repository} isDevBundle={false}>
        <QueryClientProvider client={client}>
          <RemindersMount />
          <SignOutButton />
        </QueryClientProvider>
      </AuthProvider>
    </AppProvider>,
  );
}

beforeEach(() => {
  onlineManager.setOnline(true);
  resetInstallationIdForTests();
  resetBeforeSignOutForTests();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(reminderEndpoints, 'getReminderSettings').mockResolvedValue(reminderSettings as never);
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [commitment] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue({ routine: null } as never);
  jest.spyOn(deviceEndpoints, 'registerDevice').mockResolvedValue({ success: true, ok: true } as never);
  jest.spyOn(deviceEndpoints, 'forgetDevice').mockResolvedValue({ success: true, ok: true, existed: true } as never);
  // The channels and categories are the setup module's own business; this test
  // is about what the mount wires, not about what expo-notifications does.
  jest.spyOn(notificationsSetup, 'configureNotifications').mockResolvedValue(undefined);
  // The one native answer this path cannot do without. The inert mock in
  // `jest.setup.js` returns null, which is a real device state — a phone that
  // has no token yet registers nothing — but it is not the state this test is
  // about.
  jest.spyOn(messaging, 'getToken').mockResolvedValue('a-real-looking-fcm-token-aaaaaaaaaaaaaaaaaaaaaaa' as never);
});

afterEach(async () => {
  cleanup();
  // A real macrotask: a registration still settling when the tree comes down
  // leaves React work in flight, and in RNTL v14 the next render mounts nothing.
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  resetBeforeSignOutForTests();
  await AsyncStorage.removeItem(awarenessStorageKey(USER.uid));
  jest.restoreAllMocks();
});

describe('what the mount wires', () => {
  it('registers this phone once somebody is signed in', async () => {
    await mount();
    await waitFor(() => expect(deviceEndpoints.registerDevice).toHaveBeenCalledTimes(1));
    const sent = (deviceEndpoints.registerDevice as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
    // The uid is the token's, and there is no field here to claim one.
    expect('uid' in sent).toBe(false);
    expect(sent.installationId).toEqual(expect.any(String));
  });

  it('sets up the notification system, and asks for no permission doing it', async () => {
    await mount();
    await waitFor(() => expect(notificationsSetup.configureNotifications).toHaveBeenCalled());
  });

  it('deletes the device document when the user signs out', async () => {
    const view = await mount();
    await waitFor(() => expect(deviceEndpoints.registerDevice).toHaveBeenCalledTimes(1));

    await act(async () => {
      view.getByTestId('sign-out').props.onPress();
    });

    // The acceptance criterion, as the app performs it: the row is gone, and
    // it went while the session could still authorise the DELETE.
    await waitFor(() => expect(deviceEndpoints.forgetDevice).toHaveBeenCalledTimes(1));
    expect(repository.signOutReasons).toEqual(['user']);
  });
});
