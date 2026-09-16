import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository, type FakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { useReminderSync } from '../useReminderSync';
import type { NotificationGateway, ScheduleRequest } from '../../../notifications/gateway';
import type { ScheduledNotificationRequest } from '../../../notifications/types';
import * as awarenessStore from '../../../lib/deviceSettings/awarenessStore';
import { awarenessStorageKey, withAwareness, EMPTY_AWARENESS } from '../../../lib/deviceSettings/awarenessStore';
import * as reminderEndpoints from '../../../api/endpoints/reminders';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as profileEndpoints from '../../../api/endpoints/profile';
import type { AuthUser } from '../../../auth/types';
import { hardReceiptStorageKey, loadHardReceipts } from '../hardReceiptQueue';
import commitment from '../../../api/__fixtures__/commitments.one.json';
import reminderSettings from '../../../api/__fixtures__/reminders.settingsSaved.json';

/**
 * The hook that decides *when* the engine runs, and when it must instead undo
 * everything (UC-3.11, #196).
 *
 * `softAwarenessEngine.test.ts` proves what a sync computes. This proves the
 * three moments the engine must not be asked to compute anything at all — and
 * the one of them that is a promise rather than an omission:
 *
 * **The kill switch cancels what is already pending.** "Schedule nothing from
 * now on" is not a kill switch: a request scheduled yesterday fires today
 * whether or not this build would have made it. A mutation that turned the
 * switch into a plain `return` was the one change in this lane that left the
 * whole suite green, which is what this file is for.
 */

const USER: AuthUser = {
  uid: 'sync-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

/** A commitment far enough out that a 30-minute lead is still in the future. */
const FUTURE = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

/**
 * The fixture's window, removed.
 *
 * `FUTURE` is six hours from whenever this runs, so with quiet hours in play
 * whether a stage is deferred would depend on the host's wall clock — and a
 * test whose answer depends on the hour it is run at is the flake #382 was
 * about. The quiet-hours rules have their own file, evaluated at fixed
 * instants; here they are switched off so the moments being tested are the
 * only variable.
 */
const SETTINGS_NO_QUIET = {
  ...reminderSettings,
  // The gentlest ceiling, stated: the saved fixture's account answered the
  // survey with `followUp`, and the moments below are about *whether* the
  // engine runs, which one stage shows as clearly as three.
  reminderSettings: {
    ...reminderSettings.reminderSettings,
    quietHours: null,
    escalationCeiling: 'soft',
    hardEnabled: false,
    mustThroughQuietHours: false,
  },
};

interface FakeGateway extends NotificationGateway {
  readonly scheduled: ScheduleRequest[];
  readonly cancelled: string[];
  /** One entry per `cancelAll`, so a test can say "and then another one". */
  readonly cancelledAllFor: string[];
}

function fakeGateway(pending: ScheduledNotificationRequest[] = []): FakeGateway {
  const scheduled: ScheduleRequest[] = [];
  const cancelled: string[] = [];
  const cancelledAllFor: string[] = [];
  return {
    scheduled,
    cancelled,
    cancelledAllFor,
    getScheduled: async () => pending,
    schedule: async request => {
      scheduled.push(request);
    },
    cancel: async identifier => {
      cancelled.push(identifier);
    },
    cancelAll: async () => {
      cancelledAllFor.push('all');
    },
  };
}

let client: QueryClient;
let repository: FakeAuthRepository;
const savedFlag = process.env.EXPO_PUBLIC_FEATURE_SOFT_REMINDERS;

function Harness({ gateway, exactAlarms }: { gateway: NotificationGateway; exactAlarms: () => boolean }) {
  useReminderSync({ gateway, exactAlarms });
  return null;
}

async function mount(gateway: NotificationGateway, exactAlarms: () => boolean = () => true) {
  return render(
    <AppProvider>
      <AuthProvider repository={repository} isDevBundle={false}>
        <QueryClientProvider client={client}>
          <Harness gateway={gateway} exactAlarms={exactAlarms} />
        </QueryClientProvider>
      </AuthProvider>
    </AppProvider>,
  );
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
  jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue({ routine: null } as never);
});

afterEach(async () => {
  cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  await AsyncStorage.removeItem(awarenessStorageKey(USER.uid));
  await AsyncStorage.removeItem(hardReceiptStorageKey(USER.uid));
  if (savedFlag === undefined) delete process.env.EXPO_PUBLIC_FEATURE_SOFT_REMINDERS;
  else process.env.EXPO_PUBLIC_FEATURE_SOFT_REMINDERS = savedFlag;
  jest.restoreAllMocks();
});

