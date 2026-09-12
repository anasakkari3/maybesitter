import React from 'react';
import { describe, expect, it } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../AuthProvider';
import { EmailAuthScreen } from '../../screens/EmailAuthScreen';
import { createFakeAuthRepository, type FakeAuthRepository } from '../fakeAuthRepository';
import { MIN_PASSWORD_LENGTH } from '../validation';
import en from '../../i18n/locales/en.json';

/**
 * UC-1.3 (#147) end to end, without Firebase.
 *
 * The rules these assert are the product's, not the SDK's: a mistyped address
 * never reaches the network, a failed sign-in never says *which* half was
 * wrong, and a reset reports the same thing whether or not the account exists.
 */

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const VALID_PASSWORD = 'correct horse battery';

async function renderEmail(repository: FakeAuthRepository) {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <EmailAuthScreen onBack={() => {}} />
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

// RNTL v14's fireEvent is asynchronous: it returns once React has flushed.
async function type(label: string, value: string) {
  await fireEvent.changeText(screen.getByLabelText(label), value);
}

async function press(label: string) {
  await fireEvent.press(screen.getByLabelText(label));
}

describe('email sign-in', () => {
  it('signs in with an address and a password', async () => {
    const repository = createFakeAuthRepository({ initialUser: null });
    await renderEmail(repository);
    await type(en.authEmailLabel, '  Someone@Example.COM ');
    await type(en.authPasswordLabel, VALID_PASSWORD);
    await press(en.authModeSignIn);
    expect(repository.calls).toEqual([{ method: 'signInWithEmail', email: 'someone@example.com' }]);
  });

  it('refuses a malformed address before any network call', async () => {
    const repository = createFakeAuthRepository({ initialUser: null });
    await renderEmail(repository);
    await type(en.authEmailLabel, 'not-an-email');
    await type(en.authPasswordLabel, VALID_PASSWORD);
    await press(en.authModeSignIn);
    expect(repository.calls).toEqual([]);
    expect(screen.getByText(en.authFieldEmailInvalid)).toBeTruthy();
  });

  it('refuses a short password before any network call', async () => {
    const repository = createFakeAuthRepository({ initialUser: null });
    await renderEmail(repository);
    await type(en.authEmailLabel, 'someone@example.com');
    await type(en.authPasswordLabel, 'short');
    await press(en.authModeSignIn);
    expect(repository.calls).toEqual([]);
    expect(screen.getByText(`Use at least ${MIN_PASSWORD_LENGTH} characters.`)).toBeTruthy();
  });

  it.each([
    'auth/user-not-found',
    'auth/wrong-password',
    'auth/invalid-credential',
  ])('says the same thing for %s, so nobody can enumerate accounts', async code => {
    const repository = createFakeAuthRepository({ initialUser: null });
    repository.failNext('signInWithEmail', Object.assign(new Error('x'), { code }));
    await renderEmail(repository);
    await type(en.authEmailLabel, 'someone@example.com');
    await type(en.authPasswordLabel, VALID_PASSWORD);
    await press(en.authModeSignIn);
    expect(screen.getByText(en.authErrorSignIn)).toBeTruthy();
  });

  it('never renders the SDK error message', async () => {
    const repository = createFakeAuthRepository({ initialUser: null });
    repository.failNext(
      'signInWithEmail',
      Object.assign(new Error('[auth/wrong-password] The password is invalid for someone@example.com'), {
        code: 'auth/wrong-password',
      }),
    );
    await renderEmail(repository);
    await type(en.authEmailLabel, 'someone@example.com');
    await type(en.authPasswordLabel, VALID_PASSWORD);
    await press(en.authModeSignIn);
    expect(screen.queryByText(/\[auth\//)).toBeNull();
    expect(screen.queryByText(/invalid for/)).toBeNull();
  });
});

describe('account creation', () => {
  it('creates an account from the sign-up mode', async () => {
    const repository = createFakeAuthRepository({ initialUser: null });
    await renderEmail(repository);
    await press(en.authSwitchToSignUp);
    await type(en.authEmailLabel, 'new@example.com');
    await type(en.authPasswordLabel, VALID_PASSWORD);
    await press(en.authModeSignUp);
    expect(repository.calls).toEqual([{ method: 'createAccount', email: 'new@example.com' }]);
  });

  it('points a duplicate address at sign-in rather than confirming it exists', async () => {
    const repository = createFakeAuthRepository({ initialUser: null });
    repository.failNext('createAccount', Object.assign(new Error('x'), { code: 'auth/email-already-in-use' }));
    await renderEmail(repository);
    await press(en.authSwitchToSignUp);
    await type(en.authEmailLabel, 'taken@example.com');
    await type(en.authPasswordLabel, VALID_PASSWORD);
    await press(en.authModeSignUp);
    expect(screen.getByText(en.authErrorEmailInUse)).toBeTruthy();
  });
});

describe('password reset', () => {
  it('sends a reset link and answers the same way for any address', async () => {
    const repository = createFakeAuthRepository({ initialUser: null });
    await renderEmail(repository);
    await press(en.authForgotPassword);
    await type(en.authEmailLabel, 'anyone@example.com');
    await press(en.authResetSend);
    expect(repository.calls).toEqual([{ method: 'sendPasswordReset', email: 'anyone@example.com' }]);
    expect(screen.getByText(en.authResetSent)).toBeTruthy();
  });

  it('asks for no password in reset mode', async () => {
    await renderEmail(createFakeAuthRepository({ initialUser: null }));
    await press(en.authForgotPassword);
    expect(screen.queryByLabelText(en.authPasswordLabel)).toBeNull();
  });
});
