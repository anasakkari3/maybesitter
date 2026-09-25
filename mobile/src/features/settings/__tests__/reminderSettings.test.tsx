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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
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
import * as profileEndpoints from '../../../api/endpoints/profile';
import * as exactAlarms from '../../../notifications/exactAlarms';
import { AppState, Linking, Platform, type AppStateStatus } from 'react-native';

// Hoisted above the imports by babel-plugin-jest-hoist, so `i18n/timezone`
// sees it when it reaches for `getCalendars`. The phone is in Berlin; every
// other zone in this file is Asia/Jerusalem, so a screen that sent the
// device's zone when it should not would be visible too.
jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Europe/Berlin' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

/** The account that has answered the routine survey, in Asia/Jerusalem. */
const ROUTINE_PROFILE = {
  success: true,
  routine: {
    schemaVersion: 1,
    timezone: 'Asia/Jerusalem',
    sleepWindow: { start: '23:00', end: '07:00' },
    focusWindows: [],
    fixedCommitmentWindows: [],
    preferredReminderIntensity: 'softAwareness',
    quietHours: { start: '22:00', end: '07:00' },
    surveySkipped: false,
    updatedAt: '2026-08-09T09:00:00.000Z',
  },
};

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
  jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue(ROUTINE_PROFILE as never);
  jest.spyOn(permission, 'requestNotificationPermission').mockResolvedValue('granted');
  jest.spyOn(permission, 'getNotificationPermission').mockResolvedValue('granted');
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

/**
 * Takes the tree down in the middle of a test.
 *
 * RNTL v14's `cleanup` is async: it walks its queue of unmounts, each inside
 * `act`. Left un-awaited, the next `render` joins that queue while it is still
 * being walked and is unmounted with the old tree, so `screen` answers from a
 * dead renderer. The screen's own permission read on mount (#475) added enough
 * async work to make that race lose regularly.
 */
async function remount() {
  await cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
}

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

