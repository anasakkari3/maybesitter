import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { NotificationsSettingsScreen } from '../../settings/NotificationsSettingsScreen';
import type { PlanSettings } from '../../../api/schemas/plan';
import { ValidationError } from '../../../api/errors';
import { ltr } from '../../../i18n/strings';
import { timeShowing } from '../pickerClock';
import { deferred } from '../../../testing/deferred';
import en from '../../../i18n/locales/en.json';

import * as planEndpoints from '../../../api/endpoints/plans';
// The screen this renders is also #196's reminders screen since the two lanes
// merged. Its other two reads are stubbed here so this file drives one feature
// against a server that answers, rather than against a failed fetch.
import * as reminderEndpoints from '../../../api/endpoints/reminders';
import * as profileEndpoints from '../../../api/endpoints/profile';
import * as permission from '../../../notifications/permission';
import reminderFixture from '../../../api/__fixtures__/reminders.settingsDefault.json';

/**
 * The morning-plan switch (UC-3.10b, #195 step 5).
 *
 * The property under test is the one `ServerToggle` exists for: the position is
 * the server's answer, never the tap. A switch that flipped optimistically
 * would tell somebody their phone is going to wake them up tomorrow morning on
 * the strength of a write that had not landed.
 */

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'plan-settings-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

const OFF: PlanSettings = {
  enabled: false, deliveryLocalTime: '07:30', timezone: 'Asia/Jerusalem', nextRunAt: null, continuousReplanEnabled: true,
};

const ON: PlanSettings = { ...OFF, enabled: true, nextRunAt: '2026-08-10T04:30:00.000Z' };

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

/**
 * A server that remembers, because the screen reads it back.
 *
 * `useSavePlanSettings` invalidates after it writes, so a GET that kept
 * answering "off" after a successful PUT would snap the switch back — and a
 * stub that did that would be testing the stub, not the screen.
 */
let stored: PlanSettings;

beforeEach(() => {
  onlineManager.setOnline(true);
  stored = OFF;
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(reminderEndpoints, 'getReminderSettings').mockResolvedValue(reminderFixture as never);
  jest.spyOn(reminderEndpoints, 'putReminderSettings').mockResolvedValue(reminderFixture as never);
  jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue({ success: true, routine: null } as never);
  jest.spyOn(permission, 'requestNotificationPermission').mockResolvedValue('granted');
  jest.spyOn(planEndpoints, 'getPlanSettings').mockImplementation((async () => stored) as never);
  jest.spyOn(planEndpoints, 'putPlanSettings').mockImplementation((async (input: { enabled: boolean; deliveryLocalTime?: string }) => {
    stored = {
      ...stored,
      enabled: input.enabled,
      ...(input.deliveryLocalTime ? { deliveryLocalTime: input.deliveryLocalTime } : {}),
      nextRunAt: input.enabled ? ON.nextRunAt : null,
    };
    return stored;
  }) as never);
});

