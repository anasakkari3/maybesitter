import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository, type FakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { queryKeys } from '../../../api/queries';
import { useReminderSync } from '../useReminderSync';
import type { NotificationGateway, ScheduleRequest } from '../../../notifications/gateway';
import type { ScheduledNotificationRequest } from '../../../notifications/types';
import { awarenessStorageKey } from '../../../lib/deviceSettings/awarenessStore';
import * as reminderEndpoints from '../../../api/endpoints/reminders';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as profileEndpoints from '../../../api/endpoints/profile';
import type { ReminderIntensity } from '../policy';
import type { AuthUser } from '../../../auth/types';
import commitment from '../../../api/__fixtures__/commitments.one.json';
import reminderSettings from '../../../api/__fixtures__/reminders.settingsSaved.json';

/**
 * The ceiling, at the hook (UC-3.13, #199).
 *
 * `avoidanceInvariant.test.ts` proves the engine never plans above the
 * intensity it is handed. This proves the hook never hands it one above the
 * user's — which it did in two ways:
 *
 *  - **Before the profile had answered.** The fallback for "no answer yet" was
 *    `softAwareness`, the same as the fallback for "never took the survey". For
 *    an account whose stored choice is `none`, the first sync of every launch
 *    scheduled a reminder the user had declined, and a profile that failed to
 *    load kept it scheduled.
 *  - **When the ceiling changed while a sync was running.** The in-flight guard
 *    returned early and nothing ran again afterwards, so the plan made under the
 *    old, higher ceiling stayed pending on the device.
 */

const USER: AuthUser = {
  uid: 'ceiling-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

/** Far enough out that both stages are still ahead; quiet hours removed (see useReminderSync.test.tsx). */
const FUTURE = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
const SETTINGS_NO_QUIET = {
  ...reminderSettings,
  reminderSettings: { ...reminderSettings.reminderSettings, softLeadMinutes: 60, quietHours: null },
};

function routineWith(intensity: ReminderIntensity) {
  return {
    routine: {
      schemaVersion: 1,
      updatedAt: '2026-09-01T00:00:00.000Z',
      timezone: 'UTC',
      sleepWindow: null,
      focusWindows: [],
      fixedCommitmentWindows: [],
      preferredReminderIntensity: intensity,
      quietHours: null,
      surveySkipped: false,
    },
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

/** An OS store: what is scheduled stays pending until cancelled. */
function osGateway(options: { holdFirstRead?: Promise<void> } = {}) {
  const pending = new Map<string, number>();
  const scheduled: ScheduleRequest[] = [];
  const cancelled: string[] = [];
  let reads = 0;
  const gateway: NotificationGateway = {
    async getScheduled(): Promise<ScheduledNotificationRequest[]> {
      reads += 1;
      if (reads === 1 && options.holdFirstRead) await options.holdFirstRead;
      return [...pending].map(([identifier, at]) => ({ identifier, at }));
    },
    async schedule(request) {
      scheduled.push(request);
      pending.set(request.identifier, request.at.getTime());
    },
    async cancel(identifier) {
      cancelled.push(identifier);
      pending.delete(identifier);
    },
    async cancelAll() {
      pending.clear();
    },
  };
  return { gateway, pending, scheduled, cancelled, reads: () => reads };
}

let client: QueryClient;
let repository: FakeAuthRepository;

function Harness({ gateway }: { gateway: NotificationGateway }) {
  useReminderSync({ gateway });
  return null;
}

async function mount(gateway: NotificationGateway) {
  return render(
    <AppProvider>
      <AuthProvider repository={repository} isDevBundle={false}>
        <QueryClientProvider client={client}>
          <Harness gateway={gateway} />
        </QueryClientProvider>
      </AuthProvider>
    </AppProvider>,
  );
}

/** Lets every pending promise and effect run; the hook has no timer to wait on. */
async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
  });
}

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(reminderEndpoints, 'getReminderSettings').mockResolvedValue(SETTINGS_NO_QUIET as never);
  jest.spyOn(commitmentEndpoints, 'listToday')
    .mockResolvedValue({ items: [{ ...commitment, timeSpec: { ...commitment.timeSpec, dueAt: FUTURE } }] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
});

