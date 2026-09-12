import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../AuthProvider';
import { AppleSignInButton } from '../AppleSignInButton';
import { AppleSignInCancelled, AppleSignInUnavailable, requestAppleCredential } from '../appleSignIn';
import { createFakeAuthRepository, type FakeAuthRepository } from '../fakeAuthRepository';
import en from '../../i18n/locales/en.json';

/**
 * UC-1.1 (#145)'s code side.
 *
 * Apple Sign-In cannot be exercised for real here: the capability is not
 * enabled on the App ID, and the Firebase Apple provider is not filled in. So
 * these tests cover the parts that are this app's own — the availability gate,
 * cancellation, and the refusal to do anything at all before the owner has
 * flipped the flag.
 */

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const ORIGINAL = process.env.EXPO_PUBLIC_APPLE_SIGN_IN_ENABLED;

let repository: FakeAuthRepository;

beforeEach(() => {
  repository = createFakeAuthRepository({ initialUser: null });
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.EXPO_PUBLIC_APPLE_SIGN_IN_ENABLED;
  else process.env.EXPO_PUBLIC_APPLE_SIGN_IN_ENABLED = ORIGINAL;
  jest.restoreAllMocks();
});

async function renderButton() {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <AppleSignInButton />
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

describe('the Apple button', () => {
  it('renders nothing until the owner has enabled the provider', async () => {
    delete process.env.EXPO_PUBLIC_APPLE_SIGN_IN_ENABLED;
    await renderButton();
    // `isAvailableAsync()` answers true on any iOS 13+ device regardless of
    // whether the App ID carries the capability, so the flag is what keeps a
    // button that can only fail off the screen.
    expect(screen.queryByLabelText(en.authContinueApple)).toBeNull();
  });

  it('renders nothing on Android, where the web flow is not implemented', async () => {
    process.env.EXPO_PUBLIC_APPLE_SIGN_IN_ENABLED = 'true';
    // jest-expo's default platform is ios; this asserts the platform gate
    // itself rather than the default.
    const { Platform } = require('react-native') as typeof import('react-native');
    const original = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    try {
      await renderButton();
      expect(screen.queryByLabelText(en.authContinueApple)).toBeNull();
    } finally {
      Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
    }
  });

  it('signs in through the repository when it is enabled on iOS', async () => {
    process.env.EXPO_PUBLIC_APPLE_SIGN_IN_ENABLED = 'true';
    const { findByLabelText } = await renderButton();
    // Availability is resolved asynchronously, so the button appears a tick
    // after the first render rather than during it.
    await fireEvent.press(await findByLabelText(en.authContinueApple));
    expect(repository.calls).toEqual([{ method: 'signInWithApple' }]);
    expect(repository.currentUser()?.providerIds).toEqual(['apple.com']);
  });

  it('reports no email for a private-relay account, rather than inventing one', async () => {
    process.env.EXPO_PUBLIC_APPLE_SIGN_IN_ENABLED = 'true';
    const { findByLabelText } = await renderButton();
    await fireEvent.press(await findByLabelText(en.authContinueApple));
    expect(repository.currentUser()?.email).toBeNull();
  });

  it('shows nothing when the user dismisses the sheet', async () => {
    process.env.EXPO_PUBLIC_APPLE_SIGN_IN_ENABLED = 'true';
    repository.cancelNextApple();
    const { findByLabelText } = await renderButton();
    await fireEvent.press(await findByLabelText(en.authContinueApple));
    expect(repository.currentUser()).toBeNull();
    expect(screen.queryByText(en.authErrorGeneric)).toBeNull();
  });

  it('treats a cancellation thrown from the SDK the same way', async () => {
    process.env.EXPO_PUBLIC_APPLE_SIGN_IN_ENABLED = 'true';
    repository.failNext('signInWithApple', new AppleSignInCancelled());
    const { findByLabelText } = await renderButton();
    await fireEvent.press(await findByLabelText(en.authContinueApple));
    expect(screen.queryByText(en.authErrorGeneric)).toBeNull();
  });

  it('points an unsupported platform at the other providers', async () => {
    process.env.EXPO_PUBLIC_APPLE_SIGN_IN_ENABLED = 'true';
    repository.failNext('signInWithApple', new AppleSignInUnavailable('unsupportedPlatform'));
    const { findByLabelText } = await renderButton();
    await fireEvent.press(await findByLabelText(en.authContinueApple));
    expect(screen.getByText(en.authErrorAppleUnavailable)).toBeTruthy();
  });

  it('maps a Firebase credential failure through the shared error table', async () => {
    process.env.EXPO_PUBLIC_APPLE_SIGN_IN_ENABLED = 'true';
    repository.failNext(
      'signInWithApple',
      Object.assign(new Error('x'), { code: 'auth/network-request-failed' }),
    );
    const { findByLabelText } = await renderButton();
    await fireEvent.press(await findByLabelText(en.authContinueApple));
    expect(screen.getByText(en.authErrorNetwork)).toBeTruthy();
  });
});

describe('requesting the credential directly', () => {
  it('refuses before the owner has enabled the provider', async () => {
    delete process.env.EXPO_PUBLIC_APPLE_SIGN_IN_ENABLED;
    await expect(requestAppleCredential()).rejects.toBeInstanceOf(AppleSignInUnavailable);
  });

  it('refuses on a platform with no native sheet', async () => {
    process.env.EXPO_PUBLIC_APPLE_SIGN_IN_ENABLED = 'true';
    const { Platform } = require('react-native') as typeof import('react-native');
    const original = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    try {
      const error = await requestAppleCredential().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppleSignInUnavailable);
      expect((error as AppleSignInUnavailable).kind).toBe('unsupportedPlatform');
    } finally {
      Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
    }
  });
});
