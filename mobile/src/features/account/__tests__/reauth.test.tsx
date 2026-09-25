import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Alert } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository, type FakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { createAppQueryClient } from '../../../api/queryClient';
import { ApiProvider } from '../../../api/ui/ApiProvider';
import { AccountDeletionProvider } from '../AccountDeletionProvider';
import { AccountDeletedGate } from '../AccountDeletedGate';
import { DeleteAccountScreen } from '../../../screens/DeleteAccountScreen';
import { reauthProviderFor } from '../reauthenticate';
import type { AuthUser } from '../../../auth/types';
import en from '../../../i18n/locales/en.json';

/**
 * Re-authenticating, then asking again (UC-1.5 #149).
 *
 * The server wants proof of recent identity before it deletes. The behaviours
 * worth pinning: the user is never signed out by it, the provider is read
 * rather than guessed, a cancelled provider sheet changes nothing, and the
 * second deletion attempt is one deliberate call rather than a retry queue.
 */

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const RECEIPT_BODY = {
  success: true,
  receipt: { receiptId: 'r-1', deletedAt: '2026-09-12T12:00:00.000Z', steps: { receipt: 'done' } },
};
const RECENT_LOGIN = { status: 401, body: { success: false, error: 'recent login required', reason: 'recent_login_required' } };

function userWith(providerIds: string[]): AuthUser {
  return { uid: 'alice', email: 'alice@example.com', emailVerified: true, displayName: null, providerIds };
}

let requests: string[] = [];
let repository: FakeAuthRepository;
let client: ReturnType<typeof createAppQueryClient>;
let alertButtons: { text?: string; onPress?: () => void }[] = [];

function respondWith(...responses: { status: number; body?: unknown }[]): void {
  let index = 0;
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (_url: string, init: RequestInit) => {
    requests.push((init.method as string) ?? 'GET');
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return {
      status: response.status,
      text: async () => JSON.stringify(response.body ?? {}),
      headers: { get: () => null },
    };
  }) as never;
}

