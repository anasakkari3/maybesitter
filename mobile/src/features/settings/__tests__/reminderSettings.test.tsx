/**
 * The reminders screen (UC-3.11, #196).
 *
 * Three claims, each with a test that goes red when it stops holding:
 *
 *  - the OS prompt is asked on the way *on*, and nowhere else;
 *  - a denial does not roll the setting back — it says what the phone is set to
 *    and leaves the switch where the user put it;
 *  - the quiet-hours chips write the same four windows the routine survey
 *    writes, into the same place.
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
import { NotificationsSettingsScreen } from '../NotificationsSettingsScreen';
import en from '../../../i18n/locales/en.json';
import * as reminderEndpoints from '../../../api/endpoints/reminders';
import * as permission from '../../../notifications/permission';
import settingsFixture from '../../../api/__fixtures__/reminders.settingsSaved.json';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'reminder-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function settings(overrides: Partial<typeof settingsFixture.reminderSettings> = {}) {
  return { ...settingsFixture, reminderSettings: { ...settingsFixture.reminderSettings, ...overrides } };
}

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(reminderEndpoints, 'getReminderSettings').mockResolvedValue(settings() as never);
  jest.spyOn(reminderEndpoints, 'putReminderSettings').mockResolvedValue(settings() as never);
  jest.spyOn(permission, 'requestNotificationPermission').mockResolvedValue('granted');
});

afterEach(async () => {
  cleanup();
  // A real macrotask: a save still settling when the tree comes down leaves
  // React work in flight, and in RNTL v14 the next `render` then mounts
  // nothing at all.
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
            <NotificationsSettingsScreen onBack={() => {}} />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

/**
 * The switch, once the server's answer has arrived.
 *
 * `ServerToggle` ignores a `valueChange` while `disabled` is set, and this
 * screen sets it until `useReminderSettings` resolves. Waiting only for the
 * control to *exist* therefore fires into a switch that is still loading and
 * proves nothing — which is exactly how the "not asked on the way off" case
 * first went green while doing nothing at all.
 */
async function readySwitch() {
  await waitFor(() => {
    const control = screen.getByTestId('gentle-reminders-switch');
    expect(control.props.accessibilityState?.disabled).toBe(false);
  });
  return screen.getByTestId('gentle-reminders-switch');
}

describe('the OS prompt', () => {
  it('is asked when the user turns reminders on, and not before', async () => {
    jest.spyOn(reminderEndpoints, 'getReminderSettings')
      .mockResolvedValue(settings({ softEnabled: false }) as never);
    await show();
    const control = await readySwitch();

    // Rendering the screen asks nobody anything. iOS allows one prompt per
    // install, and spending it on a screen visit is spending it on nothing.
    expect(permission.requestNotificationPermission).not.toHaveBeenCalled();

    fireEvent(control, 'valueChange', true);
    await waitFor(() => expect(permission.requestNotificationPermission).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(reminderEndpoints.putReminderSettings)
      .toHaveBeenCalledWith({ softEnabled: true }));
  });

  it('is not asked on the way off', async () => {
    await show();
    fireEvent(await readySwitch(), 'valueChange', false);
    await waitFor(() => expect(reminderEndpoints.putReminderSettings)
      .toHaveBeenCalledWith({ softEnabled: false }));
    expect(permission.requestNotificationPermission).not.toHaveBeenCalled();
  });

  it('says what the phone is set to when the answer is no, and saves anyway', async () => {
    jest.spyOn(permission, 'requestNotificationPermission').mockResolvedValue('denied');
    jest.spyOn(reminderEndpoints, 'getReminderSettings')
      .mockResolvedValue(settings({ softEnabled: false }) as never);
    await show();

    fireEvent(await readySwitch(), 'valueChange', true);
    await waitFor(() => expect(screen.queryByTestId('notifications-denied')).not.toBeNull());
    // The setting is what the user wants; the permission is what the phone
    // currently allows. Rolling the setting back would lose the first when
    // they change the second.
    expect(reminderEndpoints.putReminderSettings).toHaveBeenCalledWith({ softEnabled: true });
    expect(screen.queryByText(en.notifDenied)).not.toBeNull();
    // And the way to change the answer is still on the screen.
    expect(screen.queryByTestId('notifications-open-settings')).not.toBeNull();
  });
});