describe('the way to phone settings (first iPhone run, L7)', () => {
  /*
   * Soft reminders are on by default on the server, so the switch showed "on"
   * and the one place the phone could ever be asked was a switch nobody
   * needed to touch. Meanwhile "Open phone settings" was always on screen —
   * sending somebody the phone had never asked to a toggle that does not
   * exist yet. Settings is for undoing a no; a phone that has not been asked
   * is asked, here, in the app.
   */
  it('is not offered to a phone that has never been asked; the app asks instead', async () => {
    jest.spyOn(permission, 'getNotificationPermission').mockResolvedValue('undetermined');
    jest.spyOn(permission, 'requestNotificationPermission').mockResolvedValue('granted');
    await show();
    await waitFor(() => expect(screen.queryByTestId('notifications-allow')).not.toBeNull());
    expect(screen.queryByTestId('notifications-open-settings')).toBeNull();
    expect(permission.requestNotificationPermission).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('notifications-allow'));
    await waitFor(() => expect(permission.requestNotificationPermission).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('notifications-allow')).toBeNull());
    expect(screen.queryByTestId('notifications-open-settings')).toBeNull();
  });

  it('is not offered when the phone already allows notifications', async () => {
    await show();
    await readySwitch();
    await waitFor(() => expect(permission.getNotificationPermission).toHaveBeenCalled());
    expect(screen.queryByTestId('notifications-open-settings')).toBeNull();
    expect(screen.queryByTestId('notifications-allow')).toBeNull();
  });

  it('is offered once the phone has said no', async () => {
    jest.spyOn(permission, 'getNotificationPermission').mockResolvedValue('denied');
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    await show();
    await waitFor(() => expect(screen.queryByTestId('notifications-open-settings')).not.toBeNull());
    expect(screen.queryByTestId('notifications-allow')).toBeNull();
    await fireEvent.press(screen.getByTestId('notifications-open-settings'));
    expect(open).toHaveBeenCalledTimes(1);
    // `Linking.openSettings` is already a jest.fn in the RN preset, so spyOn
    // hands back that same function and `restoreAllMocks` keeps its calls.
    // Cleared here so a later case counting its own presses starts at zero.
    open.mockClear();
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

  /*
   * The zone is the one the window is answered in, and `UTC` on the wire is
   * not an answer.
   *
   * An account that has never done the routine survey gets `timezone: "UTC"`
   * on `GET /api/mobile/settings/reminders` — the server's fallback, because
   * nobody has told it anything. Echoing it back stored the user's quiet hours
   * in UTC, which in Israel silences the app from 01:30 to 10:30 and lets it
   * speak at 23:00, on the phone and in every server push alike.
   */
  it('sends the phone\'s zone when the account has never said which one it is in', async () => {
    jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue({ success: true, routine: null } as never);
    jest.spyOn(reminderEndpoints, 'getReminderSettings')
      .mockResolvedValue(settings({ quietHours: null as never, timezone: 'UTC' }) as never);
    await show();
    await waitFor(() => expect(screen.queryByTestId('reminder-quiet-standard')).not.toBeNull());
    // The profile query has to have answered `null` before the tap, or this
    // would pass on the loading fallback rather than on the fix.
    await waitFor(() => expect(profileEndpoints.getProfile).toHaveBeenCalled());

    fireEvent.press(screen.getByTestId('reminder-quiet-standard'));
    await waitFor(() => expect(reminderEndpoints.putReminderSettings).toHaveBeenCalled());
    const [patch] = (reminderEndpoints.putReminderSettings as jest.Mock).mock.calls.at(-1) as [
      { quietHours: { timezone: string } },
    ];
    expect(patch.quietHours.timezone).toBe('Europe/Berlin');
  });

  it('keeps the zone the survey was answered in rather than the one the phone is in now', async () => {
    // Same traveller, the other direction: the profile says Asia/Jerusalem and
    // the phone says Europe/Berlin. Changing the chip must not move the sleep
    // window the survey stored, which shares this zone.
    await show();
    await waitFor(() => expect(screen.queryByTestId('reminder-quiet-late')).not.toBeNull());
    await waitFor(() => expect(profileEndpoints.getProfile).toHaveBeenCalled());

    fireEvent.press(screen.getByTestId('reminder-quiet-late'));
    await waitFor(() => expect(reminderEndpoints.putReminderSettings).toHaveBeenCalled());
    const [patch] = (reminderEndpoints.putReminderSettings as jest.Mock).mock.calls.at(-1) as [
      { quietHours: { timezone: string } },
    ];
    expect(patch.quietHours.timezone).toBe('Asia/Jerusalem');
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

/*
 * ── Must reminders (UC-3.12a, #197) ─────────────────────────────
 */
describe('Must reminders', () => {
  const originalOs = Platform.OS;
  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
  });

  async function readyCeiling(choice: 'soft' | 'followUp' | 'hard') {
    await waitFor(() => expect(screen.queryByTestId(`must-ceiling-${choice}`)).not.toBeNull());
    return screen.getByTestId(`must-ceiling-${choice}`);
  }

  it('never rings on one tap: "Ring for Must items" explains first and writes nothing', async () => {
    await show();
    fireEvent.press(await readyCeiling('hard'));

    await waitFor(() => expect(screen.queryByTestId('must-hard-explainer')).not.toBeNull());
    expect(screen.queryByText(en.notifHardExplainBody)).not.toBeNull();
    expect(reminderEndpoints.putReminderSettings).not.toHaveBeenCalled();
    expect(permission.requestNotificationPermission).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('must-hard-cancel'));
    await waitFor(() => expect(screen.queryByTestId('must-hard-explainer')).toBeNull());
    expect(reminderEndpoints.putReminderSettings).not.toHaveBeenCalled();
  });

  it('turns ringing on from the explainer s confirm, opt-in and ceiling together', async () => {
    await show();
    fireEvent.press(await readyCeiling('hard'));
    await waitFor(() => expect(screen.queryByTestId('must-hard-confirm')).not.toBeNull());
    fireEvent.press(screen.getByTestId('must-hard-confirm'));

    await waitFor(() => expect(reminderEndpoints.putReminderSettings)
      .toHaveBeenCalledWith({ escalationCeiling: 'hard', hardEnabled: true }));
    // Something that rings is something the OS has to allow.
    expect(permission.requestNotificationPermission).toHaveBeenCalledTimes(1);
  });

  it('turns ringing off in the same write that lowers the ceiling', async () => {
    jest.spyOn(reminderEndpoints, 'getReminderSettings')
      .mockResolvedValue(settings({ hardEnabled: true, escalationCeiling: 'hard' }) as never);
    await show();
    fireEvent.press(await readyCeiling('soft'));
    await waitFor(() => expect(reminderEndpoints.putReminderSettings)
      .toHaveBeenCalledWith({ escalationCeiling: 'soft', hardEnabled: false }));
    expect(permission.requestNotificationPermission).not.toHaveBeenCalled();
  });

  it('shows the quiet-hours exception only while ringing is on, and sends it alone', async () => {
    await show();
    await readyCeiling('soft');
    expect(screen.queryByTestId('must-through-quiet-switch')).toBeNull();
    await remount();

    jest.spyOn(reminderEndpoints, 'getReminderSettings')
      .mockResolvedValue(settings({ hardEnabled: true, escalationCeiling: 'hard' }) as never);
    jest.spyOn(reminderEndpoints, 'putReminderSettings')
      .mockResolvedValue(settings({ hardEnabled: true, escalationCeiling: 'hard', mustThroughQuietHours: true }) as never);
    client.clear();
    await show();
    await waitFor(() => {
      const control = screen.getByTestId('must-through-quiet-switch');
      expect(control.props.value).toBe(false);
    });
    fireEvent(screen.getByTestId('must-through-quiet-switch'), 'valueChange', true);
    await waitFor(() => expect(reminderEndpoints.putReminderSettings)
      .toHaveBeenCalledWith({ mustThroughQuietHours: true }));
  });

  it('shows the calm exact-alarm note on Android when ringing is on and exact alarms are denied', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    jest.spyOn(exactAlarms, 'canScheduleExactAlarms').mockReturnValue(false);
    const open = jest.spyOn(exactAlarms, 'openExactAlarmSettings').mockReturnValue(true);
    jest.spyOn(reminderEndpoints, 'getReminderSettings')
      .mockResolvedValue(settings({ hardEnabled: true, escalationCeiling: 'hard' }) as never);
    await show();

    await waitFor(() => expect(screen.queryByTestId('must-exact-denied')).not.toBeNull());
    expect(screen.queryByText(en.notifExactDenied)).not.toBeNull();
    fireEvent.press(screen.getByTestId('must-exact-open'));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('shows no exact-alarm note when it is granted, or when nothing rings', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    const asked = jest.spyOn(exactAlarms, 'canScheduleExactAlarms').mockReturnValue(true);
    jest.spyOn(reminderEndpoints, 'getReminderSettings')
      .mockResolvedValue(settings({ hardEnabled: true, escalationCeiling: 'hard' }) as never);
    await show();
    await readyCeiling('hard');
    await waitFor(() => expect(asked).toHaveBeenCalled());
    expect(screen.queryByTestId('must-exact-denied')).toBeNull();
    await remount();

    asked.mockReturnValue(false);
    jest.spyOn(reminderEndpoints, 'getReminderSettings')
      .mockResolvedValue(settings({ hardEnabled: false, escalationCeiling: 'followUp' }) as never);
    client.clear();
    await show();
    await readyCeiling('followUp');
    expect(screen.queryByTestId('must-exact-denied')).toBeNull();
  });

  it('is not there while reminders are off', async () => {
    jest.spyOn(reminderEndpoints, 'getReminderSettings')
      .mockResolvedValue(settings({ softEnabled: false, hardEnabled: true, escalationCeiling: 'hard' }) as never);
    await show();
    await waitFor(() => expect(screen.queryByTestId('gentle-reminders-switch')).not.toBeNull());
    expect(screen.queryByTestId('must-reminders')).toBeNull();
  });
});

/*
 * #475: "Ring for Must items" looked exactly the same after iOS said no as
 * after it said yes. The preference stays what the person chose; what the
 * phone allows is shown at the control, read on mount and on every return to
 * the foreground.
 */
describe('Must ringing when the phone will not ring (#475)', () => {
  function captureAppState() {
    const listeners: ((state: AppStateStatus) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, listener: (state: AppStateStatus) => void) => {
      listeners.push(listener);
      return { remove: () => {} };
    }) as never);
    return (state: AppStateStatus) => { for (const listener of listeners) listener(state); };
  }

  const ringingSaved = () => settings({ hardEnabled: true, escalationCeiling: 'hard' });

  it('warns at the Must control when the prompt answers no, and keeps the saved choice', async () => {
    jest.spyOn(permission, 'getNotificationPermission').mockResolvedValue('undetermined');
    jest.spyOn(permission, 'requestNotificationPermission').mockResolvedValue('denied');
    const put = jest.spyOn(reminderEndpoints, 'putReminderSettings').mockResolvedValue(ringingSaved() as never);
    // The save invalidates and refetches: the server answers with what was stored.
    jest.spyOn(reminderEndpoints, 'getReminderSettings').mockImplementation(async () =>
      (put.mock.calls.length > 0 ? ringingSaved() : settings()) as never);
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined as never);
    await show();

    await waitFor(() => expect(screen.queryByTestId('must-ceiling-hard')).not.toBeNull());
    fireEvent.press(screen.getByTestId('must-ceiling-hard'));
    await waitFor(() => expect(screen.queryByTestId('must-hard-confirm')).not.toBeNull());
    fireEvent.press(screen.getByTestId('must-hard-confirm'));

    await waitFor(() => expect(screen.queryByTestId('must-ring-denied')).not.toBeNull());
    expect(screen.queryByText(en.notifMustRingDenied)).not.toBeNull();
    // At the control: inside the Must card, not at the bottom of the screen.
    expect(within(screen.getByTestId('must-reminders')).queryByTestId('must-ring-denied')).not.toBeNull();
    // (f) The choice is not rolled back.
    expect(put).toHaveBeenCalledWith({ escalationCeiling: 'hard', hardEnabled: true });
    expect(put).not.toHaveBeenCalledWith(expect.objectContaining({ hardEnabled: false }));
    // One warning for one condition.
    expect(screen.queryByTestId('notifications-denied')).toBeNull();

    fireEvent.press(within(screen.getByTestId('must-reminders')).getByTestId('must-ring-open-settings'));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('warns on opening the screen when ringing is saved and the phone already said no, without asking', async () => {
    jest.spyOn(permission, 'getNotificationPermission').mockResolvedValue('denied');
    jest.spyOn(reminderEndpoints, 'getReminderSettings').mockResolvedValue(ringingSaved() as never);
    await show();

    await waitFor(() => expect(screen.queryByTestId('must-ring-denied')).not.toBeNull());
    expect(screen.queryByTestId('must-ring-open-settings')).not.toBeNull();
    expect(permission.requestNotificationPermission).not.toHaveBeenCalled();
    expect(reminderEndpoints.putReminderSettings).not.toHaveBeenCalled();
  });

  it('shows no warning when the phone allows notifications', async () => {
    const read = jest.spyOn(permission, 'getNotificationPermission').mockResolvedValue('granted');
    jest.spyOn(reminderEndpoints, 'getReminderSettings').mockResolvedValue(ringingSaved() as never);
    await show();

    await waitFor(() => expect(screen.queryByTestId('must-through-quiet-switch')).not.toBeNull());
    await waitFor(() => expect(read).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.queryByTestId('must-ring-denied')).toBeNull();
    expect(screen.queryByTestId('must-ring-provisional')).toBeNull();
    expect(screen.queryByTestId('must-ring-open-settings')).toBeNull();
  });

  it('says quiet delivery cannot ring when the permission is provisional', async () => {
    jest.spyOn(permission, 'getNotificationPermission').mockResolvedValue('provisional');
    jest.spyOn(reminderEndpoints, 'getReminderSettings').mockResolvedValue(ringingSaved() as never);
    await show();

    await waitFor(() => expect(screen.queryByTestId('must-ring-provisional')).not.toBeNull());
    expect(screen.queryByText(en.notifMustRingProvisional)).not.toBeNull();
    expect(screen.queryByTestId('must-ring-denied')).toBeNull();
    expect(screen.queryByTestId('must-ring-open-settings')).not.toBeNull();
  });

  it('clears the warning when the app comes back after the user allowed notifications', async () => {
    const fire = captureAppState();
    const read = jest.spyOn(permission, 'getNotificationPermission').mockResolvedValue('denied');
    jest.spyOn(reminderEndpoints, 'getReminderSettings').mockResolvedValue(ringingSaved() as never);
    await show();
    await waitFor(() => expect(screen.queryByTestId('must-ring-denied')).not.toBeNull());

    read.mockResolvedValue('granted');
    await act(async () => { fire('active'); });

    await waitFor(() => expect(screen.queryByTestId('must-ring-denied')).toBeNull());
    expect(screen.queryByTestId('must-ring-open-settings')).toBeNull();
    expect(permission.requestNotificationPermission).not.toHaveBeenCalled();
  });
});

describe('the kill switch', () => {
  it('takes the whole section away rather than leaving a dead switch', async () => {
    const previous = process.env.EXPO_PUBLIC_FEATURE_SOFT_REMINDERS;
    process.env.EXPO_PUBLIC_FEATURE_SOFT_REMINDERS = 'false';
    try {
      await show();
      // The plan card is the rest of the screen, rendered once the plan read
      // lands. (This waited on the phone-settings button until L7 made that
      // button appear only after a no.)
      await waitFor(() => expect(screen.queryByTestId('plan-settings')).not.toBeNull());
      expect(screen.queryByTestId('gentle-reminders-switch')).toBeNull();
      expect(screen.queryByTestId('reminder-lead-60')).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.EXPO_PUBLIC_FEATURE_SOFT_REMINDERS;
      else process.env.EXPO_PUBLIC_FEATURE_SOFT_REMINDERS = previous;
    }
  });
});
