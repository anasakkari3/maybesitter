import React from 'react';
import { describe, expect, it, jest } from '@jest/globals';
import { Keyboard, TextInput } from 'react-native';
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

/**
 * Once the account call has been made, the form takes no more touches
 * (UAT 2026-09-26, D4).
 *
 * The controller's instrumented device run: after email sign-up, the first
 * press on welcome «كمّل» reached no Pressable. It focused THIS screen's
 * password field (`authPasswordInput`, secure, under this screen's
 * ScrollView), whose native view was still hit-testable over welcome; the
 * second press worked. React has unmounted the screen by then — jest shows
 * it gone — so what lingers is the native view, frozen with the last props it
 * was given. Those props are the ones set here while the call runs: no
 * pointer events and no editable field, so a view that outlives its screen
 * cannot take a touch or the keyboard. They stay that way after a success,
 * because the screen is on its way out; a failure hands the form back.
 */
describe('the form while and after the account call', () => {
  const root = () => screen.getByTestId('email-auth-root');
  const pointerEvents = () => root().props.pointerEvents as string | undefined;
  const editable = (id: string) => screen.getByTestId(id).props.editable as boolean;

  it('takes no touches while the call runs', async () => {
    const repository = createFakeAuthRepository({ initialUser: null });
    let release: () => void = () => {};
    (repository as unknown as Record<string, unknown>).createAccount = () => new Promise<void>((resolve) => { release = resolve; });
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <AuthProvider repository={repository} isDevBundle={false}>
            <EmailAuthScreen onBack={() => {}} initialMode="signUp" />
          </AuthProvider>
        </AppProvider>
      </SafeAreaProvider>,
    );
    await type(en.authEmailLabel, 'someone@example.com');
    await type(en.authPasswordLabel, VALID_PASSWORD);
    await press(en.authModeSignUp);
    expect(pointerEvents()).toBe('none');
    expect(editable('authPasswordInput')).toBe(false);
    expect(editable('authEmailInput')).toBe(false);
    await React.act(async () => { release(); });
  });

  it('stays inert after the account exists, so nothing left of it can take a touch', async () => {
    // A repository that succeeds without emitting a user keeps this screen
    // mounted — the lingering the device showed, held still for the test.
    const repository = createFakeAuthRepository({ initialUser: null });
    (repository as unknown as Record<string, unknown>).createAccount = async () => {};
    await renderEmailIn(repository, 'signUp');
    await type(en.authEmailLabel, 'someone@example.com');
    await type(en.authPasswordLabel, VALID_PASSWORD);
    await press(en.authModeSignUp);
    expect(pointerEvents()).toBe('none');
    expect(editable('authPasswordInput')).toBe(false);
    expect(editable('authEmailInput')).toBe(false);
  });

  it('hands the form back after a refused sign-in, with the password ready to retype (review NEW-1)', async () => {
    const repository = createFakeAuthRepository({ initialUser: null });
    repository.failNext('signInWithEmail', Object.assign(new Error('x'), { code: 'auth/wrong-password' }));
    await renderEmailIn(repository, 'signIn');
    await type(en.authEmailLabel, 'someone@example.com');
    await type(en.authPasswordLabel, VALID_PASSWORD);
    const focus = jest.spyOn(TextInput.prototype as unknown as { focus: () => void }, 'focus');
    await press(en.authModeSignIn);
    expect(pointerEvents()).toBe('auto');
    expect(editable('authPasswordInput')).toBe(true);
    expect(focus).toHaveBeenCalled();
    focus.mockRestore();
  });

  // Round 2 dismissed the keyboard before every call. It did not fix D4 on the
  // device, and a refused sign-in then left the person with no keyboard to
  // retype on (review NEW-1). The form's own inert state does the D4 job.
  it('does not dismiss the keyboard before the call', async () => {
    const repository = createFakeAuthRepository({ initialUser: null });
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    try {
      await renderEmail(repository);
      await type(en.authEmailLabel, 'someone@example.com');
      await type(en.authPasswordLabel, VALID_PASSWORD);
      await press(en.authModeSignIn);
      expect(dismiss).not.toHaveBeenCalled();
    } finally {
      dismiss.mockRestore();
    }
  });
});

async function renderEmailIn(repository: FakeAuthRepository, mode: 'signIn' | 'signUp') {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <EmailAuthScreen onBack={() => {}} initialMode={mode} />
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}
