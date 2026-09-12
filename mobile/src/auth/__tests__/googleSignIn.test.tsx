import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../AuthProvider';
import { GoogleSignInButton } from '../GoogleSignInButton';
import { createFakeAuthRepository, type FakeAuthRepository } from '../fakeAuthRepository';
import { GoogleSignInCancelled, GoogleSignInUnavailable } from '../googleSignIn';
import en from '../../i18n/locales/en.json';

/**
 * UC-1.2 (#146)'s code side, without the Google SDK.
 *
 * The two behaviours worth protecting are both about *not* showing an error:
 * a user who backs out of the account chooser did nothing wrong, and a build
 * with no Web Client ID must hide the button rather than offer one that can
 * only fail with `DEVELOPER_ERROR`.
 */

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const WEB_CLIENT_ID = '955684917741-example.apps.googleusercontent.com';
const ORIGINAL = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;

let repository: FakeAuthRepository;

beforeEach(() => {
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = WEB_CLIENT_ID;
  repository = createFakeAuthRepository({ initialUser: null });
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  else process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = ORIGINAL;
  jest.restoreAllMocks();
});

async function renderButton() {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <GoogleSignInButton />
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

describe('the Google button', () => {
  it('signs in through the repository', async () => {
    await renderButton();
    await fireEvent.press(screen.getByLabelText(en.authContinueGoogle));
    expect(repository.calls).toEqual([{ method: 'signInWithGoogle' }]);
    expect(repository.currentUser()?.providerIds).toEqual(['google.com']);
  });

  it('shows nothing at all when the user backs out of the chooser', async () => {
    repository.cancelNextGoogle();
    await renderButton();
    await fireEvent.press(screen.getByLabelText(en.authContinueGoogle));
    expect(repository.currentUser()).toBeNull();
    // No error, no toast, no state change. The screen is as it was.
    expect(screen.queryByText(en.authErrorGeneric)).toBeNull();
    expect(screen.queryByText(en.authErrorNoPlayServices)).toBeNull();
  });

  it('treats a cancellation thrown from the SDK the same way', async () => {
    repository.failNext('signInWithGoogle', new GoogleSignInCancelled());
    await renderButton();
    await fireEvent.press(screen.getByLabelText(en.authContinueGoogle));
    expect(screen.queryByText(en.authErrorGeneric)).toBeNull();
  });

  it('points a device without Play services at email', async () => {
    repository.failNext('signInWithGoogle', new GoogleSignInUnavailable('playServices'));
    await renderButton();
    await fireEvent.press(screen.getByLabelText(en.authContinueGoogle));
    expect(screen.getByText(en.authErrorNoPlayServices)).toBeTruthy();
  });

  it('says nothing specific about a missing SHA fingerprint, which the user cannot fix', async () => {
    repository.failNext('signInWithGoogle', new GoogleSignInUnavailable('misconfigured'));
    await renderButton();
    await fireEvent.press(screen.getByLabelText(en.authContinueGoogle));
    expect(screen.getByText(en.authErrorGeneric)).toBeTruthy();
    expect(screen.queryByText(/SHA|fingerprint|DEVELOPER_ERROR/i)).toBeNull();
  });

  it('maps a Firebase credential failure through the shared error table', async () => {
    repository.failNext(
      'signInWithGoogle',
      Object.assign(new Error('x'), { code: 'auth/network-request-failed' }),
    );
    await renderButton();
    await fireEvent.press(screen.getByLabelText(en.authContinueGoogle));
    expect(screen.getByText(en.authErrorNetwork)).toBeTruthy();
  });

  it('hides itself in a build with no Web Client ID', async () => {
    delete process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
    await renderButton();
    // A button that can only answer DEVELOPER_ERROR is worse than no button.
    expect(screen.queryByLabelText(en.authContinueGoogle)).toBeNull();
  });

});
