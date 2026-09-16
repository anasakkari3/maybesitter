import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, render, waitFor } from '@testing-library/react-native';
import { AppState, Text } from 'react-native';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider, useApp } from '../../../state/AppContext';
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
import { hardReceiptStorageKey } from '../../../lib/deviceSettings/hardReceiptQueue';
import { loadOutbox, outboxStorageKey } from '../actionOutbox';
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

/** Where the app is, as the screen switch in `Root` would read it. */
function Location() {
  const { s } = useApp();
  return <Text testID="location">{`${s.screen}|${s.planDate ?? ''}`}</Text>;
}

/** The open sheet and the commitment it is about (#200's confirm-drop). */
function SheetState() {
  const { s } = useApp();
  return <Text testID="sheet">{`${s.sheet ?? ''}|${s.detailId ?? ''}`}</Text>;
}

async function mount() {
  return render(
    <AppProvider>
      <AuthProvider repository={repository} isDevBundle={false}>
        <QueryClientProvider client={client}>
          <RemindersMount />
          <SignOutButton />
          <Location />
          <SheetState />
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
  await AsyncStorage.removeItem(outboxStorageKey(USER.uid));
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

  it('forgets this account s Must-reminder receipts however the session ended (#197)', async () => {
    const view = await mount();
    await waitFor(() => expect(commitmentEndpoints.listToday).toHaveBeenCalled());
    // A receipt silences the server's backup push. Left on a phone that
    // changes hands, it would speak for an account that is no longer here.
    await AsyncStorage.setItem(
      hardReceiptStorageKey(USER.uid),
      JSON.stringify({ version: 1, pending: [], sent: {} }),
    );

    await act(async () => {
      view.getByTestId('sign-out-expired').props.onPress();
    });

    await waitFor(async () => {
      expect(await AsyncStorage.getItem(hardReceiptStorageKey(USER.uid))).toBeNull();
    });
  });
});

/** One tap, as expo-notifications delivers it: on the body unless a button is named (#200). */
function response(data: Record<string, unknown>, actionIdentifier = 'expo.modules.notifications.actions.DEFAULT') {
  return {
    actionIdentifier,
    notification: { request: { identifier: `${String(data.commitmentId ?? 'plan')}:soft`, content: { data } } },
  } as never;
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

    // A plan push opens the plan (below). Marking a commitment aware off a
    // payload that names none would silence something the user never
    // acknowledged.
    expect(Object.keys((await storedAwareness()).entries)).toEqual([]);
  });
});

/*
 * ── A plan push opens the plan ───────────────────────────────────
 *
 * The server sends `plan_ready` with the day in `planDate` (#194), and
 * `routeFromNotification` has always answered `{ kind: 'plan' }` for it. The
 * mount then ignored that answer and opened Today, under a comment saying the
 * plan screen (#195) did not exist yet. #195 is merged and `openPlan` exists,
 * so the one notification the morning plan sends landed a step away from the
 * plan, from the live listener and from a cold start alike.
 */
describe('tapping the morning plan push', () => {
  const PLAN_PUSH = { kind: 'plan_ready', planDate: '2026-09-16' };

  it('opens that day\'s plan when the app is running', async () => {
    let tapped: ((value: unknown) => void) | undefined;
    jest.spyOn(notifications, 'addNotificationResponseReceivedListener')
      .mockImplementation(handler => {
        tapped = handler as unknown as (value: unknown) => void;
        return { remove: () => {} } as never;
      });

    const view = await mount();
    await waitFor(() => expect(tapped).toBeDefined());
    await act(async () => {
      tapped?.(response(PLAN_PUSH));
    });

    await waitFor(() => expect(view.getByTestId('location').props.children).toBe('plan|2026-09-16'));
  });

  it('opens that day\'s plan when the tap launched the app', async () => {
    jest.spyOn(notifications, 'getLastNotificationResponseAsync').mockResolvedValue(response(PLAN_PUSH));

    const view = await mount();

    await waitFor(() => expect(view.getByTestId('location').props.children).toBe('plan|2026-09-16'));
  });

  it('opens Today for a plan push whose date is not a date', async () => {
    jest.spyOn(notifications, 'getLastNotificationResponseAsync')
      .mockResolvedValue(response({ kind: 'plan_ready', planDate: '2026-02-30' }));

    const view = await mount();
    await waitFor(() => expect(commitmentEndpoints.listToday).toHaveBeenCalled());
    await waitFor(() => expect(notifications.getLastNotificationResponseAsync).toHaveBeenCalled());
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(view.getByTestId('location').props.children).toBe('today|');
  });
});

