import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider, useAuth } from '../../../auth/AuthProvider';
import { createFakeAuthRepository, type FakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository, signOutForbidden } from '../../../api/auth';
import { resetBeforeSignOutForTests } from '../../../auth/beforeSignOut';
import { RemindersMount } from '../RemindersMount';
import * as deviceEndpoints from '../../../api/endpoints/devices';
import * as reminderEndpoints from '../../../api/endpoints/reminders';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as profileEndpoints from '../../../api/endpoints/profile';
import * as notificationsSetup from '../../../notifications/setup';
import * as messaging from '@react-native-firebase/messaging';
import * as notifications from 'expo-notifications';
import { resetInstallationIdForTests } from '../../../lib/installationId';
import { awarenessStorageKey, parseAwarenessCache } from '../../../lib/deviceSettings/awarenessStore';
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
 * So the claims here are acceptance criteria phrased as app behaviour: signing
 * in registers this phone, signing out deletes its device document before the
 * credential goes — and a tap on a reminder writes the awareness record, from
 * the live listener and from the cold start that a force-quit produces.
 *
 * That last one is the one this file was missing. The store round-trips and
 * the engine honours a record written before the launch, both proved
 * elsewhere; neither proves that a *tap* ever writes one. Deleting the
 * `markAware` call left this suite green, which means #196's headline promise
 * — tap, force-quit, relaunch, no follow-up — was resting on a reading of the
 * file. It is not any more.
 */

