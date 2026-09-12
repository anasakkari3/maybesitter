import React from 'react';
import { describe, expect, it } from '@jest/globals';
import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../state/AppContext';
import { AuthGate } from '../AuthGate';
import { AuthProvider } from '../AuthProvider';
import { createFakeAuthRepository, type FakeAuthRepository } from '../fakeAuthRepository';
import type { AuthUser } from '../types';
import en from '../../i18n/locales/en.json';

// The gate is the whole of UC-1.7's safety claim: while nobody is signed in,
// nothing but sign-in is reachable. These tests drive the same repository the
// app uses, with the network removed, so "signed in" here means exactly what
// it means on a device.

const USER: AuthUser = {
  uid: 'u1',
  email: 'someone@example.com',
  emailVerified: true,
  displayName: null,
  providerIds: ['password'],
};

/** Insets a test can rely on: SafeAreaProvider never measures under Jest. */
const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

// RNTL v14's render() is asynchronous — it resolves to the query object.
async function renderGate(repository: FakeAuthRepository) {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <AuthGate>
            <Text>THE APP</Text>
          </AuthGate>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

describe('auth gate', () => {
  it('holds on a blank screen until Firebase has answered', async () => {
    // No initialUser at all: the repository has not resolved yet.
    await renderGate(createFakeAuthRepository());
    expect(screen.getByTestId('auth-loading')).toBeTruthy();
    expect(screen.queryByText('THE APP')).toBeNull();
    expect(screen.queryByText(en.authTitle)).toBeNull();
  });

  it('shows sign-in, and not the app, when nobody is signed in', async () => {
    await renderGate(createFakeAuthRepository({ initialUser: null }));
    expect(screen.getByText(en.authTitle)).toBeTruthy();
    expect(screen.queryByText('THE APP')).toBeNull();
  });

  it('shows the app once a user arrives', async () => {
    const repository = createFakeAuthRepository({ initialUser: null });
    await renderGate(repository);
    await act(async () => repository.emit(USER));
    expect(screen.getByText('THE APP')).toBeTruthy();
    expect(screen.queryByText(en.authTitle)).toBeNull();
  });

  it('returns to sign-in after a sign-out', async () => {
    const repository = createFakeAuthRepository({ initialUser: USER });
    await renderGate(repository);
    expect(screen.getByText('THE APP')).toBeTruthy();
    await act(async () => {
      await repository.signOut({ reason: 'user' });
    });
    expect(screen.getByText(en.authTitle)).toBeTruthy();
    expect(screen.queryByText('THE APP')).toBeNull();
  });

  it('shows "please sign in again" only after an expired session', async () => {
    const repository = createFakeAuthRepository({ initialUser: USER });
    await renderGate(repository);
    expect(screen.queryByText(en.authSessionExpired)).toBeNull();
    await act(async () => {
      await repository.signOut({ reason: 'session_expired' });
    });
    expect(screen.getByText(en.authSessionExpired)).toBeTruthy();
  });

  it('does not carry the expired notice into a fresh launch', async () => {
    // A new render is a new process as far as the provider is concerned: the
    // reason is useState, so there is nothing to carry.
    await renderGate(createFakeAuthRepository({ initialUser: null }));
    expect(screen.queryByText(en.authSessionExpired)).toBeNull();
  });

  it('names a revoked and a deleted account rather than "signed out"', async () => {
    const repository = createFakeAuthRepository({ initialUser: USER });
    await renderGate(repository);
    await act(async () => {
      await repository.signOut({ reason: 'revoked' });
    });
    expect(screen.getByText(en.authSignedOutRevoked)).toBeTruthy();
  });

  it('never renders a pilot token field', async () => {
    await renderGate(createFakeAuthRepository({ initialUser: null }));
    expect(screen.queryByText(/pilot/i)).toBeNull();
    expect(screen.queryByText(/رمز التجربة/)).toBeNull();
  });
});
