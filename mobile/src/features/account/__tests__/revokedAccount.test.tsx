import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Alert, Text } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository, type FakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { holdRevoked, resetAuthForTests, revokedAccount, setAuthRepository } from '../../../api/auth';
import { onBeforeSignOut, resetBeforeSignOutForTests } from '../../../auth/beforeSignOut';
import * as revokedScreen from '../../../screens/RevokedAccountScreen';
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
import exported from '../../../api/__fixtures__/account.export.json';
import resumed from '../../../api/__fixtures__/account.resumed.json';

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
// The real route's response, as `exportMobileApiFixtures.test.ts` recorded it.
const EXPORT = exported;

let requests: { method: string; url: string }[] = [];
/** What `POST /api/mobile/account/resume` answers; the recorded fixture unless a test says otherwise. */
let resumeAnswer: { status: number; body: unknown } = { status: 200, body: resumed };
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
        : path === '/api/mobile/account/resume' && method === 'POST' ? resumeAnswer
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
  resumeAnswer = { status: 200, body: resumed };
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
  resetBeforeSignOutForTests();
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

  it('offers nothing but the way back, export, delete and sign out', async () => {
    await mount();
    await firstRequestRefused();
    await waitFor(() => expect(screen.getByTestId('revoked-account')).toBeTruthy());
    const buttons = screen.getAllByRole('button').map(b => b.props.accessibilityLabel ?? '');
    expect(buttons.sort()).toEqual([
      en.revokedAccountResume, en.revokedAccountDelete, en.revokedAccountExport, en.revokedAccountSignOut,
    ].sort());
    // What coming back means is said before it is pressed.
    expect(screen.getByText(en.revokedAccountResumeBody)).toBeTruthy();
  });

  // QA v3: an account the old «وقّف» locked (before #873) had no way back.
  it('brings the account back through POST /api/mobile/account/resume, and the app returns', async () => {
    await mount();
    await firstRequestRefused();
    requests = [];
    await waitFor(() => expect(screen.getByTestId('revoked-account')).toBeTruthy());

    await act(async () => {
      await fireEvent.press(screen.getByLabelText(en.revokedAccountResume));
    });

    await waitFor(() => expect(screen.getByTestId('the-app')).toBeTruthy());
    expect(screen.queryByTestId('revoked-account')).toBeNull();
    expect(requests).toEqual([{ method: 'POST', url: 'http://localhost:3000/api/mobile/account/resume' }]);
    expect(revokedAccount()).toBeNull();
    expect(repository.signOutReasons).toEqual([]);
  });

  it('says a failed resume out loud and keeps the revoked screen and its other actions', async () => {
    resumeAnswer = { status: 503, body: { success: false, error: 'unavailable' } };
    await mount();
    await firstRequestRefused();
    await waitFor(() => expect(screen.getByTestId('revoked-account')).toBeTruthy());

    await act(async () => {
      await fireEvent.press(screen.getByLabelText(en.revokedAccountResume));
    });

    await waitFor(() => expect(screen.getByText(en.revokedAccountResumeFailed)).toBeTruthy());
    const region = screen.getByTestId('revoked-resume-status');
    expect(region.props.accessibilityLiveRegion).toBe('assertive');
    expect(region.props.accessibilityRole).toBe('alert');
    expect(screen.getByTestId('revoked-account')).toBeTruthy();
    expect(revokedAccount()).toBe(A.uid);
    // The button is offered again, for «كمان مرّة».
    expect(screen.getByLabelText(en.revokedAccountResume).props.accessibilityState?.disabled).not.toBe(true);
    expect(screen.getByLabelText(en.revokedAccountExport)).toBeTruthy();
  });

  it('exports through GET /api/mobile/account/export', async () => {
    const share = jest.spyOn(dataExportFile, 'shareExportFile').mockResolvedValue(undefined as never);
    await mount();
    await firstRequestRefused();
    requests = [];
    await waitFor(() => expect(screen.getByTestId('revoked-account')).toBeTruthy());

    await act(async () => {
      await fireEvent.press(screen.getByLabelText(en.revokedAccountExport));
    });

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(requests).toEqual([{ method: 'GET', url: 'http://localhost:3000/api/mobile/account/export' }]);
    expect(repository.signOutReasons).toEqual([]);
  });

  it('announces an export failure assertively, as an alert', async () => {
    jest.spyOn(dataExportFile, 'shareExportFile').mockRejectedValue(new Error('share failed') as never);
    await mount();
    await firstRequestRefused();
    await waitFor(() => expect(screen.getByTestId('revoked-account')).toBeTruthy());
    await act(async () => {
      await fireEvent.press(screen.getByLabelText(en.revokedAccountExport));
    });
    await waitFor(() => expect(screen.getByText(en.exportDataFailed)).toBeTruthy());
    const region = screen.getByTestId('revoked-export-status');
    expect(region.props.accessibilityLiveRegion).toBe('assertive');
    expect(region.props.accessibilityRole).toBe('alert');
  });

  it('deletes through the deletion flow and its confirmation, then shows the receipt', async () => {
    await mount();
    await firstRequestRefused();
    requests = [];
    await waitFor(() => expect(screen.getByTestId('revoked-account')).toBeTruthy());

    await act(async () => {
      await fireEvent.press(screen.getByLabelText(en.revokedAccountDelete));
    });
    // The existing screen, with its own explanation and confirm.
    expect(screen.getByText(en.accountDeleteTitle)).toBeTruthy();
    await act(async () => {
      await fireEvent.press(screen.getByText(en.accountDeleteAction));
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

  it('signs out from the sign-out button', async () => {
    await mount();
    await firstRequestRefused();
    await waitFor(() => expect(screen.getByTestId('revoked-account')).toBeTruthy());
    await act(async () => {
      await fireEvent.press(screen.getByLabelText(en.revokedAccountSignOut));
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

  it("never shows A's revoked screen to B, not even for one render", async () => {
    await mount();
    await firstRequestRefused();
    await waitFor(() => expect(screen.getByTestId('revoked-account')).toBeTruthy());
    const rendered = jest.spyOn(revokedScreen, 'RevokedAccountScreen');

    await act(async () => {
      repository.emit(B);
    });

    expect(rendered).not.toHaveBeenCalled();
    expect(screen.getByTestId('the-app')).toBeTruthy();
  });
});

describe('holding an account as revoked is bound to that account (C12.1)', () => {
  it("never holds B for a 403 that was A's, nor cleans B's handset for it", async () => {
    const cleanup = jest.fn(async () => {});
    onBeforeSignOut(cleanup);
    repository.emit(B);
    await holdRevoked(A.uid);
    expect(revokedAccount()).toBeNull();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('never holds an account that changed while the cleanup ran', async () => {
    onBeforeSignOut(async () => {
      repository.emit(B);
    });
    await holdRevoked();
    expect(revokedAccount()).toBeNull();
  });

  it('runs the cleanup once for many 403s at the same moment', async () => {
    // A cleanup that takes a moment, as the real one (FCM, the OS) does.
    const cleanup = jest.fn(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    onBeforeSignOut(cleanup);
    await Promise.all([holdRevoked(), holdRevoked(A.uid), holdRevoked()]);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(revokedAccount()).toBe(A.uid);
  });

  it('holds the signed-in account otherwise', async () => {
    await holdRevoked();
    expect(revokedAccount()).toBe(A.uid);
  });
});