const USER: AuthUser = {
  uid: 'mount-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

let client: QueryClient;
let repository: FakeAuthRepository;

function SignOutButton() {
  const { signOut } = useAuth();
  return (
    <>
      <Text testID="sign-out" onPress={() => void signOut({ reason: 'user' })}>out</Text>
      <Text testID="sign-out-expired" onPress={() => void signOut({ reason: 'session_expired' })}>
        expired
      </Text>
    </>
  );
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
  jest.spyOn(messaging, 'deleteToken').mockResolvedValue(undefined as never);
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

/*
 * ── The token has to die on *every* sign-out ─────────────────────
 *
 * The installation id deliberately survives sign-out, and the FCM token is
 * issued to the *installation*, not to the account. So a session that ends
 * without deleting the token leaves `users/alice/devices/{id}` pointing at a
 * token that is still live on that handset — and when Bob signs in on the same
 * phone, every push addressed to Alice lands on Bob's screen carrying Alice's
 * `commitmentId`, and the tap deep-links Bob's app at Alice's commitment.
 *
 * Only `reason === 'user'` ran the teardown, which is the one reason that
 * *cannot* be the abandoned-phone case. `session_expired` — the reason a phone
 * left in a drawer for a month signs out with — skipped it entirely.
 *
 * The fix is local and deliberately not server-side. Deleting the token at FCM
 * needs no credential, works on every reason, and makes the stale row reap
 * itself on the next push (`registration-token-not-registered`). Evicting the
 * token from other uids at registration time would also close it and would
 * hand every authenticated caller a denial-of-notifications primitive:
 * `parseDeviceRegistration` validates a token's *shape* and can never validate
 * that the caller owns it, so Bob could unregister Alice by posting her token.
 */
describe('signing out, by every route a session can end', () => {
  it('deletes the FCM token even when the session expired rather than ended', async () => {
    const view = await mount();
    await waitFor(() => expect(deviceEndpoints.registerDevice).toHaveBeenCalledTimes(1));

    await act(async () => {
      view.getByTestId('sign-out-expired').props.onPress();
    });

    // The token is gone from FCM, so Alice's row is unreachable and reaps
    // itself, and Bob's sign-in mints a fresh token of his own.
    await waitFor(() => expect(messaging.deleteToken).toHaveBeenCalledTimes(1));
    // And the server DELETE is not attempted: the credential is already
    // refused, so the call could only ever 401.
    expect(deviceEndpoints.forgetDevice).not.toHaveBeenCalled();
    expect(repository.signOutReasons).toEqual(['session_expired']);
  });

  it('deletes the token when the account was revoked, which cannot call DELETE at all', async () => {
    await mount();
    await waitFor(() => expect(deviceEndpoints.registerDevice).toHaveBeenCalledTimes(1));

    // `signOutForbidden` goes straight to the repository, the way a 403 on any
    // request does — it never passes through `AuthProvider.signOut`.
    await act(async () => {
      await signOutForbidden('revoked');
    });

    await waitFor(() => expect(messaging.deleteToken).toHaveBeenCalledTimes(1));
    expect(deviceEndpoints.forgetDevice).not.toHaveBeenCalled();
  });

  it('deletes the row and then the token when the user pressed sign out', async () => {
    const view = await mount();
    await waitFor(() => expect(deviceEndpoints.registerDevice).toHaveBeenCalledTimes(1));

    await act(async () => {
      view.getByTestId('sign-out').props.onPress();
    });

    await waitFor(() => expect(deviceEndpoints.forgetDevice).toHaveBeenCalledTimes(1));
    expect(messaging.deleteToken).toHaveBeenCalledTimes(1);
  });

  it('forgets this account s awareness however the session ended', async () => {
    const view = await mount();
    await waitFor(() => expect(commitmentEndpoints.listToday).toHaveBeenCalled());
    await AsyncStorage.setItem(
      awarenessStorageKey(USER.uid),
      JSON.stringify({ version: 1, entries: { c1: { at: '2026-09-15T00:00:00.000Z', startFingerprint: 'x' } } }),
    );

    await act(async () => {
      view.getByTestId('sign-out-expired').props.onPress();
    });

    await waitFor(async () => {
      expect(await AsyncStorage.getItem(awarenessStorageKey(USER.uid))).toBeNull();
    });
  });
});

/** One tap, as expo-notifications delivers it. */
function response(data: Record<string, unknown>) {
  return { notification: { request: { content: { data } } } } as never;
}

/** The record this account holds on disk, as the engine would read it. */
async function storedAwareness() {
  return parseAwarenessCache(await AsyncStorage.getItem(awarenessStorageKey(USER.uid)));
}

describe('tapping a reminder is the "I know" gesture', () => {
  it('writes the awareness record, fingerprinted with the start the app knows', async () => {
    let tapped: ((value: unknown) => void) | undefined;
    jest.spyOn(notifications, 'addNotificationResponseReceivedListener')
      .mockImplementation(handler => {
        tapped = handler as unknown as (value: unknown) => void;
        return { remove: () => {} } as never;
      });

    await mount();
    await waitFor(() => expect(tapped).toBeDefined());
    // The commitment has to have loaded, or the fingerprint would be written
    // as null and the test would pass on a record that silences nothing.
    await waitFor(() => expect(commitmentEndpoints.listToday).toHaveBeenCalled());

    await act(async () => {
      tapped?.(response({ commitmentId: commitment.id, stage: 'soft', notificationId: `${commitment.id}:soft` }));
    });

    await waitFor(async () => {
      const cache = await storedAwareness();
      expect(cache.entries[commitment.id]).toEqual({
        at: expect.any(String),
        // The start as the app currently understands it. A record fingerprinted
        // with anything else would be discarded by `isAware` on the next sync,
        // and the follow-up would come back — which is the defect #196 exists
        // to fix, wearing a green test.
        startFingerprint: commitment.timeSpec.dueAt,
      });
    });
  });

  it('writes it for the tap that launched the app, which is the force-quit case', async () => {
    // The live listener was not installed when this tap happened: the process
    // did not exist. `getLastNotificationResponseAsync` is the only way that
    // tap is ever seen, and #196's second acceptance criterion is exactly it.
    jest.spyOn(notifications, 'getLastNotificationResponseAsync')
      .mockResolvedValue(response({ commitmentId: commitment.id, stage: 'soft' }));

    await mount();

    await waitFor(async () => {
      const cache = await storedAwareness();
      expect(cache.entries[commitment.id]?.startFingerprint).toBe(commitment.timeSpec.dueAt);
    });
  });

  it('records nothing for a payload that names no commitment', async () => {
    let tapped: ((value: unknown) => void) | undefined;
    jest.spyOn(notifications, 'addNotificationResponseReceivedListener')
      .mockImplementation(handler => {
        tapped = handler as unknown as (value: unknown) => void;
        return { remove: () => {} } as never;
      });

    await mount();
    await waitFor(() => expect(tapped).toBeDefined());
    await act(async () => {
      tapped?.(response({ kind: 'plan_ready', planDate: '2026-09-16' }));
    });

    // A plan push opens Today. Marking a commitment aware off a payload that
    // names none would silence something the user never acknowledged.
    expect(Object.keys((await storedAwareness()).entries)).toEqual([]);
  });
});
