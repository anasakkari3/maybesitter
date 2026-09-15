import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
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
import en from '../../../i18n/locales/en.json';

import * as planEndpoints from '../../../api/endpoints/plans';

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
  enabled: false, deliveryLocalTime: '07:30', timezone: 'Asia/Jerusalem', nextRunAt: null,
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
    await show();
    expect(screen.getByTestId('plan-morning-toggle').props.disabled).toBe(true);
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
    stored = ON;
    await settled();
    await fireEvent.press(screen.getByTestId('plan-delivery-time'));
    await waitFor(() => expect(screen.queryByTestId('plan-delivery-picker')).not.toBeNull());
    await fireEvent(screen.getByTestId('plan-delivery-picker'), 'change', {
      type: 'set',
      nativeEvent: { timestamp: timeShowing('07:30').getTime() },
    });
    expect(planEndpoints.putPlanSettings).not.toHaveBeenCalled();
  });
});

describe('the way to the plan itself', () => {
  it('offers to open today’s plan', async () => {
    await settled();
    expect(screen.queryByTestId('plan-open')).not.toBeNull();
  });

  it('still does not spend the notification prompt from a settings screen', async () => {
    // iOS lets an app ask once. #195 asks that an undetermined permission route
    // to UC-3.11 (#196)'s flow; that flow does not exist in this app yet, and
    // asking here — before the user has anything that would ring — spends the
    // prompt on the version of the question most likely to be denied.
    await settled();
    expect(screen.queryByTestId('notifications-open-settings')).not.toBeNull();
  });
});
