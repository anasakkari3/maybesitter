import React, { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Alert, Text } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { onlineManager, useQuery } from '@tanstack/react-query';
import { AppProvider, useApp } from '../../../state/AppContext';
import { AuthProvider, useAuth } from '../../../auth/AuthProvider';
import { createFakeAuthRepository, type FakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { createAppQueryClient } from '../../../api/queryClient';
import { forgetValidators, rememberValidator, validatorFor } from '../../../api/queries';
import { ApiProvider } from '../../../api/ui/ApiProvider';
import { AccountDeletionProvider } from '../AccountDeletionProvider';
import { AccountDeletedGate } from '../AccountDeletedGate';
import { AuthGate } from '../../../auth/AuthGate';
import { DeleteAccountScreen } from '../../../screens/DeleteAccountScreen';
import type { AuthUser } from '../../../auth/types';
import en from '../../../i18n/locales/en.json';

/**
 * Deleting an account, from the tap to the receipt (UC-1.5 #149).
 *
 * The invariants worth protecting here are not "does the button work". They
 * are: nothing is deleted before the confirmation, a `recent_login_required`
 * does not eject the user, the receipt actually reaches the screen, and not
 * one row of the deleted account survives for whoever signs in next.
 */

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const RECEIPT_ID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';
const RECEIPT_BODY = {
  success: true,
  receipt: {
    receiptId: RECEIPT_ID,
    deletedAt: '2026-09-12T12:00:00.000Z',
    steps: { markDeleted: 'done', authUser: 'done', userTree: 'done', receipt: 'done' },
  },
};

function userWith(uid: string, providerIds: string[] = ['password']): AuthUser {
  return { uid, email: `${uid}@example.com`, emailVerified: true, displayName: null, providerIds };
}

let requests: { method: string; url: string }[] = [];
let repository: FakeAuthRepository;
let client: ReturnType<typeof createAppQueryClient>;
let alertButtons: { text?: string; style?: string; onPress?: () => void }[] = [];

function respondWith(...responses: { status: number; body?: unknown }[]): void {
  let index = 0;
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (url: string, init: RequestInit) => {
    requests.push({ method: (init.method as string) ?? 'GET', url });
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return {
      status: response.status,
      text: async () => (response.body === undefined ? '' : JSON.stringify(response.body)),
      headers: { get: () => null },
    };
  }) as never;
}

/** Captures the confirmation alert instead of showing it. */
function captureAlert(): void {
  jest.spyOn(Alert, 'alert').mockImplementation(((
    _title: string,
    _body?: string,
    buttons?: typeof alertButtons,
  ) => {
    alertButtons = buttons ?? [];
  }) as never);
}

/** The probe's rendered string. `toHaveTextContent` matches exactly here. */
const probeText = (): string => String(screen.getByTestId('probe').props.children);

const tapAlert = async (text: string) => {
  const button = alertButtons.find(b => b.text === text);
  expect(button).toBeDefined();
  await act(async () => {
    button?.onPress?.();
  });
};

/**
 * Reads whatever Today currently holds, straight from the cache.
 *
 * The uid comes from `useAuth()` rather than from the repository directly:
 * a non-reactive read would not re-run the query when Firebase resolves, and
 * the probe would sit on `signed-out` forever.
 */
function TodayProbe() {
  const { user } = useAuth();
  const uid = user?.uid ?? 'signed-out';
  const { data } = useQuery({
    queryKey: ['user', uid, 'commitments', 'today', 'UTC'],
    queryFn: async () => ({ items: [{ id: 'a-secret-commitment' }] }),
    enabled: uid !== 'signed-out',
  });
  const { s, actions } = useApp();
  // Published from an effect: a component may not reassign an outer binding,
  // and the React Compiler rules refuse it outright.
  useEffect(() => {
    probe.mutate = () => {
      // Two pieces of per-user state a screen really holds: which day is open,
      // and a half-typed capture.
      actions.setSelDay(6);
      actions.setInput('something the user was typing');
    };
  }, [actions]);
  return (
    <Text testID="probe">{`rows:${data?.items.length ?? 0}|day:${s.selDay}|input:${s.input.length}`}</Text>
  );
}

const probe: { mutate: (() => void) | null } = { mutate: null };

async function renderFlow() {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <ApiProvider client={client}>
            <AccountDeletionProvider>
              <AccountDeletedGate>
                <AuthGate>
                  <DeleteAccountScreen onBack={() => {}} />
                </AuthGate>
              </AccountDeletedGate>
              {/* Outside the gate so it can be read in the signed-out state
                  too: the point is that nothing of the deleted account
                  survives into it. */}
              <TodayProbe />
            </AccountDeletionProvider>
          </ApiProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  requests = [];
  alertButtons = [];
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  onlineManager.setOnline(true);
  client = createAppQueryClient();
  repository = createFakeAuthRepository({ initialUser: userWith('alice') });
  setAuthRepository(repository);
  captureAlert();
});