describe('the controls', () => {
  it('sends the lead time the user picked', async () => {
    await show();
    await waitFor(() => expect(screen.queryByTestId('reminder-lead-15')).not.toBeNull());
    fireEvent.press(screen.getByTestId('reminder-lead-15'));
    await waitFor(() => expect(reminderEndpoints.putReminderSettings)
      .toHaveBeenCalledWith({ softLeadMinutes: 15 }));
  });

  it('sends a quiet window the routine survey could re-open on a chip', async () => {
    await show();
    await waitFor(() => expect(screen.queryByTestId('reminder-quiet-early')).not.toBeNull());
    fireEvent.press(screen.getByTestId('reminder-quiet-early'));
    await waitFor(() => expect(reminderEndpoints.putReminderSettings).toHaveBeenCalled());
    const [patch] = (reminderEndpoints.putReminderSettings as jest.Mock).mock.calls.at(-1) as [
      { quietHours: { start: string; end: string; timezone: string } },
    ];
    // The survey's own `early` window. A free picker here could produce
    // 22:17-06:43, which the survey could then only render as "none".
    expect(patch.quietHours.start).toBe('21:30');
    expect(patch.quietHours.end).toBe('06:30');
    expect(patch.quietHours.timezone).toBe(settingsFixture.reminderSettings.timezone);
  });

  it('clears the window when the user picks none', async () => {
    await show();
    await waitFor(() => expect(screen.queryByTestId('reminder-quiet-none')).not.toBeNull());
    fireEvent.press(screen.getByTestId('reminder-quiet-none'));
    await waitFor(() => expect(reminderEndpoints.putReminderSettings)
      .toHaveBeenCalledWith({ quietHours: null }));
  });

  it('hides the lead and quiet controls while reminders are off', async () => {
    jest.spyOn(reminderEndpoints, 'getReminderSettings')
      .mockResolvedValue(settings({ softEnabled: false }) as never);
    await show();
    await waitFor(() => expect(screen.queryByTestId('gentle-reminders-switch')).not.toBeNull());
    expect(screen.queryByTestId('reminder-lead-60')).toBeNull();
    expect(screen.queryByTestId('reminder-quiet-early')).toBeNull();
  });

  it('says so when the save does not land', async () => {
    jest.spyOn(reminderEndpoints, 'putReminderSettings').mockRejectedValue(new Error('offline'));
    await show();
    await waitFor(() => expect(screen.queryByTestId('reminder-lead-30')).not.toBeNull());
    fireEvent.press(screen.getByTestId('reminder-lead-30'));
    await waitFor(() => expect(screen.queryByTestId('notifications-save-failed')).not.toBeNull());
  });
});

describe('the kill switch', () => {
  it('takes the whole section away rather than leaving a dead switch', async () => {
    const previous = process.env.EXPO_PUBLIC_FEATURE_SOFT_REMINDERS;
    process.env.EXPO_PUBLIC_FEATURE_SOFT_REMINDERS = 'false';
    try {
      await show();
      await waitFor(() => expect(screen.queryByTestId('notifications-open-settings')).not.toBeNull());
      expect(screen.queryByTestId('gentle-reminders-switch')).toBeNull();
      expect(screen.queryByTestId('reminder-lead-60')).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.EXPO_PUBLIC_FEATURE_SOFT_REMINDERS;
      else process.env.EXPO_PUBLIC_FEATURE_SOFT_REMINDERS = previous;
    }
  });
});