async function renderFor(providerIds: string[]) {
  repository = createFakeAuthRepository({ initialUser: userWith(providerIds) });
  setAuthRepository(repository);
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <ApiProvider client={client}>
            <AccountDeletionProvider>
              <AccountDeletedGate>
                <DeleteAccountScreen onBack={() => {}} />
              </AccountDeletedGate>
            </AccountDeletionProvider>
          </ApiProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

/** Taps the destructive button and accepts the confirmation alert. */
async function confirmDeletion() {
  await fireEvent.press(screen.getByLabelText(en.accountDeleteAction));
  const proceed = alertButtons.find(b => b.text === en.accountDeleteConfirmProceed);
  await act(async () => {
    proceed?.onPress?.();
  });
}

beforeEach(() => {
  requests = [];
  alertButtons = [];
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  onlineManager.setOnline(true);
  client = createAppQueryClient();
  jest.spyOn(Alert, 'alert').mockImplementation(((
    _title: string,
    _body?: string,
    buttons?: typeof alertButtons,
  ) => {
    alertButtons = buttons ?? [];
  }) as never);
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

describe('choosing the provider', () => {
  it('reads it from the account rather than asking', () => {
    expect(reauthProviderFor(userWith(['password']))).toBe('password');
    expect(reauthProviderFor(userWith(['google.com']))).toBe('google.com');
    expect(reauthProviderFor(userWith(['apple.com']))).toBe('apple.com');
  });

  it('picks one that can actually prove identity when several are linked', () => {
    // The user should not have to remember which one Firebase considers
    // primary — any linked credential proves recent identity.
    expect(reauthProviderFor(userWith(['apple.com', 'password']))).toBe('password');
    expect(reauthProviderFor(userWith(['apple.com', 'google.com']))).toBe('google.com');
  });

  it('has nothing to offer for an account with no usable provider', () => {
    expect(reauthProviderFor(userWith(['phone']))).toBeNull();
    expect(reauthProviderFor(null)).toBeNull();
  });
});

describe('the recent-login prompt', () => {
  it('appears without signing the user out', async () => {
    respondWith(RECENT_LOGIN);
    await renderFor(['password']);
    await confirmDeletion();

    await waitFor(() => expect(screen.getByText(en.accountReauthTitle)).toBeTruthy());
    // The single invariant this whole path exists for.
    expect(repository.signOutReasons).toEqual([]);
    expect(repository.currentUser()).not.toBeNull();
  });

  it('offers the password field for a password account', async () => {
    respondWith(RECENT_LOGIN);
    await renderFor(['password']);
    await confirmDeletion();
    await waitFor(() => expect(screen.getByTestId('reauth-password')).toBeTruthy());
    expect(screen.queryByLabelText(en.accountReauthGoogleAction)).toBeNull();
  });

  it('offers the Google button for a Google account, and no password field', async () => {
    respondWith(RECENT_LOGIN);
    await renderFor(['google.com']);
    await confirmDeletion();
    await waitFor(() => expect(screen.getByLabelText(en.accountReauthGoogleAction)).toBeTruthy());
    expect(screen.queryByTestId('reauth-password')).toBeNull();
  });

  it('offers the Apple button for an Apple account', async () => {
    respondWith(RECENT_LOGIN);
    await renderFor(['apple.com']);
    await confirmDeletion();
    await waitFor(() => expect(screen.getByLabelText(en.accountReauthAppleAction)).toBeTruthy());
  });

  it('says so plainly when no provider here can prove identity', async () => {
    respondWith(RECENT_LOGIN);
    await renderFor(['phone']);
    await confirmDeletion();
    // Better than looping the user through a sheet that cannot work.
    await waitFor(() => expect(screen.getByText(en.accountDeleteUnavailable)).toBeTruthy());
    expect(repository.signOutReasons).toEqual([]);
  });

  it('lets the user back out, with nothing deleted', async () => {
    respondWith(RECENT_LOGIN);
    await renderFor(['password']);
    await confirmDeletion();
    await waitFor(() => expect(screen.getByText(en.accountReauthTitle)).toBeTruthy());

    await fireEvent.press(screen.getByLabelText(en.back));
    await waitFor(() => expect(screen.getByText(en.accountDeleteTitle)).toBeTruthy());
    expect(requests.filter(m => m === 'DELETE')).toHaveLength(1);
    expect(repository.currentUser()).not.toBeNull();
  });
});

describe('re-authenticating and asking again', () => {
  it('password: succeeds, refreshes the identity, and deletes on one more call', async () => {
    respondWith(RECENT_LOGIN, { status: 200, body: RECEIPT_BODY });
    await renderFor(['password']);
    await confirmDeletion();
    await waitFor(() => expect(screen.getByTestId('reauth-password')).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId('reauth-password'), 'the-real-password');
    await fireEvent.press(screen.getByLabelText(en.accountReauthPasswordAction));

    await waitFor(() => expect(screen.getByTestId('account-deleted')).toBeTruthy());
    expect(repository.reauthentications).toEqual(['password']);
    // `auth_time` is fresh on the account, but the cached ID token still
    // carries the old claim until it is re-minted.
    expect(repository.calls.some(c => c.method === 'refreshIdentity')).toBe(true);
    // Exactly two: the original refusal and one deliberate retry.
    expect(requests.filter(m => m === 'DELETE')).toHaveLength(2);
  });

  it('password: a wrong password stays on the flow and does not sign out', async () => {
    respondWith(RECENT_LOGIN);
    await renderFor(['password']);
    await confirmDeletion();
    await waitFor(() => expect(screen.getByTestId('reauth-password')).toBeTruthy());

    // The fake rejects an empty password, standing in for auth/wrong-password.
    await fireEvent.press(screen.getByLabelText(en.accountReauthPasswordAction));

    await waitFor(() => expect(screen.getByText(en.accountReauthFailed)).toBeTruthy());
    expect(repository.signOutReasons).toEqual([]);
    expect(repository.currentUser()).not.toBeNull();
    // No second deletion attempt on a failed re-authentication.
    expect(requests.filter(m => m === 'DELETE')).toHaveLength(1);
    // Still on the re-auth step, not thrown back to the start.
    expect(screen.getByTestId('reauth-password')).toBeTruthy();
  });

  it('google: succeeds and deletes on one more call', async () => {
    respondWith(RECENT_LOGIN, { status: 200, body: RECEIPT_BODY });
    await renderFor(['google.com']);
    await confirmDeletion();
    await waitFor(() => expect(screen.getByLabelText(en.accountReauthGoogleAction)).toBeTruthy());

    await fireEvent.press(screen.getByLabelText(en.accountReauthGoogleAction));
    await waitFor(() => expect(screen.getByTestId('account-deleted')).toBeTruthy());
    expect(repository.reauthentications).toEqual(['google.com']);
    expect(requests.filter(m => m === 'DELETE')).toHaveLength(2);
  });

  it('google: a cancelled chooser is not an error and deletes nothing', async () => {
    respondWith(RECENT_LOGIN);
    await renderFor(['google.com']);
    await confirmDeletion();
    await waitFor(() => expect(screen.getByLabelText(en.accountReauthGoogleAction)).toBeTruthy());

    repository.cancelNextGoogle();
    await fireEvent.press(screen.getByLabelText(en.accountReauthGoogleAction));

    // No error message, no sign-out, no second attempt, and — crucially —
    // not a new sign-in replacing this account mid-deletion.
    expect(screen.queryByText(en.accountReauthFailed)).toBeNull();
    expect(repository.signOutReasons).toEqual([]);
    expect(repository.currentUser()?.uid).toBe('alice');
    expect(requests.filter(m => m === 'DELETE')).toHaveLength(1);
    expect(screen.getByLabelText(en.accountReauthGoogleAction)).toBeTruthy();
  });

  it('apple: succeeds and deletes on one more call', async () => {
    respondWith(RECENT_LOGIN, { status: 200, body: RECEIPT_BODY });
    await renderFor(['apple.com']);
    await confirmDeletion();
    await waitFor(() => expect(screen.getByLabelText(en.accountReauthAppleAction)).toBeTruthy());

    await fireEvent.press(screen.getByLabelText(en.accountReauthAppleAction));
    await waitFor(() => expect(screen.getByTestId('account-deleted')).toBeTruthy());
    // Two sheets here only because this server refuses even a fresh Apple
    // sign-in: an Apple account is asked for one sheet at confirmation (its
    // code revokes the account's Apple tokens, App Store 5.1.1(v)), and the
    // recent-login prompt is the second. The tokens are revoked once.
    expect(repository.reauthentications).toEqual(['apple.com', 'apple.com']);
    expect(repository.appleRevocations).toEqual(['fake-apple-code-1']);
    expect(requests.filter(m => m === 'DELETE')).toHaveLength(2);
  });

  it('apple: a cancelled sheet changes nothing', async () => {
    respondWith(RECENT_LOGIN);
    await renderFor(['apple.com']);
    await confirmDeletion();
    await waitFor(() => expect(screen.getByLabelText(en.accountReauthAppleAction)).toBeTruthy());

    repository.cancelNextApple();
    await fireEvent.press(screen.getByLabelText(en.accountReauthAppleAction));
    expect(screen.queryByText(en.accountReauthFailed)).toBeNull();
    expect(repository.currentUser()?.uid).toBe('alice');
    expect(requests.filter(m => m === 'DELETE')).toHaveLength(1);
  });

  it('does not loop: a second recent-login refusal re-prompts rather than retrying forever', async () => {
    // Both attempts refused. The screen must ask again, not spin.
    respondWith(RECENT_LOGIN);
    await renderFor(['password']);
    await confirmDeletion();
    await waitFor(() => expect(screen.getByTestId('reauth-password')).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId('reauth-password'), 'the-real-password');
    await fireEvent.press(screen.getByLabelText(en.accountReauthPasswordAction));

    await waitFor(() => expect(screen.getByTestId('reauth-password')).toBeTruthy());
    // Two calls, not an unbounded loop.
    expect(requests.filter(m => m === 'DELETE')).toHaveLength(2);
    expect(repository.signOutReasons).toEqual([]);
  });
});
