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
import { setCrashReporterForTests, type CrashReporter } from '../../../lib/crash';
import { signedInWithApple } from '../appleRevocation';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { HEALTH_CONNECTION_KEY_PREFIX } from '../../../lib/deviceSettings/healthConnection';
import type { AuthUser } from '../../../auth/types';
import en from '../../../i18n/locales/en.json';

/**
 * Revoking Sign in with Apple before the account is deleted (App Store
 * 5.1.1(v)).
 *
 * Pinned here: an Apple account's tokens are revoked with the fresh
 * authorisation's code *before* the server deletes the Firebase user (after
 * that, Firebase can no longer act for it); password and Google accounts are
 * never asked for an Apple sheet; a failed revocation does not stop the
 * deletion and is reported without the code; and backing out of the Apple
 * sheet deletes nothing.
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
/** Revocations and server calls on one clock, to prove the order. */
let timeline: string[] = [];
let reported: Error[] = [];
const originalAppEnv = process.env.EXPO_PUBLIC_APP_ENV;
let repository: FakeAuthRepository;
let client: ReturnType<typeof createAppQueryClient>;
let alertButtons: { text?: string; onPress?: () => void }[] = [];

function respondWith(...responses: { status: number; body?: unknown }[]): void {
  let index = 0;
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (_url: string, init: RequestInit) => {
    requests.push((init.method as string) ?? 'GET');
    timeline.push(`server:${(init.method as string) ?? 'GET'}`);
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
  const revoke = repository.revokeAppleToken.bind(repository);
  repository.revokeAppleToken = async (code: string) => {
    timeline.push('revokeAppleToken');
    await revoke(code);
  };
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
  timeline = [];
  reported = [];
  // Crash reporting is off in development; the failure report is only
  // observable with collection on, which is what a tester's build has.
  process.env.EXPO_PUBLIC_APP_ENV = 'staging';
  const fake: CrashReporter = {
    setCrashlyticsCollectionEnabled: async () => undefined,
    setAttributes: async () => undefined,
    recordError: (error: Error) => { reported.push(error); },
    log: () => undefined,
    crash: () => undefined,
  };
  setCrashReporterForTests(fake);
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
  setCrashReporterForTests(null);
  process.env.EXPO_PUBLIC_APP_ENV = originalAppEnv;
  jest.restoreAllMocks();
});

describe('an account that signed in with Apple', () => {
  it('revokes with the fresh code before the server deletes, in one Apple sheet', async () => {
    respondWith({ status: 200, body: RECEIPT_BODY });
    await renderFor(['apple.com']);
    await confirmDeletion();

    await waitFor(() => expect(screen.getByTestId('account-deleted')).toBeTruthy());
    expect(repository.reauthentications).toEqual(['apple.com']);
    expect(repository.appleRevocations).toEqual(['fake-apple-code-1']);
    // Before, not after: once the server has deleted the Firebase user there
    // is nobody left for Firebase to revoke on behalf of.
    expect(timeline).toEqual(['revokeAppleToken', 'server:DELETE']);
    // The sheet was a fresh sign-in, and the deletion call carries it.
    expect(repository.calls.map(c => c.method)).toEqual(['reauthenticateWithApple', 'refreshIdentity', 'revokeAppleToken']);
    expect(reported).toEqual([]);
  });

  it('revokes for an account that also has a password', async () => {
    respondWith({ status: 200, body: RECEIPT_BODY });
    await renderFor(['password', 'apple.com']);
    await confirmDeletion();
    await waitFor(() => expect(screen.getByTestId('account-deleted')).toBeTruthy());
    expect(repository.appleRevocations).toEqual(['fake-apple-code-1']);
    expect(timeline).toEqual(['revokeAppleToken', 'server:DELETE']);
  });

  it('still deletes when revocation fails, and reports it without the code', async () => {
    respondWith({ status: 200, body: RECEIPT_BODY });
    await renderFor(['apple.com']);
    repository.failNext('revokeAppleToken', Object.assign(new Error('fake-apple-code-1 rejected by Apple'), { code: 'auth/invalid-credential' }));
    await confirmDeletion();

    await waitFor(() => expect(screen.getByTestId('account-deleted')).toBeTruthy());
    expect(requests.filter(m => m === 'DELETE')).toHaveLength(1);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.message).toBe('apple token revocation failed: revoke_failed');
    // Neither the code nor anything the SDK said reaches the report.
    expect(JSON.stringify({ message: reported[0]!.message, stack: reported[0]!.stack })).not.toMatch(/fake-apple-code|rejected by Apple/);
  });

  it('still deletes when Apple hands back no code, and says which stage failed', async () => {
    respondWith({ status: 200, body: RECEIPT_BODY });
    await renderFor(['apple.com']);
    repository.setNextAppleAuthorizationCode(null);
    await confirmDeletion();

    await waitFor(() => expect(screen.getByTestId('account-deleted')).toBeTruthy());
    expect(repository.appleRevocations).toEqual([]);
    expect(reported.map(e => e.message)).toEqual(['apple token revocation failed: no_code']);
  });

  it('still deletes when no Apple sheet can be shown here', async () => {
    respondWith({ status: 200, body: RECEIPT_BODY });
    await renderFor(['apple.com']);
    repository.failNext('reauthenticateWithApple', new Error('unsupportedPlatform'));
    await confirmDeletion();

    await waitFor(() => expect(screen.getByTestId('account-deleted')).toBeTruthy());
    expect(repository.appleRevocations).toEqual([]);
    expect(reported.map(e => e.message)).toEqual(['apple token revocation failed: credential_unavailable']);
  });

  it('backing out of the Apple sheet deletes nothing', async () => {
    respondWith({ status: 200, body: RECEIPT_BODY });
    await renderFor(['apple.com']);
    repository.cancelNextApple();
    await confirmDeletion();

    await waitFor(() => expect(screen.getByLabelText(en.accountDeleteAction)).toBeTruthy());
    expect(requests).toEqual([]);
    expect(repository.appleRevocations).toEqual([]);
    expect(repository.currentUser()?.uid).toBe('alice');
    expect(reported).toEqual([]);
  });

  it('a recent-login retry revokes once, with the code from the prompt\'s own sheet when the first had none', async () => {
    respondWith(RECENT_LOGIN, { status: 200, body: RECEIPT_BODY });
    await renderFor(['apple.com']);
    repository.setNextAppleAuthorizationCode(null);
    await confirmDeletion();
    await waitFor(() => expect(screen.getByLabelText(en.accountReauthAppleAction)).toBeTruthy());

    await fireEvent.press(screen.getByLabelText(en.accountReauthAppleAction));
    await waitFor(() => expect(screen.getByTestId('account-deleted')).toBeTruthy());
    // The first sheet had no code; the prompt's sheet did, and it was used.
    expect(repository.appleRevocations).toEqual(['fake-apple-code-2']);
    expect(timeline).toEqual(['server:DELETE', 'revokeAppleToken', 'server:DELETE']);
  });
});