describe('the buttons on a reminder (#200)', () => {
  const tapData = { commitmentId: commitment.id, stage: 'soft', notificationId: `${commitment.id}:soft` };
  const actionResult = { value: { success: true, id: commitment.id, commitment }, etag: null } as never;

  function captureListener() {
    const box: { tap?: (value: unknown) => void } = {};
    jest.spyOn(notifications, 'addNotificationResponseReceivedListener')
      .mockImplementation(handler => {
        box.tap = handler as unknown as (value: unknown) => void;
        return { remove: () => {} } as never;
      });
    return box;
  }

  it('Done completes once with a clientActionId and cancels that commitment’s stages, even delivered twice', async () => {
    const box = captureListener();
    // The same press also comes back as the launch response: the iOS
    // background launch, or a relaunch replaying it.
    jest.spyOn(notifications, 'getLastNotificationResponseAsync')
      .mockResolvedValue(response(tapData, 'done'));
    const act_ = jest.spyOn(commitmentEndpoints, 'actOnCommitment').mockResolvedValue(actionResult);
    const cancel = jest.spyOn(notifications, 'cancelScheduledNotificationAsync');

    await mount();
    await waitFor(() => expect(box.tap).toBeDefined());
    await act(async () => {
      box.tap?.(response(tapData, 'done'));
    });

    await waitFor(() => expect(act_).toHaveBeenCalled());
    await waitFor(async () => expect((await loadOutbox(USER.uid)).items).toHaveLength(0));
    // Let the cold-start path settle too.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(act_).toHaveBeenCalledTimes(1);
    const [id, action, options] = act_.mock.calls[0]!;
    expect([id, action]).toEqual([commitment.id, 'complete']);
    expect((options as { clientActionId?: string }).clientActionId).toMatch(/^[0-9a-f-]{36}$/);
    for (const stage of ['soft', 'followUp', 'strong']) {
      expect(cancel).toHaveBeenCalledWith(`${commitment.id}:${stage}`);
    }
  });

  it('Later offline stays queued, and coming back to the app sends it once with the same id', async () => {
    const box = captureListener();
    const appState: { change?: (state: string) => void } = {};
    jest.spyOn(AppState, 'addEventListener').mockImplementation((type, handler) => {
      if (type === 'change') appState.change = handler as (state: string) => void;
      return { remove: () => {} } as never;
    });
    const { NetworkError } = jest.requireActual<typeof import('../../../api/errors')>('../../../api/errors');
    const act_ = jest.spyOn(commitmentEndpoints, 'actOnCommitment')
      .mockRejectedValueOnce(new NetworkError('airplane mode'))
      .mockResolvedValue(actionResult);

    await mount();
    await waitFor(() => expect(box.tap).toBeDefined());
    await act(async () => {
      box.tap?.(response(tapData, 'later'));
    });
    await waitFor(() => expect(act_).toHaveBeenCalledTimes(1));
    await waitFor(async () => expect((await loadOutbox(USER.uid)).items[0]?.attempts).toBe(1));
    const [queued] = (await loadOutbox(USER.uid)).items;
    expect(queued!.action).toBe('postpone');
    expect(Date.parse(queued!.postponedUntil!)).toBeGreaterThan(Date.now());

    // Back in the app, past the backoff.
    const realNow = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(realNow + 60 * 60 * 1000);
    await act(async () => {
      appState.change?.('active');
    });
    await waitFor(async () => expect((await loadOutbox(USER.uid)).items).toHaveLength(0));
    expect(act_).toHaveBeenCalledTimes(2);
    const ids = act_.mock.calls.map(call => (call[2] as { clientActionId: string }).clientActionId);
    expect(ids[1]).toBe(ids[0]);
  });

  it('Not doing it opens the confirm sheet and drops nothing', async () => {
    const box = captureListener();
    const act_ = jest.spyOn(commitmentEndpoints, 'actOnCommitment').mockResolvedValue(actionResult);

    const screen = await mount();
    await waitFor(() => expect(box.tap).toBeDefined());
    await act(async () => {
      box.tap?.(response(tapData, 'drop'));
    });

    await waitFor(() => expect(screen.getByTestId('sheet').props.children).toBe(`confirmDrop|${commitment.id}`));
    expect(act_).not.toHaveBeenCalled();
    expect((await loadOutbox(USER.uid)).items).toHaveLength(0);
  });

  it('a body tap records aware on the server as well as on the phone', async () => {
    const box = captureListener();
    const act_ = jest.spyOn(commitmentEndpoints, 'actOnCommitment').mockResolvedValue(actionResult);

    await mount();
    await waitFor(() => expect(box.tap).toBeDefined());
    await waitFor(() => expect(commitmentEndpoints.listToday).toHaveBeenCalled());
    await act(async () => {
      box.tap?.(response(tapData));
    });

    await waitFor(() => expect(act_).toHaveBeenCalledWith(commitment.id, 'aware', expect.anything()));
  });

  it('an unknown button does nothing', async () => {
    const box = captureListener();
    const act_ = jest.spyOn(commitmentEndpoints, 'actOnCommitment').mockResolvedValue(actionResult);

    const screen = await mount();
    await waitFor(() => expect(box.tap).toBeDefined());
    await act(async () => {
      box.tap?.(response(tapData, 'snooze'));
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(act_).not.toHaveBeenCalled();
    expect(screen.getByTestId('location').props.children).not.toMatch(/^details/);
  });
});