afterEach(() => {
  client.clear();
  forgetValidators();
  resetAuthForTests();
  jest.restoreAllMocks();
});

describe('before the confirmation', () => {
  it('shows what is deleted and what is kept', async () => {
    respondWith({ status: 200, body: RECEIPT_BODY });
    await renderFlow();
    expect(screen.getByText(en.accountDeleteWhatGoesSignIn)).toBeTruthy();
    expect(screen.getByText(en.accountDeleteWhatGoesData)).toBeTruthy();
    expect(screen.getByText(en.accountDeleteWhatGoesIntegrations)).toBeTruthy();
    expect(screen.getByText(en.accountDeleteWhatStaysCrash)).toBeTruthy();
    expect(screen.getByText(en.accountDeleteWhatStaysBackups)).toBeTruthy();
    expect(screen.getByText(en.accountDeleteWhatStaysReceipt)).toBeTruthy();
    // No invented URL: the policy link only appears once one is configured.
    expect(screen.queryByLabelText(en.accountDeleteReadMore)).toBeNull();
  });

  it('says it is permanent, without pleading', async () => {
    respondWith({ status: 200, body: RECEIPT_BODY });
    await renderFlow();
    expect(screen.getByText(en.accountDeleteLede)).toBeTruthy();
    // No type-to-confirm: Apple asks that deletion not be made burdensome.
    expect(screen.queryByLabelText(/type/i)).toBeNull();
  });

  it('makes ZERO requests when the alert is cancelled', async () => {
    respondWith({ status: 200, body: RECEIPT_BODY });
    await renderFlow();
    await fireEvent.press(screen.getByLabelText(en.accountDeleteAction));
    // The alert was raised but nothing was chosen yet.
    expect(requests.filter(r => r.method === 'DELETE')).toHaveLength(0);
    // Cancel is the alert's cancel-styled button.
    expect(alertButtons[0]).toMatchObject({ text: en.accountDeleteConfirmCancel, style: 'cancel' });
    expect(alertButtons[0]?.onPress).toBeUndefined();
    expect(requests.filter(r => r.method === 'DELETE')).toHaveLength(0);
  });

  it('disables the action while offline', async () => {
    onlineManager.setOnline(false);
    respondWith({ status: 200, body: RECEIPT_BODY });
    await renderFlow();
    expect(screen.getByText(en.accountDeleteOfflineNote)).toBeTruthy();
    expect(screen.getByLabelText(en.accountDeleteAction).props.accessibilityState.disabled).toBe(true);
  });
});

