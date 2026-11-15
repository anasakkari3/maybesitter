import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Alert, Text } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository, type FakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, revokedAccount, setAuthRepository } from '../../../api/auth';
import { apiRequest } from '../../../api/client';
import { createAppQueryClient } from '../../../api/queryClient';
import { ApiProvider } from '../../../api/ui/ApiProvider';
import { AccountDeletionProvider } from '../AccountDeletionProvider';
import { AccountDeletedGate } from '../AccountDeletedGate';
import { RevokedAccountGate } from '../RevokedAccountGate';
import * as dataExportFile from '../../../lib/dataExportFile';
import type { AuthUser } from '../../../auth/types';
import { z } from 'zod';
import en from '../../../i18n/locales/en.json';

/**
 * A revoked account, in the app (C12.1, owner decision (a)).
 *
 * A 403 `revoked` used to sign the person out at once, so the two rights the
 * server keeps for a revoked account — export and deletion — were never
 * reachable from the app. Now the session stays, the app is replaced by one
 * screen with exactly those two actions and a sign-out, and nothing else of
 * the app is mounted to fire queries that would all 403.
 */

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const A: AuthUser = { uid: 'revoked-a', email: 'a@example.com', emailVerified: true, displayName: null, providerIds: ['password'] };
const B: AuthUser = { uid: 'fresh-b', email: 'b@example.com', emailVerified: true, displayName: null, providerIds: ['password'] };

const RECEIPT = {
  success: true,
  receipt: {
    receiptId: '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9',
    deletedAt: '2026-09-12T12:00:00.000Z',
    steps: { markDeleted: 'done', authUser: 'done', userTree: 'done', receipt: 'done' },
  },
};
const EXPORT = {
  exportedAt: '2026-11-15T10:00:00.000Z',
  schemaVersion: 1,
  account: { uid: A.uid, profile: null },
  collections: {},
  excluded: {},
};

let requests: { method: string; url: string }[] = [];
let repository: FakeAuthRepository;
let alertButtons: { text?: string; style?: string; onPress?: () => void }[] = [];

/** The server for a revoked account: 403 everywhere but the two rights routes. */
function serveRevoked(): void {
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (url: string, init: RequestInit) => {
    const method = (init.method as string) ?? 'GET';
    requests.push({ method, url });
    const path = new URL(url).pathname;
    const body = path === '/api/mobile/account/export' && method === 'GET' ? { status: 200, body: EXPORT }
      : path === '/api/mobile/account' && method === 'DELETE' ? { status: 200, body: RECEIPT }
        : { status: 403, body: { success: false, error: 'this account was revoked', reason: 'revoked' } };
    return {
      status: body.status,
      text: async () => JSON.stringify(body.body),
      headers: { get: () => null },
    };
  }) as never;
}

function TheApp() {
  return <Text testID="the-app">app</Text>;
}

async function mount() {
  const client = createAppQueryClient();
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <ApiProvider client={client}>
            <AccountDeletionProvider>
              <AccountDeletedGate>
                <RevokedAccountGate>
                  <TheApp />
                </RevokedAccountGate>
              </AccountDeletedGate>
            </AccountDeletionProvider>
          </ApiProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

/** Any request the app makes, answered 403 revoked, the way the first one is. */
async function firstRequestRefused() {
  await act(async () => {
    await apiRequest('GET', '/api/mobile/today', { schema: z.object({}) }).catch(() => undefined);
  });
}

beforeEach(() => {
  requests = [];
  alertButtons = [];
  onlineManager.setOnline(true);
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  repository = createFakeAuthRepository({ initialUser: A });
  setAuthRepository(repository);
  serveRevoked();
  jest.spyOn(Alert, 'alert').mockImplementation(((_t: string, _b?: string, buttons?: typeof alertButtons) => {
    alertButtons = buttons ?? [];
  }) as never);
});

afterEach(() => {
  resetAuthForTests();
  jest.restoreAllMocks();
});

describe('a revoked account (C12.1)', () => {
  it('shows the revoked screen in place of the app, and stays signed in', async () => {
    await mount();
    expect(screen.getByTestId('the-app')).toBeTruthy();
    await firstRequestRefused();

    await waitFor(() => expect(screen.getByTestId('revoked-account')).toBeTruthy());
    expect(screen.queryByTestId('the-app')).toBeNull();
    expect(repository.signOutReasons).toEqual([]);
    expect(screen.getByText(en.revokedAccountLine)).toBeTruthy();
  });

  it('offers nothing but export, delete and sign out', async () => {
    await mount();
    await firstRequestRefused();
    await waitFor(() => expect(screen.getByTestId('revoked-account')).toBeTruthy());
    const buttons = screen.getAllByRole('button').map(b => b.props.accessibilityLabel ?? '');
    expect(buttons.sort()).toEqual([en.revokedAccountDelete, en.revokedAccountExport, en.revokedAccountSignOut].sort());
  });

  it('exports through GET /api/mobile/account/export', async () => {
    const share = jest.spyOn(dataExportFile, 'shareExportFile').mockResolvedValue(undefined as never);
    await mount();
    await firstRequestRefused();
    requests = [];
    await waitFor(() => expect(screen.getByTestId('revoked-account')).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByLabelText(en.revokedAccountExport));
    });

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(requests).toEqual([{ method: 'GET', url: 'http://localhost:3000/api/mobile/account/export' }]);
    expect(repository.signOutReasons).toEqual([]);
  });

  it('deletes through the deletion flow and its confirmation, then shows the receipt', async () => {
    await mount();
    await firstRequestRefused();
    requests = [];
    await waitFor(() => expect(screen.getByTestId('revoked-account')).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByLabelText(en.revokedAccountDelete));
    });
    // The existing screen, with its own explanation and confirm.
    expect(screen.getByText(en.accountDeleteTitle)).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText(en.accountDeleteAction));
    });
    // Nothing is sent before the confirmation.
    expect(requests).toEqual([]);
    const proceed = alertButtons.find(b => b.text === en.accountDeleteConfirmProceed);
    await act(async () => {
      proceed?.onPress?.();
    });

    await waitFor(() => expect(screen.getByTestId('account-deleted')).toBeTruthy());
    expect(requests).toEqual([{ method: 'DELETE', url: 'http://localhost:3000/api/mobile/account' }]);
    expect(repository.signOutReasons).toEqual(['deleted']);
  });

  it('signs out from «اطلع»', async () => {
    await mount();
    await firstRequestRefused();
    await waitFor(() => expect(screen.getByTestId('revoked-account')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByLabelText(en.revokedAccountSignOut));
    });
    await waitFor(() => expect(repository.signOutReasons).toEqual(['revoked']));
    expect(revokedAccount()).toBeNull();
  });

  it('is cleared when another account signs in', async () => {
    await mount();
    await firstRequestRefused();
    await waitFor(() => expect(screen.getByTestId('revoked-account')).toBeTruthy());

    await act(async () => {
      repository.emit(B);
    });

    await waitFor(() => expect(screen.getByTestId('the-app')).toBeTruthy());
    expect(screen.queryByTestId('revoked-account')).toBeNull();
    expect(revokedAccount()).toBeNull();
  });
});
