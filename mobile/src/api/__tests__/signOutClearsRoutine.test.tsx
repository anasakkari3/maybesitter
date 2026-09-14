/**
 * Signing out leaves none of the account's routine on the device (#148).
 *
 * `ApiProvider` already clears the query cache on a uid change, "so a
 * signed-out device holds nothing in memory either". The disk copy was not in
 * that sentence: `clearRoutineCache` existed and every caller of it was a
 * test. The 2026-09-14 audit found the consequence — A's sleep and focus hours
 * were still on disk when B signed in, and the survey showed them to B.
 */
import React from 'react';
import { Text } from 'react-native';
import { beforeEach, describe, expect, it } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, waitFor } from '@testing-library/react-native';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { createAppQueryClient } from '../queryClient';
import { ApiProvider } from '../ui/ApiProvider';
import { EMPTY_CACHE, routineStorageKey, saveRoutineCache } from '../../lib/deviceSettings/routineCache';

const ALICE = {
  uid: 'account-a',
  email: 'a@example.com',
  emailVerified: true,
  displayName: null,
  providerIds: ['password'],
};

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('signing out', () => {
  it('removes the routine answers the account left on this device', async () => {
    const repository = createFakeAuthRepository({ initialUser: ALICE });
    await saveRoutineCache('account-a', { ...EMPTY_CACHE, updatedAt: '2026-09-13T09:00:00.000Z' });

    await render(
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <ApiProvider client={createAppQueryClient()}>
            <Text>signed in</Text>
          </ApiProvider>
        </AuthProvider>
      </AppProvider>,
    );

    // Still there while that account is the one signed in.
    expect(await AsyncStorage.getItem(routineStorageKey('account-a'))).not.toBeNull();

    await repository.signOut();

    await waitFor(async () => {
      expect(await AsyncStorage.getItem(routineStorageKey('account-a'))).toBeNull();
    });
  });
});
