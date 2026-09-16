import { beforeEach, describe, expect, it } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { withHermesIntl } from '../../../testing/hermesIntl';
import { wallClockIn } from '../../../lib/time/zoneOffset';
import { AWARENESS_CATEGORY_ID, AWARENESS_CHANNEL_ID } from '../../../notifications/channels';
import type { NotificationGateway, ScheduleRequest } from '../../../notifications/gateway';
import type { ScheduledNotificationRequest } from '../../../notifications/types';
import {
  EMPTY_AWARENESS,
  loadAwareness,
  markAware,
  type AwarenessCache,
} from '../../../lib/deviceSettings/awarenessStore';
import { HORIZON_DAYS, MAX_PENDING_REQUESTS, type ReminderCommitment } from '../policy';
import { cancelEveryReminder, desiredRequests, syncCommitments, type SyncInput } from '../softAwarenessEngine';

/**
 * The engine, against a gateway that is a list (UC-3.11, #196).
 *
 * `getScheduled()` is exactly `getAllScheduledNotificationsAsync`, which is
 * the instrument #196's acceptance criteria are written in — so the two
 * "force-quit and relaunch" criteria are testable here rather than only on a
 * phone: a second engine run against a fresh awareness read *is* the relaunch,
 * because nothing about awareness lives in module state.
 */

const NOW = new Date('2026-09-15T09:00:00.000Z');
const ACCOUNT = 'account-a';

interface FakeGateway extends NotificationGateway {
  readonly pending: Map<string, number>;
  readonly scheduledRequests: ScheduleRequest[];
  readonly cancelled: string[];
  readonly cancelledAll: number;
  put(identifier: string, at: number | null): void;
}

function fakeGateway(): FakeGateway {
  const pending = new Map<string, number>();
  const raw = new Map<string, number | null>();
  const scheduledRequests: ScheduleRequest[] = [];
  const cancelled: string[] = [];
  let cancelledAll = 0;

  const gateway = {
    pending,
    scheduledRequests,
    cancelled,
    get cancelledAll() {
      return cancelledAll;
    },
    put(identifier: string, at: number | null) {
      raw.set(identifier, at);
      if (at !== null) pending.set(identifier, at);
    },
    async getScheduled(): Promise<ScheduledNotificationRequest[]> {
      return [...raw.entries()].map(([identifier, at]) => ({ identifier, at }));
    },
    async schedule(request: ScheduleRequest) {
      scheduledRequests.push(request);
      raw.set(request.identifier, request.at.getTime());
      pending.set(request.identifier, request.at.getTime());
    },
    async cancel(identifier: string) {
      cancelled.push(identifier);
      raw.delete(identifier);
      pending.delete(identifier);
    },
    async cancelAll() {
      cancelledAll += 1;
      raw.clear();
      pending.clear();
    },
  };
  return gateway as unknown as FakeGateway;
}

function minutesFromNow(minutes: number): string {
  return new Date(NOW.getTime() + minutes * 60_000).toISOString();
}

function input(overrides: Partial<SyncInput> = {}): SyncInput {
  return {
    commitments: [],
    now: NOW,
    settings: { softEnabled: true, softLeadMinutes: 60, intensity: 'followUp' },
    quietHours: null,
    timeZone: 'Pacific/Chatham',
    awareness: EMPTY_AWARENESS,
    copy: { title: 'A heads-up', body: 'Something is coming up.' },
    ...overrides,
  };
}

