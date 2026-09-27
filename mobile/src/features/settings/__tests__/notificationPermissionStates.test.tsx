/**
 * The reminders screen after the phone said no (closure CL2b, complaint #18).
 *
 * Simulator run 2026-09-26, shot 84: notifications were denied at the OS
 * prompt, and Settings → Reminders still opened on «تلفونك رح يسألك قبل — مش
 * هلّق» with the gentle-reminders switch on and nothing on screen to fix it.
 * The denied line and the settings link did exist — at the very bottom, under
 * the whole morning-plan card, two screens below the fold. The intro was
 * onboarding's sentence, true only before anybody had been asked.
 *
 * So, per state:
 *   undetermined  the intro says the phone will ask (or asks, when something
 *                 is already on);
 *   granted       the intro says what reminders do, and nothing else;
 *   denied        the top of the screen says the phone blocks them, with
 *                 «افتح إعدادات التلفون», and every switch that is on says it
 *                 cannot deliver.
 * Read on mount and again whenever the app comes back to the foreground.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppState, Linking, type AppStateStatus } from 'react-native';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { NotificationsSettingsScreen } from '../NotificationsSettingsScreen';
import en from '../../../i18n/locales/en.json';
import * as reminderEndpoints from '../../../api/endpoints/reminders';
import * as planEndpoints from '../../../api/endpoints/plans';
import * as profileEndpoints from '../../../api/endpoints/profile';
import * as permission from '../../../notifications/permission';
import reminderFixture from '../../../api/__fixtures__/reminders.settingsDefault.json';
import type { PlanSettings } from '../../../api/schemas/plan';
import { SettingsScreen } from '../../../screens/SettingsScreen';
import * as trustEndpoints from '../../../api/endpoints/trust';
import { deferred } from '../../../testing/deferred';
import { ltr, fill } from '../../../i18n/strings';
import type { NotificationPermission } from '../../../notifications/permission';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'permission-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

const PLAN_ON: PlanSettings = {
  enabled: true, deliveryLocalTime: '07:30', timezone: 'Asia/Jerusalem', nextRunAt: null, continuousReplanEnabled: true,
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function softOff() {
  return { ...reminderFixture, reminderSettings: { ...reminderFixture.reminderSettings, softEnabled: false } };
}

function captureAppState() {
  const listeners: ((state: AppStateStatus) => void)[] = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, listener: (state: AppStateStatus) => void) => {
    listeners.push(listener);
    return { remove: () => {} };
  }) as never);
  return (state: AppStateStatus) => { for (const listener of listeners) listener(state); };
}

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  // The default the server answers for a new account: gentle reminders ON.
  jest.spyOn(reminderEndpoints, 'getReminderSettings').mockResolvedValue(reminderFixture as never);
  jest.spyOn(reminderEndpoints, 'putReminderSettings').mockResolvedValue(reminderFixture as never);
  jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue({ success: true, routine: null } as never);
  jest.spyOn(planEndpoints, 'getPlanSettings').mockResolvedValue(PLAN_ON as never);
  jest.spyOn(permission, 'requestNotificationPermission').mockResolvedValue('granted');
  jest.spyOn(permission, 'getNotificationPermission').mockResolvedValue('granted');
});

afterEach(async () => {
  cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function show() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <NotificationsSettingsScreen onBack={() => {}} />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('gentle-reminders-switch').props.accessibilityState?.disabled).toBe(false));
  await waitFor(() => expect(screen.getByTestId('plan-morning-toggle').props.accessibilityState?.disabled).toBe(false));
  await waitFor(() => expect(permission.getNotificationPermission).toHaveBeenCalled());
  await new Promise(resolve => setTimeout(resolve, 0));
}

/** Where a testID first appears in the rendered tree — screen order, top first. */
function positionOf(testID: string): number {
  return JSON.stringify(screen.toJSON()).indexOf(`"testID":"${testID}"`);
}