afterEach(() => {
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

async function settled() {
  await show();
  await waitFor(() => expect(screen.getByTestId('plan-morning-toggle').props.disabled).toBe(false));
}

describe('the switch is the server’s record', () => {
  it('has nothing to write against until the server has answered', async () => {
    // The state this defends exists only while the read is outstanding, so the
    // read is *held* outstanding rather than caught in flight. The mock above
    // resolves on its own, and against that this assertion was a race with the
    // machine: it passed here and failed on CI, where the answer had already
    // arrived by the time the assertion ran. Wrapping it in `waitFor` would
    // have been worse — `waitFor` waits for something to *become* true, and
    // would happily wait past the state it was meant to catch.
    const answer = deferred<PlanSettings>();
    jest.spyOn(planEndpoints, 'getPlanSettings').mockReturnValue(answer.promise as never);

    await show();
    await waitFor(() => expect(planEndpoints.getPlanSettings).toHaveBeenCalled());
    // Asked, unanswered, and it cannot become answered until the line below.
    expect(screen.getByTestId('plan-morning-toggle').props.disabled).toBe(true);
    expect(screen.getByTestId('plan-morning-toggle').props.value).toBe(false);

    // And the disabling is the *read*, not the control: it lifts when the
    // answer lands. Without this the case would also pass on a switch that was
    // disabled for ever.
    await act(async () => { answer.resolve(OFF); });
    await waitFor(() => expect(screen.getByTestId('plan-morning-toggle').props.disabled).toBe(false));
  });

  it('turns the morning plan on through the route, and shows what came back', async () => {
    await settled();
    expect(screen.getByTestId('plan-morning-toggle').props.value).toBe(false);

    await fireEvent(screen.getByTestId('plan-morning-toggle'), 'valueChange', true);

    await waitFor(() => expect(screen.getByTestId('plan-morning-toggle').props.value).toBe(true));
    expect(planEndpoints.putPlanSettings).toHaveBeenCalledWith({ enabled: true, deliveryLocalTime: '07:30' });
  });

  it('shows the server’s own next delivery rather than recomputing one', async () => {
    // `nextRunAt` crosses a DST boundary correctly on the server, which has the
    // account's zone and the arithmetic to do it. The phone just prints it.
    await settled();
    await fireEvent(screen.getByTestId('plan-morning-toggle'), 'valueChange', true);
    await waitFor(() => expect(screen.queryByTestId('plan-next-run')).not.toBeNull());
  });

  it('stays where it was when the write is refused, and says so', async () => {
    jest.spyOn(planEndpoints, 'putPlanSettings')
      .mockRejectedValue(new ValidationError('deliveryLocalTime must be HH:mm') as never);
    await settled();
    await fireEvent(screen.getByTestId('plan-morning-toggle'), 'valueChange', true);
    await waitFor(() => expect(screen.queryByTestId('plan-morning-toggle-failed')).not.toBeNull());
    expect(screen.getByTestId('plan-morning-toggle').props.value).toBe(false);
    // The words are the copy table's, never the server's message.
    expect(screen.queryByText(en.trustActionFailed)).not.toBeNull();
    expect(screen.queryByText(/HH:mm/)).toBeNull();
  });

  it('round-trips through the route rather than through the device', async () => {
    // The server remembers; the phone does not. After the write the hook
    // invalidates and reads back, and what the switch then shows is what the
    // GET answered — which is also what a relaunch would get.
    await settled();
    await fireEvent(screen.getByTestId('plan-morning-toggle'), 'valueChange', true);
    await waitFor(() => expect(screen.getByTestId('plan-morning-toggle').props.value).toBe(true));
    expect(planEndpoints.getPlanSettings).toHaveBeenCalledTimes(2);
    expect(stored.enabled).toBe(true);
  });

  it('shows what the server holds on a launch that follows one', async () => {
    // A previous session turned it on. Nothing about this setting is on the
    // device, so this mount learns it the only way there is.
    stored = ON;
    await settled();
    expect(screen.getByTestId('plan-morning-toggle').props.value).toBe(true);
    expect(screen.queryByTestId('plan-next-run')).not.toBeNull();
  });
});

describe('when it arrives', () => {
  it('shows the hour the server stored', async () => {
    await settled();
    // `ltr` keeps "07:30" reading left to right inside an Arabic line; the
    // stored value is what is shown either way.
    expect(screen.queryByText(ltr('07:30'))).not.toBeNull();
  });

  it('sends a new hour, and keeps the switch where it is', async () => {
    stored = ON;
    await settled();

    await fireEvent.press(screen.getByTestId('plan-delivery-time'));
    await waitFor(() => expect(screen.queryByTestId('plan-delivery-picker')).not.toBeNull());

    // The wheel draws the OS's own clock face, and `deliveryLocalTime` is a
    // wall clock and nothing else — so what goes in and what comes out are the
    // same reading, whatever zone the machine running this is in.
    await fireEvent(screen.getByTestId('plan-delivery-picker'), 'change', {
      type: 'set',
      nativeEvent: { timestamp: timeShowing('06:45').getTime() },
    });

    await waitFor(() => expect(planEndpoints.putPlanSettings)
      .toHaveBeenCalledWith({ enabled: true, deliveryLocalTime: '06:45' }));
    await waitFor(() => expect(screen.queryByText(ltr('06:45'))).not.toBeNull());
    expect(screen.getByTestId('plan-morning-toggle').props.value).toBe(true);
  });

  it('writes nothing when the wheel is left where it was', async () => {
    // "Nothing happened" is not something a moment of silence can prove: an
    // assertion made straight after the event would also pass on a write that
    // was merely slower than this line. So a second turn of the wheel — one
    // that *is* a change — is driven afterwards, and the count is read once
    // that write has landed. A write for the first turn would then be there to
    // be counted, and this reads two instead of one.
    stored = ON;
    await settled();
    await fireEvent.press(screen.getByTestId('plan-delivery-time'));
    await waitFor(() => expect(screen.queryByTestId('plan-delivery-picker')).not.toBeNull());

    await fireEvent(screen.getByTestId('plan-delivery-picker'), 'change', {
      type: 'set',
      nativeEvent: { timestamp: timeShowing('07:30').getTime() },
    });

    await fireEvent.press(screen.getByTestId('plan-delivery-time'));
    await waitFor(() => expect(screen.queryByTestId('plan-delivery-picker')).not.toBeNull());
    await fireEvent(screen.getByTestId('plan-delivery-picker'), 'change', {
      type: 'set',
      nativeEvent: { timestamp: timeShowing('06:45').getTime() },
    });

    await waitFor(() => expect(planEndpoints.putPlanSettings).toHaveBeenCalled());
    expect(planEndpoints.putPlanSettings).toHaveBeenCalledTimes(1);
    expect(planEndpoints.putPlanSettings).toHaveBeenCalledWith({ enabled: true, deliveryLocalTime: '06:45' });
  });
});

describe('the way to the plan itself', () => {
  it('offers to open today’s plan', async () => {
    await settled();
    expect(screen.queryByTestId('plan-open')).not.toBeNull();
  });

  it('offers the way to the OS settings once the phone has said no, which is where a no can be undone', async () => {
    // Only after a no (first iPhone run, L7): before the phone is asked there
    // is no switch in phone settings to find.
    jest.spyOn(permission, 'getNotificationPermission').mockResolvedValue('denied');
    await settled();
    expect(screen.queryByTestId('notifications-open-settings')).not.toBeNull();
  });
});

describe('the OS prompt, from this switch', () => {
  it('is asked when the morning plan is turned on, and not on the way to the screen', async () => {
    // #195 asked for this and could not have it: UC-3.11 (#196) had not landed,
    // so there was no flow to route an undetermined permission to. There is
    // now, and the morning plan is a push — a switch that promised "one note
    // when it's ready" without ever asking would promise a note the phone is
    // not allowed to show.
    await settled();
    // Rendering the screen asks nobody anything. iOS allows one prompt per
    // install, and spending it on a screen visit is spending it on nothing.
    expect(permission.requestNotificationPermission).not.toHaveBeenCalled();

    await fireEvent(screen.getByTestId('plan-morning-toggle'), 'valueChange', true);

    await waitFor(() => expect(permission.requestNotificationPermission).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(planEndpoints.putPlanSettings)
      .toHaveBeenCalledWith({ enabled: true, deliveryLocalTime: '07:30' }));
  });

  it('is not asked on the way off', async () => {
    stored = ON;
    await settled();
    await fireEvent(screen.getByTestId('plan-morning-toggle'), 'valueChange', false);
    await waitFor(() => expect(planEndpoints.putPlanSettings)
      .toHaveBeenCalledWith({ enabled: false, deliveryLocalTime: '07:30' }));
    expect(permission.requestNotificationPermission).not.toHaveBeenCalled();
  });

  it('says what the phone is set to when the answer is no, and turns the plan on anyway', async () => {
    jest.spyOn(permission, 'requestNotificationPermission').mockResolvedValue('denied');
    await settled();

    await fireEvent(screen.getByTestId('plan-morning-toggle'), 'valueChange', true);

    await waitFor(() => expect(screen.queryByTestId('notifications-denied')).not.toBeNull());
    // A plan is still built, still on this screen, and still reachable through
    // `maybesitter://plan/<date>`. What a denial costs is the tap, not the plan
    // — so the switch stays where the user put it.
    await waitFor(() => expect(screen.getByTestId('plan-morning-toggle').props.value).toBe(true));
    expect(screen.queryByText(en.notifDenied)).not.toBeNull();
    expect(screen.queryByTestId('notifications-open-settings')).not.toBeNull();
  });
});
