/**
 * A link that arrives while nothing handles links is held, wherever the person
 * is — on the sign-in screen or in onboarding (C13.2).
 *
 * `Root` owns link handling and mounts only for a signed-in, onboarded user.
 * The provider used to hold a link only while signed out, so a widget tap or
 * a `maybesitter://commitments/<id>` during onboarding was dropped: after the
 * last step the app landed on Today (seen on the simulator).
 *
 * The held link belongs to the session that received it: a sign-out clears
 * it, and once a handler is attached nothing is held, so it is never replayed
 * on a later mount.
 */
import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, render } from '@testing-library/react-native';
import { Linking, Text } from 'react-native';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider, useAuth, type AuthModel } from '../AuthProvider';
import { createFakeAuthRepository } from '../fakeAuthRepository';
import type { AuthUser } from '../types';

const USER: AuthUser = {
  uid: 'onboarding-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

afterEach(() => jest.restoreAllMocks());

function captureLinkListeners() {
  const listeners = new Set<(event: { url: string }) => void>();
  jest.spyOn(Linking, 'addEventListener').mockImplementation(((_type: string, listener: (event: { url: string }) => void) => {
    listeners.add(listener);
    return { remove: () => listeners.delete(listener) };
  }) as never);
  return (url: string) => act(async () => { for (const l of [...listeners]) l({ url }); });
}

async function mount() {
  const fire = captureLinkListeners();
  const repository = createFakeAuthRepository({ initialUser: USER });
  const model: { current: AuthModel | null } = { current: null };
  function Probe() {
    model.current = useAuth();
    return <Text>probe</Text>;
  }
  await render(
    <AppProvider>
      <AuthProvider repository={repository} isDevBundle={false}>
        <Probe />
      </AuthProvider>
    </AppProvider>,
  );
  await act(async () => {});
  return { fire, model, repository };
}

describe('a link while signed in, before Root handles links', () => {
  it('is held for Root, as it is on the sign-in screen', async () => {
    const { fire, model } = await mount();
    await fire('maybesitter://commitments/c-42');
    expect(model.current!.takePendingLink()).toBe('maybesitter://commitments/c-42');
    expect(model.current!.takePendingLink()).toBeNull();
  });

  it('is not held once a handler is attached, so it is never replayed', async () => {
    const { fire, model } = await mount();
    let detach = () => {};
    await act(async () => { detach = model.current!.attachLinkHandler(); });
    await fire('maybesitter://commitments/c-42');
    expect(model.current!.takePendingLink()).toBeNull();
    await act(async () => detach());
    await fire('maybesitter://commitments/c-43');
    expect(model.current!.takePendingLink()).toBe('maybesitter://commitments/c-43');
  });

  it('does not outlive the session that received it', async () => {
    const { fire, model, repository } = await mount();
    await fire('maybesitter://commitments/c-42');
    await act(async () => repository.emit(null));
    expect(model.current!.takePendingLink()).toBeNull();
  });
});