describe('denied', () => {
  beforeEach(() => {
    jest.spyOn(permission, 'getNotificationPermission').mockResolvedValue('denied');
  });

  it('does not say the phone will ask "later" once it has said no', async () => {
    await show();
    expect(screen.queryByText(en.obNotifBody)).toBeNull();
    expect(screen.queryByText(en.notifIntroAsk)).toBeNull();
  });

  it('says so at the top, above the switches, with the way to phone settings', async () => {
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined as never);
    await show();
    const status = screen.getByTestId('notifications-status');
    expect(within(status).queryByText(en.notifDenied)).not.toBeNull();
    expect(within(status).queryByTestId('notifications-open-settings')).not.toBeNull();
    // The shot-84 defect: the link was there, under the whole plan card.
    expect(positionOf('notifications-open-settings')).toBeGreaterThanOrEqual(0);
    expect(positionOf('notifications-open-settings')).toBeLessThan(positionOf('gentle-reminders'));

    await fireEvent.press(within(status).getByTestId('notifications-open-settings'));
    expect(open).toHaveBeenCalledTimes(1);
    open.mockClear();
  });

  it('marks the switches that are on as blocked by the phone, without turning them off', async () => {
    await show();
    // The saved choice stays — allowing notifications later simply works.
    expect(screen.getByTestId('gentle-reminders-switch').props.value).toBe(true);
    expect(screen.queryByTestId('gentle-reminders-switch-blocked')).not.toBeNull();
    expect(screen.queryByTestId('plan-morning-toggle-blocked')).not.toBeNull();
    expect(screen.getAllByText(en.notifBlockedByPhone).length).toBe(2);
    expect(reminderEndpoints.putReminderSettings).not.toHaveBeenCalled();
  });

  it('marks nothing blocked on a switch that is off', async () => {
    jest.spyOn(reminderEndpoints, 'getReminderSettings').mockResolvedValue(softOff() as never);
    await show();
    expect(screen.queryByTestId('gentle-reminders-switch-blocked')).toBeNull();
  });

  it('clears when the app comes back after the user allowed notifications', async () => {
    const fire = captureAppState();
    const read = jest.spyOn(permission, 'getNotificationPermission').mockResolvedValue('denied');
    await show();
    expect(screen.queryByTestId('gentle-reminders-switch-blocked')).not.toBeNull();

    read.mockResolvedValue('granted');
    await act(async () => { fire('active'); });

    await waitFor(() => expect(screen.queryByTestId('gentle-reminders-switch-blocked')).toBeNull());
    expect(screen.queryByTestId('notifications-open-settings')).toBeNull();
    expect(screen.queryByText(en.notifIntroOn)).not.toBeNull();
  });
});

describe('granted', () => {
  it('says what reminders do, and nothing about asking or settings', async () => {
    await show();
    expect(within(screen.getByTestId('notifications-status')).queryByText(en.notifIntroOn)).not.toBeNull();
    expect(screen.queryByText(en.obNotifBody)).toBeNull();
    expect(screen.queryByTestId('notifications-open-settings')).toBeNull();
    expect(screen.queryByTestId('gentle-reminders-switch-blocked')).toBeNull();
    expect(screen.queryByTestId('plan-morning-toggle-blocked')).toBeNull();
  });
});

describe('undetermined', () => {
  beforeEach(() => {
    jest.spyOn(permission, 'getNotificationPermission').mockResolvedValue('undetermined');
  });

  it('asks in the app, at the top, when something is already on', async () => {
    await show();
    const status = screen.getByTestId('notifications-status');
    expect(within(status).queryByTestId('notifications-allow')).not.toBeNull();
    expect(positionOf('notifications-allow')).toBeLessThan(positionOf('gentle-reminders'));
    expect(screen.queryByTestId('notifications-open-settings')).toBeNull();
    expect(permission.requestNotificationPermission).not.toHaveBeenCalled();
  });

  it('says the phone will ask when reminders are turned on, when nothing is on yet', async () => {
    jest.spyOn(reminderEndpoints, 'getReminderSettings').mockResolvedValue(softOff() as never);
    jest.spyOn(planEndpoints, 'getPlanSettings').mockResolvedValue({ ...PLAN_ON, enabled: false } as never);
    await show();
    expect(within(screen.getByTestId('notifications-status')).queryByText(en.notifIntroAsk)).not.toBeNull();
    expect(screen.queryByTestId('notifications-allow')).toBeNull();
    expect(screen.queryByTestId('notifications-open-settings')).toBeNull();
  });
});

