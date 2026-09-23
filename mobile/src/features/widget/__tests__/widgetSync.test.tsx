/**
 * The widget snapshot, wired into the real app (UC-3.R1, #203).
 *
 * Mounted through `Root` rather than the hook alone, so the tests fail if the
 * host is ever unmounted from the signed-in tree, if the Settings row or the
 * screen case comes undone, or if sign-out stops clearing. The only fake is the
 * native bridge — the one piece that has no implementation under Jest — and it
 * records exactly the bytes a device's App Group would receive.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppState, Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider, useAuth } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { resetBeforeSignOutForTests } from '../../../auth/beforeSignOut';
import type { AuthUser } from '../../../auth/types';
import { Root } from '../../../Root';
import en from '../../../i18n/locales/en.json';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as nextStepEndpoints from '../../../api/endpoints/nextStep';
import * as trustEndpoints from '../../../api/endpoints/trust';
import * as categoryEndpoints from '../../../api/endpoints/categories';
import nextStepFixture from '../../../api/__fixtures__/nextStep.recommendation.json';
import {
  loadWidgetTitlesAllowed,
  resetWidgetSettingsForTests,
  widgetTitlesKey,
} from '../../../lib/deviceSettings/widget';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Commitment } from '../../../api/schemas/common';

type Call = { op: 'write'; json: string } | { op: 'clear' };
const calls: Call[] = [];

jest.mock('../widgetBridge', () => ({
  createNativeWidgetBridge: () => ({
    write: async (json: string) => {
      calls.push({ op: 'write', json });
    },
    clear: async () => {
      calls.push({ op: 'clear' });
    },
  }),
}));

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'widget-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

const SECRET_TODAY = 'Pay the rent to Sami';
const SECRET_NEXT = 'موعد الدكتور';

function commitment(id: string, title: string): Commitment {
  return {
    id,
    kind: 'task',
    title,
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'high', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    category: null,
    categorySource: 'inferred',
    timeSpec: { kind: 'due_by', dueAt: '2099-01-01T12:00:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: 'UTC' },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    confirmedAt: '2026-09-01T09:00:00.000Z',
    completedAt: null,
    droppedAt: null,
  } as Commitment;
}

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;
/** A button outside `Root` that signs out the way Settings does. */
function SignOutProbe() {
  const auth = useAuth();
  return <Text testID="probe-sign-out" onPress={() => void auth.signOut()}>out</Text>;
}

beforeEach(async () => {
  calls.length = 0;
  resetWidgetSettingsForTests();
  await AsyncStorage.clear();
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(commitmentEndpoints, 'listToday')
    .mockResolvedValue({ items: [commitment('c-today', SECRET_TODAY)] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(nextStepEndpoints, 'getNextStep').mockResolvedValue({
    ...nextStepFixture,
    recommendation: { ...nextStepFixture.recommendation, primaryStep: { commitmentId: 'c-next', title: SECRET_NEXT } },
  } as never);
  jest.spyOn(trustEndpoints, 'getTrust')
    .mockResolvedValue({ success: true, participantId: USER.uid, trust: { analyticsConsent: false } } as never);
  jest.spyOn(categoryEndpoints, 'getCategoryPreferences')
    .mockResolvedValue({ success: true, categoryPreferences: { enabled: [], grouping: false } } as never);
});

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  resetBeforeSignOutForTests();
  jest.restoreAllMocks();
});

async function openApp() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <SignOutProbe />
            <Root />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('tab-capture')).not.toBeNull());
}

const writes = () => calls.filter((call): call is { op: 'write'; json: string } => call.op === 'write');
const lastWrite = () => {
  const all = writes();
  return all.length > 0 ? JSON.parse(all[all.length - 1]!.json) : null;
};

/** Waits until the last snapshot carries both the next step and Today's item. */
async function settled() {
  await waitFor(() => {
    const ids = (lastWrite()?.items ?? []).map((item: { id: string }) => item.id);
    expect(ids).toEqual(['c-next', 'c-today']);
  });
}

async function openWidgetSettings() {
  await fireEvent.press(screen.getByLabelText(en.tabSettings));
  await waitFor(() => expect(screen.queryByTestId('settings-widget')).not.toBeNull());
  await fireEvent.press(screen.getByLabelText(en.settingsWidget));
  await waitFor(() => expect(screen.queryByTestId('widget-titles-toggle')).not.toBeNull());
}