function commitment(id: string, minutes: number): ReminderCommitment {
  return { id, startsAt: minutesFromNow(minutes), status: 'active' };
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('scheduling from nothing', () => {
  it('puts both stages of a timed commitment on the awareness channel', async () => {
    const gateway = fakeGateway();
    await syncCommitments(input({ commitments: [commitment('c1', 120)] }), gateway);

    expect(gateway.scheduledRequests.map(request => request.identifier).sort())
      .toEqual(['c1:followUp', 'c1:soft']);
    for (const request of gateway.scheduledRequests) {
      expect(request.channelId).toBe(AWARENESS_CHANNEL_ID);
      expect(request.categoryIdentifier).toBe(AWARENESS_CATEGORY_ID);
    }
  });

  it('carries ids in the payload and never a word about the commitment', async () => {
    const gateway = fakeGateway();
    await syncCommitments(input({ commitments: [commitment('c1', 120)] }), gateway);

    for (const request of gateway.scheduledRequests) {
      // The allowlist, asserted as the *whole* key set rather than as an
      // absence: "no title today" is satisfied by any new key added tomorrow.
      expect(Object.keys(request.data).sort()).toEqual(['commitmentId', 'notificationId', 'stage']);
      expect(Object.values(request.data).every(value => typeof value === 'string')).toBe(true);
      // The copy is the same sentence for every commitment, from the bundle.
      expect(request.title).toBe('A heads-up');
    }
  });

  it('schedules nothing for an item beyond the horizon, or already past', async () => {
    const gateway = fakeGateway();
    await syncCommitments(input({
      commitments: [
        commitment('far', HORIZON_DAYS * 24 * 60 + 1),
        commitment('gone', -10),
        // Inside the lead: the soft stage is already behind us, so only the
        // follow-up is still ahead.
        commitment('soon', 45),
      ],
    }), gateway);

    expect(gateway.scheduledRequests.map(request => request.identifier)).toEqual(['soon:followUp']);
  });
});

describe('the diff', () => {
  it('leaves a request that is already at the right instant alone', async () => {
    const gateway = fakeGateway();
    const first = await syncCommitments(input({ commitments: [commitment('c1', 120)] }), gateway);
    expect(first.scheduled).toHaveLength(2);

    const second = await syncCommitments(input({ commitments: [commitment('c1', 120)] }), gateway);
    expect(second.scheduled).toEqual([]);
    expect(second.cancelled).toEqual([]);
    expect(second.kept.sort()).toEqual(['c1:followUp', 'c1:soft']);
  });

  it('reschedules when the commitment moves', async () => {
    const gateway = fakeGateway();
    await syncCommitments(input({ commitments: [commitment('c1', 120)] }), gateway);
    const report = await syncCommitments(input({ commitments: [commitment('c1', 180)] }), gateway);

    expect(report.cancelled.sort()).toEqual(['c1:followUp', 'c1:soft']);
    expect(report.scheduled.sort()).toEqual(['c1:followUp', 'c1:soft']);
    expect(gateway.pending.get('c1:soft')).toBe(NOW.getTime() + 120 * 60_000);
  });

  it('cancels a request for a commitment that is gone', async () => {
    const gateway = fakeGateway();
    await syncCommitments(input({ commitments: [commitment('c1', 120)] }), gateway);
    const report = await syncCommitments(input({ commitments: [] }), gateway);
    expect(report.cancelled.sort()).toEqual(['c1:followUp', 'c1:soft']);
    expect(gateway.pending.size).toBe(0);
  });

  it('never touches a request that is not one of its own', async () => {
    const gateway = fakeGateway();
    // What UC-3.12a (#197) and UC-3.13 (#199) will schedule.
    gateway.put('must-reminder-7', NOW.getTime() + 60_000);
    gateway.put('c1:loud', NOW.getTime() + 60_000);

    await syncCommitments(input({ commitments: [commitment('c1', 120)] }), gateway);

    expect(gateway.cancelled).toEqual([]);
    expect(gateway.pending.has('must-reminder-7')).toBe(true);
    expect(gateway.pending.has('c1:loud')).toBe(true);
  });

  it('reschedules a pending request whose instant cannot be read', async () => {
    const gateway = fakeGateway();
    // Neither platform's trigger shape parsed: treated as wrong, not as right.
    gateway.put('c1:soft', null);
    const report = await syncCommitments(input({ commitments: [commitment('c1', 120)] }), gateway);
    expect(report.cancelled).toContain('c1:soft');
    expect(report.scheduled).toContain('c1:soft');
  });
});

describe('awareness survives a relaunch', () => {
  it('stops scheduling the follow-up after the user says they know', async () => {
    const gateway = fakeGateway();
    const item = commitment('c1', 120);
    await syncCommitments(input({ commitments: [item] }), gateway);
    expect([...gateway.pending.keys()].sort()).toEqual(['c1:followUp', 'c1:soft']);

    // The tap. Written to disk, exactly as `RemindersMount` writes it.
    await markAware(ACCOUNT, 'c1', item.startsAt, NOW);

    // The relaunch: a new engine run, reading awareness back off the device.
    const relaunched: AwarenessCache = await loadAwareness(ACCOUNT);
    const report = await syncCommitments(
      input({ commitments: [item], awareness: relaunched }),
      gateway,
    );

    expect(report.cancelled.sort()).toEqual(['c1:followUp', 'c1:soft']);
    expect(gateway.pending.size).toBe(0);
  });

  it('gives a rescheduled commitment a fresh cycle', async () => {
    const gateway = fakeGateway();
    const original = commitment('c1', 120);
    await markAware(ACCOUNT, 'c1', original.startsAt, NOW);

    const moved = commitment('c1', 300);
    const report = await syncCommitments(
      input({ commitments: [moved], awareness: await loadAwareness(ACCOUNT) }),
      gateway,
    );
    expect(report.scheduled.sort()).toEqual(['c1:followUp', 'c1:soft']);
  });
});

describe('quiet hours', () => {
  it('defers a stage inside the window to its end, and drops one too close', () => {
    withHermesIntl(() => {
      const zone = 'Pacific/Chatham';
      const minutesAt = (at: number) => {
        const clock = wallClockIn(new Date(at), zone);
        return clock.hour * 60 + clock.minute;
      };
      const findMinute = (from: number, minute: number) => {
        for (let at = from; at < from + 2 * 86_400_000; at += 60_000) {
          if (minutesAt(at) === minute) return at;
        }
        throw new Error('not found');
      };

      /*
       * Two commitments in the last hour of the quiet window, so that their
       * soft stage — one hour ahead — falls inside it.
       *
       * #196's criterion is written as "a soft stage at 22:30 with quiet hours
       * 22:00-07:00 and a commitment at 09:00": that pairing needs a ten-hour
       * lead, and the screen offers 60/30/15. The rule it is about is the one
       * tested here and in `quietHours.test.ts`, which does exercise the 22:30
       * instant directly against `deferOutOfQuietHours`.
       *
       * 07:30 defers to 07:00, thirty minutes ahead. 07:02 drops, because a
       * reminder two minutes before something is not a heads-up — which is the
       * criterion's own second half.
       */
      const morning = findMinute(NOW.getTime() + 2 * 3_600_000, 7 * 60 + 30);
      const tooEarly = findMinute(NOW.getTime() + 2 * 3_600_000, 7 * 60 + 2);

      const quiet = { start: '22:00', end: '07:00' };
      const deferred = desiredRequests(input({
        commitments: [{ id: 'c1', startsAt: new Date(morning).toISOString(), status: 'active' }],
        settings: { softEnabled: true, softLeadMinutes: 60, intensity: 'softAwareness' },
        quietHours: quiet,
        timeZone: zone,
      }));
      const soft = deferred.desired.find(request => request.identifier === 'c1:soft');
      expect(soft).toBeDefined();
      expect(minutesAt((soft as { at: number }).at)).toBe(7 * 60);

      const dropped = desiredRequests(input({
        commitments: [{ id: 'c2', startsAt: new Date(tooEarly).toISOString(), status: 'active' }],
        settings: { softEnabled: true, softLeadMinutes: 60, intensity: 'softAwareness' },
        quietHours: quiet,
        timeZone: zone,
      }));
      expect(dropped.desired).toEqual([]);
      expect(dropped.droppedForQuietHours).toEqual(['c2:soft']);
    });
  });
});

describe('the pending-request cap', () => {
  it('keeps the nearest fifty and reports what it cut', () => {
    const commitments = Array.from({ length: 40 }, (_, index) =>
      commitment(`c${String(index).padStart(3, '0')}`, 120 + index * 10));
    const { desired, overCap } = desiredRequests(input({ commitments }));

    // Forty commitments, two stages each: eighty wanted, fifty kept.
    expect(desired).toHaveLength(MAX_PENDING_REQUESTS);
    expect(overCap).toHaveLength(80 - MAX_PENDING_REQUESTS);

    // Nearest first, so what survives is what is about to happen.
    const latestKept = Math.max(...desired.map(request => request.at));
    const earliestCut = Math.min(...overCap.map(identifier => {
      const match = commitments.find(item => identifier.startsWith(`${item.id}:`));
      return Date.parse(match?.startsAt as string);
    }));
    expect(latestKept).toBeLessThanOrEqual(earliestCut);
  });
});

describe('the kill switch', () => {
  it('cancels everything, including another feature s requests', async () => {
    const gateway = fakeGateway();
    await syncCommitments(input({ commitments: [commitment('c1', 120)] }), gateway);
    gateway.put('must-reminder-7', NOW.getTime() + 60_000);

    await cancelEveryReminder(gateway);

    // The one place `cancelAll` is right: a switch that left another feature's
    // pending requests behind would still interrupt the user.
    expect(gateway.cancelledAll).toBe(1);
    expect(gateway.pending.size).toBe(0);
  });

  it('schedules nothing when the account turned reminders off', async () => {
    const gateway = fakeGateway();
    await syncCommitments(input({
      commitments: [commitment('c1', 120)],
      settings: { softEnabled: false, softLeadMinutes: 60, intensity: 'strongReminder' },
    }), gateway);
    expect(gateway.scheduledRequests).toEqual([]);
  });
});