afterEach(async () => {
  cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  await AsyncStorage.removeItem(awarenessStorageKey(USER.uid));
  jest.restoreAllMocks();
});

describe('the ceiling is known before anything is scheduled', () => {
  it('schedules nothing while the profile has not answered', async () => {
    jest.spyOn(profileEndpoints, 'getProfile').mockReturnValue(new Promise(() => {}) as never);
    const { gateway, scheduled } = osGateway();

    await mount(gateway);
    await waitFor(() => expect(commitmentEndpoints.listToday).toHaveBeenCalled());
    await settle();

    // The account's ceiling might be `none`; nothing can be above an unknown.
    expect(scheduled).toEqual([]);
  });

  it('schedules nothing when the profile cannot be read, and leaves what is pending alone', async () => {
    const { gateway, pending, scheduled, cancelled } = osGateway();
    jest.spyOn(profileEndpoints, 'getProfile').mockImplementation(async () => {
      // Planned on an earlier launch under a `followUp` ceiling, and put back
      // once the account is signed in (the signed-out frame clears the store).
      pending.set(`${commitment.id}:followUp`, Date.parse(FUTURE) - 30 * 60_000);
      throw new Error('offline');
    });

    await mount(gateway);
    await waitFor(() => expect(profileEndpoints.getProfile).toHaveBeenCalled());
    await settle();

    expect(scheduled).toEqual([]);
    // No sync ran at all. One that guessed a ceiling would have been just as
    // free to take away what the user's real one allowed.
    expect(cancelled).toEqual([]);
    expect([...pending.keys()]).toEqual([`${commitment.id}:followUp`]);
  });

  it('schedules nothing for an account whose ceiling is none', async () => {
    jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue(routineWith('none') as never);
    const { gateway, scheduled } = osGateway();

    await mount(gateway);
    await waitFor(() => expect(profileEndpoints.getProfile).toHaveBeenCalled());
    await settle();

    expect(scheduled).toEqual([]);
  });

  it('gives an account that never took the survey the gentlest reminder, and only that', async () => {
    // The other half of the fallback: `routine: null` is an answer, not a wait.
    jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue({ routine: null, updatedAt: null } as never);
    const { gateway, pending } = osGateway();

    await mount(gateway);
    await waitFor(() => expect([...pending.keys()]).toEqual([`${commitment.id}:soft`]));
  });
});

describe('a lowered ceiling reaches what is already pending', () => {
  it('takes the follow-up off when the ceiling drops while a sync is still running', async () => {
    const intensity: { value: ReminderIntensity } = { value: 'followUp' };
    jest.spyOn(profileEndpoints, 'getProfile').mockImplementation(async () => routineWith(intensity.value) as never);
    let release!: () => void;
    const hold = new Promise<void>(resolve => {
      release = resolve;
    });
    const { gateway, pending, reads } = osGateway({ holdFirstRead: hold });

    await mount(gateway);
    await waitFor(() => expect(reads()).toBe(1));
    await settle();
    const callsBefore = (profileEndpoints.getProfile as jest.Mock).mock.calls.length;

    // The first sync, under `followUp`, is blocked on reading the OS store.
    // The user lowers their ceiling now.
    intensity.value = 'softAwareness';
    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.profile(USER.uid) });
    });
    await waitFor(() => expect((profileEndpoints.getProfile as jest.Mock).mock.calls.length).toBeGreaterThan(callsBefore));
    await settle();

    // The stale sync finishes and schedules both stages.
    await act(async () => {
      release();
    });

    await waitFor(() => expect([...pending.keys()]).toEqual([`${commitment.id}:soft`]));
  });

  it('proves the hold is real: the stale sync did schedule the follow-up first', async () => {
    // Without this, the test above would also pass against a hook that simply
    // never ran the first sync — which would be a different bug, not this fix.
    jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue(routineWith('followUp') as never);
    const { gateway, scheduled } = osGateway();

    await mount(gateway);
    await waitFor(() => expect(scheduled.map(request => request.identifier).sort())
      .toEqual([`${commitment.id}:followUp`, `${commitment.id}:soft`]));
  });
});