describe('the widget snapshot in the running app', () => {
  it('writes no title into shared storage by default — not one, in any write', async () => {
    await openApp();
    await settled();
    for (const call of writes()) {
      expect(call.json).not.toContain(SECRET_TODAY);
      expect(call.json).not.toContain(SECRET_NEXT);
    }
    expect(lastWrite().items[0]).toMatchObject({ title: en.widgetPrivateCommitment, titleRedacted: true, isNextStep: true });
  });

  it('shows titles after the opt-in, and rewrites without them within a second of turning it off', async () => {
    await openApp();
    await settled();
    await openWidgetSettings();

    await fireEvent(screen.getByTestId('widget-titles-toggle'), 'valueChange', true);
    await waitFor(() => expect(lastWrite().items.map((i: { title: string }) => i.title)).toEqual([SECRET_NEXT, SECRET_TODAY]));
    expect(await AsyncStorage.getItem(widgetTitlesKey(USER.uid))).toBe('true');

    const before = writes().length;
    await fireEvent(screen.getByTestId('widget-titles-toggle'), 'valueChange', false);
    await waitFor(() => {
      expect(writes().length).toBeGreaterThan(before);
      expect(writes()[writes().length - 1]!.json).not.toContain(SECRET_TODAY);
      expect(writes()[writes().length - 1]!.json).not.toContain(SECRET_NEXT);
    }, { timeout: 1000 });
    expect(await AsyncStorage.getItem(widgetTitlesKey(USER.uid))).toBeNull();
  });

  it('still takes titles out of shared storage when turned off after Today stopped loading', async () => {
    await openApp();
    await settled();
    await openWidgetSettings();
    await fireEvent(screen.getByTestId('widget-titles-toggle'), 'valueChange', true);
    await waitFor(() => expect(lastWrite().items[0].title).toBe(SECRET_NEXT));

    // Offline: every refetch fails from here on.
    jest.spyOn(commitmentEndpoints, 'listToday').mockRejectedValue(new Error('offline'));
    jest.spyOn(nextStepEndpoints, 'getNextStep').mockRejectedValue(new Error('offline'));
    await act(async () => {
      await client.refetchQueries().catch(() => {});
    });

    const before = calls.length;
    await fireEvent(screen.getByTestId('widget-titles-toggle'), 'valueChange', false);
    await waitFor(() => {
      const after = calls.slice(before);
      expect(after.length).toBeGreaterThan(0);
      for (const call of after) {
        if (call.op === 'write') {
          expect(call.json).not.toContain(SECRET_TODAY);
          expect(call.json).not.toContain(SECRET_NEXT);
        }
      }
    }, { timeout: 1000 });
  });

  it('clears what an earlier session stored when there is no list to redact it from', async () => {
    jest.spyOn(commitmentEndpoints, 'listToday').mockRejectedValue(new Error('offline'));
    await openApp();
    await waitFor(() => expect(calls.some((call) => call.op === 'clear')).toBe(true));
    expect(writes()).toHaveLength(0);
  });

  it('previews exactly what the widget will draw', async () => {
    await openApp();
    await settled();
    await openWidgetSettings();
    await waitFor(() => expect(screen.getAllByTestId('widget-preview-item')).toHaveLength(2));
    expect(screen.queryByText(SECRET_TODAY)).toBeNull();
    expect(screen.getAllByText(en.widgetPrivateCommitment)).toHaveLength(2);
  });

  it('does not carry one account’s opt-in to the next account on the same phone', async () => {
    await AsyncStorage.setItem(widgetTitlesKey('someone-else'), 'true');
    expect(await loadWidgetTitlesAllowed(USER.uid)).toBe(false);
    await openApp();
    await settled();
    expect(writes().some((call) => call.json.includes(SECRET_TODAY))).toBe(false);
  });

  it('clears the widget on sign-out, and writes nothing after the clear', async () => {
    await openApp();
    await settled();
    await act(async () => {
      fireEvent.press(screen.getByTestId('probe-sign-out'));
    });
    await waitFor(() => expect(calls.some((call) => call.op === 'clear')).toBe(true));
    const firstClear = calls.findIndex((call) => call.op === 'clear');
    expect(calls.slice(firstClear).every((call) => call.op === 'clear')).toBe(true);
  });

  it('clears the widget when the signed-in tree goes away without a sign-out the user pressed', async () => {
    // Session expired, access revoked and account deleted all unmount Root
    // without running the before-sign-out tasks (`signOutExpired` skips them),
    // so the unmount is the only clear those paths get.
    await openApp();
    await settled();
    resetBeforeSignOutForTests();
    const before = calls.length;
    await act(async () => {
      screen.unmount();
    });
    await waitFor(() => expect(calls.slice(before).some((call) => call.op === 'clear')).toBe(true));
  });

  it('republishes when the app goes to the background', async () => {
    const listeners: ((state: string) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((type: string, listener: (state: string) => void) => {
      if (type === 'change') listeners.push(listener);
      return { remove: () => {} };
    }) as never);
    await openApp();
    await settled();
    const before = writes().length;
    await act(async () => {
      listeners.forEach((listener) => listener('background'));
    });
    await waitFor(() => expect(writes().length).toBeGreaterThan(before));
  });
});
