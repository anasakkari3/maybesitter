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
import { strings } from '../../../i18n/strings';
import { deferred } from '../../../testing/deferred';

import * as planEndpoints from '../../../api/endpoints/plans';
import * as reminderEndpoints from '../../../api/endpoints/reminders';
import * as profileEndpoints from '../../../api/endpoints/profile';
import * as permission from '../../../notifications/permission';
import reminderFixture from '../../../api/__fixtures__/reminders.settingsDefault.json';
import settingsDefault from '../../../api/__fixtures__/plan.settingsDefault.json';

/**
 * The continuous-replanning switch (#523, AC 9: "User can disable continuous
 * replanning independently from provider sync").
 *
 * It shares one record — and one PUT, which requires `enabled` every time —
 * with the morning-plan switch beside it. So besides "the position is the
 * server's answer", the property under test is that neither switch can
 * rewrite the other: flipping this one must carry the morning switch's stored
 * value, never a default, and never a value a write still in flight is about
 * to replace.
 */

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'replan-settings-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

/** The server's real default record: morning plan off, replanning on. */
const DEFAULT: PlanSettings = settingsDefault.planSettings as PlanSettings;
const MORNING_ON: PlanSettings = { ...DEFAULT, enabled: true, nextRunAt: '2026-08-10T04:30:00.000Z' };

type PutInput = { enabled: boolean; deliveryLocalTime?: string; continuousReplanEnabled?: boolean };

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;
/** A server that remembers, merging a PUT the way `savePlanSettings` does. */
let stored: PlanSettings;

beforeEach(() => {
  onlineManager.setOnline(true);
  stored = DEFAULT;
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(reminderEndpoints, 'getReminderSettings').mockResolvedValue(reminderFixture as never);
  jest.spyOn(reminderEndpoints, 'putReminderSettings').mockResolvedValue(reminderFixture as never);
  jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue({ success: true, routine: null } as never);
  jest.spyOn(permission, 'requestNotificationPermission').mockResolvedValue('granted');
  jest.spyOn(planEndpoints, 'getPlanSettings').mockImplementation((async () => stored) as never);
  jest.spyOn(planEndpoints, 'putPlanSettings').mockImplementation((async (input: PutInput) => {
    stored = {
      ...stored,
      enabled: input.enabled,
      ...(input.deliveryLocalTime ? { deliveryLocalTime: input.deliveryLocalTime } : {}),
      ...(input.continuousReplanEnabled === undefined ? {} : { continuousReplanEnabled: input.continuousReplanEnabled }),
      nextRunAt: input.enabled ? MORNING_ON.nextRunAt : null,
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
  await waitFor(() => expect(screen.getByTestId('plan-replan-toggle').props.disabled).toBe(false));
}

const replan = () => screen.getByTestId('plan-replan-toggle');
const morning = () => screen.getByTestId('plan-morning-toggle');

describe('the replanning switch is the server’s record', () => {
  it('shows the server’s default — on — once it has answered, and nothing to write against before', async () => {
    const answer = deferred<PlanSettings>();
    jest.spyOn(planEndpoints, 'getPlanSettings').mockReturnValue(answer.promise as never);
    await show();
    await waitFor(() => expect(planEndpoints.getPlanSettings).toHaveBeenCalled());
    expect(replan().props.disabled).toBe(true);

    await act(async () => { answer.resolve(DEFAULT); });
    await waitFor(() => expect(replan().props.disabled).toBe(false));
    // The regression this pins: zod stripped the field, so a default-on
    // account was drawn as off.
    expect(replan().props.value).toBe(true);
  });

  it('turns replanning off through the route and shows what came back', async () => {
    await settled();
    await fireEvent(replan(), 'valueChange', false);
    await waitFor(() => expect(replan().props.value).toBe(false));
    expect(stored.continuousReplanEnabled).toBe(false);
  });

  it('stays on when the server did not store the change', async () => {
    // A 200 whose record still says on is a refusal, not a success.
    jest.spyOn(planEndpoints, 'putPlanSettings').mockResolvedValue(DEFAULT as never);
    await settled();
    await fireEvent(replan(), 'valueChange', false);
    await waitFor(() => expect(screen.queryByTestId('plan-replan-toggle-failed')).not.toBeNull());
    expect(replan().props.value).toBe(true);
  });

  it('says that turning it back on does not catch up, whichever way it sits', async () => {
    await settled();
    const said = () => Object.values(strings).some(bundle => screen.queryByText(bundle.planReplanNoBackfill) !== null);
    expect(said()).toBe(true);
    await fireEvent(replan(), 'valueChange', false);
    await waitFor(() => expect(replan().props.value).toBe(false));
    expect(said()).toBe(true);
  });
});

describe('the two switches on one record cannot rewrite each other', () => {
  it('carries the morning plan’s stored value, not a default, when replanning is switched', async () => {
    stored = MORNING_ON;
    await settled();
    await fireEvent(replan(), 'valueChange', false);
    await waitFor(() => expect(replan().props.value).toBe(false));
    expect(planEndpoints.putPlanSettings).toHaveBeenCalledWith({ enabled: true, continuousReplanEnabled: false });
    expect(stored.enabled).toBe(true);
    expect(morning().props.value).toBe(true);
  });

  it('never sends the replanning field from the morning switch', async () => {
    stored = { ...DEFAULT, continuousReplanEnabled: false };
    await settled();
    await fireEvent(morning(), 'valueChange', true);
    await waitFor(() => expect(morning().props.value).toBe(true));
    const sent = (planEndpoints.putPlanSettings as jest.Mock).mock.calls[0]![0] as PutInput;
    expect(sent).not.toHaveProperty('continuousReplanEnabled');
    expect(stored.continuousReplanEnabled).toBe(false);
    expect(replan().props.value).toBe(false);
  });

  it('holds the replanning switch while a morning-switch write is still in flight', async () => {
    // Without this, a tap on the replanning switch here would send the morning
    // switch's *previous* value (still what the cache holds) and could land
    // after the morning write, turning the morning plan back off.
    await settled();
    const held = deferred<PlanSettings>();
    jest.spyOn(planEndpoints, 'putPlanSettings').mockReturnValue(held.promise as never);

    await fireEvent(morning(), 'valueChange', true);
    await waitFor(() => expect(replan().props.disabled).toBe(true));
    await fireEvent(replan(), 'valueChange', false);
    expect(planEndpoints.putPlanSettings).toHaveBeenCalledTimes(1);

    await act(async () => { held.resolve({ ...MORNING_ON }); });
    await waitFor(() => expect(replan().props.disabled).toBe(false));
  });
});
