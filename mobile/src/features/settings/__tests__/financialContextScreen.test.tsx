/**
 * Settings → Financial context (#financial-v1).
 *
 * What this file carries is the promise the feature makes on screen: every
 * figure says where it came from, a disagreement is shown rather than
 * resolved out of sight, and a bill the source found stays anonymous. The
 * fixtures are the ones the route exporter recorded from the real handlers,
 * so what is rendered here is what the server actually sends.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import en from '../../../i18n/locales/en.json';
import { FinancialContextScreen } from '../FinancialContextScreen';
import * as financialEndpoints from '../../../api/endpoints/financial';
import contextFixture from '../../../api/__fixtures__/financial.context.json';
import connectedFixture from '../../../api/__fixtures__/financial.connected.json';
import connectionOffFixture from '../../../api/__fixtures__/financial.connectionOff.json';
import {
  financialConnectionSchema,
  financialContextResponseSchema,
} from '../../../api/schemas/financial';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'financial-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

const CONTEXT = financialContextResponseSchema.parse(contextFixture);
const CONNECTED = financialConnectionSchema.parse(connectedFixture);
const DISCONNECTED = financialConnectionSchema.parse(connectionOffFixture);

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(financialEndpoints, 'getFinancialContext').mockResolvedValue(CONTEXT);
  jest.spyOn(financialEndpoints, 'getFinancialConnection').mockResolvedValue(CONNECTED);
});

afterEach(async () => {
  cleanup();
  // A real macrotask, for the reason the calendar screen's test gives: a
  // request settling after the tree came down leaves React work in flight and
  // RNTL v14's next `render` mounts nothing.
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function show() {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <FinancialContextScreen onBack={() => {}} />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

describe('the picture', () => {
  it('shows the buffer, the band and when it was true', async () => {
    await show();
    await waitFor(() => expect(screen.getByTestId('financial-buffer')).toBeTruthy());
    // The fixture is overdrawn on purpose: -62,200 minor units.
    expect(screen.getByTestId('financial-buffer').props.children).toContain('-622.00');
    expect(screen.getByTestId('financial-band').props.children).toBe(en.financialBandNegative);
    expect(screen.getByTestId('financial-as-of')).toBeTruthy();
  });

  it('says where every figure came from', async () => {
    await show();
    await waitFor(() => expect(screen.getByTestId('financial-cash-origin')).toBeTruthy());
    // The fixture's cash figure is a correction the user made.
    expect(screen.getByTestId('financial-cash-origin').props.children).toBe(en.financialFromYou);
    // And the buffer is arithmetic over both, which it says rather than
    // claiming the bank vouched for it.
    expect(screen.getByTestId('financial-buffer-origin').props.children).toContain(en.financialComputed);
  });
});

describe('a disagreement', () => {
  it('is shown, with both numbers and which one is being used', async () => {
    await show();
    await waitFor(() => expect(screen.getByTestId('financial-conflicts')).toBeTruthy());
    expect(screen.getByTestId('financial-conflict-cash_available')).toBeTruthy();
    expect(screen.getByTestId('financial-conflict-cash_available-using').props.children)
      .toBe(en.financialUsingYours);
  });

  it('is not hidden when there is nothing to hide', async () => {
    jest.spyOn(financialEndpoints, 'getFinancialContext').mockResolvedValue({
      ...CONTEXT,
      state: { ...CONTEXT.state, conflicts: [] },
    });
    await show();
    await waitFor(() => expect(screen.getByTestId('financial-buffer')).toBeTruthy());
    expect(screen.queryByTestId('financial-conflicts')).toBeNull();
  });
});

describe('what a bill is allowed to say', () => {
  it('shows a category for one the source found, and the words the user typed for theirs', async () => {
    await show();
    await waitFor(() => expect(screen.getByTestId('financial-obligations')).toBeTruthy());
    const rendered = JSON.stringify(screen.toJSON());
    expect(rendered).toContain('Semester B tuition');
    expect(rendered).toContain(en.financialCategoryRent);
  });

  it('never shows a merchant, an account or a transaction id', async () => {
    await show();
    await waitFor(() => expect(screen.getByTestId('financial-obligations')).toBeTruthy());
    const rendered = JSON.stringify(screen.toJSON());
    for (const sentinel of ['MCDONALDS', 'ZEBRAHOUSE', 'sbx-txn-', 'sbx-acct-', '****4432', 'Platinum Card']) {
      expect(rendered).not.toContain(sentinel);
    }
  });

  it('adds a user-entered bill with validated minor units and due date', async () => {
    const save = jest.spyOn(financialEndpoints, 'putFinancialObligation')
      .mockResolvedValue({
        success: true,
        obligation: {
          obligationId: 'manual-course-materials',
          label: 'Course materials',
          category: 'other',
          dueAt: '2026-10-04T12:00:00.000Z',
          amountMinorUnits: 4_275,
          currency: 'EUR',
          recurring: false,
          observedAt: '2026-09-23T12:00:00.000Z',
        },
      });
    await show();
    await waitFor(() => expect(screen.getByTestId('financial-bill-label')).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId('financial-bill-label'), 'Course materials');
    await fireEvent.changeText(screen.getByTestId('financial-bill-amount'), '42.75');
    await fireEvent.changeText(screen.getByTestId('financial-bill-currency'), 'eur');
    await fireEvent.changeText(screen.getByTestId('financial-bill-date'), '2026-10-04');
    await waitFor(() => expect(screen.getByTestId('financial-bill-date').props.value).toBe('2026-10-04'));
    await fireEvent.press(screen.getByTestId('financial-bill-save'));

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]?.[0]).toEqual({
      label: 'Course materials',
      category: 'other',
      dueAt: '2026-10-04T12:00:00.000Z',
      amountMinorUnits: 4_275,
      currency: 'EUR',
      recurring: false,
    });
    await waitFor(() => expect(screen.getByTestId('financial-bill-label').props.value).toBe(''));
  });

  it('only offers removal for a bill entered by the user and sends its opaque id', async () => {
    const remove = jest.spyOn(financialEndpoints, 'deleteFinancialObligation')
      .mockResolvedValue({ success: true });
    await show();
    await waitFor(() => expect(screen.getByTestId('financial-obligations')).toBeTruthy());

    expect(screen.queryByTestId('financial-obligation-remove-3e1bfa199e5c1611dea8f3c625af838d')).toBeNull();
    await fireEvent.press(screen.getByTestId('financial-obligation-remove-00000000-0000-4000-8000-000000000001'));

    await waitFor(() => expect(remove).toHaveBeenCalled());
    expect(remove.mock.calls[0]?.[0]).toBe('00000000-0000-4000-8000-000000000001');
    await new Promise(resolve => setTimeout(resolve, 0));
  });
});

describe('correcting a figure', () => {
  it('sends a correction, in minor units', async () => {
    const save = jest.spyOn(financialEndpoints, 'putFinancialField')
      .mockResolvedValue({ success: true as const });
    await show();
    await waitFor(() => expect(screen.getByTestId('financial-correction-input')).toBeTruthy());

    fireEvent.changeText(screen.getByTestId('financial-correction-input'), '1800');
    // Waiting on the input's own value, not on the button's disabled state:
    // the handler reads the typed text out of a closure, so what has to have
    // settled is the text, and `accessibilityState` is not where a Pressable
    // in this app reports it.
    await waitFor(() => expect(screen.getByTestId('financial-correction-input').props.value).toBe('1800'));
    fireEvent.press(screen.getByTestId('financial-correction-save'));

    // The first argument only. TanStack Query v5 passes a second one — the
    // client, the meta and the mutation key — so `toHaveBeenCalledWith` on the
    // variables alone fails on arity rather than on what was sent.
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]?.[0]).toEqual({
      field: 'cash_available',
      kind: 'correction',
      value: 180_000,
    });
  });

  it('offers the way back to the source\'s figure, and only when there is one to go back from', async () => {
    await show();
    await waitFor(() => expect(screen.getByTestId('financial-correction-undo')).toBeTruthy());

    cleanup();
    await new Promise(resolve => setTimeout(resolve, 0));
    jest.spyOn(financialEndpoints, 'getFinancialContext').mockResolvedValue({
      ...CONTEXT,
      state: {
        ...CONTEXT.state,
        cashAvailable: {
          ...CONTEXT.state.cashAvailable!,
          provenance: { ...CONTEXT.state.cashAvailable!.provenance, origin: 'provider' as const },
        },
      },
    });
    await show();
    // Waiting on the *origin* line, not on the row: the row renders before the
    // request lands, so waiting for it would assert against the empty state.
    await waitFor(() => expect(screen.getByTestId('financial-cash-origin').props.children)
      .toBe(en.financialFromSource));
    expect(screen.queryByTestId('financial-correction-undo')).toBeNull();
  });

  it('refuses text that is not a figure, instead of filing a zero', async () => {
    const save = jest.spyOn(financialEndpoints, 'putFinancialField')
      .mockResolvedValue({ success: true as const });
    await show();
    await waitFor(() => expect(screen.getByTestId('financial-correction-input')).toBeTruthy());

    fireEvent.changeText(screen.getByTestId('financial-correction-input'), 'about two thousand');
    await waitFor(() => expect(screen.getByTestId('financial-correction-input').props.value)
      .toBe('about two thousand'));
    fireEvent.press(screen.getByTestId('financial-correction-save'));

    await waitFor(() => expect(screen.getByTestId('financial-save-failed')).toBeTruthy());
    expect(save).not.toHaveBeenCalled();
  });

  it('says so when it did not save, rather than looking like it did', async () => {
    jest.spyOn(financialEndpoints, 'putFinancialField').mockRejectedValue(new Error('nope'));
    await show();
    await waitFor(() => expect(screen.getByTestId('financial-correction-input')).toBeTruthy());

    fireEvent.changeText(screen.getByTestId('financial-correction-input'), '1800');
    await waitFor(() => expect(screen.getByTestId('financial-correction-input').props.value).toBe('1800'));
    fireEvent.press(screen.getByTestId('financial-correction-save'));

    await waitFor(() => expect(screen.getByTestId('financial-save-failed')).toBeTruthy());
  });
});

describe('the source', () => {
  it('is named as a sandbox, not as a bank', async () => {
    await show();
    await waitFor(() => expect(screen.getByTestId('financial-connection-state').props.children)
      .toBe(en.financialSourceSandbox));
  });

  it('with nothing connected, still shows the screen and invites filling it in', async () => {
    jest.spyOn(financialEndpoints, 'getFinancialConnection').mockResolvedValue(DISCONNECTED);
    await show();
    await waitFor(() => expect(screen.getByTestId('financial-cash')).toBeTruthy());
    expect(screen.getByTestId('financial-connection-state').props.children).toBe(en.financialSourceNone);
    expect(screen.getByTestId('financial-connect-toggle')).toBeTruthy();
  });
});