describe('when the engine runs', () => {
  it('schedules the soft reminder once the settings and the week have loaded', async () => {
    const gateway = fakeGateway();
    await mount(gateway);
    await waitFor(() => expect(gateway.scheduled.length).toBe(1));
    expect(gateway.scheduled[0]?.identifier).toBe(`${commitment.id}:soft`);
    // `cancelAll` does happen once here, on the frame before the repository
    // answers — nobody is signed in then — so it is not asserted against. The
    // kill switch's own test is the one that separates the two.
  });

  it('honours an awareness record written before this launch', async () => {
    // The relaunch half of #196's second criterion, at the hook rather than at
    // the engine: the record is on disk before anything mounts.
    await AsyncStorage.setItem(
      awarenessStorageKey(USER.uid),
      JSON.stringify(withAwareness(EMPTY_AWARENESS, commitment.id, FUTURE, new Date().toISOString())),
    );
    const gateway = fakeGateway();
    await mount(gateway);
    await waitFor(() => expect(reminderEndpoints.getReminderSettings).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(gateway.scheduled).toEqual([]);
  });
});

describe('the kill switch', () => {
  it('cancels what is already pending, rather than only declining to add more', async () => {
    process.env.EXPO_PUBLIC_FEATURE_SOFT_REMINDERS = 'false';
    /*
     * Nobody is signed in yet, and that is the point.
     *
     * The hook also cancels for a signed-out device — correctly: a phone with
     * nobody signed in must not be holding an account's reminders. So a test
     * that mounted with a user already present and counted cancels would pass
     * against a kill switch that did nothing at all, on the strength of that
     * one frame. Here the signed-out cancel is taken first and set aside;
     * anything after the sign-in can only have come from the switch.
     */
    repository = createFakeAuthRepository();
    setAuthRepository(repository);
    const gateway = fakeGateway([{ identifier: `${commitment.id}:soft`, at: Date.parse(FUTURE) }]);

    await mount(gateway);
    await waitFor(() => expect(gateway.cancelledAllFor.length).toBeGreaterThan(0));
    const beforeSignIn = gateway.cancelledAllFor.length;

    await act(async () => {
      repository.emit(USER);
    });

    // A request made by yesterday's build fires today regardless, so a switch
    // that only stopped new ones would still interrupt people.
    await waitFor(() => expect(gateway.cancelledAllFor.length).toBeGreaterThan(beforeSignIn));
    expect(gateway.scheduled).toEqual([]);
  });
});

describe('when nobody is signed in', () => {
  it('leaves nothing of the account pending on the device', async () => {
    repository = createFakeAuthRepository({ initialUser: null });
    setAuthRepository(repository);
    const gateway = fakeGateway();

    await mount(gateway);

    await waitFor(() => expect(gateway.cancelledAllFor.length).toBeGreaterThan(0));
    expect(gateway.scheduled).toEqual([]);
  });
});

describe('when the account changes', () => {
  it('never answers for the new account with the old one\'s record', async () => {
    const OTHER: AuthUser = { ...USER, uid: 'other-account', email: 'b@b.c' };

    // The first account said it knew about this commitment.
    await AsyncStorage.setItem(
      awarenessStorageKey(USER.uid),
      JSON.stringify(withAwareness(EMPTY_AWARENESS, commitment.id, FUTURE, new Date().toISOString())),
    );

    const gateway = fakeGateway();
    await mount(gateway);
    await waitFor(() => expect(reminderEndpoints.getReminderSettings).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(gateway.scheduled).toEqual([]);

    /*
     * The second account's own record is *still loading* when it signs in.
     *
     * That is the frame the derivation exists for, and it is made deterministic
     * here rather than raced: a load that never resolves is the worst case, and
     * the reminder still has to be scheduled. Holding the previous account's
     * cache through this frame would silence a commitment this account has
     * never acknowledged — #148's failure, with a quieter symptom.
     */
    jest.spyOn(awarenessStore, 'loadAwareness').mockReturnValue(new Promise(() => {}));
    await act(async () => {
      repository.emit(OTHER);
    });

    await waitFor(() => expect(gateway.scheduled.length).toBe(1));
    expect(gateway.scheduled[0]?.identifier).toBe(`${commitment.id}:soft`);
  });
});

describe('Must reminders on the device (#197)', () => {
  const MUST_ITEM = {
    ...commitment,
    priority: { ...commitment.priority, level: 'high' },
    timeSpec: { ...commitment.timeSpec, dueAt: FUTURE },
  };
  const RINGING = {
    ...SETTINGS_NO_QUIET,
    reminderSettings: { ...SETTINGS_NO_QUIET.reminderSettings, escalationCeiling: 'hard', hardEnabled: true },
  };

  it('schedules the ring and files its receipt under the account, with the exact-alarm answer', async () => {
    jest.spyOn(reminderEndpoints, 'getReminderSettings').mockResolvedValue(RINGING as never);
    jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [MUST_ITEM] } as never);
    const gateway = fakeGateway();
    const asked = jest.fn(() => false);
    await mount(gateway, asked);

    await waitFor(() => expect(gateway.scheduled.map(request => request.identifier))
      .toContain(`${commitment.id}:strong`));
    await waitFor(async () => {
      const queue = await loadHardReceipts(USER.uid);
      expect(queue.pending).toEqual([{
        commitmentId: commitment.id,
        notificationId: `${commitment.id}:strong`,
        fireAt: new Date(Date.parse(FUTURE) - 10 * 60_000).toISOString(),
        exact: false,
      }]);
    });
    expect(asked).toHaveBeenCalled();
  });

  it('does not ring a Must commitment for an account that has not opted in', async () => {
    jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [MUST_ITEM] } as never);
    const gateway = fakeGateway();
    await mount(gateway);
    await waitFor(() => expect(gateway.scheduled.length).toBeGreaterThan(0));
    expect(gateway.scheduled.map(request => request.identifier)).not.toContain(`${commitment.id}:strong`);
    expect((await loadHardReceipts(USER.uid)).pending).toEqual([]);
  });
});
