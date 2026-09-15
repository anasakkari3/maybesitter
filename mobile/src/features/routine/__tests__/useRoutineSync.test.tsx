/**
 * The retry the routine sync promises, actually happening (UC-2.7a, #167 step 5).
 *
 * ── What was wrong ───────────────────────────────────────────────
 *
 * The hook read `onlineManager.isOnline()` inside its effect. Reading is not
 * subscribing: reconnecting changed nothing the effect depended on, so it
 * never re-ran, so "the next foreground-while-online tries again" could not
 * happen without a remount — and the hook mounted on exactly one settings
 * screen. A survey answered offline during onboarding therefore stayed unsent
 * until the user went looking for it.
 *
 * ── What is asserted ─────────────────────────────────────────────
 *
 * The request. `pendingSync` on screen is a description of the phone's state;
 * the thing the user is waiting for is `PUT /api/mobile/profile/routine`, so
 * that is what these count.
 *
 * Nothing here depends on a wall clock or a date literal: the local copy is
 * `pendingSync`, which wins over the server's copy by definition, so no
 * comparison of times is involved (#382).
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Text } from 'react-native';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { NetworkError, NotFoundError } from '../../../api/errors';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import type { AuthUser } from '../../../auth/types';
import { ROUTINE_CACHE_VERSION, routineStorageKey } from '../../../lib/deviceSettings/routineCache';
import { useRoutineSync } from '../useRoutineSync';

import * as profileEndpoints from '../../../api/endpoints/profile';

const USER: AuthUser = {
  uid: 'routine-sync-user',
  email: 'someone@example.com',
  emailVerified: true,
  displayName: null,
  providerIds: ['password'],
};

/** Answers given on this phone that the account has never seen. */
const UNSENT = {
  version: ROUTINE_CACHE_VERSION,
  answers: { sleep: 'standard', focus: 'workday', fixed: 'none', reminder: 'soft', quiet: 'standard' },
  skipped: false,
  // Any instant at all: `pendingSync` decides this case, not a comparison.
  updatedAt: '2026-01-01T00:00:00.000Z',
  pendingSync: true,
  timezone: 'Asia/Jerusalem',
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;
let putRoutine: jest.SpiedFunction<typeof profileEndpoints.putRoutine>;

beforeEach(async () => {
  await AsyncStorage.clear();
  await AsyncStorage.setItem(routineStorageKey(USER.uid), JSON.stringify(UNSENT));
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  // The account has never answered, so there is nothing to adopt and the
  // device's copy is the only one.
  jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue({ routine: null } as never);
  putRoutine = jest.spyOn(profileEndpoints, 'putRoutine').mockResolvedValue({} as never);
});

afterEach(async () => {
  cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  onlineManager.setOnline(true);
  await AsyncStorage.clear();
});

/** Renders the hook and nothing else, reporting what it says. */
function Probe() {
  const sync = useRoutineSync();
  return (
    <Text testID="probe">
      {JSON.stringify({
        loading: sync.loading,
        pendingSync: sync.pendingSync,
        localSaveFailed: sync.localSaveFailed,
      })}
    </Text>
  );
}

async function mount() {
  await render(
    <AuthProvider repository={repository} isDevBundle={false}>
      <QueryClientProvider client={client}><Probe /></QueryClientProvider>
    </AuthProvider>,
  );
  await waitFor(() => expect(state().loading).toBe(false));
}

function state(): { loading: boolean; pendingSync: boolean; localSaveFailed: boolean } {
  return JSON.parse(screen.getByTestId('probe').props.children as string);
}

/** Connectivity as the device reports it, flushed the way React needs. */
async function setOnline(value: boolean) {
  await act(async () => { onlineManager.setOnline(value); });
}

describe('coming back online', () => {
  it('sends the answers that were given offline, with nothing else to wake it', async () => {
    /*
     * The profile query is deliberately made to produce nothing here.
     *
     * A shape this test had first — an offline mount with a profile that
     * loads on reconnect — passed against the unfixed hook, because the query
     * react-query had paused while offline resumed, delivered data, and *that*
     * re-ran the effect. The reconnection was never what woke it, so the test
     * proved nothing about the subscription it was named for.
     *
     * A 404 is the documented state of this route when the memory feature is
     * off (`src/api/endpoints/profile.ts`). `data` then stays `undefined`
     * across the reconnection, so the only thing that can re-run the effect is
     * the online state itself.
     */
    jest.spyOn(profileEndpoints, 'getProfile').mockRejectedValue(new NotFoundError('feature off'));
    await setOnline(false);
    await mount();

    // Offline is `idle` on purpose: there is no server copy worth trusting.
    expect(putRoutine).not.toHaveBeenCalled();
    expect(state().pendingSync).toBe(true);

    await setOnline(true);

    // The whole claim. Nothing remounted, nothing came to the foreground, and
    // the user did not open Settings.
    await waitFor(() => expect(putRoutine).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(state().pendingSync).toBe(false));
  });

  it('tries again after a push that failed, once per reconnection', async () => {
    putRoutine.mockRejectedValueOnce(new NetworkError('no signal'));
    await mount();

    await waitFor(() => expect(putRoutine).toHaveBeenCalledTimes(1));
    // Left pending, and latched: nothing loops while the connection is bad.
    await waitFor(() => expect(state().pendingSync).toBe(true));
    expect(putRoutine).toHaveBeenCalledTimes(1);

    await setOnline(false);
    await setOnline(true);

    await waitFor(() => expect(putRoutine).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(state().pendingSync).toBe(false));

    // And the latch still holds afterwards: a success is never repeated.
    await setOnline(false);
    await setOnline(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(putRoutine).toHaveBeenCalledTimes(2);
  });
});

describe('a phone that will not keep the copy', () => {
  it('says so instead of dropping the answer on the floor', async () => {
    // `saveRoutineCache` has always reported this and every caller threw it
    // away, so an unwritable disk looked exactly like a disk that had saved.
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValue(new Error('no space'));
    await mount();

    await waitFor(() => expect(putRoutine).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(state().localSaveFailed).toBe(true));
  });
});
