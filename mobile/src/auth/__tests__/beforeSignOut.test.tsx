import React from 'react';
import { afterEach, describe, expect, it } from '@jest/globals';
import { act, render } from '@testing-library/react-native';
import { Text } from 'react-native';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider, useAuth } from '../AuthProvider';
import { createFakeAuthRepository, type FakeAuthRepository } from '../fakeAuthRepository';
import { onBeforeSignOut, resetBeforeSignOutForTests, runBeforeSignOut } from '../beforeSignOut';
import type { AuthUser } from '../types';

/**
 * The work that only a live session can do, done while there still is one
 * (UC-3.0b, #184).
 *
 * Deleting this account's `users/{uid}/devices/{installationId}` is the task,
 * and it is the acceptance criterion "signing out deletes the device
 * document". `pushRegistration.test.ts` proves `deregisterDeviceForPush`
 * deletes the row before the token; nothing there proves anybody *calls* it.
 * This does — and it fails if the `runBeforeSignOut` line is taken out of
 * `AuthProvider`, or if it is moved after `repo.signOut`.
 */

const USER: AuthUser = {
  uid: 'signing-out', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

afterEach(() => resetBeforeSignOutForTests());

/** Records the order of everything, including the repository's own sign-out. */
function recordingRepository(order: string[]): FakeAuthRepository {
  const repository = createFakeAuthRepository({ initialUser: USER });
  const signOut = repository.signOut.bind(repository);
  repository.signOut = async options => {
    order.push('repo.signOut');
    return signOut(options);
  };
  return repository;
}

function Harness({ reason }: { reason: 'user' | 'session_expired' | undefined }) {
  const { signOut } = useAuth();
  return (
    <Text
      testID="sign-out"
      onPress={() => void signOut(reason ? { reason } : undefined)}
    >
      out
    </Text>
  );
}

async function signOutThrough(order: string[], reason?: 'user' | 'session_expired') {
  const repository = recordingRepository(order);
  const view = await render(
    <AppProvider>
      <AuthProvider repository={repository} isDevBundle={false}>
        <Harness reason={reason} />
      </AuthProvider>
    </AppProvider>,
  );
  await act(async () => {
    view.getByTestId('sign-out').props.onPress();
  });
  return repository;
}

describe('before a sign-out', () => {
  it('runs registered work before the credential is gone', async () => {
    const order: string[] = [];
    onBeforeSignOut(async () => {
      order.push('delete device row');
    });

    await signOutThrough(order);

    // The whole point: after `repo.signOut` there is no token, and a DELETE on
    // the device row needs one.
    expect(order).toEqual(['delete device row', 'repo.signOut']);
  });

  it('does not run it when the session is already gone', async () => {
    const order: string[] = [];
    onBeforeSignOut(async () => {
      order.push('delete device row');
    });

    // `session_expired`, `revoked` and `deleted` all mean the token is already
    // refused, so the DELETE would fail — and the user is being signed out
    // whether or not it could.
    await signOutThrough(order, 'session_expired');

    expect(order).toEqual(['repo.signOut']);
  });

  it('signs the user out even when the work throws', async () => {
    const order: string[] = [];
    onBeforeSignOut(async () => {
      throw new Error('offline');
    });

    const repository = await signOutThrough(order);

    expect(order).toEqual(['repo.signOut']);
    expect(repository.signOutReasons).toEqual(['user']);
  });

  it('forgets a task once its owner unmounts', async () => {
    const order: string[] = [];
    const unsubscribe = onBeforeSignOut(async () => {
      order.push('stale');
    });
    unsubscribe();
    await runBeforeSignOut('user');
    expect(order).toEqual([]);
  });
});