describe('the confirmed deletion', () => {
  it('makes exactly one DELETE request', async () => {
    respondWith({ status: 200, body: RECEIPT_BODY });
    await renderFlow();
    await fireEvent.press(screen.getByLabelText(en.accountDeleteAction));
    await tapAlert(en.accountDeleteConfirmProceed);
    expect(requests.filter(r => r.method === 'DELETE')).toHaveLength(1);
  });

  it('shows the receipt id on screen', async () => {
    respondWith({ status: 200, body: RECEIPT_BODY });
    await renderFlow();
    await fireEvent.press(screen.getByLabelText(en.accountDeleteAction));
    await tapAlert(en.accountDeleteConfirmProceed);

    // The whole point: the user is owed proof, and a receipt that only ever
    // existed in a promise is not proof they received.
    await waitFor(() => expect(screen.getByTestId('account-deleted')).toBeTruthy());
    expect(screen.getByText(en.accountDeletedTitle)).toBeTruthy();
    expect(screen.getByTestId('receipt-id').props.children).toBe(RECEIPT_ID);
  });

  it('signs out, and still shows the receipt over the sign-in screen', async () => {
    respondWith({ status: 200, body: RECEIPT_BODY });
    await renderFlow();
    await fireEvent.press(screen.getByLabelText(en.accountDeleteAction));
    await tapAlert(en.accountDeleteConfirmProceed);

    await waitFor(() => expect(screen.getByTestId('account-deleted')).toBeTruthy());
    // Signed out behind it, with the reason the sign-in screen will show.
    expect(repository.signOutReasons).toEqual(['deleted']);
    expect(repository.currentUser()).toBeNull();
    // The receipt is above the gate, so sign-in is not what the user sees.
    expect(screen.queryByText(en.authTitle)).toBeNull();
  });

  it('reaches the signed-out app once the receipt is dismissed', async () => {
    respondWith({ status: 200, body: RECEIPT_BODY });
    await renderFlow();
    await fireEvent.press(screen.getByLabelText(en.accountDeleteAction));
    await tapAlert(en.accountDeleteConfirmProceed);
    await waitFor(() => expect(screen.getByTestId('account-deleted')).toBeTruthy());

    await fireEvent.press(screen.getByLabelText(en.accountDeletedContinue));
    await waitFor(() => expect(screen.getByText(en.authTitle)).toBeTruthy());
    expect(screen.queryByTestId('account-deleted')).toBeNull();
    // And it says why, rather than a bare sign-in screen.
    expect(screen.getByText(en.authSignedOutDeleted)).toBeTruthy();
  });

  it('makes no further authenticated request after success', async () => {
    respondWith({ status: 200, body: RECEIPT_BODY });
    await renderFlow();
    await fireEvent.press(screen.getByLabelText(en.accountDeleteAction));
    await tapAlert(en.accountDeleteConfirmProceed);
    await waitFor(() => expect(screen.getByTestId('account-deleted')).toBeTruthy());

    // The Firebase user is gone server-side; the token in hand is dead. A
    // further call would 401 into the generic session-expired path.
    expect(requests.filter(r => r.method === 'DELETE')).toHaveLength(1);
    expect(requests.filter(r => r.method !== 'DELETE')).toEqual([]);
  });

  it('leaves the user signed in and says so when the server fails', async () => {
    respondWith({ status: 500, body: { success: false, error: 'boom' } });
    await renderFlow();
    await fireEvent.press(screen.getByLabelText(en.accountDeleteAction));
    await tapAlert(en.accountDeleteConfirmProceed);

    await waitFor(() => expect(screen.getByText(en.accountDeleteFailed)).toBeTruthy());
    expect(repository.currentUser()).not.toBeNull();
    expect(repository.signOutReasons).toEqual([]);
    expect(screen.queryByTestId('account-deleted')).toBeNull();
  });
});

describe('the privacy invariant', () => {
  it('clears the query cache, the validators and AppContext on success', async () => {
    respondWith({ status: 200, body: RECEIPT_BODY });
    rememberValidator('c1', '"2026-09-12T10:00:00.000Z.abcdef012345"');
    await renderFlow();

    // Something cached, and something in the in-memory app state.
    await waitFor(() => expect(probeText()).toMatch(/^rows:1\|/));
    expect(client.getQueryCache().getAll().length).toBeGreaterThan(0);
    expect(validatorFor('c1')).toBeDefined();

    // And per-user state inside AppContext, which the query cache does not own.
    await act(async () => probe.mutate?.());
    expect(probeText()).toBe('rows:1|day:6|input:29');

    await fireEvent.press(screen.getByLabelText(en.accountDeleteAction));
    await tapAlert(en.accountDeleteConfirmProceed);
    await waitFor(() => expect(screen.getByTestId('account-deleted')).toBeTruthy());

    expect(client.getQueryCache().getAll()).toEqual([]);
    // A validator is a fact about the deleted account's commitments.
    expect(validatorFor('c1')).toBeUndefined();

    // The probe lives inside the gate, and the receipt renders above it — so
    // it is unmounted here, which is itself correct. Dismissing the receipt
    // brings the signed-out app back, and the open day and half-typed capture
    // must be gone from it: a screen re-rendering from AppContext would
    // otherwise still show the deleted account's work.
    await fireEvent.press(screen.getByLabelText(en.accountDeletedContinue));
    await waitFor(() => expect(screen.getByText(en.authTitle)).toBeTruthy());
    expect(probeText()).toBe('rows:0|day:4|input:0');
  });

  it('never shows account A data to account B', async () => {
    respondWith({ status: 200, body: RECEIPT_BODY });
    await renderFlow();
    await waitFor(() => expect(probeText()).toMatch(/^rows:1\|/));

    await fireEvent.press(screen.getByLabelText(en.accountDeleteAction));
    await tapAlert(en.accountDeleteConfirmProceed);
    await waitFor(() => expect(screen.getByTestId('account-deleted')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText(en.accountDeletedContinue));

    // B signs in on the same device, and nothing of A's may reach them — not
    // a row, not a validator, not a frame before a refetch lands.
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () => new Promise(() => {})) as never;
    await act(async () => {
      repository.emit(userWith('blake'));
    });

    expect(probeText()).toMatch(/^rows:0\|/);
    expect(validatorFor('c1')).toBeUndefined();
    expect(client.getQueryCache().findAll({ queryKey: ['user', 'alice'] })).toEqual([]);
  });
});