describe('accounts that did not sign in with Apple', () => {
  it.each([[['password']], [['google.com']]])('%j: no Apple sheet and no revocation', async (providerIds) => {
    respondWith({ status: 200, body: RECEIPT_BODY });
    await renderFor(providerIds);
    await confirmDeletion();
    await waitFor(() => expect(screen.getByTestId('account-deleted')).toBeTruthy());
    expect(repository.calls.map(c => c.method)).not.toContain('reauthenticateWithApple');
    expect(repository.appleRevocations).toEqual([]);
    expect(timeline).toEqual(['server:DELETE']);
    expect(reported).toEqual([]);
  });
});

describe('which accounts count as Sign in with Apple', () => {
  it('matches the provider id exactly, never a look-alike', () => {
    expect(signedInWithApple(userWith(['apple.com']))).toBe(true);
    expect(signedInWithApple(userWith(['password', 'apple.com']))).toBe(true);
    for (const lookAlike of ['apple.com.example', 'notapple.com', 'https://apple.com', 'apple.co', 'APPLE.COM', ' apple.com']) {
      expect({ lookAlike, apple: signedInWithApple(userWith([lookAlike])) }).toEqual({ lookAlike, apple: false });
    }
    expect(signedInWithApple(null)).toBe(false);
  });

  it('a look-alike provider gets no Apple sheet and no revocation', async () => {
    respondWith({ status: 200, body: RECEIPT_BODY });
    await renderFor(['password', 'https://apple.com']);
    await confirmDeletion();
    await waitFor(() => expect(screen.getByTestId('account-deleted')).toBeTruthy());
    expect(repository.calls.map(c => c.method)).not.toContain('reauthenticateWithApple');
    expect(repository.appleRevocations).toEqual([]);
  });
});

describe('what a failed refresh and a finished deletion leave behind', () => {
  it('still revokes with the code in hand when the token refresh after the Apple sheet fails', async () => {
    respondWith({ status: 200, body: RECEIPT_BODY });
    await renderFor(['apple.com']);
    repository.failNext('refreshIdentity', new Error('network'));
    await confirmDeletion();

    await waitFor(() => expect(screen.getByTestId('account-deleted')).toBeTruthy());
    expect(repository.appleRevocations).toEqual(['fake-apple-code-1']);
    expect(timeline).toEqual(['revokeAppleToken', 'server:DELETE']);
    expect(reported).toEqual([]);
  });

  it('removes this device\'s Health connection key for the deleted account, and leaves other accounts\' keys', async () => {
    await AsyncStorage.setItem(`${HEALTH_CONNECTION_KEY_PREFIX}alice`, JSON.stringify({ connected: true, lastAttemptAt: null }));
    await AsyncStorage.setItem(`${HEALTH_CONNECTION_KEY_PREFIX}bob`, JSON.stringify({ connected: true, lastAttemptAt: null }));
    respondWith({ status: 200, body: RECEIPT_BODY });
    await renderFor(['password']);
    await confirmDeletion();

    await waitFor(() => expect(screen.getByTestId('account-deleted')).toBeTruthy());
    expect(await AsyncStorage.getItem(`${HEALTH_CONNECTION_KEY_PREFIX}alice`)).toBeNull();
    expect(await AsyncStorage.getItem(`${HEALTH_CONNECTION_KEY_PREFIX}bob`)).not.toBeNull();
    await AsyncStorage.clear();
  });
});