/*
 * Round 2 (review m1): before the first read lands the screen does not know
 * what the phone allows, so it must not claim anything — not even for one
 * frame. A denied user saw "reminds you at the times you chose" flash first.
 */
describe('before the phone has answered', () => {
  it('shows a neutral checking line, not a claim, until the first read resolves', async () => {
    const answer = deferred<NotificationPermission>();
    jest.spyOn(permission, 'getNotificationPermission').mockReturnValue(answer.promise);
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <AuthProvider repository={repository} isDevBundle={false}>
            <QueryClientProvider client={client}>
              <NotificationsSettingsScreen onBack={() => {}} />
            </QueryClientProvider>
          </AuthProvider>
        </AppProvider>
      </SafeAreaProvider>,
    );
    await waitFor(() => expect(permission.getNotificationPermission).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('gentle-reminders-switch').props.accessibilityState?.disabled).toBe(false));
    // Asked, unanswered: nothing true can be said yet except that.
    const status = screen.getByTestId('notifications-status');
    expect(within(status).queryByText(en.notifIntroChecking)).not.toBeNull();
    expect(screen.queryByText(en.notifIntroOn)).toBeNull();
    expect(screen.queryByText(en.notifIntroAsk)).toBeNull();
    expect(screen.queryByTestId('gentle-reminders-switch-blocked')).toBeNull();

    await act(async () => { answer.resolve('denied'); });
    await waitFor(() => expect(screen.queryByTestId('notifications-open-settings')).not.toBeNull());
    expect(screen.queryByText(en.notifIntroChecking)).toBeNull();
    expect(screen.queryByText(en.notifIntroOn)).toBeNull();
  });
});

/*
 * Round 2 (review m2): the Settings list's morning-plan row said "Arrives at
 * 07:30" while the phone blocked every notification — a promise the phone
 * would not keep. It says it is blocked instead, read the same way (mount
 * and foreground).
 */
describe('the Settings list', () => {
  async function showList() {
    jest.spyOn(trustEndpoints, 'getTrust')
      .mockResolvedValue({ success: true, participantId: USER.uid, trust: { analyticsConsent: false } } as never);
    jest.spyOn(profileEndpoints, 'listMemory').mockResolvedValue({ items: [], suggestions: [], adaptive: null } as never);
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <AuthProvider repository={repository} isDevBundle={false}>
            <QueryClientProvider client={client}>
              <SettingsScreen />
            </QueryClientProvider>
          </AuthProvider>
        </AppProvider>
      </SafeAreaProvider>,
    );
    await waitFor(() => expect(permission.getNotificationPermission).toHaveBeenCalled());
  }
  const arrives = fill(en.settingsMorningSub, { t: ltr(PLAN_ON.deliveryLocalTime) });

  it('does not promise the morning note while the phone blocks notifications', async () => {
    jest.spyOn(permission, 'getNotificationPermission').mockResolvedValue('denied');
    await showList();
    await waitFor(() => expect(screen.queryByTestId('settings-morning-blocked')).not.toBeNull());
    expect(screen.queryByText(arrives)).toBeNull();
    expect(screen.getByTestId('settings-morning-blocked').props.children).toBe(en.notifBlockedByPhone);
  });

  it('says when it arrives once the phone allows it', async () => {
    await showList();
    await waitFor(() => expect(screen.queryByText(arrives)).not.toBeNull());
    expect(screen.queryByTestId('settings-morning-blocked')).toBeNull();
  });

  it('clears the blocked line when the app comes back after the user allowed notifications', async () => {
    const fire = captureAppState();
    const read = jest.spyOn(permission, 'getNotificationPermission').mockResolvedValue('denied');
    await showList();
    await waitFor(() => expect(screen.queryByTestId('settings-morning-blocked')).not.toBeNull());
    read.mockResolvedValue('granted');
    await act(async () => { fire('active'); });
    await waitFor(() => expect(screen.queryByText(arrives)).not.toBeNull());
    expect(screen.queryByTestId('settings-morning-blocked')).toBeNull();
  });
});
